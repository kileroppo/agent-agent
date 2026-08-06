export const TASK_STATUSES = Object.freeze([
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
]);

export const TERMINAL_TASK_STATUSES = Object.freeze([
  'waiting_test',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

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
});

const STATUS_SET = new Set(TASK_STATUSES);
const TERMINAL_STATUS_SET = new Set(TERMINAL_TASK_STATUSES);
const RETRY_ENTRY_STATUS_SET = new Set(['received', 'queued']);
const APPROVAL_STATUS_SET = new Set([
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
]);
const APPROVAL_CONTINUE_STATUS_SET = new Set(['approved', 'superseded']);
const APPROVAL_STOP_STATUS_SET = new Set(['rejected', 'expired', 'superseded']);
const INITIAL_STATUS_SET = new Set([
  'received',
  'needs_input',
  'queued',
  'running',
  'waiting_worker',
]);

const TRANSITIONS = new Map([
  ['received', new Set(['needs_input', 'queued', 'cancelled'])],
  ['needs_input', new Set(['queued', 'expired', 'cancelled'])],
  ['queued', new Set([
    'needs_input',
    'running',
    'waiting_worker',
    'waiting_approval',
    'failed',
    'cancelled',
  ])],
  ['running', new Set([
    'needs_input',
    'waiting_worker',
    'waiting_approval',
    'pausing',
    'waiting_test',
    'succeeded',
    'failed',
    'cancelled',
  ])],
  ['waiting_worker', new Set([
    'queued',
    'running',
    'needs_input',
    'waiting_approval',
    'waiting_test',
    'failed',
    'cancelled',
  ])],
  ['pausing', new Set([
    'running',
    'paused',
    'waiting_test',
    'failed',
    'cancelled',
  ])],
  ['paused', new Set([
    'queued',
    'running',
    'waiting_approval',
    'failed',
    'cancelled',
  ])],
  ['waiting_approval', new Set([
    'queued',
    'running',
    'needs_input',
    'failed',
    'cancelled',
    'expired',
  ])],
]);

export class TaskLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.code = code;
    this.details = details;
  }
}

export function isKnownTaskStatus(status) {
  return typeof status === 'string' && STATUS_SET.has(status);
}

export function isTerminalTaskStatus(status) {
  return typeof status === 'string' && TERMINAL_STATUS_SET.has(status);
}

export function initializeTaskRecord(input, { taskId, now } = {}) {
  if (!isRecord(input)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK, '新任务必须是一个对象。');
  }
  const status = input.status ?? 'received';
  assertKnownStatus(status, 'initial');
  if (!INITIAL_STATUS_SET.has(status)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_STATUS,
      `任务不能直接创建为“${status}”。`,
      { status },
    );
  }
  if (Object.hasOwn(input, 'attempt') && input.attempt !== 1) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_ATTEMPT,
      '新任务 attempt 必须为 1。',
      { attempt:input.attempt },
    );
  }
  const stableTaskId = String(taskId || '').trim();
  const timestamp = String(now || '').trim();
  if (!stableTaskId || !timestamp) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK,
      '新任务缺少系统生成的 taskId 或时间。',
    );
  }
  return {
    schemaVersion:'agent.army/task/v1',
    priority:'normal',
    artifactRefs:[],
    approvalRefs:[],
    ...input,
    taskId:stableTaskId,
    status,
    attempt:1,
    artifactRefs:Array.isArray(input.artifactRefs) ? [...input.artifactRefs] : [],
    approvalRefs:Array.isArray(input.approvalRefs) ? [...input.approvalRefs] : [],
    createdAt:timestamp,
    updatedAt:timestamp,
  };
}

