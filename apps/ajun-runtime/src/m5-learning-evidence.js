import {
  M5_PLATFORM_IDS,
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
} from '@agent-army/m5-contracts';
import { m5GrayProductionTemplateBinding } from './m5-production-template-resolver.js';
import {
  isValidM5WorkProductDate,
  trustedM5WorkProducts,
  uniqueTrustedM5WorkProduct,
} from './m5-work-product-trust.js';

const CONTENT_PROVIDER = 'agent-army.content-autonomy';
const METRIC_PROVIDER = 'agent-army.publisher-gateway';
const REQUIRED_REVIEW_CHECKS = Object.freeze([
  'facts',
  'privacy',
  'rights',
  'media',
  'claims',
  'grantScope',
  'duplicate',
]);

const SCHEMAS = Object.freeze({
  contentVersion:M5_SCHEMA_IDS.CONTENT_VERSION,
  machineReview:M5_SCHEMA_IDS.MACHINE_REVIEW,
  metric:M5_SCHEMA_IDS.METRIC_SNAPSHOT,
  publishReceipt:M5_SCHEMA_IDS.PUBLISH_RECEIPT,
});

/**
 * Validates the complete evidence chain used by M5 learning decisions.
 *
 * Callers only choose which lifecycle transition they are attempting. This
 * module owns Work Product trust, uniqueness, lineage and metric comparison.
 */
export class M5LearningEvidence {
  collectOfflineReplay({ outputs, snapshotRefs }) {
    const refs = new Set(snapshotRefs);
    const samples = trusted72hSnapshots(outputs)
      .filter((item) => refs.has(item.snapshot.snapshotId));
    if (samples.length !== refs.size) {
      throw new M5LearningLifecycleError('离线回放无法回读全部历史 MetricSnapshot。');
    }
    const reviews = samples.map((sample) =>
      uniqueMachineReview(outputs, sample.snapshot.contentVersionId));
    if (reviews.some((review) => !review || !machineReviewPassed(review))) {
      throw new M5LearningLifecycleError('离线回放要求每条历史内容都能回到通过的 MachineReview。');
    }
    return { samples, reviews };
  }

  selectSingleGrayContent({ outputs, templateVersion, templateWorkProductId }) {
    const candidates = trustedGrayContentVersions(
      outputs,
      templateVersion,
      templateWorkProductId,
    );
    if (candidates.length > 1) {
      throw new M5LearningLifecycleError(
        `模板版本 ${templateVersion.templateVersionId} 只能灰度一条内容，当前发现 ${candidates.length} 条。`,
      );
    }
    return candidates[0] || null;
  }

  evaluateGray({ outputs, offlineReplay, templateVersion, grayContentVersion }) {
    const review = uniqueMachineReview(outputs, grayContentVersion);
    const snapshot = uniqueGrayMetric(outputs, grayContentVersion);
    if (!review || !snapshot) return null;

    const primaryMetric = offlineReplay.primaryMetric;
    const baseline = Number(offlineReplay.baselineMetrics?.[primaryMetric]);
    const actual = Number(snapshot.metrics?.[primaryMetric]);
    const qualityPassed = machineReviewPassed(review);
    const comparable = Number.isFinite(baseline) && Number.isFinite(actual);
    const metricDeclined = !comparable || actual < baseline;
    const reasons = [];
    if (!qualityPassed) reasons.push('灰度内容机器审核质量低于生产门禁。');
    if (!comparable) reasons.push(`灰度 72h 指标缺少可比较主指标 ${primaryMetric}。`);
    else if (metricDeclined) reasons.push(`灰度主指标 ${primaryMetric} 从历史均值 ${baseline} 降至 ${actual}。`);
    const rollback = !qualityPassed || metricDeclined;
    return {
      status:rollback ? 'rolled_back' : 'validated',
      templateVersionId:templateVersion.templateVersionId,
      previousTemplateVersionId:templateVersion.previousTemplateVersionId,
      activeTemplateVersionId:rollback
        ? templateVersion.previousTemplateVersionId
        : templateVersion.templateVersionId,
      grayContentVersionId:grayContentVersion.contentVersionId,
      grayMetricSnapshotId:snapshot.snapshotId,
      grayPublishReceiptId:snapshot.receiptId,
      grayMetricCollectionKey:snapshot.collectionKey,
      grayMachineReviewId:review.id,
      grayLineage:{
        dayCaseId:grayContentVersion.dayCaseId,
        platformCaseId:grayContentVersion.platformCaseId,
        platform:grayContentVersion.platform,
        scheduledDate:grayContentVersion.scheduledDate,
        checksum:grayContentVersion.checksum || null,
        templateWorkProductId:grayContentVersion.templateWorkProductId,
        templateBindingHash:grayContentVersion.templateBindingHash,
        variantKey:grayContentVersion.templateApplication.variantKey,
        scriptHash:grayContentVersion.templateApplication.scriptHash,
        renderChecksum:grayContentVersion.templateApplication.renderChecksum,
      },
      qualityPassed,
      performance:{
        primaryMetric,
        baseline,
        actual:Number.isFinite(actual) ? actual : null,
        comparable,
        declined:metricDeclined,
      },
      reasons,
      automaticRollback:rollback,
      productionDefault:!rollback,
    };
  }
}

