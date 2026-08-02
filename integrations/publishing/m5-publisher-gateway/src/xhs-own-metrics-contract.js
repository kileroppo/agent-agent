import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded } from './policy.js';

export const XHS_OWN_METRIC_CONTEXT_SCHEMA =
  'agent.army/xhs-own-metric-context/v1';
export const XHS_OWN_METRIC_OBSERVATION_SCHEMA =
  'agent.army/xhs-own-metric-observation/v1';
export const XHS_OWN_METRIC_PAGE_KIND = 'own_note_detail';

const XHS_METRIC_ORIGINS = new Set([
  'https://creator.xiaohongshu.com',
  'https://pro.xiaohongshu.com',
]);
const CHECKPOINTS = new Set(['2h', '24h', '72h']);
const RECEIPT_ID =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const EXTERNAL_CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SELECTOR_VERSION = /^[1-9]\d*\.\d+\.\d+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const METRIC_KEYS = Object.freeze(['views', 'likes', 'saves', 'comments']);
const CONTEXT_KEYS = Object.freeze([
  'accountRef',
  'approvalRef',
  'origin',
  'pageKind',
  'schemaVersion',
  'selectorBundleVersion',
  'selectorChecksum',
  'source',
]);
const OBSERVATION_KEYS = Object.freeze([
  'accountRef',
  'capturedAt',
  'externalContentId',
  'kind',
  'metrics',
  'origin',
  'pageKind',
  'schemaVersion',
  'selectorBundleVersion',
  'selectorChecksum',
]);

export function xhsOwnMetricCollectionKey(receiptId, checkpoint) {
  if (!RECEIPT_ID.test(String(receiptId || '')) || !CHECKPOINTS.has(checkpoint)) {
    throw coded(
      'xhs_metric_collection_identity_invalid',
      '小红书本人指标只能使用有效 receiptId 与 2h、24h 或 72h 检查点。',
    );
  }
  return `${receiptId}:${checkpoint}`;
}

export function normalizeXhsOwnMetricObservation({
  trustedReceipt,
  checkpoint,
  collectionKey,
  collectedAt,
  trustedContext,
  observation,
} = {}) {
  const receipt = validateReceipt(trustedReceipt);
  const expectedCollectionKey = xhsOwnMetricCollectionKey(
    receipt.receiptId,
    checkpoint,
  );
  if (collectionKey !== expectedCollectionKey) {
    throw coded(
      'xhs_metric_collection_identity_invalid',
      '小红书本人指标 collectionKey 必须精确绑定同一 receiptId 与检查点。',
    );
  }
  const normalizedCollectedAt = timestamp(
    collectedAt,
    'xhs_metric_collection_time_invalid',
  );
  const context = validateTrustedContext(trustedContext, receipt);
  const observed = validateObservation(observation);
  assertObservationIdentity(observed, context, receipt);
  const observationAgeMs = Date.parse(normalizedCollectedAt)
    - Date.parse(observed.capturedAt);
  if (
    observationAgeMs < 0
    || observationAgeMs > MAX_OBSERVATION_AGE_MS
  ) {
    throw coded(
      'xhs_metric_observation_invalid',
      '小红书本人指标观察时间必须位于本次采集前五分钟内。',
    );
  }

  const output = {
    collectionKey:expectedCollectionKey,
    checkpoint,
    receiptId:receipt.receiptId,
    platform:M5_PLATFORM_IDS.XIAOHONGSHU,
    accountRef:receipt.accountRef,
    externalContentId:receipt.externalContentId,
    contentVersionId:receipt.contentVersionId,
    collectedAt:normalizedCollectedAt,
    metrics:normalizeMetrics(observed.metrics),
    source:{
      kind:'official_creator_ui',
      origin:context.origin,
      pageKind:XHS_OWN_METRIC_PAGE_KIND,
      selectorBundleVersion:context.selectorBundleVersion,
      selectorChecksum:context.selectorChecksum,
      approvalRef:context.approvalRef,
      capturedAt:timestamp(
        observed.capturedAt,
        'xhs_metric_observation_invalid',
      ),
      rawMetrics:structuredClone(observed.metrics),
    },
  };
  return deepFreeze(output);
}