export function initializeApprovalRecord(input, { approvalId, now } = {}) {
  if (!isRecord(input)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批必须是一个对象。');
  }
  if (Object.hasOwn(input, 'status') && input.status !== 'pending') {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID,
      '新审批只能创建为 pending。',
      { status:input.status },
    );
  }
  const stableApprovalId = String(approvalId || '').trim();
  const taskId = String(input.taskId || '').trim();
  const timestamp = String(now || '').trim();
  if (!stableApprovalId || !taskId || !timestamp) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID,
      '审批缺少系统生成的 approvalId、taskId 或时间。',
    );
  }
  return {
    schemaVersion:'agent.army/approval/v1',
    ...input,
    approvalId:stableApprovalId,
    taskId,
    status:'pending',
    createdAt:timestamp,
  };
}

export function applyApprovalPatch(approval, patch) {
  if (!isRecord(approval) || !APPROVAL_STATUS_SET.has(approval.status) || !isRecord(patch)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID, '审批或审批 patch 无效。');
  }
  const nextStatus = Object.hasOwn(patch, 'status') ? patch.status : approval.status;
  if (!APPROVAL_STATUS_SET.has(nextStatus)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID,
      `未知审批状态“${String(nextStatus)}”。`,
      { status:nextStatus },
    );
  }
  if (approval.status !== 'pending' && nextStatus !== approval.status) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_TRANSITION_INVALID,
      `审批不能从“${approval.status}”变为“${nextStatus}”。`,
      { fromStatus:approval.status, toStatus:nextStatus },
    );
  }
  if (approval.status === 'pending' && nextStatus !== 'pending') {
    const decisionBy = String(patch.decisionBy || '').trim();
    const decisionReason = String(patch.decisionReason || '').trim();
    const decidedAt = String(patch.decidedAt || '').trim();
    if (!decisionBy || !decisionReason || !decidedAt || !Number.isFinite(Date.parse(decidedAt))) {
      throw lifecycleError(
        TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_REQUIRED,
        '审批决定必须包含 decisionBy、decisionReason 和有效 decidedAt。',
        { toStatus:nextStatus },
      );
    }
  }
  return { ...approval, ...patch, status:nextStatus };
}

export function holdTaskForApproval(task, approval) {
  assertApprovalForTask(task, approval, new Set(['pending']));
  const approvalRefs = uniqueStrings([...(task.approvalRefs || []), approval.approvalId]);
  const linked = { ...task, approvalRefs };
  if (approval.holdTask === false) return linked;
  return applyTaskStatusPatch(linked, {
    status:'waiting_approval',
    currentStage:'approval_required',
  }, { approvals:[approval] });
}

export function isWorkerTaskClaimable(task, { taskTypes, now = Date.now() } = {}) {
  if (!isRecord(task)) return false;
  const allowedTypes = new Set(uniqueStrings(taskTypes));
  if (!allowedTypes.has(task.taskType)) return false;
  if (task.status === 'waiting_worker') return true;
  const expiresAt = Date.parse(task.execution?.worker?.leaseExpiresAt || '');
  return task.status === 'running'
    && task.execution?.mode === 'mac_worker'
    && Number.isFinite(expiresAt)
    && expiresAt <= now;
}

export function claimTaskForWorker(task, {
  workerId,
  leaseId,
  leaseMs = 120_000,
  now = Date.now(),
} = {}) {
  const lease = normalizeWorkerLeaseInput({ workerId, leaseId, leaseMs, now });
  const currentExpiry = Date.parse(task?.execution?.worker?.leaseExpiresAt || '');
  const claimable = task?.status === 'waiting_worker'
    || (task?.status === 'running'
      && task?.execution?.mode === 'mac_worker'
      && Number.isFinite(currentExpiry)
      && currentExpiry <= lease.now);
  if (!claimable) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.WORKER_TASK_NOT_CLAIMABLE,
      '任务当前不能被 Mac 工作间领取。',
    );
  }
  const leasedAt = new Date(lease.now).toISOString();
  return applyTaskStatusPatch(task, {
    status:'running',
    currentStage:'mac_worker_claimed',
    updatedAt:leasedAt,
    execution:{
      ...(task.execution || {}),
      executor:'xiaod',
      mode:'mac_worker',
      worker:{
        state:'leased',
        workerId:lease.workerId,
        leaseId:lease.leaseId,
        leasedAt,
        lastHeartbeatAt:leasedAt,
        leaseExpiresAt:new Date(lease.now + lease.leaseMs).toISOString(),
      },
    },
  });
}

