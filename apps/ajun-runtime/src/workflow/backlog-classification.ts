export type BacklogClassification =
  | 'current'
  | 'superseded'
  | 'expected_acceptance_failure'
  | 'intentionally_disabled'
  | 'needs_human'
  | 'archived_cancelled'
  | 'needs_reverification'
  | 'unresolved_failure'
  | 'unresolved'
  | 'completed';

export function classifyTaskBacklog(task: any, allTasks: readonly any[] = []): BacklogClassification {
  if (task?.status === 'succeeded') return 'completed';
  if (isIntentionallyDisabled(task)) return 'intentionally_disabled';
  if (isExpectedAcceptanceFailure(task)) return 'expected_acceptance_failure';
  if (isSuperseded(task, allTasks)) return 'superseded';
  if (task?.status === 'needs_input' || task?.status === 'waiting_approval') return 'needs_human';
  if (['running', 'queued', 'received', 'waiting_worker', 'pausing', 'paused'].includes(task?.status)) return 'current';
  if (task?.status === 'cancelled') return 'archived_cancelled';
  if (task?.status === 'waiting_test') return 'needs_reverification';
  if (task?.status === 'failed') return 'unresolved_failure';
  return 'unresolved';
}

export function summarizeBacklog(tasks: readonly any[]): Readonly<{
  counts: Readonly<Record<BacklogClassification, number>>;
  reviewBacklog: number;
  verificationBacklog: number;
  unresolvedFailures: number;
  historicalArchived: number;
  ownerActionable: number;
}> {
  const counts: Record<BacklogClassification, number> = {
    current:0,
    superseded:0,
    expected_acceptance_failure:0,
    intentionally_disabled:0,
    needs_human:0,
    archived_cancelled:0,
    needs_reverification:0,
    unresolved_failure:0,
    unresolved:0,
    completed:0,
  };
  for (const task of tasks || []) counts[classifyTaskBacklog(task, tasks)] += 1;
  return Object.freeze({
    counts:Object.freeze(counts),
    reviewBacklog:counts.needs_reverification + counts.unresolved_failure + counts.unresolved,
    verificationBacklog:counts.needs_reverification,
    unresolvedFailures:counts.unresolved_failure + counts.unresolved,
    historicalArchived:counts.archived_cancelled + counts.superseded + counts.expected_acceptance_failure,
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
  return ['acceptance', 'test', 'fixture'].some((marker) => channel.includes(marker) || key.includes(marker));
}

function isSuperseded(task: any, allTasks: readonly any[]): boolean {
  if (task?.status === 'cancelled' && task?.recovery?.supersededByTaskId) return true;
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
