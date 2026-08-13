export function isExactLegacyMaturityContentBlock(task: any): boolean {
  return task?.taskType === 'content.video-script-package'
    && task.status === 'waiting_test'
    && task.currentStage === 'maturity_execution_blocked'
    && task.attempt === 1
    && task.error?.code === 'maturity_execution_guard_rejected'
    && task.error?.message === 'this.research is not a function'
    && task.error?.category === 'governance'
    && task.error?.stage === 'maturity_execution_guard'
    && task.error?.retryable === false
    && sameKeys(task.error, ['category', 'code', 'message', 'occurredAt', 'retryable', 'stage', 'userMessage'])
    && task.execution?.executor === 'content-creator'
    && task.execution?.outcome === 'maturity_execution_blocked'
    && !task.execution?.owner
    && sameKeys(task.execution, ['executor', 'finishedAt', 'outcome', 'startedAt'])
    && task.usage == null
    && task.governance == null
    && Array.isArray(task.artifactRefs)
    && task.artifactRefs.length === 0;
}

export function isExactQueuedMaturityContentRetry(task: any): boolean {
  return task?.taskType === 'content.video-script-package'
    && task.status === 'queued'
    && task.currentStage === 'queued_for_execution'
    && task.attempt === 2
    && task.input?.context?.productMaturityAuthorization?.kind === 'product-maturity-validation'
    && /^maturity-[0-9a-f-]{36}$/i.test(String(task.source?.eventRef || ''))
    && typeof task.parentTaskId === 'string'
    && task.parentTaskId.length > 0
    && task.execution == null
    && task.error == null
    && task.usage == null
    && task.governance == null
    && Array.isArray(task.artifactRefs)
    && task.artifactRefs.length === 0;
}

export function isExactWaitingMaturityMissionRetry(task: any): boolean {
  const batchId = String(task?.input?.context?.productMaturityBatchId || '');
  return task?.taskType === 'army.cross-agent-mission'
    && task.assigneeAgentId === 'ajun'
    && task.status === 'waiting_test'
    && task.currentStage === 'mission_waiting_test'
    && task.attempt === 1
    && /^maturity-[0-9a-f-]{36}$/i.test(batchId)
    && task.idempotencyKey === `product-maturity-validation:${batchId}`
    && task.source?.eventRef === batchId
    && task.error == null
    && task.governance == null
    && task.execution?.executor === 'ajun'
    && task.execution?.mode === 'cross_agent_mission_plan'
    && task.execution?.outcome === 'subtasks_ready'
    && !task.execution?.owner
    && sameKeys(task.execution, ['executor', 'finishedAt', 'mode', 'outcome', 'startedAt'])
    && knownZeroUsage(task.usage);
}

export function isExactQueuedMaturityMissionRetry(task: any): boolean {
  return exactMaturityMissionIdentity(task)
    && task.status === 'queued'
    && task.currentStage === 'queued_for_execution'
    && task.attempt === 2
    && task.execution == null
    && task.error == null
    && task.governance == null
    && hasRetryableMissionPlan(task)
    && knownZeroUsage(task.usage);
}

export function isExactRunningMaturityMissionRetry(task: any): boolean {
  if (!exactMaturityMissionIdentity(task)
    || task.status !== 'running'
    || task.attempt !== 2
    || task.error != null
    || task.governance != null
    || !hasRetryableMissionPlan(task)
    || !knownZeroUsage(task.usage)) return false;
  if (task.currentStage === 'starting') {
    return task.execution?.executor === 'ajun'
      && typeof task.execution?.startedAt === 'string'
      && sameKeys(task.execution, ['executor', 'startedAt']);
  }
  return task.currentStage === 'mission_planned'
    && task.execution?.executor === 'ajun'
    && task.execution?.mode === 'cross_agent_mission_plan'
    && task.execution?.outcome === 'subtasks_ready'
    && !task.execution?.owner
    && sameKeys(task.execution, ['executor', 'finishedAt', 'mode', 'outcome', 'startedAt']);
}

export function isExactPlannedMaturityMissionRetry(task: any): boolean {
  return isExactRunningMaturityMissionRetry(task) && task.currentStage === 'mission_planned';
}

export function isExactSucceededMaturityMissionRetry(task: any): boolean {
  const summaries = task?.artifactRefs?.filter((item: any) => item?.type === 'cross_agent_mission_summary') || [];
  return exactMaturityMissionIdentity(task)
    && task.status === 'succeeded'
    && task.currentStage === 'mission_delivered'
    && task.attempt === 2
    && task.error == null
    && task.governance == null
    && knownZeroUsage(task.usage)
    && task.execution?.executor === 'ajun'
    && task.execution?.mode === 'cross_agent_mission_plan'
    && task.execution?.outcome === 'subtasks_ready'
    && !task.execution?.owner
    && sameKeys(task.execution, ['executor', 'finishedAt', 'mode', 'outcome', 'startedAt'])
    && summaries.length === 1
    && summaries[0]?.data?.completed === true;
}

export function knownZeroUsage(usage: any): boolean {
  return usage?.model?.status === 'reported'
    && typeof usage.model.apiCalls === 'number'
    && Number.isFinite(usage.model.apiCalls)
    && usage.model.apiCalls === 0
    && usage?.cost?.status === 'reported'
    && typeof usage.cost.amount === 'number'
    && Number.isFinite(usage.cost.amount)
    && usage.cost.amount === 0
    && String(usage.cost.currency || '').toUpperCase() === 'USD';
}

function sameKeys(value: any, expected: readonly string[]) {
  return value && typeof value === 'object'
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactMaturityMissionIdentity(task: any) {
  const batchId = String(task?.input?.context?.productMaturityBatchId || '');
  return task?.taskType === 'army.cross-agent-mission'
    && task.assigneeAgentId === 'ajun'
    && /^maturity-[0-9a-f-]{36}$/i.test(batchId)
    && task.idempotencyKey === `product-maturity-validation:${batchId}`
    && task.source?.eventRef === batchId;
}

function hasRetryableMissionPlan(task: any) {
  const plans = task?.artifactRefs?.filter((item: any) => item?.type === 'cross_agent_mission_plan') || [];
  const summaries = task?.artifactRefs?.filter((item: any) => item?.type === 'cross_agent_mission_summary') || [];
  return plans.length === 1
    && summaries.length <= 1
    && (summaries.length === 0 || summaries[0]?.data?.completed === false);
}
