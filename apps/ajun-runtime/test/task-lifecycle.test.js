import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_LIFECYCLE_ERROR_CODES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  applyApprovalPatch,
  applyTaskStatusPatch,
  applyWorkerTaskPatch,
  claimTaskForWorker,
  holdTaskForApproval,
  initializeApprovalRecord,
  initializeTaskRecord,
  isTerminalTaskStatus,
  isWorkerTaskClaimable,
  validateTaskStatusPatch,
} from '../src/task-lifecycle.ts';

function task(status, attempt = 1) {
  return { taskId:'task-1', status, attempt, currentStage:'before' };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test('标准状态包含契约状态和生产待测试状态', () => {
  assert.deepEqual(TASK_STATUSES, [
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
  assert.deepEqual(TERMINAL_TASK_STATUSES, [
    'waiting_test',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ]);
  assert.equal(isTerminalTaskStatus('waiting_test'), true);
  assert.equal(isTerminalTaskStatus('paused'), false);
});

test('新任务由生命周期入口固定初态、attempt 和系统身份字段', () => {
  const created = initializeTaskRecord({
    taskId:'caller-controlled',
    status:'queued',
    attempt:1,
    taskType:'army.intake',
  }, {
    taskId:'task-generated',
    now:'2026-08-02T00:00:00.000Z',
  });

  assert.equal(created.taskId, 'task-generated');
  assert.equal(created.status, 'queued');
  assert.equal(created.attempt, 1);
  assert.equal(created.createdAt, '2026-08-02T00:00:00.000Z');
  assert.equal(created.updatedAt, '2026-08-02T00:00:00.000Z');
  assert.throws(
    () => initializeTaskRecord({ status:'succeeded' }, { taskId:'task-2', now:'2026-08-02T00:00:00.000Z' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_STATUS),
  );
  assert.throws(
    () => initializeTaskRecord({ status:'queued', attempt:2 }, { taskId:'task-3', now:'2026-08-02T00:00:00.000Z' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.INVALID_INITIAL_ATTEMPT),
  );
});

test('审批引用、决定和离开待审批状态由同一生命周期入口核验', () => {
  const approval = initializeApprovalRecord({ taskId:'task-1', reason:'高风险动作' }, {
    approvalId:'approval-1',
    now:'2026-08-02T00:00:00.000Z',
  });
  const held = holdTaskForApproval(task('queued'), approval);

  assert.equal(approval.status, 'pending');
  assert.equal(held.status, 'waiting_approval');
  assert.deepEqual(held.approvalRefs, ['approval-1']);
  assert.throws(
    () => applyApprovalPatch(approval, { status:'approved' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_REQUIRED),
  );
  assert.throws(
    () => applyTaskStatusPatch(held, { status:'queued' }, { approvals:[approval] }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_DECISION_MISMATCH),
  );

  const approved = applyApprovalPatch(approval, {
    status:'approved',
    decisionBy:'A君',
    decisionReason:'范围已确认',
    decidedAt:'2026-08-02T00:01:00.000Z',
  });
  assert.equal(
    applyTaskStatusPatch(held, { status:'queued' }, { approvals:[approved] }).status,
    'queued',
  );
  assert.throws(
    () => initializeApprovalRecord({ taskId:'task-1', status:'approved' }, {
      approvalId:'approval-2',
      now:'2026-08-02T00:00:00.000Z',
    }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.APPROVAL_INVALID),
  );
});

test('Worker领取、身份、过期与续租由生命周期入口统一核验', () => {
  const waiting = {
    ...task('waiting_worker'),
    taskType:'media.transcribe-and-refine',
    execution:{ mode:'mac_worker', worker:{ state:'waiting' } },
  };
  assert.equal(isWorkerTaskClaimable(waiting, {
    taskTypes:['media.transcribe-and-refine'],
    now:1_000,
  }), true);
  const claimed = claimTaskForWorker(waiting, {
    workerId:'worker-a',
    leaseId:'lease-a',
    leaseMs:500,
    now:1_000,
  });
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.execution.worker.leaseExpiresAt, new Date(1_500).toISOString());
  assert.equal(isWorkerTaskClaimable(claimed, {
    taskTypes:['media.transcribe-and-refine'],
    now:1_499,
  }), false);
  assert.throws(
    () => applyWorkerTaskPatch(claimed, {
      workerId:'worker-b', leaseId:'lease-a', patch:{}, now:1_100,
    }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_MISMATCH),
  );
  assert.throws(
    () => applyWorkerTaskPatch(claimed, {
      workerId:'worker-a', leaseId:'lease-a', patch:{}, now:1_500,
    }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.WORKER_LEASE_EXPIRED),
  );
  const renewed = applyWorkerTaskPatch(claimed, {
    workerId:'worker-a',
    leaseId:'lease-a',
    patch:{ currentStage:'working', execution:{ worker:{ progress:50 } } },
    extendLease:true,
    leaseMs:500,
    now:1_100,
  });
  assert.equal(renewed.currentStage, 'working');
  assert.equal(renewed.execution.worker.progress, 50);
  assert.equal(renewed.execution.worker.leaseId, 'lease-a');
  assert.equal(renewed.execution.worker.leaseExpiresAt, new Date(1_600).toISOString());
});

test('完整状态迁移矩阵只允许契约路径、幂等更新和显式终态重试', () => {
  const allowed = new Map([
    ['received', ['needs_input', 'queued', 'cancelled']],
    ['needs_input', ['queued', 'expired', 'cancelled']],
    ['queued', ['needs_input', 'running', 'waiting_worker', 'waiting_approval', 'waiting_test', 'failed', 'cancelled']],
    ['running', ['needs_input', 'waiting_worker', 'waiting_approval', 'pausing', 'waiting_test', 'succeeded', 'failed', 'cancelled']],
    ['waiting_worker', ['queued', 'running', 'needs_input', 'waiting_approval', 'waiting_test', 'failed', 'cancelled']],
    ['pausing', ['running', 'paused', 'waiting_test', 'failed', 'cancelled']],
    ['paused', ['queued', 'running', 'waiting_approval', 'failed', 'cancelled']],
    ['waiting_approval', ['queued', 'running', 'needs_input', 'failed', 'cancelled', 'expired']],
    ['waiting_test', ['succeeded', 'failed', 'cancelled']],
  ]);

  for (const fromStatus of TASK_STATUSES) {
    for (const toStatus of TASK_STATUSES) {
      const retry = TERMINAL_TASK_STATUSES.includes(fromStatus)
        && ['received', 'queued'].includes(toStatus);
      const expected = fromStatus === toStatus
        || retry
        || (allowed.get(fromStatus) || []).includes(toStatus);
      const approvalId = `approval-${fromStatus}-${toStatus}`;
      const current = {
        ...task(fromStatus),
        ...(fromStatus === 'waiting_approval' || toStatus === 'waiting_approval'
          ? { approvalRefs:[approvalId] }
          : {}),
      };
      const approvalStatus = fromStatus === 'waiting_approval'
        ? (['queued', 'running'].includes(toStatus) ? 'approved' : 'rejected')
        : 'pending';
      const options = current.approvalRefs
        ? { approvals:[{ approvalId, taskId:current.taskId, status:approvalStatus }] }
        : {};
      const patch = {
        status:toStatus,
        ...(retry ? { attempt:current.attempt + 1 } : {}),
      };

      if (expected) {
        assert.doesNotThrow(
          () => validateTaskStatusPatch(current, patch, options),
          `${fromStatus} -> ${toStatus} 应允许`,
        );
      } else {
        assert.throws(
          () => validateTaskStatusPatch(current, patch, options),
          `${fromStatus} -> ${toStatus} 应拒绝`,
        );
      }
    }
  }
});

test('running 可以安全收口为 waiting_test，waiting_test 是终态', () => {
  const original = task('running');
  const updated = applyTaskStatusPatch(original, {
    status:'waiting_test',
    currentStage:'verification_incomplete',
  });

  assert.equal(updated.status, 'waiting_test');
  assert.equal(updated.currentStage, 'verification_incomplete');
  assert.equal(isTerminalTaskStatus(updated.status), true);
  assert.equal(original.status, 'running');
  assert.equal(original.currentStage, 'before');
});

test('queued 可在执行器启动前因确定性门禁失败收口为 waiting_test', () => {
  const original = task('queued');
  const updated = applyTaskStatusPatch(original, {
    status:'waiting_test',
    currentStage:'maturity_execution_blocked',
  });
  assert.equal(updated.status, 'waiting_test');
  assert.equal(updated.currentStage, 'maturity_execution_blocked');
});

test('同状态更新是幂等 patch，不要求增加 attempt', () => {
  const original = task('succeeded', 2);
  const updated = applyTaskStatusPatch(original, {
    status:'succeeded',
    currentStage:'receipt_reconciled',
  });

  assert.deepEqual(updated, {
    taskId:'task-1',
    status:'succeeded',
    attempt:2,
    currentStage:'receipt_reconciled',
  });
  assert.notEqual(updated, original);
});

test('不含 status 的普通 patch 保持状态并仍返回新对象', () => {
  const original = task('running');
  const updated = applyTaskStatusPatch(original, { currentStage:'working' });

  assert.deepEqual(updated, { ...original, currentStage:'working' });
  assert.notEqual(updated, original);
});

test('未知的当前状态和目标状态都被稳定错误码拒绝', () => {
  assert.throws(
    () => validateTaskStatusPatch(task('mystery'), { currentStage:'noop' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.UNKNOWN_STATUS),
  );
  assert.throws(
    () => validateTaskStatusPatch(task('running'), { status:'completed' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.UNKNOWN_STATUS),
  );
});

test('非终态之间不能跳过必要的生命周期阶段', () => {
  assert.throws(
    () => applyTaskStatusPatch(task('queued'), { status:'succeeded' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.INVALID_TRANSITION),
  );
  assert.throws(
    () => applyTaskStatusPatch(task('paused'), { status:'succeeded' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.INVALID_TRANSITION),
  );
});

test('终态不能直接回退到运行状态', () => {
  assert.throws(
    () => applyTaskStatusPatch(task('failed'), { status:'running', attempt:2 }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.INVALID_TERMINAL_ROLLBACK),
  );
});

test('终态重试必须显式创建恰好下一个 attempt', () => {
  assert.throws(
    () => applyTaskStatusPatch(task('failed', 2), { status:'queued' }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_REQUIRED),
  );
  assert.throws(
    () => applyTaskStatusPatch(task('failed', 2), { status:'queued', attempt:2 }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_INVALID),
  );
  assert.throws(
    () => applyTaskStatusPatch(task('failed', 2), { status:'queued', attempt:4 }),
    expectCode(TASK_LIFECYCLE_ERROR_CODES.RETRY_ATTEMPT_INVALID),
  );

  const retried = applyTaskStatusPatch(task('failed', 2), {
    status:'queued',
    attempt:3,
    currentStage:'retry_queued',
  });
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempt, 3);
});
