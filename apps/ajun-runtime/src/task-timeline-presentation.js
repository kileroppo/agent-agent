const TIMELINE_SCHEMA_VERSION = 'agent.army/task-timeline/v1';

const LAN_VISIBLE_EVENTS = new Set([
  'task_received',
  'delivery_brief_resolved',
  'workflow_started',
  'step_started',
  'route_fallback_started',
  'quality_check_completed',
  'review_requested',
  'review_completed',
  'revision_started',
  'artifact_committed',
  'delivery_started',
  'delivery_completed',
  'workflow_blocked',
  'workflow_completed',
]);

const EVENT_PRESENTATION = Object.freeze({
  task_received:['已收到任务', '目标已经进入处理队列。', 'active'],
  delivery_brief_resolved:['已理解目标', '交付目标和完成标准已经明确。', 'active'],
  workflow_started:['已开始处理', '任务已经开始执行。', 'active'],
  step_started:['正在处理', '正在推进当前工作步骤。', 'active'],
  checkpoint_saved:['已保存进度', '当前进度已经安全保存。', 'active'],
  capability_policy_decided:['已选择执行策略', '系统已经按权限、数据和费用边界选择能力。', 'active'],
  route_selected:['已选择能力', '当前步骤的执行能力已经就绪。', 'active'],
  capability_call_started:['能力调用中', '正在调用当前步骤所需的能力。', 'active'],
  capability_call_succeeded:['能力调用完成', '当前能力已经返回结果。', 'success'],
  capability_call_failed:['能力调用未完成', '当前能力没有完成本次调用，系统正在判断后续动作。', 'warning'],
  capability_result_ambiguous:['正在核对外部结果', '外部结果暂时无法确认，系统不会盲目重复执行。', 'warning'],
  route_recovery_started:['正在恢复能力', '系统正在执行一次受控恢复。', 'warning'],
  route_fallback_started:['已切换备用能力', '原能力不可用，系统已在授权范围内切换备用方案。', 'warning'],
  quality_check_completed:['已检查结果质量', '当前结果已经完成质量检查。', 'success'],
  review_requested:['正在复核结果', '交付物已进入独立复核。', 'active'],
  review_completed:['复核已完成', '交付物的复核已经完成。', 'success'],
  revision_started:['正在内部修正', '系统正在根据复核结果修正交付物。', 'warning'],
  checkpoint_restored:['已恢复进度', '任务已经从最近的安全进度继续。', 'active'],
  artifact_committed:['已生成产物', '新的可追溯产物已经保存。', 'success'],
  delivery_started:['正在交付', '最终结果正在发送到原任务入口。', 'active'],
  delivery_completed:['交付完成', '最终结果已经送达。', 'success'],
  workflow_blocked:['需要处理', '任务已安全暂停，需要处理后才能继续。', 'danger'],
  workflow_completed:['任务完成', '任务已经完成全部执行步骤。', 'success'],
});

export function presentTaskTimelinePage(page, { taskId, audience = 'lan', filters = [] } = {}) {
  const resolvedAudience = audience === 'local-owner' ? 'local-owner' : 'lan';
  const items = (Array.isArray(page?.items) ? page.items : [])
    .filter((event) => resolvedAudience === 'local-owner' || LAN_VISIBLE_EVENTS.has(event?.eventType))
    .map((event) => presentTaskTimelineEvent(event, { audience:resolvedAudience }))
    .filter(Boolean);
  return {
    schemaVersion:TIMELINE_SCHEMA_VERSION,
    taskId:cleanText(taskId, 80),
    audience:resolvedAudience,
    items,
    nextCursor:cleanCursor(page?.nextCursor),
    filters:[...new Set((Array.isArray(filters) ? filters : []).map((item) => cleanText(item, 24)).filter(Boolean))],
  };
}

export function presentTaskTimelineEvent(event, { audience = 'lan' } = {}) {
  if (!event || typeof event !== 'object') return null;
  const eventType = cleanText(event.eventType, 80);
  if (!eventType) return null;
  const [defaultTitle, defaultSummary, defaultTone] = EVENT_PRESENTATION[eventType]
    || ['运行状态更新', '任务运行状态已经更新。', 'active'];
  const qualityStatus = cleanText(event.qualityResult?.status || event.qualityStatus, 40);
  const status = cleanText(event.status || qualityStatus, 40);
  const publicSummary = cleanText(event.publicSummary, 360);
  const item = {
    eventId:cleanText(event.eventId, 100),
    eventType,
    occurredAt:validTimestamp(event.finishedAt || event.startedAt || event.occurredAt || event.createdAt),
    title:publicSummary ? cleanText(event.publicTitle, 100) || defaultTitle : defaultTitle,
    summary:publicSummary || summaryForStatus(eventType, status, defaultSummary),
    tone:toneForStatus(status, defaultTone),
    status:status || null,
  };
  if (audience === 'local-owner') item.technical = technicalProjection(event);
  return item;
}

