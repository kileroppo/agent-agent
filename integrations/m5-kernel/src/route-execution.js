import crypto from 'node:crypto';

const ROUTE_EXECUTION_SCHEMA = 'agent.army/m5-route-execution/v1';
const OBSERVATION_DECISION_SCHEMA = 'agent.army/m5-observation-decision/v1';
const OBSERVATION_DECISION_ACTIONS = new Set([
  'continue',
  'switch_adapter',
  'safe_retry',
  'request_replan',
  'complete',
]);

export class M5RouteExecutionError extends Error {}

export function createM5RouteExecution({
  runId,
  stageKey,
  recovery = null,
  previousExecution = null,
  strategy,
  toolIds,
  inputs,
  now = () => new Date(),
} = {}) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedStageKey = String(stageKey || '').trim();
  const normalizedStrategy = String(strategy || '').trim();
  const normalizedToolIds = [...new Set(
    (Array.isArray(toolIds) ? toolIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].sort();
  if (
    !normalizedRunId
    || !/^[a-z][a-z0-9_]{0,63}$/.test(normalizedStageKey)
    || !normalizedStrategy
    || normalizedToolIds.length === 0
  ) {
    throw new M5RouteExecutionError('M5 路线执行缺少 Run、阶段、策略或实际工具集合。');
  }

  const descriptor = {
    strategy:normalizedStrategy,
    toolIds:normalizedToolIds,
    inputHash:sha256(stableJson(inputs)),
  };
  const routeFingerprint = routeDescriptorFingerprint(descriptor);
  const revisionId = String(recovery?.revisionId || '').trim() || null;
  const rejectedExecution = normalizeRouteDescriptor(
    previousExecution?.consumedRevisionId === revisionId
      ? previousExecution
      : recovery?.rejectedRoute?.execution,
  );
  const rejectedFingerprint = rejectedExecution
    ? routeDescriptorFingerprint(rejectedExecution)
    : String(recovery?.rejectedRoute?.routeFingerprint || '').trim() || null;
  const changedDimensions = rejectedExecution
    ? routeChangedDimensions(rejectedExecution, descriptor)
    : [];
  const routeChanged = Boolean(
    revisionId
    && rejectedFingerprint
    && routeFingerprint !== rejectedFingerprint
    && changedDimensions.length > 0,
  );

  return {
    schemaVersion:ROUTE_EXECUTION_SCHEMA,
    runId:normalizedRunId,
    stageKey:normalizedStageKey,
    consumedRevisionId:revisionId,
    strategy:descriptor.strategy,
    toolIds:descriptor.toolIds,
    inputHash:descriptor.inputHash,
    routeFingerprint,
    rejectedRouteFingerprint:rejectedFingerprint,
    routeChanged,
    changedDimensions,
    routeSummary:routeChanged
      ? `执行器已改变 ${changedDimensions.join('、')}，并按新路线执行。`
      : revisionId
        ? '执行器计算出的输入、工具和策略与上一条失败路线相同。'
        : '执行器按默认路线执行。',
    executedAt:now().toISOString(),
  };
}

export function createM5ObservationDecision({
  runId,
  issueId,
  observation,
  action,
  selectedToolId = null,
  successCondition,
  budget,
  now = () => new Date(),
} = {}) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedIssueId = String(issueId || '').trim();
  const observationId = String(observation?.observationId || '').trim();
  const normalizedAction = String(action || '').trim();
  const normalizedToolId = String(selectedToolId || '').trim() || null;
  const normalizedSuccessCondition = String(successCondition || '').trim();
  if (
    !normalizedRunId
    || !normalizedIssueId
    || observation?.schemaVersion !== 'agent.army/tool-observation/v1'
    || !observationId
    || !OBSERVATION_DECISION_ACTIONS.has(normalizedAction)
    || !normalizedSuccessCondition
  ) {
    throw new M5RouteExecutionError(
      'Observation 决策缺少 Run、Issue、结构化 Observation、动作或成功条件。',
    );
  }
  if (
    ['continue', 'switch_adapter', 'safe_retry'].includes(normalizedAction)
    && !normalizedToolId
  ) {
    throw new M5RouteExecutionError('可执行的 Observation 决策缺少实际工具。');
  }
  if (
    ['request_replan', 'complete'].includes(normalizedAction)
    && normalizedToolId
  ) {
    throw new M5RouteExecutionError('重规划或完成决策不得伪造工具调用。');
  }
  const normalizedBudget = normalizeDecisionBudget(budget);
  const observationHash = sha256(stableJson(observation));
  const descriptor = {
    runId:normalizedRunId,
    issueId:normalizedIssueId,
    observationId,
    observationHash,
    action:normalizedAction,
    selectedToolId:normalizedToolId,
    successCondition:normalizedSuccessCondition,
    budget:normalizedBudget,
  };
  return {
    schemaVersion:OBSERVATION_DECISION_SCHEMA,
    decisionId:sha256(stableJson(descriptor)),
    source:{
      runId:normalizedRunId,
      issueId:normalizedIssueId,
      observationId,
      observationHash,
    },
    action:normalizedAction,
    selectedToolId:normalizedToolId,
    successCondition:normalizedSuccessCondition,
    budget:normalizedBudget,
    decidedAt:now().toISOString(),
  };
}

