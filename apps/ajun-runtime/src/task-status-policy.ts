import { TASK_STATUSES, TERMINAL_TASK_STATUSES } from './task-lifecycle.ts';
import type { WorkflowStatus } from './workflow/contracts.ts';
import {
  ACCEPTANCE_OWNER_ACTION,
  BLOCKED_TASK_STATUSES,
  DELIVERY_OUTCOME_PROJECTIONS,
  EXECUTION_CLOSED_TASK_STATUSES,
  NOTIFICATION_TERMINAL_TASK_STATUSES,
  PAPERCLIP_COMPLETION_TASK_STATUSES,
  STATUS_DETAILS,
  TASK_CARD_TERMINAL_TASK_STATUSES,
  TERMINAL_FAILURE_TASK_STATUSES,
  WORKFLOW_OUTCOME_STATUSES,
  type TaskStatusPolicy,
  type WorkflowStepOutcome,
} from './task-status-policy-contracts.ts';

const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_TASK_STATUSES);
const BLOCKED_STATUS_SET = new Set<string>(BLOCKED_TASK_STATUSES);
const NOTIFICATION_TERMINAL_STATUS_SET = new Set<string>([
  ...TERMINAL_TASK_STATUSES,
  ...NOTIFICATION_TERMINAL_TASK_STATUSES,
]);
const EXECUTION_CLOSED_STATUS_SET = new Set<string>(EXECUTION_CLOSED_TASK_STATUSES);
export { PAPERCLIP_COMPLETION_TASK_STATUSES } from './task-status-policy-contracts.ts';
const PAPERCLIP_COMPLETION_STATUS_SET = new Set<string>(PAPERCLIP_COMPLETION_TASK_STATUSES);
const TASK_CARD_TERMINAL_STATUS_SET = new Set<string>(TASK_CARD_TERMINAL_TASK_STATUSES);
const TERMINAL_FAILURE_TASK_STATUS_SET = new Set<string>(TERMINAL_FAILURE_TASK_STATUSES);
const WORKFLOW_OUTCOME_STATUS_SET = new Set<WorkflowStatus>(WORKFLOW_OUTCOME_STATUSES);

export const TASK_BLOCKED_STATUSES: readonly string[] = Object.freeze(
  (TASK_STATUSES as readonly string[]).filter((status: string) => BLOCKED_STATUS_SET.has(status)),
);

export const TASK_STATUS_POLICIES: Readonly<Record<string, TaskStatusPolicy>> = Object.freeze(Object.fromEntries(
  (TASK_STATUSES as readonly string[]).map((status: string) => {
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
));

export function taskStatusPolicy(status: unknown): TaskStatusPolicy {
  const value = String(status || '').trim();
  return TASK_STATUS_POLICIES[value] || Object.freeze({
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
) {
  const value = String(outcome || '').trim();
  const workflowOutcome = WORKFLOW_OUTCOME_STATUS_SET.has(value as WorkflowStatus)
    ? value as WorkflowStatus
    : 'running';
  const projection = DELIVERY_OUTCOME_PROJECTIONS[value] || [null, workflowOutcome, null];
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
  const currentTaskStatus = String(taskStatus || '');
  if (verified && requiresAcceptance && !humanAccepted) return 'waiting_acceptance';
  if (verified) return partial ? 'partial' : 'succeeded';
  if (currentTaskStatus === 'needs_input' || currentTaskStatus === 'waiting_approval') return 'waiting_user';
  if (recoveryPending) return 'recovering';
  if (TERMINAL_FAILURE_TASK_STATUS_SET.has(currentTaskStatus)) return currentTaskStatus === 'cancelled' ? 'cancelled' : 'failed';
  if (currentTaskStatus === 'waiting_test' || currentTaskStatus === 'succeeded') return 'waiting_validation';
  if (currentTaskStatus === 'received') return 'received';
  return currentTaskStatus === 'queued' ? 'planning' : 'running';
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

export function taskLifecycleEventPolicy(status: unknown) {
  const policy = taskStatusPolicy(status);
  return Object.freeze({
    eventType:status === 'succeeded'
      ? 'workflow_completed'
      : policy.blocked
        ? 'workflow_blocked'
        : 'workflow_state_changed',
    retentionClass:status === 'succeeded' || policy.blocked ? 'audit' : 'transient',
  });
}
