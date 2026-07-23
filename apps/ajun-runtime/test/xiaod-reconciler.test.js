import assert from 'node:assert/strict';
import test from 'node:test';
import { XiaodReconciler } from '../src/xiaod-reconciler.js';

function setup({ taskPatch = {}, getJob, onFailure = null } = {}) {
  const task = {
    taskId: 'task-1', status: 'running', currentStage: 'delegated_to_xiaod', artifactRefs: [],
    execution: { executor: 'xiaod', xiaodJobId: 'xiaod-1', polling: { state: 'pending', consecutiveFailures: 0, nextPollAt: null } },
    ...taskPatch
  };
  const store = {
    async list() { return [task]; },
    async updateTask(taskId, patch) { assert.equal(taskId, 'task-1'); Object.assign(task, patch); return task; }
  };
  const now = () => Date.parse('2026-07-21T00:00:00.000Z');
  return { task, reconciler: new XiaodReconciler({ store, xiaod: { baseUrl: 'http://127.0.0.1:4318', getJob }, onFailure, now }) };
}

test('central reconciler settles a persisted running task after restart', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'completed', title: '素材', output: { markdownPath: '/tmp/result.md', larkUrl: 'https://example.feishu.cn/docx/result', larkPermissionGranted: true }, quality: { passed: true } }) });
  await reconciler.reconcile();
  assert.equal(task.status, 'succeeded');
  assert.equal(task.execution.polling.state, 'settled');
  assert.equal(task.artifactRefs[0].artifactId, 'xiaod-job:xiaod-1');
  assert.equal(task.artifactRefs[0].data.larkPermissionGranted, true);
});

test('小D已暂停时，A君保留已暂停状态并停止后续自动查询', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id:'xiaod-1', status:'paused', progress:45 }) });
  await reconciler.reconcile();
  assert.equal(task.status, 'paused');
  assert.equal(task.execution.polling.state, 'settled');
  assert.equal(task.execution.polling.nextPollAt, null);
});

test('short Xiaod outages keep the task running and persist exponential backoff', async () => {
  const { task, reconciler } = setup({ getJob: async () => { throw new Error('connect ECONNREFUSED'); } });
  await reconciler.reconcile();
  assert.equal(task.status, 'running');
  assert.equal(task.currentStage, 'xiaod_status_retrying');
  assert.equal(task.execution.polling.state, 'backoff');
  assert.equal(task.execution.polling.consecutiveFailures, 1);
  assert.equal(task.execution.polling.nextPollAt, '2026-07-21T00:00:03.000Z');
  assert.equal(task.error.category, 'retryable');
});

test('Xiaod retryable failure is preserved on the parent task', async () => {
  let recoveryTask;
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'failed', error: '服务重启导致任务中断，请重试。', failure: { category: 'retryable', retryable: true, recovery: '请重试小D任务。' } }), onFailure: async (failed) => { recoveryTask = failed; } });
  await reconciler.reconcile();
  assert.equal(task.status, 'failed');
  assert.equal(task.error.category, 'retryable');
  assert.equal(task.error.retryable, true);
  assert.equal(task.error.userMessage, '请重试小D任务。');
  assert.equal(recoveryTask.taskId, 'task-1');
});

test('恢复协调暂时失败时保留待处理记录，不覆盖原始业务失败', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'failed', error: '任务失败。', failure: { category: 'manual', retryable: false } }), onFailure: async () => { throw new Error('恢复协调服务暂不可用'); } });
  await reconciler.reconcile();
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'xiaod_job_failed');
  assert.equal(task.recovery.coordination.status, 'pending');
  assert.match(task.recovery.coordination.reason, /暂不可用/);
});