export function routeExecutionDescriptor(value) {
  return normalizeRouteDescriptor(value);
}

export function routeDescriptorFingerprint(value) {
  const descriptor = normalizeRouteDescriptor(value);
  if (!descriptor) return null;
  return sha256(stableJson(descriptor));
}

export function validM5RouteExecution(value) {
  return value?.schemaVersion === ROUTE_EXECUTION_SCHEMA
    && Boolean(String(value.runId || '').trim())
    && /^[a-z][a-z0-9_]{0,63}$/.test(String(value.stageKey || ''))
    && Boolean(String(value.strategy || '').trim())
    && Array.isArray(value.toolIds)
    && value.toolIds.length > 0
    && value.toolIds.every((item) => Boolean(String(item || '').trim()))
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.inputHash || ''))
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.routeFingerprint || ''))
    && Number.isFinite(Date.parse(String(value.executedAt || '')));
}

export function assertChangedM5RecoveryRoute(execution, recovery) {
  if (!recovery) return execution;
  if (
    !validM5RouteExecution(execution)
    || execution.consumedRevisionId !== recovery.revisionId
    || execution.stageKey !== recovery.nextRoute?.stageKey
  ) {
    throw new M5RouteExecutionError('M5 执行器没有消费当前 PlanRevision。');
  }
  if (execution.routeChanged !== true || execution.changedDimensions.length === 0) {
    throw new M5RouteExecutionError(
      'M5 恢复路线与上一条失败路线相同；输入、工具或策略没有真实变化，拒绝伪恢复。',
    );
  }
  return execution;
}

function normalizeRouteDescriptor(value) {
  const strategy = String(value?.strategy || '').trim();
  const toolIds = [...new Set(
    (Array.isArray(value?.toolIds) ? value.toolIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].sort();
  const inputHash = String(value?.inputHash || '').trim();
  if (
    !strategy
    || toolIds.length === 0
    || !/^sha256:[0-9a-f]{64}$/i.test(inputHash)
  ) return null;
  return { strategy, toolIds, inputHash };
}

function normalizeDecisionBudget(value) {
  const keys = [
    'stepsRemaining',
    'safeRetriesRemaining',
    'replansRemaining',
    'remainingUnitsAfterDecision',
  ];
  const normalized = Object.fromEntries(keys.map((key) => {
    const number = Number(value?.[key]);
    if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
      throw new M5RouteExecutionError(`Observation 决策预算 ${key} 必须是非负整数。`);
    }
    return [key, number];
  }));
  return normalized;
}

function routeChangedDimensions(previous, current) {
  const changed = [];
  if (previous.inputHash !== current.inputHash) changed.push('inputs');
  if (stableJson(previous.toolIds) !== stableJson(current.toolIds)) changed.push('tools');
  if (previous.strategy !== current.strategy) changed.push('strategy');
  return changed;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stableValue(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !/(?:secret|token|cookie|authorization|password|credential|apiKey)/i.test(key))
      .map((key) => [key, stableValue(value[key], depth + 1)]),
  );
}