export class M5LearningLifecycleError extends Error {}

function trustedGrayContentVersions(outputs, templateVersion, templateWorkProductId) {
  const expectedBinding = m5GrayProductionTemplateBinding({
    templateVersion,
    templateWorkProductId,
  });
  const byContentVersion = new Map();
  for (const item of trustedM5WorkProducts(outputs, {
    provider:CONTENT_PROVIDER,
    schemaVersion:SCHEMAS.contentVersion,
    kind:'ContentVersion',
  })) {
    const version = item.metadata?.contentVersion;
    const application = version?.templateApplication;
    if (
      version?.templateVersionId !== templateVersion.templateVersionId
      || version?.templateWorkProductId !== templateWorkProductId
      || version?.grayRelease !== true
      || !String(version.contentVersionId || '').trim()
      || version.platform !== templateVersion.grayTargetPlatform
      || version.platform !== M5_PLATFORM_IDS.DOUYIN
      || version.dayCaseId !== templateVersion.grayTargetDayCaseId
      || version.platformCaseId !== templateVersion.grayTargetCaseId
      || version.scheduledDate !== templateVersion.grayTargetScheduledDate
      || !sha256(version.checksum)
      || !sha256(version.templateBindingHash)
      || version.templateBindingHash !== expectedBinding.bindingHash
      || application?.mode !== 'verified_full_content_variant'
      || application?.variantKey !== 'gray_douyin'
      || application?.bindingHash !== version.templateBindingHash
      || !sha256(application?.scriptHash)
      || application?.renderChecksum !== version.checksum
    ) continue;
    byContentVersion.set(version.contentVersionId, structuredClone(version));
  }
  return [...byContentVersion.values()];
}

function uniqueMachineReview(outputs, contentVersionOrId) {
  const contentVersion = typeof contentVersionOrId === 'object'
    ? contentVersionOrId
    : null;
  const contentVersionId = contentVersion?.contentVersionId || contentVersionOrId;
  return uniqueTrustedM5WorkProduct(outputs, {
    provider:CONTENT_PROVIDER,
    schemaVersion:SCHEMAS.machineReview,
    kind:'MachineReview',
  }, {
    matches:(item) => item.metadata?.reviewReport?.contentVersionId === contentVersionId
      && (!contentVersion || machineReviewMatchesContentVersion(
        item.metadata.reviewReport,
        contentVersion,
      )),
    duplicateError:() => new M5LearningLifecycleError(
      `内容 ${contentVersionId} 存在多个可信 MachineReview。`,
    ),
  });
}

function uniqueGrayMetric(outputs, contentVersion) {
  const matches = trusted72hSnapshots(outputs).filter((item) =>
    item.snapshot.contentVersionId === contentVersion.contentVersionId
    && item.snapshot.platform === contentVersion.platform
    && item.receipt.contentChecksum === contentVersion.checksum
    && item.receipt.scheduledDate === contentVersion.scheduledDate);
  if (matches.length > 1) {
    throw new M5LearningLifecycleError(`灰度内容 ${contentVersion.contentVersionId} 存在多个可信 72h 指标。`);
  }
  return matches[0]?.snapshot || null;
}

