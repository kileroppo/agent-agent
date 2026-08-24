import {
  TASK_LIFECYCLE_ERROR_CODES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type ApprovalRecord,
  type ApprovalStatus,
  type InitialTaskStatus,
  type TaskLifecycleErrorCode,
  type TaskPatch,
  type TaskRecord,
  type TaskStatus,
  type TaskTransitionMap,
  type UnknownRecord,
} from './task-lifecycle-contracts.ts';

export { TASK_LIFECYCLE_ERROR_CODES, TASK_STATUSES, TERMINAL_TASK_STATUSES } from './task-lifecycle-contracts.ts';
export type { ApprovalRecord, ApprovalStatus, InitialTaskStatus, TaskLifecycleErrorCode, TaskPatch, TaskRecord, TaskStatus, UnknownRecord } from './task-lifecycle-contracts.ts';

const STATUS_SET = new Set<TaskStatus>(TASK_STATUSES);
const TERMINAL_STATUS_SET = new Set<TaskStatus>(TERMINAL_TASK_STATUSES);
const RETRY_ENTRY_STATUS_SET = new Set<TaskStatus>(['received', 'queued']);
const APPROVAL_STATUS_SET = new Set<ApprovalStatus>(['pending', 'approved', 'rejected', 'expired', 'superseded']);
const APPROVAL_CONTINUE_STATUS_SET = new Set<ApprovalStatus>(['approved', 'superseded']);
const APPROVAL_STOP_STATUS_SET = new Set<ApprovalStatus>(['rejected', 'expired', 'superseded']);
const APPROVAL_STATUS_SET_FOR_PENDING = new Set<ApprovalStatus>(['pending']);
const INITIAL_STATUS_SET = new Set<InitialTaskStatus>(['received', 'needs_input', 'queued', 'running', 'waiting_worker']);

// Record forces a compile error whenever a new lifecycle status lacks an explicit path.
const TRANSITIONS: TaskTransitionMap = Object.freeze({
  received: ['needs_input', 'queued', 'cancelled'],
  needs_input: ['queued', 'expired', 'cancelled'],
  queued: ['needs_input', 'running', 'waiting_worker', 'waiting_approval', 'waiting_test', 'failed', 'cancelled'],
  running: ['needs_input', 'waiting_worker', 'waiting_approval', 'pausing', 'waiting_test', 'succeeded', 'failed', 'cancelled'],
  waiting_worker: ['queued', 'running', 'needs_input', 'waiting_approval', 'waiting_test', 'failed', 'cancelled'],
  pausing: ['running', 'paused', 'waiting_test', 'failed', 'cancelled'],
  paused: ['queued', 'running', 'waiting_approval', 'failed', 'cancelled'],
  waiting_approval: ['queued', 'running', 'needs_input', 'failed', 'cancelled', 'expired'],
  waiting_test: ['succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [], expired: [],
});

export class TaskLifecycleError extends Error {
  readonly code: TaskLifecycleErrorCode;
  readonly details: unknown;
  constructor(code: TaskLifecycleErrorCode, message: string, details: unknown = {}) {
    super(message); this.name = 'TaskLifecycleError'; this.code = code; this.details = details;
  }
}

export function isKnownTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && STATUS_SET.has(status as TaskStatus);
}

export function isTerminalTaskStatus(status: unknown): status is typeof TERMINAL_TASK_STATUSES[number] {
  return typeof status === 'string' && TERMINAL_STATUS_SET.has(status as TaskStatus);
}

