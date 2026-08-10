export type BacklogClassification =
  | 'current'
  | 'superseded'
  | 'validated_by_later_evidence'
  | 'expected_acceptance_failure'
  | 'expected_boundary_rejection'
  | 'intentionally_disabled'
  | 'needs_human'
  | 'archived_cancelled'
  | 'needs_reverification'
  | 'unresolved_failure'
  | 'unresolved'
  | 'completed';

export type BacklogEvidenceContext = Readonly<{
  proposals?: readonly any[];
  taskTypeDelegates?: Readonly<Record<string, string>>;
}>;

export function classifyTaskBacklog(
  task: any,
  allTasks: readonly any[] = [],
  context: BacklogEvidenceContext = {},
): BacklogClassification {
  if (task?.status === 'succeeded') return 'completed';
  if (isIntentionallyDisabled(task)) return 'intentionally_disabled';
  if (isExpectedAcceptanceFailure(task)) return 'expected_acceptance_failure';
  if (isExpectedBoundaryRejection(task, allTasks)) return 'expected_boundary_rejection';
  if (isSuperseded(task, allTasks)) return 'superseded';
  if (isValidatedByLaterEvidence(task, allTasks, context)) return 'validated_by_later_evidence';
  if (task?.status === 'needs_input' || task?.status === 'waiting_approval') return 'needs_human';
  if (['running', 'queued', 'received', 'waiting_worker', 'pausing', 'paused'].includes(task?.status)) return 'current';
  if (task?.status === 'cancelled') return 'archived_cancelled';
  if (task?.status === 'waiting_test') return 'needs_reverification';
  if (task?.status === 'failed') return 'unresolved_failure';
  return 'unresolved';
}

export function summarizeBacklog(tasks: readonly any[], context: BacklogEvidenceContext = {}): Readonly<{
  counts: Readonly<Record<BacklogClassification, number>>;
  reviewBacklog: number;
  verificationBacklog: number;
  unresolvedFailures: number;
  historicalArchived: number;
  validatedByLaterEvidence: number;
  ownerActionable: number;
}> {
  const counts: Record<BacklogClassification, number> = {
    current:0,
    superseded:0,
    validated_by_later_evidence:0,
    expected_acceptance_failure:0,
    expected_boundary_rejection:0,
    intentionally_disabled:0,
    needs_human:0,
    archived_cancelled:0,
    needs_reverification:0,
    unresolved_failure:0,
    unresolved:0,
    completed:0,
  };
  for (const task of tasks || []) counts[classifyTaskBacklog(task, tasks, context)] += 1;
  return Object.freeze({
    counts:Object.freeze(counts),
    reviewBacklog:counts.needs_reverification + counts.unresolved_failure + counts.unresolved,
    verificationBacklog:counts.needs_reverification,
    unresolvedFailures:counts.unresolved_failure + counts.unresolved,
    historicalArchived:counts.archived_cancelled
      + counts.superseded
      + counts.expected_acceptance_failure
      + counts.expected_boundary_rejection,
    validatedByLaterEvidence:counts.validated_by_later_evidence,
    ownerActionable:counts.needs_human,
  });
}

function isIntentionallyDisabled(task: any): boolean {
  const type = String(task?.taskType || '');
  const code = String(task?.error?.code || '');
  return type.startsWith('content.campaign-')
    || type.startsWith('publisher.')
    || ['publisher_disabled', 'campaign_not_approved', 'cron_disabled', 'external_execution_not_enabled'].includes(code);
}

function isExpectedAcceptanceFailure(task: any): boolean {
  const channel = String(task?.source?.channel || '');
  const key = String(task?.idempotencyKey || '');
  const code = String(task?.error?.code || '');
  const title = String(task?.input?.title || '');
  return ['acceptance', 'test', 'fixture'].some((marker) => channel.includes(marker) || key.includes(marker))
    || code === 'controlled_public_report_failure'
    || title.includes('真实StepFun多模态付费探针');
}