export function applyWorkerTaskPatch(task, {
  workerId,
  leaseId,
  patch,
  leaseMs = 120_000,
  now = Date.now(),
  extendLease = false,
} = {}) {
  if (!isRecord(task) || !isRecord(patch)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Worker 任务或 patch 无效。');
  }
  const stableWorkerId = String(workerId || '').trim();
  const stableLeaseId = String(leaseId || '').trim();
  const lease = task.execution?.worker;
  if (task.execution?.mode !== 'mac_worker'
    || !stableWorkerId
    || !stableLeaseId
    || lease?.workerId !== stableWorkerId
    || lease?.leaseId !== stableLeaseId) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_MISMATCH,
      'Mac 工作间租约身份不匹配。',
    );
  }
  const timestamp = Number(now);
  const expiresAt = Date.parse(lease.leaseExpiresAt || '');
  if (!Number.isFinite(timestamp) || !Number.isFinite(expiresAt)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Mac 工作间租约时间无效。');
  }
  if (expiresAt <= timestamp) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_EXPIRED,
      'Mac 工作间租约已经过期。',
    );
  }
  const suppliedWorker = isRecord(patch.execution?.worker) ? patch.execution.worker : {};
  if ((Object.hasOwn(suppliedWorker, 'workerId') && suppliedWorker.workerId !== stableWorkerId)
    || (Object.hasOwn(suppliedWorker, 'leaseId') && suppliedWorker.leaseId !== stableLeaseId)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_MISMATCH,
      'Worker patch 不能改写租约身份。',
    );
  }
  const normalizedLeaseMs = Number(leaseMs);
  if (extendLease && (!Number.isSafeInteger(normalizedLeaseMs) || normalizedLeaseMs <= 0)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Worker 续租时长无效。');
  }
  const at = new Date(timestamp).toISOString();
  const worker = {
    ...lease,
    ...(extendLease ? {
      state:'working',
      lastHeartbeatAt:at,
      leaseExpiresAt:new Date(timestamp + normalizedLeaseMs).toISOString(),
    } : {}),
    ...suppliedWorker,
    workerId:stableWorkerId,
    leaseId:stableLeaseId,
  };
  return applyTaskStatusPatch(task, {
    ...patch,
    updatedAt:at,
    execution:{
      ...(task.execution || {}),
      ...(patch.execution || {}),
      mode:'mac_worker',
      worker,
    },
  });
}

/**
 * Validate a status-bearing task patch without mutating the task or patch.
 * A patch without `status` is treated as an idempotent update to the current
 * lifecycle state. Retrying a terminal task creates the next attempt and may
 * only re-enter through `received` or `queued`.
 */
export function validateTaskStatusPatch(task, patch, { approvals = [] } = {}) {
  if (!isRecord(task)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_TASK,
      '任务必须是一个对象。',
    );
  }
  if (!isRecord(patch)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_PATCH,
      '任务 patch 必须是一个对象。',
    );
  }

  const fromStatus = task.status;
  assertKnownStatus(fromStatus, 'current');

  const hasStatusPatch = Object.hasOwn(patch, 'status');
  const toStatus = hasStatusPatch ? patch.status : fromStatus;
  assertKnownStatus(toStatus, 'target');

  if (fromStatus !== toStatus && toStatus === 'waiting_approval') {
    assertTaskApprovalDecision(task, patch, approvals, new Set(['pending']));
  } else if (fromStatus === 'waiting_approval' && fromStatus !== toStatus) {
    const accepted = ['queued', 'running'].includes(toStatus)
      ? APPROVAL_CONTINUE_STATUS_SET
      : APPROVAL_STOP_STATUS_SET;
    assertTaskApprovalDecision(task, patch, approvals, accepted);
  }

  if (fromStatus === toStatus) {
    return { fromStatus, toStatus, changed:false, retry:false };
  }

  if (isTerminalTaskStatus(fromStatus)) {
    if (!RETRY_ENTRY_STATUS_SET.has(toStatus)) {
      throw lifecycleError(
        TASK_LIFECYCLE_ERROR_CODES.INVALID_TERMINAL_ROLLBACK,
        `终态“${fromStatus}”不能直接回退到“${toStatus}”。`,
        { fromStatus, toStatus },
      );
    }
    validateRetryAttempt(task, patch, fromStatus, toStatus);
    return { fromStatus, toStatus, changed:true, retry:true };
  }

  if (!TRANSITIONS.get(fromStatus)?.has(toStatus)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.INVALID_TRANSITION,
      `任务状态不能从“${fromStatus}”推进到“${toStatus}”。`,
      { fromStatus, toStatus },
    );
  }

  return { fromStatus, toStatus, changed:true, retry:false };
}

