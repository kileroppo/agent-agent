import assert from 'node:assert/strict';
import test from 'node:test';
import { InterruptedLocalExecutionReconciler } from '../src/interrupted-local-execution-reconciler.ts';

test('运行台重启后只收敛旧进程中断在本地启动阶段的任务', async () => {
  const tasks = [
    localTask('old-local', 'starting', '2026-08-08T00:00:00.000Z'),
    localTask('old-presentation', 'office_presentation_local_starting', '2026-08-08T00:00:01.000Z'),
    localTask('new-local', 'starting', '2026-08-08T00:10:01.000Z'),
    localTask('xiaod', 'delegated_to_xiaod', '2026-08-08T00:00:02.000Z'),
    localTask('mission', 'mission_in_progress', '2026-08-08T00:00:03.000Z'),
    localTask('paperclip', 'waiting_paperclip_heartbeat', '2026-08-08T00:00:04.000Z'),
  ];
  const recovered = [];
  const store = {
    async list() { return tasks; },
    async recoverInterruptedTaskExecution(taskId, input) {
      const task = tasks.find((item) => item.taskId === taskId);
      assert.equal(input.expectedStartedAt, task.execution.startedAt);
      task.status = 'waiting_test';
      task.currentStage = 'local_execution_interrupted';
      task.error = { code:'local_execution_interrupted' };
      recovered.push(taskId);
      return { task, recovered:true };
    },
  };
  const reconciler = new InterruptedLocalExecutionReconciler({
    store,
    bootedAt:'2026-08-08T00:10:00.000Z',
  });

  const result = await reconciler.start();

  assert.equal(result.status, 'reconciled');
  assert.deepEqual(recovered, ['old-local', 'old-presentation']);
  assert.equal(tasks.find((task) => task.taskId === 'new-local').status, 'running');
  assert.equal(tasks.find((task) => task.taskId === 'xiaod').status, 'running');
  assert.equal(tasks.find((task) => task.taskId === 'mission').status, 'running');
  assert.equal(tasks.find((task) => task.taskId === 'paperclip').status, 'running');
});

test('中断任务扫描失败时保留原状态并报告待同步', async () => {
  let reported;
  const reconciler = new InterruptedLocalExecutionReconciler({
    store:{ async list() { throw new Error('store unavailable'); } },
    bootedAt:'2026-08-08T00:10:00.000Z',
    onResult:(result) => { reported = result; },
  });

  const result = await reconciler.start();

  assert.equal(result.status, 'sync_pending');
  assert.equal(reported.status, 'sync_pending');
});

function localTask(taskId, currentStage, startedAt) {
  return {
    taskId,
    taskType:'operations.health-review',
    status:'running',
    currentStage,
    execution:{ executor:'operator', startedAt },
  };
}