export function initializeTaskRecord(input: unknown, options: { taskId?: unknown; now?: unknown } = {}): TaskRecord {
  if (!isRecord(input)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK, '新任务必须是一个对象。');
  const status = input.status ?? 'received';
  assertKnownStatus(status, 'initial');
  if (!isInitialTaskStatus(status)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_STATUS, `任务不能直接创建为“${status}”。`, { status });
  if (Object.hasOwn(input, 'attempt') && input.attempt !== 1) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_ATTEMPT, '新任务 attempt 必须为 1。', { attempt: input.attempt });
  const stableTaskId = text(options.taskId);
  const timestamp = text(options.now);
  if (!stableTaskId || !timestamp) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK, '新任务缺少系统生成的 taskId 或时间。');
  return { schemaVersion: 'agent.army/task/v1', priority: 'normal', ...input, taskId: stableTaskId, status, attempt: 1,
    artifactRefs: Array.isArray(input.artifactRefs) ? [...input.artifactRefs] : [], approvalRefs: Array.isArray(input.approvalRefs) ? [...input.approvalRefs] : [], createdAt: timestamp, updatedAt: timestamp };
}

export function assertTaskIdempotencyMatch(existing: unknown, candidate: unknown): void {
  const existingRecord = asRecord(existing);
  const candidateRecord = asRecord(candidate);
  const existingKey = text(existingRecord?.idempotencyKey);
  const candidateKey = text(candidateRecord?.idempotencyKey);
  if (!existingKey || existingKey !== candidateKey) return;
  const existingFingerprint = text(existingRecord?.idempotencyFingerprint);
  const candidateFingerprint = text(candidateRecord?.idempotencyFingerprint);
  if (!existingFingerprint || !candidateFingerprint || existingFingerprint === candidateFingerprint) return;
  throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.IDEMPOTENCY_CONFLICT, '同一幂等键不能绑定不同的任务内容。', { idempotencyKey: existingKey });
}

export function initializeApprovalRecord(input: unknown, options: { approvalId?: unknown; now?: unknown } = {}): ApprovalRecord {
  if (!isRecord(input)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批必须是一个对象。');
  if (Object.hasOwn(input, 'status') && input.status !== 'pending') throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '新审批只能创建为 pending。', { status: input.status });
  const stableApprovalId = text(options.approvalId);
  const taskId = text(input.taskId);
  const timestamp = text(options.now);
  if (!stableApprovalId || !taskId || !timestamp) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批缺少系统生成的 approvalId、taskId 或时间。');
  return { schemaVersion: 'agent.army/approval/v1', ...input, approvalId: stableApprovalId, taskId, status: 'pending', createdAt: timestamp };
}

export function applyApprovalPatch(approval: unknown, patch: unknown): ApprovalRecord {
  if (!isApprovalRecord(approval) || !isRecord(patch)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批或审批 patch 无效。');
  const nextStatus = Object.hasOwn(patch, 'status') ? patch.status : approval.status;
  if (!isApprovalStatus(nextStatus)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, `未知审批状态“${String(nextStatus)}”。`, { status: nextStatus });
  if (approval.status !== 'pending' && nextStatus !== approval.status) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_TRANSITION_INVALID, `审批不能从“${approval.status}”变为“${nextStatus}”。`, { fromStatus: approval.status, toStatus: nextStatus });
  if (approval.status === 'pending' && nextStatus !== 'pending') {
    const decisionBy = text(patch.decisionBy); const decisionReason = text(patch.decisionReason); const decidedAt = text(patch.decidedAt);
    if (!decisionBy || !decisionReason || !decidedAt || !Number.isFinite(Date.parse(decidedAt))) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_REQUIRED, '审批决定必须包含 decisionBy、decisionReason 和有效 decidedAt。', { toStatus: nextStatus });
  }
  return { ...approval, ...patch, status: nextStatus };
}

export function holdTaskForApproval(task: unknown, approval: unknown): TaskRecord {
  const stableTask = assertTaskRecord(task); const stableApproval = assertApprovalRecord(approval);
  assertApprovalForTask(stableTask, stableApproval, APPROVAL_STATUS_SET_FOR_PENDING);
  const approvalRefs = uniqueStrings([...array(stableTask.approvalRefs), stableApproval.approvalId]);
  const linked: TaskRecord = { ...stableTask, approvalRefs };
  return stableApproval.holdTask === false ? linked : applyTaskStatusPatch(linked, { status: 'waiting_approval', currentStage: 'approval_required' }, { approvals: [stableApproval] });
}