function isExpectedBoundaryRejection(task: any, allTasks: readonly any[]): boolean {
  if (task?.status !== 'failed') return false;
  const reportedSafeRefusal = task?.error?.code === 'paperclip_hermes_reported_failure'
    && task?.error?.retryable === false
    && hasVerifiedArtifact(task);
  if (!reportedSafeRefusal) return false;
  if (task?.taskType === 'content.platform-draft') {
    const sourceTaskIds = task?.input?.context?.sourceTaskIds || task?.input?.sourceTaskIds;
    return !task?.parentTaskId && (!Array.isArray(sourceTaskIds) || sourceTaskIds.length === 0);
  }
  if (!['operations.failure-recovery', 'operations.technical-repair'].includes(task?.taskType)) return false;
  const failedTaskId = task?.input?.context?.failedTaskId || task?.parentTaskId;
  const failedTask = allTasks.find((candidate) => candidate?.taskId === failedTaskId);
  const failureCategory = task?.input?.context?.failure?.category || failedTask?.error?.category;
  return failureCategory === 'needs_input';
}

function isSuperseded(task: any, allTasks: readonly any[]): boolean {
  if (task?.status === 'cancelled' && task?.recovery?.supersededByTaskId) return true;
  if (recoveryTargetWasSuperseded(task, allTasks)) return true;
  const sourceUrl = String(task?.input?.sourceUrl || '').trim();
  const taskTime = Date.parse(task?.updatedAt || task?.createdAt || '') || 0;
  if (sourceUrl && allTasks.some((candidate) => candidate?.taskId !== task?.taskId
    && candidate?.status === 'succeeded'
    && candidate?.taskType === task?.taskType
    && String(candidate?.input?.sourceUrl || '').trim() === sourceUrl
    && (Date.parse(candidate?.updatedAt || candidate?.createdAt || '') || 0) > taskTime)) return true;
  const createdAt = Date.parse(task?.createdAt || '');
  if (!Number.isFinite(createdAt)) return false;
  return allTasks.some((candidate) => candidate?.taskId !== task?.taskId
    && candidate?.parentTaskId
    && candidate.parentTaskId === task?.parentTaskId
    && candidate?.taskType === task?.taskType
    && candidate?.assigneeAgentId === task?.assigneeAgentId
    && Date.parse(candidate?.createdAt || '') > createdAt
    && candidate?.status === 'succeeded');
}

function isValidatedByLaterEvidence(
  task: any,
  allTasks: readonly any[],
  context: BacklogEvidenceContext,
): boolean {
  if (!['waiting_test', 'failed'].includes(task?.status)) return false;
  const taskTime = Date.parse(task?.updatedAt || task?.createdAt || '') || 0;
  const delegatedTaskType = context.taskTypeDelegates?.[String(task?.taskType || '')];
  const openTaskTypes = Object.entries(context.taskTypeDelegates || {})
    .filter(([, delegate]) => delegate === task?.taskType)
    .map(([openTaskType]) => openTaskType);
  const acceptedTaskTypes = new Set([task?.taskType, delegatedTaskType, ...openTaskTypes].filter(Boolean));
  if (allTasks.some((candidate) => candidate?.taskId !== task?.taskId
    && candidate?.status === 'succeeded'
    && acceptedTaskTypes.has(candidate?.taskType)
    && candidate?.assigneeAgentId === task?.assigneeAgentId
    && (candidate?.taskType === task?.taskType
      || candidate?.taskType === delegatedTaskType
      || sameDelegatedBusinessIntent(task, candidate))
    && (Date.parse(candidate?.updatedAt || candidate?.createdAt || '') || 0) > taskTime
    && hasVerifiedArtifact(candidate))) return true;
  if (crossAgentMissionHasLaterDelivery(task, allTasks, taskTime)) return true;
  return activeProposalValidatesLegacyTask(task, context.proposals || [], taskTime);
}

