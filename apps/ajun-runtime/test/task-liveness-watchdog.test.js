import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskLivenessWatchdog, abortProcessTree } from '../src/task-liveness-watchdog.ts';

test('TaskLivenessWatchdog 正常心跳续约不触发卡死熔断', async () => {
  let now = 1000000;
  const tasks = [
    { taskId: 'task-1', taskType: 'media.transcribe', status: 'running', startedAt: new Date(now - 10000).toISOString() },
  ];
  const store = {
    async list() { return tasks; },
    async save(t) {
      const idx = tasks.findIndex((item) => item.taskId === t.taskId);
      if (idx >= 0) tasks[idx] = t;
    },
  };

  const watchdog = new TaskLivenessWatchdog({
    store,
    now: () => now,
  });

  // 记录心跳
  watchdog.recordHeartbeat('task-1', { at: now });

  // 经过 5 分钟（租约 15 分钟）
  now += 5 * 60 * 1000;
  const res = await watchdog.checkStalledTasks({ now });
  assert.equal(res.stalledCount, 0);
  assert.equal(tasks[0].status, 'running');
});

test('TaskLivenessWatchdog 超时未上报心跳自动标记为卡死失败并触发恢复', async () => {
  let now = 1000000;
  const tasks = [
    {
      taskId: 'task-stalled-1',
      taskType: 'report.intel-research', // lease is 10 min
      status: 'running',
      startedAt: new Date(now - 1000).toISOString(),
    },
  ];
  const store = {
    async list() { return tasks; },
    async save(t) {
      const idx = tasks.findIndex((item) => item.taskId === t.taskId);
      if (idx >= 0) tasks[idx] = t;
    },
  };

  let killedPid = null;
  const stalledNotifications = [];

  const watchdog = new TaskLivenessWatchdog({
    store,
    now: () => now,
    killProcess: async (pid) => { killedPid = pid; return true; },
    onTaskStalled: (t) => { stalledNotifications.push(t.taskId); },
  });

  watchdog.recordHeartbeat('task-stalled-1', { pid: 9999, at: now });

  // 推进时间超过 10 分钟
  now += 11 * 60 * 1000;

  const res = await watchdog.checkStalledTasks({ now });
  assert.equal(res.stalledCount, 1);
  assert.equal(res.stalledTaskIds[0], 'task-stalled-1');
  assert.equal(killedPid, 9999);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].error.code, 'task_execution_stalled');
  assert.equal(tasks[0].recovery.coordination.status, 'pending');
  assert.deepEqual(stalledNotifications, ['task-stalled-1']);

  // reconcile 再次调用为 0（已转为 failed，不在 active 列表中）
  const rec = await watchdog.reconcile();
  assert.equal(rec.status, 'reconciled');
  assert.equal(rec.stalledCount, 0);
});

test('abortProcessTree 安全拒绝当前进程与无效 pid', async () => {
  assert.equal(await abortProcessTree(0), false);
  assert.equal(await abortProcessTree(-1), false);
  assert.equal(await abortProcessTree(process.pid), false);
});