export function isWorkerTaskClaimable(task: unknown, { taskTypes, now = Date.now() }: { taskTypes?: unknown; now?: unknown } = {}): boolean {
  const record = asRecord(task); if (!record) return false;
  if (!new Set(uniqueStrings(taskTypes)).has(text(record.taskType))) return false;
  if (record.status === 'waiting_worker') return true;
  const execution = asRecord(record.execution); const worker = asRecord(execution?.worker); const expiresAt = Date.parse(text(worker?.leaseExpiresAt));
  return record.status === 'running' && execution?.mode === 'mac_worker' && Number.isFinite(expiresAt) && expiresAt <= Number(now);
}

export function claimTaskForWorker(task: unknown, options: { workerId?: unknown; leaseId?: unknown; leaseMs?: unknown; now?: unknown } = {}): TaskRecord {
  const stableTask = assertTaskRecord(task); const lease = normalizeWorkerLeaseInput(options);
  const execution = asRecord(stableTask.execution); const worker = asRecord(execution?.worker); const currentExpiry = Date.parse(text(worker?.leaseExpiresAt));
  const claimable = stableTask.status === 'waiting_worker' || (stableTask.status === 'running' && execution?.mode === 'mac_worker' && Number.isFinite(currentExpiry) && currentExpiry <= lease.now);
  if (!claimable) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_TASK_NOT_CLAIMABLE, '任务当前不能被 Mac 工作间领取。');
  const leasedAt = new Date(lease.now).toISOString();
  return applyTaskStatusPatch(stableTask, { status: 'running', currentStage: 'mac_worker_claimed', updatedAt: leasedAt, execution: { ...(execution || {}), executor: 'xiaod', mode: 'mac_worker', worker: { state: 'leased', workerId: lease.workerId, leaseId: lease.leaseId, leasedAt, lastHeartbeatAt: leasedAt, leaseExpiresAt: new Date(lease.now + lease.leaseMs).toISOString() } } });
}