function recoveryTargetWasSuperseded(task: any, allTasks: readonly any[]): boolean {
  if (!['operations.failure-recovery', 'operations.technical-repair'].includes(task?.taskType)) return false;
  const failedTaskId = task?.input?.context?.failedTaskId || task?.parentTaskId;
  const failedTask = allTasks.find((candidate) => candidate?.taskId === failedTaskId);
  if (!failedTask) return false;
  const sourceUrl = String(failedTask?.input?.sourceUrl || task?.input?.context?.sourceUrl || '').trim();
  if (!sourceUrl) return false;
  const failedAt = Date.parse(failedTask?.updatedAt || failedTask?.createdAt || '') || 0;
  const recoveryStartedAt = Date.parse(task?.createdAt || '') || 0;
  if (!failedAt || !recoveryStartedAt) return false;
  return allTasks.some((candidate) => candidate?.taskId !== failedTaskId
    && candidate?.status === 'succeeded'
    && candidate?.taskType === failedTask?.taskType
    && candidate?.assigneeAgentId === failedTask?.assigneeAgentId
    && String(candidate?.input?.sourceUrl || '').trim() === sourceUrl
    && (Date.parse(candidate?.updatedAt || candidate?.createdAt || '') || 0) > Math.max(failedAt, recoveryStartedAt)
    && hasVerifiedArtifact(candidate));
}

function sameDelegatedBusinessIntent(task: any, candidate: any): boolean {
  if (candidate?.input?.context?.delegatedTaskType !== task?.taskType) return false;
  const originalSourceUrl = String(task?.input?.sourceUrl || '').trim();
  const candidateSourceUrl = String(candidate?.input?.sourceUrl || '').trim();
  if (originalSourceUrl && candidateSourceUrl) return originalSourceUrl === candidateSourceUrl;
  const originalIntent = normalizedLegacyIntent(task?.input?.title);
  const candidateIntent = normalizedLegacyIntent(candidate?.input?.title);
  return Boolean(originalIntent && originalIntent === candidateIntent);
}

function normalizedLegacyIntent(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\bv\d+\b/giu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function crossAgentMissionHasLaterDelivery(task: any, allTasks: readonly any[], taskTime: number): boolean {
  if (task?.taskType !== 'army.cross-agent-mission') return false;
  const plannedTaskTypes = new Set((task?.input?.context?.businessMissionItems || [])
    .map((item: any) => item?.taskType)
    .filter(Boolean));
  if (!plannedTaskTypes.size) return false;
  const verifiedChildren = allTasks.filter((candidate) => candidate?.parentTaskId === task?.taskId
    && candidate?.status === 'succeeded'
    && hasVerifiedArtifact(candidate));
  const verifiedChildIds = new Set(verifiedChildren.map((candidate) => candidate.taskId));
  if (!verifiedChildIds.size) return false;
  const deliveredTaskTypes = new Set(verifiedChildren.map((candidate) => candidate?.taskType).filter(Boolean));
  for (const candidate of allTasks) {
    if (candidate?.status !== 'succeeded' || !hasVerifiedArtifact(candidate)) continue;
    if ((Date.parse(candidate?.updatedAt || candidate?.createdAt || '') || 0) <= taskTime) continue;
    if (!plannedTaskTypes.has(candidate?.taskType)) continue;
    const sourceTaskIds = candidate?.input?.context?.sourceTaskIds || candidate?.input?.sourceTaskIds || [];
    if (Array.isArray(sourceTaskIds) && sourceTaskIds.some((taskId: string) => verifiedChildIds.has(taskId))) {
      deliveredTaskTypes.add(candidate.taskType);
    }
  }
  return [...plannedTaskTypes].every((taskType) => deliveredTaskTypes.has(taskType));
}

function activeProposalValidatesLegacyTask(task: any, proposals: readonly any[], taskTime: number): boolean {
  if (task?.taskType !== 'governance.agent-proposal') return false;
  const title = String(task?.input?.title || '').trim();
  return proposals.some((proposal) => {
    if (proposal?.status !== 'active') return false;
    const name = String(proposal?.candidateManifest?.name || proposal?.name || '').trim();
    return name && title.includes(name)
      && (Date.parse(proposal?.updatedAt || proposal?.createdAt || '') || 0) > taskTime;
  });
}

function hasVerifiedArtifact(task: any): boolean {
  return (task?.artifactRefs || []).some((artifact: any) => artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty === true);
}
