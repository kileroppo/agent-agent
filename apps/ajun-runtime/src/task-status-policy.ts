import { isKnownTaskStatus, TASK_STATUSES, TERMINAL_TASK_STATUSES, type TaskStatus } from './task-lifecycle.ts';
import type { WorkflowStatus } from './workflow/contracts.ts';
import {
  ACCEPTANCE_OWNER_ACTION,
  BLOCKED_TASK_STATUSES,
  deliveryProjectionForOutcome,
  EXECUTION_CLOSED_TASK_STATUSES,
  NOTIFICATION_TERMINAL_TASK_STATUSES,
  PAPERCLIP_COMPLETION_TASK_STATUSES,
  STATUS_DETAILS,
  TASK_CARD_TERMINAL_TASK_STATUSES,
  WORKFLOW_OUTCOME_STATUSES,
  type TaskStatusPolicy,
  type TaskOutcomeProjection,
  taskLifecycleEventForPolicy,
  type WorkflowStepOutcome,
} from './task-status-policy-contracts.ts';

const TERMINAL_STATUS_SET = new Set<TaskStatus>(TERMINAL_TASK_STATUSES);
const BLOCKED_STATUS_SET = new Set<TaskStatus>(BLOCKED_TASK_STATUSES);
const NOTIFICATION_TERMINAL_STATUS_SET = new Set<TaskStatus>([
  ...TERMINAL_TASK_STATUSES,
  ...NOTIFICATION_TERMINAL_TASK_STATUSES,
]);
const EXECUTION_CLOSED_STATUS_SET = new Set<TaskStatus>(EXECUTION_CLOSED_TASK_STATUSES);
export { PAPERCLIP_COMPLETION_TASK_STATUSES } from './task-status-policy-contracts.ts';
const PAPERCLIP_COMPLETION_STATUS_SET = new Set<TaskStatus>(PAPERCLIP_COMPLETION_TASK_STATUSES);
const TASK_CARD_TERMINAL_STATUS_SET = new Set<TaskStatus>(TASK_CARD_TERMINAL_TASK_STATUSES);
const WORKFLOW_OUTCOME_STATUS_SET = new Set<WorkflowStatus>(WORKFLOW_OUTCOME_STATUSES);

export const TASK_BLOCKED_STATUSES: readonly TaskStatus[] = Object.freeze(
  TASK_STATUSES.filter((status) => BLOCKED_STATUS_SET.has(status)),
);

export const TASK_STATUS_POLICIES: Readonly<Record<TaskStatus, TaskStatusPolicy>> = Object.freeze(Object.fromEntries(
  TASK_STATUSES.map((status) => {
    const detail = STATUS_DETAILS[status];
    if (!detail) throw new Error(`任务状态策略缺少状态：${status}`);
    return [status, Object.freeze({
      status,
      label:detail.label,
      terminal:TERMINAL_STATUS_SET.has(status),
      blocked:BLOCKED_STATUS_SET.has(status),
      notificationTerminal:NOTIFICATION_TERMINAL_STATUS_SET.has(status),
      executionClosed:EXECUTION_CLOSED_STATUS_SET.has(status),
      taskCardTerminal:TASK_CARD_TERMINAL_STATUS_SET.has(status),
      attentionPriority:detail.attentionPriority,
      paperclipIssueStatus:detail.paperclipIssueStatus,
      paperclipCompletionEligible:PAPERCLIP_COMPLETION_STATUS_SET.has(status),
    })];
  }),
)) as Readonly<Record<TaskStatus, TaskStatusPolicy>>;

export function taskStatusPolicy(status: unknown): TaskStatusPolicy {
  const value = String(status || '').trim();
  return (isKnownTaskStatus(value) ? TASK_STATUS_POLICIES[value] : null) || Object.freeze({
    status:value || 'unknown',
    label:value || '未知',
    terminal:false,
    blocked:false,
    notificationTerminal:false,
    executionClosed:false,
    taskCardTerminal:false,
    attentionPriority:8,
    paperclipIssueStatus:'backlog',
    paperclipCompletionEligible:false,
  });
}