export function applyWorkerTaskPatch(task: unknown, options: { workerId?: unknown; leaseId?: unknown; patch?: unknown; leaseMs?: unknown; now?: unknown; extendLease?: unknown } = {}): TaskRecord {
  const stableTask = assertTaskRecord(task); if (!isRecord(options.patch)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Worker 任务或 patch 无效。');
  const patch = options.patch; const stableWorkerId = text(options.workerId); const stableLeaseId = text(options.leaseId);
  const execution = asRecord(stableTask.execution); const lease = asRecord(execution?.worker);
  if (execution?.mode !== 'mac_worker' || !stableWorkerId || !stableLeaseId || lease?.workerId !== stableWorkerId || lease?.leaseId !== stableLeaseId) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_MISMATCH, 'Mac 工作间租约身份不匹配。');
  const timestamp = Number(options.now ?? Date.now()); const expiresAt = Date.parse(text(lease.leaseExpiresAt));
  if (!Number.isFinite(timestamp) || !Number.isFinite(expiresAt)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Mac 工作间租约时间无效。');
  if (expiresAt <= timestamp) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_EXPIRED, 'Mac 工作间租约已经过期。');
  const patchExecution = asRecord(patch.execution); const suppliedWorker = asRecord(patchExecution?.worker) || {};
  if ((Object.hasOwn(suppliedWorker, 'workerId') && suppliedWorker.workerId !== stableWorkerId) || (Object.hasOwn(suppliedWorker, 'leaseId') && suppliedWorker.leaseId !== stableLeaseId)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_MISMATCH, 'Worker patch 不能改写租约身份。');
  const normalizedLeaseMs = Number(options.leaseMs ?? 120000);
  if (options.extendLease === true && (!Number.isSafeInteger(normalizedLeaseMs) || normalizedLeaseMs <= 0)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Worker 续租时长无效。');
  const at = new Date(timestamp).toISOString();
  const worker: UnknownRecord = { ...lease, ...(options.extendLease === true ? { state: 'working', lastHeartbeatAt: at, leaseExpiresAt: new Date(timestamp + normalizedLeaseMs).toISOString() } : {}), ...suppliedWorker, workerId: stableWorkerId, leaseId: stableLeaseId };
  return applyTaskStatusPatch(stableTask, { ...patch, updatedAt: at, execution: { ...(execution || {}), ...(patchExecution || {}), mode: 'mac_worker', worker } });
}

export type TaskStatusPatchValidation = Readonly<{ fromStatus: TaskStatus; toStatus: TaskStatus; changed: boolean; retry: boolean }>;

export function validateTaskStatusPatch(task: unknown, patch: unknown, { approvals = [] }: { approvals?: unknown } = {}): TaskStatusPatchValidation {
  const stableTask = assertTaskRecord(task); if (!isRecord(patch)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_PATCH, '任务 patch 必须是一个对象。');
  const fromStatus = stableTask.status; const toStatus = Object.hasOwn(patch, 'status') ? patch.status : fromStatus; assertKnownStatus(toStatus, 'target');
  if (fromStatus !== toStatus && toStatus === 'waiting_approval') assertTaskApprovalDecision(stableTask, patch, approvals, APPROVAL_STATUS_SET_FOR_PENDING);
  else if (fromStatus === 'waiting_approval' && fromStatus !== toStatus) assertTaskApprovalDecision(stableTask, patch, approvals, toStatus === 'queued' || toStatus === 'running' ? APPROVAL_CONTINUE_STATUS_SET : APPROVAL_STOP_STATUS_SET);
  if (fromStatus === toStatus) return { fromStatus, toStatus, changed: false, retry: false };
  if (fromStatus === 'waiting_test' && ['succeeded', 'failed', 'cancelled'].includes(toStatus)) {
    return { fromStatus, toStatus, changed: true, retry: false };
  }
  if (isTerminalTaskStatus(fromStatus)) {
    if (!RETRY_ENTRY_STATUS_SET.has(toStatus)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TERMINAL_ROLLBACK, `终态“${fromStatus}”不能直接回退到“${toStatus}”。`, { fromStatus, toStatus });
    validateRetryAttempt(stableTask, patch, fromStatus, toStatus); return { fromStatus, toStatus, changed: true, retry: true };
  }
  if (!TRANSITIONS[fromStatus].includes(toStatus)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TRANSITION, `任务状态不能从“${fromStatus}”推进到“${toStatus}”。`, { fromStatus, toStatus });
  return { fromStatus, toStatus, changed: true, retry: false };
}

export function applyTaskStatusPatch(task: unknown, patch: unknown, options: { approvals?: unknown } = {}): TaskRecord {
  const stableTask = assertTaskRecord(task); if (!isRecord(patch)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_PATCH, '任务 patch 必须是一个对象。');
  validateTaskStatusPatch(stableTask, patch, options);
  return { ...stableTask, ...patch, status: Object.hasOwn(patch, 'status') ? patch.status as TaskStatus : stableTask.status } as TaskRecord;
}

export function interruptedTaskExecutionPatch(task: unknown, detectedAt: unknown): TaskPatch {
  const execution = asRecord(asRecord(task)?.execution);
  return { status: 'waiting_test', currentStage: 'local_execution_interrupted', execution: { ...(execution || {}), finishedAt: detectedAt, outcome: 'interrupted', interruption: { reason: 'runtime_restart', detectedAt } }, error: { code: 'local_execution_interrupted', message: 'A君运行进程在本地执行器回写结果前中断。', userMessage: '这项本地工作在运行台重启前没有留下完整结果；已转为待测试，不会自动重做或冒充成功。', category: 'manual', stage: 'local_execution', retryable: false, occurredAt: detectedAt } };
}

function assertTaskApprovalDecision(task: TaskRecord, patch: UnknownRecord, approvals: unknown, acceptedStatuses: ReadonlySet<ApprovalStatus>): void {
  const refs = uniqueStrings(Object.hasOwn(patch, 'approvalRefs') ? patch.approvalRefs : task.approvalRefs);
  if (!refs.length) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_REFERENCE_REQUIRED, '任务进入或离开待审批状态必须保留 approvalRef。');
  const matching = array(approvals).map(asRecord).find((approval) => approval && refs.includes(text(approval.approvalId)) && approval.taskId === task.taskId && isApprovalStatus(approval.status) && acceptedStatuses.has(approval.status));
  if (!matching) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_MISMATCH, '任务状态迁移缺少匹配的审批决定。', { acceptedStatuses: [...acceptedStatuses], approvalRefs: refs });
}

