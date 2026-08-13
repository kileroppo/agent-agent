import crypto from 'node:crypto';

export const TASK_RUN_EVENT_SCHEMA_VERSION = 'agent.army/task-run-event/v1';

export const TASK_RUN_EVENT_FIELDS = Object.freeze([
  'eventId', 'traceId', 'spanId', 'parentSpanId', 'taskId', 'workflowId', 'stepId', 'agentId',
  'eventType', 'capabilityId', 'routeId', 'provider', 'model', 'attempt', 'status', 'startedAt',
  'finishedAt', 'durationMs', 'policyDecisionId', 'receiptId', 'checkpointRef', 'inputHash',
  'outputHash', 'artifactRefs', 'errorCode', 'safeSummary', 'costAmount', 'costCurrency',
  'retentionClass',
]);

const RETENTION_CLASSES = new Set(['detail', 'permanent']);
const MAX_LENGTH = Object.freeze({
  eventId:120, traceId:120, spanId:120, parentSpanId:120, taskId:160, workflowId:160,
  stepId:160, agentId:120, eventType:120, capabilityId:160, routeId:160, provider:120,
  model:160, status:80, policyDecisionId:160, receiptId:160, checkpointRef:240,
  inputHash:160, outputHash:160, errorCode:120, safeSummary:500, costCurrency:12,
});

export function normalizeTaskRunEvent(input, { now = new Date().toISOString() } = {}) {
  const taskId = cleanIdentifier(input?.taskId, MAX_LENGTH.taskId);
  const eventType = cleanIdentifier(input?.eventType, MAX_LENGTH.eventType);
  if (!taskId) throw codedError('task_run_event_task_required', '运行事件必须关联任务。');
  if (!eventType) throw codedError('task_run_event_type_required', '运行事件必须声明事件类型。');
  const startedAt = normalizeIso(input?.startedAt) || normalizeIso(now);
  if (!startedAt) throw codedError('task_run_event_time_invalid', '运行事件时间无效。');
  const finishedAt = normalizeIso(input?.finishedAt);
  if (finishedAt && finishedAt < startedAt) {
    throw codedError('task_run_event_time_invalid', '运行事件结束时间不能早于开始时间。');
  }

  const event = {};
  for (const field of TASK_RUN_EVENT_FIELDS) {
    if (field === 'eventId') event.eventId = cleanIdentifier(input?.eventId, MAX_LENGTH.eventId) || crypto.randomUUID();
    else if (field === 'taskId') event.taskId = taskId;
    else if (field === 'eventType') event.eventType = eventType;
    else if (field === 'startedAt') event.startedAt = startedAt;
    else if (field === 'finishedAt') event.finishedAt = finishedAt || null;
    else if (field === 'attempt') event.attempt = normalizeNonNegativeInteger(input?.attempt);
    else if (field === 'durationMs') event.durationMs = normalizeDuration(input?.durationMs, startedAt, finishedAt);
    else if (field === 'costAmount') event.costAmount = normalizeCost(input?.costAmount);
    else if (field === 'artifactRefs') event.artifactRefs = normalizeArtifactRefs(input?.artifactRefs);
    else if (field === 'safeSummary') event.safeSummary = redactTaskRunSummary(input?.safeSummary);
    else if (field === 'retentionClass') event.retentionClass = RETENTION_CLASSES.has(input?.retentionClass) ? input.retentionClass : 'detail';
    else event[field] = cleanIdentifier(input?.[field], MAX_LENGTH[field]) || null;
  }
  return Object.freeze({ schemaVersion:TASK_RUN_EVENT_SCHEMA_VERSION, ...event });
}

export function normalizeTaskRunEventQuery(input = {}) {
  const taskId = cleanIdentifier(input.taskId, MAX_LENGTH.taskId);
  if (!taskId) throw codedError('task_run_event_task_required', '查询运行事件必须指定任务。');
  const filterInput = Array.isArray(input.filters) ? { flags:input.filters } : (input.filters || {});
  return {
    taskId,
    limit:Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 50, 200)),
    cursor:decodeTaskRunEventCursor(input.cursor),
    filters:{
      flags:normalizeEnumList(filterInput.flags, ['failure', 'fallback', 'cost', 'quality']),
      eventTypes:normalizeStringList(filterInput.eventTypes, MAX_LENGTH.eventType),
      statuses:normalizeStringList(filterInput.statuses, MAX_LENGTH.status),
      capabilityIds:normalizeStringList(filterInput.capabilityIds, MAX_LENGTH.capabilityId),
    },
  };
}

export function encodeTaskRunEventCursor(event) {
  if (!event?.startedAt || !event?.eventId) return null;
  return Buffer.from(JSON.stringify([event.startedAt, event.eventId])).toString('base64url');
}

export function decodeTaskRunEventCursor(value) {
  const encoded = String(value || '').trim();
  if (!encoded) return null;
  try {
    const [startedAt, eventId] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const normalizedTime = normalizeIso(startedAt);
    const normalizedId = cleanIdentifier(eventId, MAX_LENGTH.eventId);
    return normalizedTime && normalizedId ? { startedAt:normalizedTime, eventId:normalizedId } : null;
  } catch {
    return null;
  }
}

export function redactTaskRunSummary(value) {
  let text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  text = text
    .replace(/\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[已脱敏]');
  return text.slice(0, MAX_LENGTH.safeSummary);
}

function normalizeArtifactRefs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => redactSecrets(cleanIdentifier(item, 240))).filter(Boolean))].slice(0, 24);
}

function normalizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanIdentifier(item, limit)).filter(Boolean))].slice(0, 50);
}

function normalizeEnumList(value, allowed) {
  const allowedSet = new Set(allowed);
  return normalizeStringList(value, 40).filter((item) => allowedSet.has(item));
}

function normalizeNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeDuration(value, startedAt, finishedAt) {
  const explicit = normalizeNonNegativeInteger(value);
  if (explicit !== null) return explicit;
  return finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null;
}

function normalizeCost(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 1e8) / 1e8;
}

function normalizeIso(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function cleanIdentifier(value, limit = 160) {
  return redactSecrets(String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, limit);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[已脱敏]');
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