function validateReceipt(value) {
  if (
    !value
    || value.platform !== M5_PLATFORM_IDS.XIAOHONGSHU
    || !RECEIPT_ID.test(String(value.receiptId || ''))
    || !REFERENCE.test(String(value.accountRef || ''))
    || !EXTERNAL_CONTENT_ID.test(String(value.externalContentId || ''))
    || !REFERENCE.test(String(value.contentVersionId || ''))
  ) {
    throw coded(
      'xhs_metric_receipt_invalid',
      '小红书本人指标必须绑定结构完整的可信 PublishReceipt。',
    );
  }
  return {
    receiptId:value.receiptId,
    accountRef:value.accountRef,
    externalContentId:value.externalContentId,
    contentVersionId:value.contentVersionId,
  };
}

function validateTrustedContext(value, receipt) {
  if (
    !sameKeys(value, CONTEXT_KEYS)
    || value.schemaVersion !== XHS_OWN_METRIC_CONTEXT_SCHEMA
    || value.source !== 'paperclip'
    || !REFERENCE.test(String(value.approvalRef || ''))
    || !String(value.approvalRef).startsWith('paperclip:')
    || !XHS_METRIC_ORIGINS.has(value.origin)
    || value.pageKind !== XHS_OWN_METRIC_PAGE_KIND
    || value.accountRef !== receipt.accountRef
    || !SELECTOR_VERSION.test(String(value.selectorBundleVersion || ''))
    || !SHA256.test(String(value.selectorChecksum || ''))
  ) {
    throw coded(
      'xhs_metric_trusted_context_invalid',
      '小红书本人指标缺少 Paperclip 背书的官方页面、账号和 selector 身份。',
    );
  }
  return value;
}

function validateObservation(value) {
  if (
    !sameKeys(value, OBSERVATION_KEYS)
    || value.schemaVersion !== XHS_OWN_METRIC_OBSERVATION_SCHEMA
    || value.kind !== 'ok'
    || !XHS_METRIC_ORIGINS.has(value.origin)
    || value.pageKind !== XHS_OWN_METRIC_PAGE_KIND
    || !REFERENCE.test(String(value.accountRef || ''))
    || !EXTERNAL_CONTENT_ID.test(String(value.externalContentId || ''))
    || !SELECTOR_VERSION.test(String(value.selectorBundleVersion || ''))
    || !SHA256.test(String(value.selectorChecksum || ''))
    || !sameKeys(value.metrics, METRIC_KEYS)
  ) {
    throw coded(
      'xhs_metric_observation_invalid',
      '小红书本人指标观察结果结构无效、包含额外字段或不来自获批官方页面。',
    );
  }
  timestamp(value.capturedAt, 'xhs_metric_observation_invalid');
  return value;
}

function assertObservationIdentity(observation, context, receipt) {
  if (
    observation.origin !== context.origin
    || observation.pageKind !== context.pageKind
    || observation.accountRef !== receipt.accountRef
    || observation.externalContentId !== receipt.externalContentId
    || observation.selectorBundleVersion !== context.selectorBundleVersion
    || observation.selectorChecksum !== context.selectorChecksum
  ) {
    throw coded(
      'xhs_metric_observation_identity_mismatch',
      '小红书本人指标观察结果与回执账号、笔记或获批 selector 身份不一致。',
    );
  }
}

function normalizeMetrics(metrics) {
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [key, exactNonNegativeInteger(metrics[key])]),
  );
}

function exactNonNegativeInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') {
    throw metricValueError();
  }
  const text = value.trim();
  const canonicalDigits = /^(?:0|[1-9]\d*)$/.test(text);
  const groupedDigits = /^(?:[1-9]\d{0,2})(?:,\d{3})+$/.test(text);
  if (!canonicalDigits && !groupedDigits) throw metricValueError();
  const number = Number(text.replaceAll(',', ''));
  if (!Number.isSafeInteger(number) || number < 0) throw metricValueError();
  return number;
}

function metricValueError() {
  return coded(
    'xhs_metric_value_not_exact',
    '小红书本人指标必须是精确非负整数；缩写、区间、小数、空值或估算值不得写入快照。',
  );
}

function timestamp(value, code) {
  if (typeof value !== 'string') {
    throw coded(code, '小红书本人指标时间必须是规范 UTC 时间戳。');
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== value
  ) {
    throw coded(code, '小红书本人指标时间必须是规范 UTC 时间戳。');
  }
  return value;
}

function sameKeys(value, expected) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
