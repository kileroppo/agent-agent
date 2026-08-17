import type { WorkflowStatus } from './workflow/contracts.ts';
import type { TaskStatus } from './task-lifecycle.ts';

export type PaperclipIssueStatus = 'backlog' | 'blocked' | 'done';
export type TaskOutcome =
  | WorkflowStatus
  | 'delivery_quality_review_pending'
  | 'delivery_quality_review_start_failed'
  | 'delivery_quality_passed'
  | 'delivery_quality_stopped';

export type TaskStatusPolicy = Readonly<{
  status: TaskStatus;
  label: string;
  terminal: boolean;
  blocked: boolean;
  notificationTerminal: boolean;
  executionClosed: boolean;
  taskCardTerminal: boolean;
  attentionPriority: number;
  paperclipIssueStatus: PaperclipIssueStatus;
  paperclipCompletionEligible: boolean;
}>;

/** Runtime compatibility boundary for persisted statuses newer than this runtime. */
export type UnknownTaskStatusPolicy = Readonly<{
  status: string;
  label: string;
  terminal: false;
  blocked: false;
  notificationTerminal: false;
  executionClosed: false;
  taskCardTerminal: false;
  attentionPriority: number;
  paperclipIssueStatus: PaperclipIssueStatus;
  paperclipCompletionEligible: false;
}>;

export type WorkflowStepOutcome = Readonly<{
  status: WorkflowStatus;
  required?: boolean;
  stepId?: unknown;
  failureCode?: unknown;
}>;

export type DeliveryProjection = readonly [TaskStatus | null, WorkflowStatus, TaskOutcome | null];

export type TaskOutcomeProjection = Readonly<{
  outcome: string;
  taskStatus: TaskStatus | null;
  executionOutcome: TaskOutcome | null;
  workflowStatus: WorkflowStatus;
  ownerAction: string | null;
  ownerActionable: boolean;
}>;

export const ACCEPTANCE_OWNER_ACTION = '验收已经生成的业务产物';
export const BLOCKED_TASK_STATUSES = ['needs_input', 'paused', 'waiting_approval', 'waiting_test', 'failed', 'cancelled', 'expired'] as const satisfies readonly TaskStatus[];
export const NOTIFICATION_TERMINAL_TASK_STATUSES = ['needs_input', 'paused'] as const satisfies readonly TaskStatus[];
export const EXECUTION_CLOSED_TASK_STATUSES = ['succeeded', 'failed', 'cancelled', 'waiting_test'] as const satisfies readonly TaskStatus[];
export const PAPERCLIP_COMPLETION_TASK_STATUSES = ['succeeded', 'failed', 'waiting_test'] as const satisfies readonly TaskStatus[];
export const TASK_CARD_TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[];
export const TERMINAL_FAILURE_TASK_STATUSES = ['failed', 'cancelled', 'expired'] as const satisfies readonly TaskStatus[];
export const WORKFLOW_OUTCOME_STATUSES: readonly WorkflowStatus[] = [
  'received', 'planning', 'running', 'recovering', 'waiting_user', 'waiting_validation',
  'waiting_acceptance', 'partial', 'succeeded', 'failed', 'cancelled',
];

export const DELIVERY_OUTCOME_PROJECTIONS = Object.freeze({
  delivery_quality_review_pending:['running', 'running', 'delivery_quality_review_pending'],
  delivery_quality_review_start_failed:['waiting_test', 'waiting_validation', 'delivery_quality_review_start_failed'],
  delivery_quality_passed:['succeeded', 'waiting_acceptance', 'succeeded'],
  delivery_quality_stopped:['waiting_test', 'waiting_validation', 'delivery_quality_stopped'],
} satisfies Readonly<Record<Extract<TaskOutcome, `delivery_${string}`>, DeliveryProjection>>);

export function deliveryProjectionForOutcome(outcome: string): DeliveryProjection | null {
  return Object.hasOwn(DELIVERY_OUTCOME_PROJECTIONS, outcome)
    ? DELIVERY_OUTCOME_PROJECTIONS[outcome as keyof typeof DELIVERY_OUTCOME_PROJECTIONS]
    : null;
}

export function taskLifecycleEventForPolicy(
  status: unknown,
  policy: Pick<TaskStatusPolicy, 'blocked'>,
): Readonly<{
  eventType: 'workflow_completed' | 'workflow_blocked' | 'workflow_state_changed';
  retentionClass: 'audit' | 'transient';
}> {
  const completed = status === 'succeeded';
  return Object.freeze({
    eventType: completed ? 'workflow_completed' : policy.blocked ? 'workflow_blocked' : 'workflow_state_changed',
    retentionClass: completed || policy.blocked ? 'audit' : 'transient',
  });
}

export const STATUS_DETAILS = Object.freeze({
  received:{ label:'已收到', attentionPriority:8, paperclipIssueStatus:'backlog' },
  needs_input:{ label:'等待补充信息', attentionPriority:1, paperclipIssueStatus:'blocked' },
  queued:{ label:'排队中', attentionPriority:7, paperclipIssueStatus:'backlog' },
  running:{ label:'处理中', attentionPriority:6, paperclipIssueStatus:'backlog' },
  waiting_worker:{ label:'等待 Mac工作间上线', attentionPriority:8, paperclipIssueStatus:'backlog' },
  pausing:{ label:'正在暂停', attentionPriority:4, paperclipIssueStatus:'backlog' },
  paused:{ label:'已暂停', attentionPriority:5, paperclipIssueStatus:'blocked' },
  waiting_approval:{ label:'等待批准', attentionPriority:0, paperclipIssueStatus:'blocked' },
  waiting_test:{ label:'等待验证', attentionPriority:3, paperclipIssueStatus:'blocked' },
  succeeded:{ label:'已完成', attentionPriority:8, paperclipIssueStatus:'done' },
  failed:{ label:'失败', attentionPriority:2, paperclipIssueStatus:'blocked' },
  cancelled:{ label:'已取消', attentionPriority:8, paperclipIssueStatus:'blocked' },
  expired:{ label:'已过期', attentionPriority:8, paperclipIssueStatus:'blocked' },
} satisfies Readonly<Record<TaskStatus, Readonly<{
  label: string;
  attentionPriority: number;
  paperclipIssueStatus: PaperclipIssueStatus;
}>>>);
