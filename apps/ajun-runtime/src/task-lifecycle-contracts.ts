export const TASK_STATUSES = [
  'received',
  'needs_input',
  'queued',
  'running',
  'waiting_worker',
  'pausing',
  'paused',
  'waiting_approval',
  'waiting_test',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export const TERMINAL_TASK_STATUSES = [
  'waiting_test',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly TaskStatus[];

export type TerminalTaskStatus = typeof TERMINAL_TASK_STATUSES[number];
export type RetryEntryTaskStatus = 'received' | 'queued';
export type InitialTaskStatus = 'received' | 'needs_input' | 'queued' | 'running' | 'waiting_worker';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';

export type UnknownRecord = Record<string, unknown>;

export type TaskRecord = UnknownRecord & Readonly<{
  taskId: string;
  status: TaskStatus;
  attempt: number;
}>;

export type TaskPatch = UnknownRecord & Readonly<{ status?: unknown; attempt?: unknown }>;

export type ApprovalRecord = UnknownRecord & Readonly<{
  approvalId: string;
  taskId: string;
  status: ApprovalStatus;
}>;

export type ApprovalPatch = UnknownRecord & Readonly<{ status?: unknown }>;

export type TaskLifecycleErrorCode =
  | 'task_lifecycle_invalid_task'
  | 'task_lifecycle_invalid_patch'
  | 'task_initial_status_invalid'
  | 'task_initial_attempt_invalid'
  | 'task_approval_invalid'
  | 'task_approval_transition_invalid'
  | 'task_approval_decision_required'
  | 'task_approval_reference_required'
  | 'task_approval_decision_mismatch'
  | 'worker_lease_invalid'
  | 'worker_lease_mismatch'
  | 'worker_lease_expired'
  | 'worker_task_not_claimable'
  | 'task_status_unknown'
  | 'task_status_transition_invalid'
  | 'task_terminal_rollback_invalid'
  | 'task_terminal_retry_attempt_required'
  | 'task_terminal_retry_attempt_invalid'
  | 'task_idempotency_conflict';

export const TASK_LIFECYCLE_ERROR_CODES = Object.freeze({
  INVALID_TASK: 'task_lifecycle_invalid_task',
  INVALID_PATCH: 'task_lifecycle_invalid_patch',
  INVALID_INITIAL_STATUS: 'task_initial_status_invalid',
  INVALID_INITIAL_ATTEMPT: 'task_initial_attempt_invalid',
  APPROVAL_INVALID: 'task_approval_invalid',
  APPROVAL_TRANSITION_INVALID: 'task_approval_transition_invalid',
  APPROVAL_DECISION_REQUIRED: 'task_approval_decision_required',
  APPROVAL_REFERENCE_REQUIRED: 'task_approval_reference_required',
  APPROVAL_DECISION_MISMATCH: 'task_approval_decision_mismatch',
  WORKER_LEASE_INVALID: 'worker_lease_invalid',
  WORKER_LEASE_MISMATCH: 'worker_lease_mismatch',
  WORKER_LEASE_EXPIRED: 'worker_lease_expired',
  WORKER_TASK_NOT_CLAIMABLE: 'worker_task_not_claimable',
  UNKNOWN_STATUS: 'task_status_unknown',
  INVALID_TRANSITION: 'task_status_transition_invalid',
  INVALID_TERMINAL_ROLLBACK: 'task_terminal_rollback_invalid',
  RETRY_ATTEMPT_REQUIRED: 'task_terminal_retry_attempt_required',
  RETRY_ATTEMPT_INVALID: 'task_terminal_retry_attempt_invalid',
  IDEMPOTENCY_CONFLICT: 'task_idempotency_conflict',
} as const satisfies Record<string, TaskLifecycleErrorCode>);

export type TaskTransitionMap = Readonly<Record<TaskStatus, readonly TaskStatus[]>>;
