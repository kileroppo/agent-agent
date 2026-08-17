import type { WorkflowStatus, WorkflowStepEvaluation } from './workflow/contracts.ts';
import type { TaskStatus } from './task-lifecycle.ts';
import type { TaskOutcome, TaskStatusPolicy, UnknownTaskStatusPolicy } from './task-status-policy-contracts.ts';

export type TaskStatusProjection = TaskStatusPolicy | UnknownTaskStatusPolicy;

export const PAPERCLIP_COMPLETION_TASK_STATUSES: readonly TaskStatus[];
export const TASK_BLOCKED_STATUSES: readonly TaskStatus[];
export const TASK_STATUS_POLICIES: Readonly<Record<TaskStatus, TaskStatusPolicy>>;

export function taskStatusPolicy(status: TaskStatus): TaskStatusPolicy;
export function taskStatusPolicy(status: unknown): UnknownTaskStatusPolicy;
export function taskStatusLabel(status: unknown): string;
export const taskStatusPriority: (status: unknown) => number;
export const paperclipIssueStatusForTaskStatus: (status: unknown) => TaskStatusProjection['paperclipIssueStatus'];
export const isTaskTerminalStatus: (status: unknown) => boolean;
export const isTaskBlockedStatus: (status: unknown) => boolean;
export const isTaskNotificationTerminalStatus: (status: unknown) => boolean;
export const isTaskExecutionClosedStatus: (status: unknown) => boolean;
export const isTaskCardTerminalStatus: (status: unknown) => boolean;
export const isPaperclipCompletionTaskStatus: (status: unknown) => boolean;
export function taskLifecycleEventPolicy(status: unknown): Readonly<{
  eventType: 'workflow_completed' | 'workflow_blocked' | 'workflow_state_changed';
  retentionClass: 'audit' | 'transient';
}>;

export type TaskOutcomeProjection = Readonly<{
  outcome: string;
  taskStatus: TaskStatus | null;
  executionOutcome: TaskOutcome | null;
  workflowStatus: WorkflowStatus;
  ownerAction: string | null;
  ownerActionable: boolean;
}>;

export function taskOutcomePolicy(
  outcome: unknown,
  options?: { hasUsableArtifact?: boolean },
): TaskOutcomeProjection;

export function workflowStatusForTaskOutcome(input?: {
  taskStatus?: unknown;
  verified?: boolean;
  partial?: boolean;
  requiresAcceptance?: boolean;
  humanAccepted?: boolean;
  recoveryPending?: boolean;
}): WorkflowStatus;

export function workflowStatusForStepOutcomes(
  steps: readonly Pick<WorkflowStepEvaluation, 'status' | 'required'>[],
  state?: {
    requiredStepsComplete?: boolean;
    humanAcceptanceRequired?: boolean;
    humanAccepted?: boolean;
  },
): WorkflowStatus;

export function ownerActionForWorkflowOutcome(
  steps: readonly Pick<WorkflowStepEvaluation, 'stepId' | 'status' | 'failureCode'>[],
  status: WorkflowStatus,
): string | null;