/** Validate and shallow-apply a task patch, returning a new task object. */
export function applyTaskStatusPatch(task, patch, options = {}) {
  validateTaskStatusPatch(task, patch, options);
  return { ...task, ...patch };
}

function assertTaskApprovalDecision(task, patch, approvals, acceptedStatuses) {
  const refs = uniqueStrings(
    Object.hasOwn(patch, 'approvalRefs') ? patch.approvalRefs : task.approvalRefs,
  );
  if (!refs.length) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_REFERENCE_REQUIRED,
      '任务进入或离开待审批状态必须保留 approvalRef。',
    );
  }
  const matching = (Array.isArray(approvals) ? approvals : []).find((approval) =>
    refs.includes(approval?.approvalId)
    && approval?.taskId === task.taskId
    && acceptedStatuses.has(approval?.status)
  );
  if (!matching) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_MISMATCH,
      '任务状态迁移缺少匹配的审批决定。',
      { acceptedStatuses:[...acceptedStatuses], approvalRefs:refs },
    );
  }
}

function assertApprovalForTask(task, approval, acceptedStatuses) {
  if (!isRecord(task) || !isRecord(approval)
    || approval.taskId !== task.taskId
    || !String(approval.approvalId || '').trim()
    || !acceptedStatuses.has(approval.status)) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID,
      '审批与任务身份或状态不匹配。',
    );
  }
}

function validateRetryAttempt(task, patch, fromStatus, toStatus) {
  if (!Object.hasOwn(patch, 'attempt')) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_REQUIRED,
      '终态重试必须显式提供新的 attempt。',
      { fromStatus, toStatus, currentAttempt:task.attempt },
    );
  }

  const currentAttempt = task.attempt;
  const nextAttempt = patch.attempt;
  if (!Number.isSafeInteger(currentAttempt)
    || currentAttempt < 1
    || !Number.isSafeInteger(nextAttempt)
    || nextAttempt !== currentAttempt + 1) {
    throw lifecycleError(
      TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_INVALID,
      '终态重试的 attempt 必须恰好增加 1。',
      { fromStatus, toStatus, currentAttempt, nextAttempt },
    );
  }
}

function assertKnownStatus(status, position) {
  if (isKnownTaskStatus(status)) return;
  throw lifecycleError(
    TASK_LIFECYCLE_ERROR_CODES.UNKNOWN_STATUS,
    `未知的任务状态“${String(status)}”。`,
    { status, position },
  );
}

function lifecycleError(code, message, details = {}) {
  return new TaskLifecycleError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeWorkerLeaseInput({ workerId, leaseId, leaseMs, now }) {
  const normalized = {
    workerId:String(workerId || '').trim(),
    leaseId:String(leaseId || '').trim(),
    leaseMs:Number(leaseMs),
    now:Number(now),
  };
  if (!normalized.workerId
    || !normalized.leaseId
    || !Number.isSafeInteger(normalized.leaseMs)
    || normalized.leaseMs <= 0
    || !Number.isFinite(normalized.now)) {
    throw lifecycleError(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_INVALID, 'Mac 工作间租约参数无效。');
  }
  return normalized;
}
