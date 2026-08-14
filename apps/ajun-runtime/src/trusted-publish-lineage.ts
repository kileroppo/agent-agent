import { M5_PLATFORM_IDS, M5_PLATFORMS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { trustedM5WorkProducts } from './m5-work-product-trust.ts';
const CONTENT_PROVIDER: any = 'agent-army.content-autonomy';
const PUBLISHER_PROVIDER: any = 'agent-army.publisher-gateway';
const TRUSTED_REFERENCE: any = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CONNECTOR_MODE: any = /^(?:fake|real:[a-z0-9][a-z0-9_-]{0,127})$/;
const UUID: any = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONTENT_SHA256: any = /^sha256:[a-f0-9]{64}$/i;
const EVIDENCE_SHA256: any = /^sha256:[a-f0-9]{64}$/;
const MAX_METRIC_OBSERVATION_AGE_MS: any = 5 * 60000;
export function trustedContentVersionProducts(outputs: any): any {
    return trustedM5WorkProducts(outputs, {
        provider: CONTENT_PROVIDER,
        schemaVersion: M5_SCHEMA_IDS.CONTENT_VERSION,
        kind: 'ContentVersion',
        statuses: ['active', 'approved'],
    });
}
export function trustedMachineReviewProducts(outputs: any): any {
    return trustedM5WorkProducts(outputs, {
        provider: CONTENT_PROVIDER,
        schemaVersion: M5_SCHEMA_IDS.MACHINE_REVIEW,
        kind: 'MachineReview',
        statuses: ['active', 'approved'],
    });
}
export function trustedPublishReceiptProducts(outputs: any): any {
    return trustedM5WorkProducts(outputs, {
        provider: PUBLISHER_PROVIDER,
        schemaVersion: M5_SCHEMA_IDS.PUBLISH_RECEIPT,
        kind: 'PublishReceipt',
        type: 'artifact',
        statuses: ['active', 'approved'],
    });
}
export function trustedMetricSnapshotProducts(outputs: any): any {
    return trustedM5WorkProducts(outputs, {
        provider: PUBLISHER_PROVIDER,
        schemaVersion: M5_SCHEMA_IDS.METRIC_SNAPSHOT,
        kind: 'MetricSnapshot',
        type: 'artifact',
        statuses: ['active'],
    });
}
export function assertContentVersionIdentity(contentVersion: any, { invalid }: any = {}): any {
    if (!contentVersion
        || !M5_PLATFORMS.includes(contentVersion.platform)
        || !validOpaqueId(contentVersion.contentVersionId)
        || !CONTENT_SHA256.test(String(contentVersion.checksum || ''))
        || !validRelativePath(contentVersion.mediaPath)
        || !String(contentVersion.title || '').trim()
        || !String(contentVersion.body || '').trim()
        || !Array.isArray(contentVersion.tags)) {
        throw invalidError(invalid, 'ContentVersion 可信来源链身份无效。', 'content_version_identity_invalid');
    }
    // Publisher 原调用方在构建 request 时才分别克隆 grant、tags 和 reviewReport；
    // 此处只核验并保留原对象，避免改变异常输入下的克隆时机和错误顺序。
    return contentVersion;
}
export function assertPublishReceiptIdentity(receipt: any, { invalid, requireMetricIdentity = false }: any = {}): any {
    const metricIdentityInvalid: any = requireMetricIdentity && (!TRUSTED_REFERENCE.test(String(receipt?.campaignId || ''))
        || !M5_PLATFORMS.includes(receipt?.platform)
        || !TRUSTED_REFERENCE.test(String(receipt?.accountRef || ''))
        || !CONNECTOR_MODE.test(String(receipt?.connectorMode || ''))
        || !String(receipt?.contentVersionId || '').trim());
    if (!receipt
        || !UUID.test(String(receipt.receiptId || ''))
        || !String(receipt.externalContentId || '').trim()
        || !String(receipt.evidence || '').trim()
        || !Number.isFinite(Date.parse(receipt.publishedAt))
        || metricIdentityInvalid) {
        throw invalidError(invalid, 'PublishReceipt 可信来源链身份无效。', 'publish_receipt_identity_invalid');
    }
    return structuredClone(receipt);
}
export function assertMetricSnapshotLineage({ snapshot, receipt, expectedCollectionKey, dueAt, invalid, }: any): any {
    if (!snapshot
        || typeof snapshot !== 'object'
        || Array.isArray(snapshot)
        || !String(snapshot.snapshotId || '').trim()
        || snapshot.receiptId !== receipt.receiptId
        || snapshot.collectionKey !== expectedCollectionKey
        || snapshot.platform !== receipt.platform
        || snapshot.contentVersionId !== receipt.contentVersionId
        || !optionalIdentityMatches(snapshot, receipt)
        || !Number.isFinite(Date.parse(snapshot.collectedAt))
        || Date.parse(snapshot.collectedAt) < dueAt.getTime()
        || !validMetricValues(snapshot.metrics)
        || (receipt.platform === M5_PLATFORM_IDS.XIAOHONGSHU
            && !validXhsMetricEvidence(snapshot, receipt))) {
        throw invalidError(invalid, 'MetricSnapshot 可信来源链身份无效。', 'metric_snapshot_identity_invalid');
    }
    return structuredClone(snapshot);
}
function optionalIdentityMatches(snapshot: any, receipt: any): any {
    return ['campaignId', 'accountRef', 'connectorMode', 'externalContentId']
        .every((field: any): any => !Object.hasOwn(snapshot, field) || snapshot[field] === receipt[field]);
}
function validMetricValues(metrics: any): any {
    return Boolean(metrics)
        && typeof metrics === 'object'
        && !Array.isArray(metrics)
        && Object.keys(metrics).length > 0
        && Object.values(metrics).every((value: any): any => Number.isSafeInteger(value) && value >= 0);
}
function validXhsMetricEvidence(snapshot: any, receipt: any): any {
    const source: any = snapshot.source;
    const metricKeys: any[] = ['comments', 'likes', 'saves', 'views'];
    const sourceKeys: any = [
        'approvalRef', 'capturedAt', 'kind', 'origin', 'pageKind', 'rawMetrics',
        'selectorBundleVersion', 'selectorChecksum',
    ].sort();
    const capturedAt: any = Date.parse(source?.capturedAt);
    const observationAgeMs: any = Date.parse(snapshot.collectedAt) - capturedAt;
    return snapshot.accountRef === receipt.accountRef
        && snapshot.externalContentId === receipt.externalContentId
        && Object.keys(snapshot.metrics).sort().join('\n') === metricKeys.join('\n')
        && source
        && typeof source === 'object'
        && !Array.isArray(source)
        && Object.keys(source).sort().join('\n') === sourceKeys.join('\n')
        && source.kind === 'official_creator_ui'
        && ['https://creator.xiaohongshu.com', 'https://pro.xiaohongshu.com'].includes(source.origin)
        && source.pageKind === 'own_note_detail'
        && /^[1-9]\d*\.\d+\.\d+$/.test(String(source.selectorBundleVersion || ''))
        && EVIDENCE_SHA256.test(String(source.selectorChecksum || ''))
        && String(source.approvalRef || '').startsWith('paperclip:')
        && Number.isFinite(capturedAt)
        && observationAgeMs >= 0
        && observationAgeMs <= MAX_METRIC_OBSERVATION_AGE_MS
        && source.rawMetrics
        && typeof source.rawMetrics === 'object'
        && !Array.isArray(source.rawMetrics)
        && Object.keys(source.rawMetrics).sort().join('\n') === metricKeys.join('\n')
        && metricKeys.every((key: any): any => exactRawMetricValue(source.rawMetrics[key]));
}
function exactRawMetricValue(value: any): any {
    if (Number.isSafeInteger(value) && value >= 0)
        return true;
    if (typeof value !== 'string')
        return false;
    const text: any = value.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(text) && !/^(?:[1-9]\d{0,2})(?:,\d{3})+$/.test(text)) {
        return false;
    }
    const parsed: any = Number(text.replaceAll(',', ''));
    return Number.isSafeInteger(parsed) && parsed >= 0;
}
function validRelativePath(value: any): any {
    const text: any = String(value || '').trim().replaceAll('\\', '/');
    return Boolean(text)
        && !text.startsWith('/')
        && text.split('/').every((part: any): any => part && part !== '.' && part !== '..');
}
function validOpaqueId(value: any): any {
    return /^[a-z0-9][a-z0-9_.:-]{2,127}$/i.test(String(value || ''));
}
function invalidError(factory: any, message: any, code: any): any {
    if (typeof factory === 'function')
        return factory(message, code);
    return Object.assign(new Error(message), { code });
}
