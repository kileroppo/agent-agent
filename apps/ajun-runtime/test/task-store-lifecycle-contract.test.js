import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';
import { TaskStore } from '../src/task-store.ts';

for (const backend of [jsonBackend(), sqliteBackend()]) {
  test(`${backend.name} 原子声明幂等任务创建所有权`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const results = await Promise.all(Array.from({ length:8 }, () => store.createTaskOnce({
        idempotencyKey:'feishu:concurrent-create',
        idempotencyFingerprint:'sha256:intent-a',
        taskType:'operations.health-review',
        status:'queued',
      })));
      assert.equal(results.filter((item) => item.created).length, 1);
      assert.equal(new Set(results.map((item) => item.task.taskId)).size, 1);
      assert.equal((await store.list()).length, 1);
      await assert.rejects(
        store.createTaskOnce({
          idempotencyKey:'feishu:concurrent-create',
          idempotencyFingerprint:'sha256:intent-b',
          taskType:'operations.health-review',
          status:'queued',
        }),
        hasCode('task_idempotency_conflict'),
      );
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 遵守同一初态、审批决定与 Worker 租约契约`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      await assert.rejects(
        store.createTask({ taskType:'army.intake', status:'succeeded' }),
        hasCode('task_initial_status_invalid'),
      );
      await assert.rejects(
        store.createTask({ taskType:'army.intake', status:'queued', attempt:2 }),
        hasCode('task_initial_attempt_invalid'),
      );

      const task = await store.createTask({ taskType:'army.intake', status:'queued' });
      await assert.rejects(
        store.updateTask(task.taskId, { status:'waiting_approval' }),
        hasCode('task_approval_reference_required'),
      );
      const approval = await store.createApproval({ taskId:task.taskId, reason:'需要确认' });
      assert.equal((await store.list())[0].status, 'waiting_approval');
      await assert.rejects(
        store.updateApproval(approval.approvalId, { status:'approved' }),
        hasCode('task_approval_decision_required'),
      );
      await assert.rejects(
        store.updateTask(task.taskId, { status:'queued' }),
        hasCode('task_approval_decision_mismatch'),
      );
      await store.updateApproval(approval.approvalId, {
        status:'approved',
        decisionBy:'A君',
        decisionReason:'范围已确认',
        decidedAt:'2026-08-02T00:00:00.000Z',
      });
      assert.equal((await store.updateTask(task.taskId, { status:'queued' })).status, 'queued');

      const workerTask = await store.createTask({
        taskType:'media.transcribe-and-refine',
        status:'waiting_worker',
      });
      const claimed = await store.claimWorkerTask({
        workerId:'worker-a',
        taskTypes:['media.transcribe-and-refine'],
        leaseMs:500,
        now:1_000,
      });
      assert.equal(claimed.taskId, workerTask.taskId);
      await assert.rejects(
        store.updateWorkerTask(workerTask.taskId, {
          workerId:'worker-a',
          leaseId:claimed.execution.worker.leaseId,
          patch:{ currentStage:'too-late' },
          now:1_500,
        }),
        hasCode('worker_lease_expired'),
      );
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 同一排队任务只能被一个执行入口原子抢占`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const task = await store.createTask({ taskType:'operations.health-review', status:'queued' });
      const claims = await Promise.all(Array.from({ length:8 }, () => store.claimTaskExecution(task.taskId, {
        currentStage:'starting',
        execution:{ executor:'operator' },
      })));
      assert.equal(claims.filter((item) => item.claimed).length, 1);
      assert.equal(new Set(claims.map((item) => item.task.taskId)).size, 1);
      const stored = (await store.list())[0];
      assert.equal(stored.status, 'running');
      assert.equal(stored.execution.executor, 'operator');

      const wrongOwner = await store.recoverInterruptedTaskExecution(task.taskId, {
        expectedStartedAt:'2026-08-08T00:00:00.000Z',
        expectedStage:'starting',
        interruptedAt:'2026-08-08T00:01:00.000Z',
      });
      assert.equal(wrongOwner.recovered, false);
      const recovered = await store.recoverInterruptedTaskExecution(task.taskId, {
        expectedStartedAt:stored.execution.startedAt,
        expectedStage:stored.currentStage,
        interruptedAt:'2026-08-08T00:01:00.000Z',
      });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.task.status, 'waiting_test');
      assert.equal(recovered.task.error.code, 'local_execution_interrupted');
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 仅在 queued 且 context 精确匹配时原子替换任务上下文`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const expectedContext = { dependencyTaskIds:['creator-1'], sourceTaskIds:['creator-1'] };
      const nextContext = { dependencyTaskIds:['creator-1'] };
      const task = await store.createTask({
        taskType:'operations.technical-repair', status:'queued', input:{ context:expectedContext },
      });
      const swaps = await Promise.all(Array.from({ length:8 }, () => store.compareAndSwapQueuedTaskContext(task.taskId, {
        expectedContext,
        nextContext,
      })));
      assert.equal(swaps.filter((item) => item.updated).length, 1);
      assert.deepEqual((await store.list())[0].input.context, nextContext);

      const wrongExpected = await store.compareAndSwapQueuedTaskContext(task.taskId, {
        expectedContext:{ dependencyTaskIds:['wrong'] },
        nextContext:{ dependencyTaskIds:['forbidden'] },
      });
      assert.equal(wrongExpected.updated, false);
      assert.deepEqual(wrongExpected.task.input.context, nextContext);

      await store.claimTaskExecution(task.taskId, { currentStage:'starting' });
      const noLongerQueued = await store.compareAndSwapQueuedTaskContext(task.taskId, {
        expectedContext:nextContext,
        nextContext:{ dependencyTaskIds:['forbidden'] },
      });
      assert.equal(noLongerQueued.updated, false);
      assert.equal(noLongerQueued.task.status, 'running');
      assert.deepEqual(noLongerQueued.task.input.context, nextContext);
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 仅原子重试一次精确旧版 maturity content 原型错误`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const task = await store.createTask({ taskType:'content.video-script-package', status:'queued' });
      await store.claimTaskExecution(task.taskId, {
        currentStage:'starting',
        execution:{ executor:'content-creator', startedAt:'2026-08-11T04:22:39.776Z' },
      });
      const blocked = await store.updateTask(task.taskId, {
        status:'waiting_test', currentStage:'maturity_execution_blocked',
        execution:{
          executor:'content-creator', startedAt:'2026-08-11T04:22:39.776Z',
          outcome:'maturity_execution_blocked', finishedAt:'2026-08-11T04:22:39.837Z',
        },
        error:{
          code:'maturity_execution_guard_rejected', message:'this.research is not a function',
          userMessage:'产品成熟度任务的用量、费用或副作用无法按零模型调用契约确认，已停止。',
          category:'governance', stage:'maturity_execution_guard', retryable:false,
          occurredAt:'2026-08-11T04:22:39.837Z',
        },
      });
      const retries = await Promise.all(Array.from({ length:8 }, () => (
        store.compareAndSwapLegacyMaturityContentRetry(task.taskId, { expectedTask:blocked })
      )));
      assert.equal(retries.filter((item) => item.retried).length, 1);
      const retried = (await store.list())[0];
      assert.equal(retried.status, 'queued');
      assert.equal(retried.attempt, 2);
      assert.equal(retried.error, undefined);
      assert.equal(retried.execution, undefined);
      assert.equal((await store.compareAndSwapLegacyMaturityContentRetry(task.taskId, {
        expectedTask:retried,
      })).retried, false);
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 仅原子重试一次已满足三子任务的 maturity 总任务`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const batchId = 'maturity-77777777-7777-4777-8777-777777777777';
      const task = await store.createTask({
        taskType:'army.cross-agent-mission', assigneeAgentId:'ajun', status:'queued',
        idempotencyKey:`product-maturity-validation:${batchId}`,
        source:{ eventRef:batchId }, input:{ context:{ productMaturityBatchId:batchId } },
        usage:{
          model:{ status:'reported', apiCalls:0 },
          cost:{ status:'reported', amount:0, currency:'USD' },
        },
      });
      await store.claimTaskExecution(task.taskId, { currentStage:'starting' });
      const waiting = await store.updateTask(task.taskId, {
        status:'waiting_test', currentStage:'mission_waiting_test',
        execution:{
          executor:'ajun', mode:'cross_agent_mission_plan', outcome:'subtasks_ready',
          startedAt:'2026-08-11T00:00:00.000Z', finishedAt:'2026-08-11T00:00:01.000Z',
        },
      });
      const retries = await Promise.all(Array.from({ length:8 }, () => (
        store.compareAndSwapMaturityMissionRetry(task.taskId, { expectedTask:waiting })
      )));
      assert.equal(retries.filter((item) => item.retried).length, 1);
      const retried = (await store.list())[0];
      assert.equal(retried.status, 'queued');
      assert.equal(retried.attempt, 2);
      assert.equal(retried.execution, undefined);
      assert.equal((await store.compareAndSwapMaturityMissionRetry(task.taskId, {
        expectedTask:retried,
      })).retried, false);
    } finally {
      await fixture.close();
    }
  });

  test(`${backend.name} 原子提交审批决定与任务状态且失败时整体回滚`, async () => {
    const fixture = await backend.open();
    const { store } = fixture;
    try {
      const task = await store.createTask({ taskType:'operations.health-review', status:'queued' });
      const approval = await store.createApproval({ taskId:task.taskId, reason:'组织级确认' });
      await assert.rejects(
        store.resolveApprovalAndUpdateTask(
          approval.approvalId,
          {
            status:'approved', decisionBy:'A君', decisionReason:'批准', decidedAt:'2026-08-08T00:00:00.000Z',
          },
          task.taskId,
          { status:'not-a-task-status' },
        ),
        hasCode('task_status_unknown'),
      );
      assert.equal((await store.listApprovals())[0].status, 'pending');
      assert.equal((await store.list())[0].status, 'waiting_approval');

      const committed = await store.resolveApprovalAndUpdateTask(
        approval.approvalId,
        {
          status:'approved', decisionBy:'A君', decisionReason:'批准', decidedAt:'2026-08-08T00:00:01.000Z',
        },
        task.taskId,
        { status:'queued', currentStage:'governance_approved' },
      );
      assert.equal(committed.approval.status, 'approved');
      assert.equal(committed.task.status, 'queued');
    } finally {
      await fixture.close();
    }
  });
}

function jsonBackend() {
  return {
    name:'JSON Store',
    async open() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-json-contract-'));
      return {
        store:new TaskStore(path.join(directory, 'runtime.json')),
        close:() => fs.rm(directory, { recursive:true, force:true }),
      };
    },
  };
}

function sqliteBackend() {
  return {
    name:'SQLite Store',
    async open() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-sqlite-contract-'));
      const store = new SQLiteTaskStore(path.join(directory, 'runtime.sqlite'));
      return {
        store,
        async close() {
          store.close();
          await fs.rm(directory, { recursive:true, force:true });
        },
      };
    },
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