function assertApprovalForTask(task: TaskRecord, approval: ApprovalRecord, acceptedStatuses: ReadonlySet<ApprovalStatus>): void {
  if (approval.taskId !== task.taskId || !approval.approvalId || !acceptedStatuses.has(approval.status)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批与任务身份或状态不匹配。');
}

function validateRetryAttempt(task: TaskRecord, patch: UnknownRecord, fromStatus: TaskStatus, toStatus: TaskStatus): void {
  if (!Object.hasOwn(patch, 'attempt')) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_REQUIRED, '终态重试必须显式提供新的 attempt。', { fromStatus, toStatus, currentAttempt: task.attempt });
  const nextAttempt = patch.attempt;
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1 || !Number.isSafeInteger(nextAttempt) || nextAttempt !== task.attempt + 1) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_INVALID, '终态重试的 attempt 必须恰好增加 1。', { fromStatus, toStatus, currentAttempt: task.attempt, nextAttempt });
}

function assertKnownStatus(status: unknown, position: string): asserts status is TaskStatus {
  if (isKnownTaskStatus(status)) return;
  throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.UNKNOWN_STATUS, `未知的任务状态“${String(status)}”。`, { status, position });
}
function assertTaskRecord(value: unknown): TaskRecord {
  if (!isRecord(value)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK, '任务必须是一个对象。');
  assertKnownStatus(value.status, 'current');
  // Patch validation must not rewrite legacy serialized fields merely by reading them.
  return { ...value, taskId: value.taskId as string, status: value.status, attempt: value.attempt as number };
}
function assertApprovalRecord(value: unknown): ApprovalRecord {
  if (!isRecord(value) || !isApprovalStatus(value.status) || !text(value.approvalId) || !text(value.taskId)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批与任务身份或状态不匹配。');
  return { ...value, approvalId: text(value.approvalId), taskId: text(value.taskId), status: value.status };
}
function isApprovalRecord(value: unknown): value is ApprovalRecord { return isRecord(value) && isApprovalStatus(value.status); }
function isApprovalStatus(value: unknown): value is ApprovalStatus { return typeof value === 'string' && APPROVAL_STATUS_SET.has(value as ApprovalStatus); }
function isInitialTaskStatus(value: TaskStatus): value is InitialTaskStatus { return INITIAL_STATUS_SET.has(value as InitialTaskStatus); }
function lifecycleError(code: TaskLifecycleErrorCode, message: string, details: unknown = {}): TaskLifecycleError { return new TaskLifecycleError(code, message, details); }
function asRecord(value: unknown): UnknownRecord | null { return isRecord(value) ? value : null; }
function isRecord(value: unknown): value is UnknownRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function uniqueStrings(values: unknown): string[] { return [...new Set(array(values).map(text).filter(Boolean))]; }
function text(value: unknown): string { return String(value || '').trim(); }
function normalizeWorkerLeaseInput(options: { workerId?: unknown; leaseId?: unknown; leaseMs?: unknown; now?: unknown }): Readonly<{ workerId: string; leaseId: string; leaseMs: number; now: number }> {
  const normalized = { workerId: text(options.workerId), leaseId: text(options.leaseId), leaseMs: Number(options.leaseMs ?? 120000), now: Number(options.now ?? Date.now()) };
  if (!normalized.workerId || !normalized.leaseId || !Number.isSafeInteger(normalized.leaseMs) || normalized.leaseMs <= 0 || !Number.isFinite(normalized.now)) throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Mac 工作间租约参数无效。');
  return normalized;
}