export function taskOutcomePolicy(
  outcome: unknown,
  { hasUsableArtifact = false }: Readonly<{ hasUsableArtifact?: boolean }> = {},
): TaskOutcomeProjection {
  const value = String(outcome || '').trim();
  const workflowOutcome = WORKFLOW_OUTCOME_STATUS_SET.has(value as WorkflowStatus)
    ? value as WorkflowStatus
    : 'running';
  const projection = deliveryProjectionForOutcome(value) || [null, workflowOutcome, null] as const;
  const workflowStatus = value === 'delivery_quality_stopped' && hasUsableArtifact ? 'partial' : projection[1];
  const ownerActionable = workflowStatus === 'waiting_acceptance';
  return Object.freeze({
    outcome:value || 'running',
    taskStatus:projection[0],
    executionOutcome:projection[2],
    workflowStatus,
    ownerAction:ownerActionable ? ACCEPTANCE_OWNER_ACTION : null,
    ownerActionable,
  });
}

export function workflowStatusForTaskOutcome({
  taskStatus,
  verified = false,
  partial = false,
  requiresAcceptance = false,
  humanAccepted = false,
  recoveryPending = false,
}: Readonly<{
  taskStatus?: unknown;
  verified?: boolean;
  partial?: boolean;
  requiresAcceptance?: boolean;
  humanAccepted?: boolean;
  recoveryPending?: boolean;
}> = {}): WorkflowStatus {
  const currentTaskStatus = isKnownTaskStatus(taskStatus) ? taskStatus : null;
  if (verified && requiresAcceptance && !humanAccepted) return 'waiting_acceptance';
  if (verified) return partial ? 'partial' : 'succeeded';
  if (currentTaskStatus === 'needs_input' || currentTaskStatus === 'waiting_approval') return 'waiting_user';
  if (recoveryPending) return 'recovering';
  if (currentTaskStatus === null) return 'running';
  switch (currentTaskStatus) {
    case 'failed': case 'expired': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'waiting_test': case 'succeeded': return 'waiting_validation';
    case 'received': return 'received';
    case 'queued': return 'planning';
    case 'running': case 'waiting_worker': case 'pausing': case 'paused': return 'running';
    default: return assertNever(currentTaskStatus);
  }
}

export function workflowStatusForStepOutcomes(steps: readonly WorkflowStepOutcome[], {
  requiredStepsComplete = false,
  humanAcceptanceRequired = false,
  humanAccepted = false,
}: Readonly<{
  requiredStepsComplete?: boolean;
  humanAcceptanceRequired?: boolean;
  humanAccepted?: boolean;
}> = {}): WorkflowStatus {
  const has = (status: string, required = false) => steps.some((step) => step.status === status && (!required || step.required));
  if (has('recovering')) return 'recovering';
  if (has('waiting_user')) return 'waiting_user';
  if (has('failed', true)) return 'failed';
  if (has('cancelled', true)) return 'cancelled';
  if (!requiredStepsComplete) {
    if (has('running')) return 'running';
    return has('planning') ? 'planning' : 'waiting_validation';
  }
  if (has('partial')) return 'partial';
  return humanAcceptanceRequired && !humanAccepted ? 'waiting_acceptance' : 'succeeded';
}

export function ownerActionForWorkflowOutcome(steps: readonly WorkflowStepOutcome[], status: unknown): string | null {
  const blocked = steps.find((step) => step.status === 'waiting_user');
  if (blocked) {
    return blocked.failureCode
      ? `处理步骤 ${blocked.stepId} 的 ${blocked.failureCode}`
      : `补充步骤 ${blocked.stepId} 所需信息`;
  }
  return taskOutcomePolicy(status).ownerAction;
}

export const isTaskTerminalStatus = (status: unknown) => taskStatusPolicy(status).terminal;
export const isTaskBlockedStatus = (status: unknown) => taskStatusPolicy(status).blocked;
export const isTaskNotificationTerminalStatus = (status: unknown) => taskStatusPolicy(status).notificationTerminal;
export const isTaskExecutionClosedStatus = (status: unknown) => taskStatusPolicy(status).executionClosed;
export const isTaskCardTerminalStatus = (status: unknown) => taskStatusPolicy(status).taskCardTerminal;

export function taskStatusLabel(status: unknown): string {
  if (status === 'planned') return '待开始';
  return taskStatusPolicy(status).label;
}

export const taskStatusPriority = (status: unknown) => taskStatusPolicy(status).attentionPriority;
export const paperclipIssueStatusForTaskStatus = (status: unknown) => taskStatusPolicy(status).paperclipIssueStatus;
export const isPaperclipCompletionTaskStatus = (status: unknown) => taskStatusPolicy(status).paperclipCompletionEligible;

export const taskLifecycleEventPolicy = (status: unknown) => taskLifecycleEventForPolicy(status, taskStatusPolicy(status));

function assertNever(value: never): never {
  throw new Error(`未处理的任务状态：${value}`);
}
