import { capabilityTruthView } from './agent-army-read-views.ts';

export function consoleOverviewReadView(overview: any) {
  return Object.freeze({
    schemaVersion:'agent.army/console-overview/v2',
    taskFocus:taskFocusView(overview?.taskFocus),
    manager:employeeView(overview?.manager),
    agents:Object.freeze((Array.isArray(overview?.agents) ? overview.agents : []).slice(0, 80).map(employeeView)),
    capabilities:Object.freeze((Array.isArray(overview?.capabilities) ? overview.capabilities : []).slice(0, 40).map(capabilityView)),
    recentTasks:Object.freeze((Array.isArray(overview?.recentTasks) ? overview.recentTasks : []).slice(0, 3).map(recentTaskView)),
    usage:usageView(overview?.usage),
    health:healthView(overview?.health),
  });
}

function healthView(value: any) {
  return Object.freeze({
    schemaVersion:safeText(value?.schemaVersion, 100) || 'agent.army/console-health/v1',
    checkedAt:safeText(value?.checkedAt, 40) || null,
    coreOnline:healthTier(value?.coreOnline, ['online', 'degraded', 'offline', 'unknown']),
    reliability:Object.freeze({
      ...healthTier(value?.reliability, ['healthy', 'degraded', 'unavailable', 'unknown']),
      observedAt:safeText(value?.reliability?.observedAt, 40) || null,
    }),
    businessDebt:Object.freeze({
      ...healthTier(value?.businessDebt, ['clear', 'needs_attention', 'unknown']),
      reviewBacklog:safeNullableCount(value?.businessDebt?.reviewBacklog),
      verificationBacklog:safeNullableCount(value?.businessDebt?.verificationBacklog),
      unresolvedFailures:safeNullableCount(value?.businessDebt?.unresolvedFailures),
      ownerActionable:safeNullableCount(value?.businessDebt?.ownerActionable),
    }),
  });
}

function healthTier(value: any, allowed: readonly string[]) {
  const requested = safeText(value?.status, 40);
  return Object.freeze({
    status:allowed.includes(requested) ? requested : 'unknown',
    detail:safeText(value?.detail, 240) || '尚无有效状态。',
  });
}

function taskFocusView(value: any) {
  const countKeys = [
    'total', 'completed', 'inProgress', 'backgroundInProgress', 'paused', 'needsInput',
    'waitingApproval', 'waitingTest', 'failed', 'ownerActionable', 'reviewBacklog',
    'verificationBacklog', 'unresolvedFailures', 'historicalArchived', 'validatedByLaterEvidence',
  ];
  return Object.freeze({
    ...Object.fromEntries(countKeys.map((key) => [key, safeCount(value?.[key])])),
    backlog:safeCountMap(value?.backlog, 20),
    actions:Object.freeze((Array.isArray(value?.actions) ? value.actions : []).slice(0, 5).map(focusItemView)),
    next:value?.next ? focusItemView(value.next) : null,
  });
}

function focusItemView(value: any) {
  return Object.freeze({
    taskId:safeText(value?.taskId, 160),
    workflowId:safeText(value?.workflowId, 160) || null,
    title:safeText(value?.title, 160) || '未命名任务',
    status:safeText(value?.status, 60) || 'unknown',
    action:safeText(value?.action, 400) || '请打开详情查看下一步。',
  });
}

function employeeView(value: any) {
  if (!value) return null;
  return Object.freeze({
    agentId:safeText(value?.agentId, 100),
    name:safeText(value?.name || value?.agentId, 120),
    role:safeText(value?.role, 300),
    status:safeText(value?.status, 40),
    acceptedTaskTypes:safeStringList(value?.acceptedTaskTypes, 20, 120),
    capabilityTruth:capabilityTruthView(value?.capabilityTruth),
    independentRuntime:value?.independentRuntime ? Object.freeze({
      state:safeText(value.independentRuntime.state, 60) || 'unknown',
    }) : null,
    feishuChannel:safeChannel(value?.feishuChannel),
    source:safeText(value?.source, 60) || null,
  });
}

function capabilityView(value: any) {
  return Object.freeze({
    id:safeText(value?.id, 100),
    name:safeText(value?.name, 120),
    status:safeText(value?.status, 40),
    detail:safeText(value?.detail, 300),
    truth:capabilityTruthView(value?.truth),
  });
}

function recentTaskView(value: any) {
  return Object.freeze({
    taskId:safeText(value?.taskId, 160),
    taskType:safeText(value?.taskType, 120),
    status:safeText(value?.status, 60),
    updatedAt:safeText(value?.updatedAt || value?.createdAt, 40) || null,
    input:Object.freeze({ title:safeText(value?.input?.title, 160) || '未命名任务' }),
  });
}

function usageView(value: any) {
  const totals = (Array.isArray(value?.cost?.totals) ? value.cost.totals : []).slice(0, 10).map((item: any) => Object.freeze({
    currency:safeText(item?.currency, 12),
    amount:safeNumber(item?.amount),
  }));
  return Object.freeze({
    taskCount:safeCount(value?.taskCount),
    trackedTaskCount:safeCount(value?.trackedTaskCount),
    actualToolCalls:safeCount(value?.actualToolCalls),
    cost:Object.freeze({
      reportedTaskCount:safeCount(value?.cost?.reportedTaskCount),
      totals:Object.freeze(totals),
    }),
  });
}

function safeChannel(value: any) {
  if (!value) return null;
  return Object.freeze({
    status:safeText(value.status, 40),
    message:safeText(value.message, 200),
    verified:value.verified === true,
  });
}

function safeCountMap(value: any, limit: number) {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).slice(0, limit)
    : [];
  return Object.freeze(Object.fromEntries(entries.map(([key, count]) => [safeText(key, 60), safeCount(count)])));
}

function safeStringList(value: unknown, maxItems: number, maxChars: number): readonly string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return Object.freeze([...new Set(values.map((item) => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems));
}

function safeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeNullableCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeText(value: unknown, limit: number): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
