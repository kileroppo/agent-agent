import assert from 'node:assert/strict';
import test from 'node:test';
import { XiaodDelegate } from '../src/xiaod-delegate.js';

test('小D缺少公开素材链接时不发起下游请求', async () => {
  let calls = 0;
  const delegate = new XiaodDelegate({ fetchImpl: async () => { calls += 1; throw new Error('不应请求'); } });
  const result = await delegate.execute({ input: {}, routing: { reason: '已路由' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.currentStage, 'source_url_required');
  assert.equal(calls, 0);
});

test('小D只在任务记录完成后开始跟踪下游任务', async () => {
  const started = [];
  const delegate = new XiaodDelegate({
    onStarted: (value) => started.push(value),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:4318/api/jobs');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { url: 'https://example.com/video' });
      return new Response(JSON.stringify({ job: { id: 'xiaod-1' } }), { status: 202 });
    }
  });
  const result = await delegate.execute({ taskId: 'task-1', input: { sourceUrl: 'https://example.com/video' }, routing: {} });
  assert.equal(result.status, 'running');
  assert.equal(result.execution.polling.state, 'pending');
  assert.equal(result.execution.polling.consecutiveFailures, 0);
  assert.deepEqual(result.usage.tools, [{ id:'xiaod-local-api', name:'小D本机处理', calls:1 }]);
  assert.equal(started.length, 0);
  delegate.observe({ taskId: 'task-1', execution: result.execution });
  assert.deepEqual(started, [{ taskId: 'task-1', xiaodJobId: 'xiaod-1' }]);
});

test('小D下游地址只能是本机回环地址', () => {
  assert.throws(() => new XiaodDelegate({ baseUrl: 'https://example.com' }), /本机回环地址/);
});

test('小D暂停和继续只调用本机工作接口', async () => {
  const calls = [];
  const delegate = new XiaodDelegate({ fetchImpl: async (url, options) => {
    calls.push({ url, method:options.method });
    return new Response(JSON.stringify({ job:{ id:'xiaod-1', status:url.endsWith('/pause') ? 'pausing' : 'queued', progress:45 } }), { status:202 });
  } });
  const task = { taskId:'task-1', execution:{ xiaodJobId:'xiaod-1' } };
  const paused = await delegate.pause(task); const resumed = await delegate.resume(task);
  assert.equal(paused.status, 'pausing'); assert.equal(resumed.status, 'queued');
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:4318/api/jobs/xiaod-1/pause', 'http://127.0.0.1:4318/api/jobs/xiaod-1/resume']);
});
