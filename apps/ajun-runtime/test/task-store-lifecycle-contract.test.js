import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SQLiteTaskStore } from '../src/sqlite-task-store.js';
import { TaskStore } from '../src/task-store.js';

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