function trusted72hSnapshots(outputs) {
  const receipts = trustedPublishReceipts(outputs);
  const byContentVersion = new Map();
  for (const item of trustedM5WorkProducts(outputs, {
    provider:METRIC_PROVIDER,
    schemaVersion:SCHEMAS.metric,
    kind:'MetricSnapshot',
  })) {
    if (item.metadata?.checkpoint !== '72h') continue;
    const snapshot = item.metadata?.snapshot;
    const receipt = receipts.get(String(item.metadata?.receiptId || ''));
    const expectedCollectionKey = receipt ? `${receipt.receiptId}:72h` : null;
    const expectedDueAt = receipt
      ? new Date(Date.parse(receipt.publishedAt) + 72 * 60 * 60 * 1_000).toISOString()
      : null;
    if (
      !snapshot
      || !receipt
      || !String(snapshot.snapshotId || '').trim()
      || !String(snapshot.contentVersionId || '').trim()
      || snapshot.contentVersionId !== receipt.contentVersionId
      || snapshot.platform !== receipt.platform
      || snapshot.receiptId !== receipt.receiptId
      || snapshot.collectionKey !== expectedCollectionKey
      || item.metadata?.collectionKey !== expectedCollectionKey
      || item.metadata?.dueAt !== expectedDueAt
      || !isValidM5WorkProductDate(snapshot.collectedAt)
      || Date.parse(snapshot.collectedAt) < Date.parse(expectedDueAt)
      || !snapshot.metrics
      || typeof snapshot.metrics !== 'object'
      || Array.isArray(snapshot.metrics)
    ) continue;
    const current = byContentVersion.get(snapshot.contentVersionId);
    if (!current || Date.parse(snapshot.collectedAt) > Date.parse(current.snapshot.collectedAt)) {
      byContentVersion.set(snapshot.contentVersionId, {
        id:item.id,
        snapshot:structuredClone(snapshot),
        receipt:structuredClone(receipt),
      });
    }
  }
  return [...byContentVersion.values()];
}

function trustedPublishReceipts(outputs) {
  const byReceiptId = new Map();
  for (const item of trustedM5WorkProducts(outputs, {
    provider:METRIC_PROVIDER,
    schemaVersion:SCHEMAS.publishReceipt,
    kind:'PublishReceipt',
  })) {
    const receipt = item.metadata?.receipt;
    if (
      !receipt
      || !String(receipt.receiptId || '').trim()
      || !String(receipt.contentVersionId || '').trim()
      || !M5_PLATFORMS.includes(receipt.platform)
      || !isValidM5WorkProductDate(receipt.publishedAt)
      || !sha256(receipt.contentChecksum)
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.scheduledDate || ''))
    ) continue;
    if (byReceiptId.has(receipt.receiptId)) {
      throw new M5LearningLifecycleError(`发布回执 ${receipt.receiptId} 不唯一。`);
    }
    byReceiptId.set(receipt.receiptId, structuredClone(receipt));
  }
  return byReceiptId;
}

function machineReviewPassed(item) {
  const report = item?.metadata?.reviewReport;
  return report?.status === 'passed'
    && REQUIRED_REVIEW_CHECKS.every((key) => report?.checks?.[key] === true);
}

function machineReviewMatchesContentVersion(report, contentVersion) {
  const lineage = report?.variantLineage;
  const application = contentVersion?.templateApplication;
  return lineage?.variantKey === application?.variantKey
    && lineage?.scriptHash === application?.scriptHash
    && lineage?.templateBindingHash === contentVersion?.templateBindingHash
    && lineage?.templateBindingHash === application?.bindingHash
    && lineage?.renderChecksum === contentVersion?.checksum
    && lineage?.renderChecksum === application?.renderChecksum;
}

function sha256(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}