function technicalProjection(event) {
  const cost = finiteNumber(event.costAmount ?? event.cost?.amount);
  const technical = {
    traceId:cleanText(event.traceId, 100),
    spanId:cleanText(event.spanId, 100),
    parentSpanId:cleanText(event.parentSpanId, 100),
    workflowId:cleanText(event.workflowId, 100),
    stepId:cleanText(event.stepId, 100),
    agentId:cleanText(event.agentId, 80),
    capabilityId:cleanText(event.capabilityId, 120),
    routeId:cleanText(event.routeId, 120),
    provider:cleanText(event.provider, 80),
    model:cleanText(event.model, 120),
    attempt:positiveInteger(event.attempt),
    durationMs:nonNegativeInteger(event.durationMs),
    policyDecisionId:cleanText(event.policyDecisionId, 100),
    receiptId:cleanText(event.receiptId, 100),
    checkpointRef:cleanRef(event.checkpointRef),
    inputHash:cleanHash(event.inputHash),
    outputHash:cleanHash(event.outputHash),
    artifactRefs:cleanArtifactRefs(event.artifactRefs),
    errorCode:cleanText(event.errorCode, 120),
    safeSummary:redactSensitiveText(event.safeSummary, 600),
    cost:cost === null ? null : {
      amount:cost,
      currency:cleanText(event.costCurrency || event.cost?.currency, 12) || 'CNY',
    },
    qualityResult:cleanQualityResult(event.qualityResult),
  };
  return Object.fromEntries(Object.entries(technical).filter(([, value]) => (
    value !== null && value !== '' && (!Array.isArray(value) || value.length)
  )));
}

function summaryForStatus(eventType, status, fallback) {
  if (eventType === 'quality_check_completed') {
    if (['failed', 'revise', 'blocked', 'quality_failed'].includes(status)) return '质量检查发现问题，结果不会直接进入下游。';
    if (['passed', 'success', 'succeeded'].includes(status)) return '当前结果已经通过质量检查。';
  }
  if (eventType === 'review_completed' && ['failed', 'revise', 'blocked'].includes(status)) {
    return '复核发现需要修正的内容，系统将先内部处理。';
  }
  return fallback;
}

function toneForStatus(status, fallback) {
  if (['failed', 'blocked', 'denied', 'error'].includes(status)) return 'danger';
  if (['warning', 'revise', 'ambiguous', 'degraded', 'quality_failed'].includes(status)) return 'warning';
  if (['success', 'succeeded', 'passed', 'completed'].includes(status)) return 'success';
  return fallback;
}

function cleanQualityResult(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    status:cleanText(value.status, 40),
    gateId:cleanText(value.gateId || value.qualityGateId, 120),
    failedCriteria:(Array.isArray(value.failedCriteria) ? value.failedCriteria : [])
      .slice(0, 20).map((item) => cleanText(item, 160)).filter(Boolean),
  };
  return result.status || result.gateId || result.failedCriteria.length ? result : null;
}

function cleanArtifactRefs(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 20).map((value) => {
    if (typeof value === 'string') return { artifactId:cleanText(value, 160) };
    if (!value || typeof value !== 'object') return null;
    return {
      artifactId:cleanText(value.artifactId || value.ref, 160),
      type:cleanText(value.type, 80),
      title:cleanText(value.title, 160),
    };
  }).filter((value) => value?.artifactId);
}

function cleanRef(value) {
  const text = cleanText(value, 240);
  return /^(?:runtime|artifact|checkpoint):\/\/[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/i.test(text) ? text : '';
}

function cleanHash(value) {
  const text = cleanText(value, 160);
  return /^(?:sha256:)?[a-f0-9]{32,128}$/i.test(text) ? text : '';
}

function cleanCursor(value) {
  const text = cleanText(value, 512);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

function cleanText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function redactSensitiveText(value, limit) {
  return cleanText(value, limit)
    .replace(/\b(bearer|token|api[_ -]?key|secret|cookie|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已脱敏]');
}

function validTimestamp(value) {
  const text = cleanText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export const taskTimelinePresentationContract = Object.freeze({
  schemaVersion:TIMELINE_SCHEMA_VERSION,
  lanVisibleEvents:LAN_VISIBLE_EVENTS,
});
