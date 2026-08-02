import crypto from 'node:crypto';
import {
  M5_ALLOWED_PUBLISH_ACTIONS,
  M5_PLATFORMS,
  M5_PROHIBITED_PUBLISH_ACTIONS,
  M5_SCHEMA_IDS,
} from '@agent-army/m5-contracts';

export const PLATFORMS = M5_PLATFORMS;
export const STOP_REASONS = Object.freeze([
  'captcha',
  'identity_verification',
  'account_switch',
  'risk_control',
  'platform_violation',
  'unknown_page'
]);
export const FORBIDDEN_ACTIONS = M5_PROHIBITED_PUBLISH_ACTIONS;
export const REQUIRED_ACTIONS = M5_ALLOWED_PUBLISH_ACTIONS;
export const REQUIRED_REVIEW_CHECKS = Object.freeze([
  'facts', 'privacy', 'rights', 'media', 'claims', 'grantScope', 'duplicate'
]);
export const IMMEDIATE_PUBLISH_RECOVERY_ACTION =
  'reschedule_platform_case_for_current_date';
const PUBLISH_TIME_ZONE = 'Asia/Shanghai';
const FORBIDDEN_CALLER_COST_FIELDS = Object.freeze([
  'amountUsd',
  'actualCost',
  'providerRequestId',
  'receiptRef',
  'cost',
  'billing',
]);

export function publishIdempotencyKey(request) {
  return [
    request.campaignId,
    request.platform,
    request.contentVersionId,
    request.scheduledDate
  ].join(':');
}

export function validatePublishRequest(request, now = new Date()) {
  const errors = [];
  const executionDate = calendarDateInShanghai(now);
  const grant = request?.grant;
  if (!request?.campaignId) errors.push('缺少 campaignId。');
  if (grant?.schemaVersion !== M5_SCHEMA_IDS.CAMPAIGN_GRANT) errors.push('CampaignGrant 版本无效。');
  if (grant?.status !== 'active') errors.push('活动授权未激活。');
  if (grant?.themeScope !== 'AI Agent 实战') errors.push('活动主题范围无效。');
  if (!PLATFORMS.includes(request?.platform) || !grant?.platforms?.includes(request?.platform)) {
    errors.push('平台不在活动授权范围内。');
  }
  if (!grant?.accountRefs?.[request?.platform]) errors.push('缺少平台账号引用。');
  if (grant?.totalPublishLimit !== 14 || grant?.dailyPublishLimitPerPlatform !== 1) {
    errors.push('活动发布上限无效。');
  }
  if (!Number.isInteger(grant?.budgetCents) || grant.budgetCents <= 0) errors.push('活动预算无效。');
  const startsAt = Date.parse(grant?.startsAt);
  const expiresAt = Date.parse(grant?.expiresAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
    || startsAt > now.getTime() || expiresAt <= now.getTime()) {
    errors.push('活动授权尚未生效或已经过期。');
  }
  if ((grant?.allowedActions || []).some((action) => FORBIDDEN_ACTIONS.includes(action))) {
    errors.push('活动授权错误包含禁止动作。');
  }
  for (const action of REQUIRED_ACTIONS) {
    if (!grant?.allowedActions?.includes(action)) errors.push(`活动未授权 ${action}。`);
  }
  if (FORBIDDEN_ACTIONS.some((action) => !grant?.prohibitedActions?.includes(action))) {
    errors.push('活动没有完整声明禁止动作。');
  }
  if (!request?.contentVersionId || !/^sha256:[a-f0-9]{64}$/.test(String(request?.contentChecksum || ''))) {
    errors.push('内容版本或文件哈希无效。');
  }
  const scheduledDate = String(request?.scheduledDate || '');
  const scheduledAt = Date.parse(`${scheduledDate}T00:00:00+08:00`);
  if (!validCalendarDate(scheduledDate) || !Number.isFinite(scheduledAt)
    || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
    || scheduledAt < startsAt || scheduledAt > expiresAt) {
    errors.push('发布日期无效或超出活动授权期限。');
  } else if (scheduledDate !== executionDate) {
    throw immediatePublishDateMismatch(scheduledDate, executionDate);
  }
  if (!request?.reviewReport || request.reviewReport.status !== 'passed'
    || REQUIRED_REVIEW_CHECKS.some((check) => request.reviewReport?.checks?.[check] !== true)) {
    errors.push('机器审核七项检查没有全部通过。');
  }
  if (!request?.mediaPath || !request?.title || !request?.body) errors.push('缺少视频、标题或正文。');
  if (FORBIDDEN_CALLER_COST_FIELDS.some((field) => Object.hasOwn(request || {}, field))) {
    errors.push('发布调用方不得提供或覆盖费用字段。');
  }
  const expected = publishIdempotencyKey(request);
  if (request?.idempotencyKey && request.idempotencyKey !== expected) errors.push('幂等键与发布请求不一致。');
  return { passed:errors.length === 0, errors, idempotencyKey:expected };
}

export function receiptId(idempotencyKey) {
  const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isPublisherError = true;
  return error;
}

export function calendarDateInShanghai(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw coded('publisher_clock_invalid', 'Publisher 执行时钟无效。');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:PUBLISH_TIME_ZONE,
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function immediatePublishDateMismatch(scheduledDate, executionDate) {
  const error = coded(
    'publisher_scheduled_date_mismatch',
    `当前连接器只允许即时发布；Case 日期 ${scheduledDate} 与上海执行日 ${executionDate} 不一致。`,
  );
  error.recoveryAction = Object.freeze({
    action:IMMEDIATE_PUBLISH_RECOVERY_ACTION,
    instruction:'将平台 Case 重排到当前上海日期后重新执行；禁止直接补发历史 Case 或提前发布未来 Case。',
    scheduledDate,
    executionDate,
    timeZone:PUBLISH_TIME_ZONE,
  });
  return error;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
