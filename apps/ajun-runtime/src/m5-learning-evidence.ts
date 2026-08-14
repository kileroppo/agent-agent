import { M5_PLATFORM_IDS, M5_PLATFORMS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { m5GrayProductionTemplateBinding } from './m5-production-template-resolver.ts';
import { isValidM5WorkProductDate, trustedM5WorkProducts, uniqueTrustedM5WorkProduct, } from './m5-work-product-trust.ts';
const CONTENT_PROVIDER: any = 'agent-army.content-autonomy';
const METRIC_PROVIDER: any = 'agent-army.publisher-gateway';
const REQUIRED_REVIEW_CHECKS: any = Object.freeze([
    'facts',
    'privacy',
    'rights',
    'media',
    'claims',
    'grantScope',
    'duplicate',
]);
const SCHEMAS: any = Object.freeze({
    contentVersion: M5_SCHEMA_IDS.CONTENT_VERSION,
    machineReview: M5_SCHEMA_IDS.MACHINE_REVIEW,
    metric: M5_SCHEMA_IDS.METRIC_SNAPSHOT,
    publishReceipt: M5_SCHEMA_IDS.PUBLISH_RECEIPT,
});
/**
 * Validates the complete evidence chain used by M5 learning decisions.
 *
 * Callers only choose which lifecycle transition they are attempting. This
 * module owns Work Product trust, uniqueness, lineage and metric comparison.
 */
export class M5LearningEvidence {
    collectOfflineReplay({ outputs, snapshotRefs }: any): any {
        const refs: any = new Set(snapshotRefs);
        const samples: any = trusted72hSnapshots(outputs)
            .filter((item: any): any => refs.has(item.snapshot.snapshotId));
        if (samples.length !== refs.size) {
            throw new M5LearningLifecycleError('离线回放无法回读全部历史 MetricSnapshot。');
        }
        const reviews: any = samples.map((sample: any): any => uniqueMachineReview(outputs, sample.snapshot.contentVersionId));
        if (reviews.some((review: any): any => !review || !machineReviewPassed(review))) {
            throw new M5LearningLifecycleError('离线回放要求每条历史内容都能回到通过的 MachineReview。');
        }
        return { samples, reviews };
    }
    selectSingleGrayContent({ outputs, templateVersion, templateWorkProductId }: any): any {
        const candidates: any = trustedGrayContentVersions(outputs, templateVersion, templateWorkProductId);
        if (candidates.length > 1) {
            throw new M5LearningLifecycleError(`模板版本 ${templateVersion.templateVersionId} 只能灰度一条内容，当前发现 ${candidates.length} 条。`);
        }
        return candidates[0] || null;
    }
    evaluateGray({ outputs, offlineReplay, templateVersion, grayContentVersion }: any): any {
        const review: any = uniqueMachineReview(outputs, grayContentVersion);
        const snapshot: any = uniqueGrayMetric(outputs, grayContentVersion);
        if (!review || !snapshot)
            return null;
        const primaryMetric: any = offlineReplay.primaryMetric;
        const baseline: any = Number(offlineReplay.baselineMetrics?.[primaryMetric]);
        const actual: any = Number(snapshot.metrics?.[primaryMetric]);
        const qualityPassed: any = machineReviewPassed(review);
        const comparable: any = Number.isFinite(baseline) && Number.isFinite(actual);
        const metricDeclined: any = !comparable || actual < baseline;
        const reasons: any[] = [];
        if (!qualityPassed)
            reasons.push('灰度内容机器审核质量低于生产门禁。');
        if (!comparable)
            reasons.push(`灰度 72h 指标缺少可比较主指标 ${primaryMetric}。`);
        else if (metricDeclined)
            reasons.push(`灰度主指标 ${primaryMetric} 从历史均值 ${baseline} 降至 ${actual}。`);
        const rollback: any = !qualityPassed || metricDeclined;
        return {
            status: rollback ? 'rolled_back' : 'validated',
            templateVersionId: templateVersion.templateVersionId,
            previousTemplateVersionId: templateVersion.previousTemplateVersionId,
            activeTemplateVersionId: rollback
                ? templateVersion.previousTemplateVersionId
                : templateVersion.templateVersionId,
            grayContentVersionId: grayContentVersion.contentVersionId,
            grayMetricSnapshotId: snapshot.snapshotId,
            grayPublishReceiptId: snapshot.receiptId,
            grayMetricCollectionKey: snapshot.collectionKey,
            grayMachineReviewId: review.id,
            grayLineage: {
                dayCaseId: grayContentVersion.dayCaseId,
                platformCaseId: grayContentVersion.platformCaseId,
                platform: grayContentVersion.platform,
                scheduledDate: grayContentVersion.scheduledDate,
                checksum: grayContentVersion.checksum || null,
                templateWorkProductId: grayContentVersion.templateWorkProductId,
                templateBindingHash: grayContentVersion.templateBindingHash,
                variantKey: grayContentVersion.templateApplication.variantKey,
                scriptHash: grayContentVersion.templateApplication.scriptHash,
                renderChecksum: grayContentVersion.templateApplication.renderChecksum,
            },
            qualityPassed,
            performance: {
                primaryMetric,
                baseline,
                actual: Number.isFinite(actual) ? actual : null,
                comparable,
                declined: metricDeclined,
            },
            reasons,
            automaticRollback: rollback,
            productionDefault: !rollback,
        };
    }
}
export class M5LearningLifecycleError extends Error {
}
function trustedGrayContentVersions(outputs: any, templateVersion: any, templateWorkProductId: any): any {
    const expectedBinding: any = m5GrayProductionTemplateBinding({
        templateVersion,
        templateWorkProductId,
    });
    const byContentVersion: any = new Map();
    for (const item of trustedM5WorkProducts(outputs, {
        provider: CONTENT_PROVIDER,
        schemaVersion: SCHEMAS.contentVersion,
        kind: 'ContentVersion',
    })) {
        const version: any = item.metadata?.contentVersion;
        const application: any = version?.templateApplication;
        if (version?.templateVersionId !== templateVersion.templateVersionId
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
            || application?.renderChecksum !== version.checksum)
            continue;
        byContentVersion.set(version.contentVersionId, structuredClone(version));
    }
    return [...byContentVersion.values()];
}
function uniqueMachineReview(outputs: any, contentVersionOrId: any): any {
    const contentVersion: any = typeof contentVersionOrId === 'object'
        ? contentVersionOrId
        : null;
    const contentVersionId: any = contentVersion?.contentVersionId || contentVersionOrId;
    return uniqueTrustedM5WorkProduct(outputs, {
        provider: CONTENT_PROVIDER,
        schemaVersion: SCHEMAS.machineReview,
        kind: 'MachineReview',
    }, {
        matches: (item: any): any => item.metadata?.reviewReport?.contentVersionId === contentVersionId
            && (!contentVersion || machineReviewMatchesContentVersion(item.metadata.reviewReport, contentVersion)),
        duplicateError: (): any => new M5LearningLifecycleError(`内容 ${contentVersionId} 存在多个可信 MachineReview。`),
    });
}
function uniqueGrayMetric(outputs: any, contentVersion: any): any {
    const matches: any = trusted72hSnapshots(outputs).filter((item: any): any => item.snapshot.contentVersionId === contentVersion.contentVersionId
        && item.snapshot.platform === contentVersion.platform
        && item.receipt.contentChecksum === contentVersion.checksum
        && item.receipt.scheduledDate === contentVersion.scheduledDate);
    if (matches.length > 1) {
        throw new M5LearningLifecycleError(`灰度内容 ${contentVersion.contentVersionId} 存在多个可信 72h 指标。`);
    }
    return matches[0]?.snapshot || null;
}
function trusted72hSnapshots(outputs: any): any {
    const receipts: any = trustedPublishReceipts(outputs);
    const byContentVersion: any = new Map();
    for (const item of trustedM5WorkProducts(outputs, {
        provider: METRIC_PROVIDER,
        schemaVersion: SCHEMAS.metric,
        kind: 'MetricSnapshot',
    })) {
        if (item.metadata?.checkpoint !== '72h')
            continue;
        const snapshot: any = item.metadata?.snapshot;
        const receipt: any = receipts.get(String(item.metadata?.receiptId || ''));
        const expectedCollectionKey: any = receipt ? `${receipt.receiptId}:72h` : null;
        const expectedDueAt: any = receipt
            ? new Date(Date.parse(receipt.publishedAt) + 72 * 60 * 60 * 1000).toISOString()
            : null;
        if (!snapshot
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
            || Array.isArray(snapshot.metrics))
            continue;
        const current: any = byContentVersion.get(snapshot.contentVersionId);
        if (!current || Date.parse(snapshot.collectedAt) > Date.parse(current.snapshot.collectedAt)) {
            byContentVersion.set(snapshot.contentVersionId, {
                id: item.id,
                snapshot: structuredClone(snapshot),
                receipt: structuredClone(receipt),
            });
        }
    }
    return [...byContentVersion.values()];
}
function trustedPublishReceipts(outputs: any): any {
    const byReceiptId: any = new Map();
    for (const item of trustedM5WorkProducts(outputs, {
        provider: METRIC_PROVIDER,
        schemaVersion: SCHEMAS.publishReceipt,
        kind: 'PublishReceipt',
    })) {
        const receipt: any = item.metadata?.receipt;
        if (!receipt
            || !String(receipt.receiptId || '').trim()
            || !String(receipt.contentVersionId || '').trim()
            || !M5_PLATFORMS.includes(receipt.platform)
            || !isValidM5WorkProductDate(receipt.publishedAt)
            || !sha256(receipt.contentChecksum)
            || !/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.scheduledDate || '')))
            continue;
        if (byReceiptId.has(receipt.receiptId)) {
            throw new M5LearningLifecycleError(`发布回执 ${receipt.receiptId} 不唯一。`);
        }
        byReceiptId.set(receipt.receiptId, structuredClone(receipt));
    }
    return byReceiptId;
}
function machineReviewPassed(item: any): any {
    const report: any = item?.metadata?.reviewReport;
    return report?.status === 'passed'
        && REQUIRED_REVIEW_CHECKS.every((key: any): any => report?.checks?.[key] === true);
}
function machineReviewMatchesContentVersion(report: any, contentVersion: any): any {
    const lineage: any = report?.variantLineage;
    const application: any = contentVersion?.templateApplication;
    return lineage?.variantKey === application?.variantKey
        && lineage?.scriptHash === application?.scriptHash
        && lineage?.templateBindingHash === contentVersion?.templateBindingHash
        && lineage?.templateBindingHash === application?.bindingHash
        && lineage?.renderChecksum === contentVersion?.checksum
        && lineage?.renderChecksum === application?.renderChecksum;
}
function sha256(value: any): any {
    return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}
