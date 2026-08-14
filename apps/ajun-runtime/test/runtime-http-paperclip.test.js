import assert from 'node:assert/strict';
import test from 'node:test';

import { routePaperclipHttp } from '../src/runtime-http-paperclip.ts';

test('Paperclip HTTP Module 忽略域外请求且在读取请求体前拒绝非本机调用', async () => {
  let bodyReads = 0;
  const paperclip = unreachable();

  assert.equal(await routePaperclipHttp({
    request:request('POST', '/api/tasks'),
    paperclip,
    local:true,
    readBody:async () => { bodyReads += 1; },
  }), null);
  assert.deepEqual(await routePaperclipHttp({
    request:request('POST', '/api/paperclip/m5-learning-heartbeat'),
    paperclip,
    local:false,
    readBody:async () => { bodyReads += 1; },
  }), {
    status:403,
    payload:{ error:'M5 学习 heartbeat 只能由本机 Paperclip 调用。' },
  });
  assert.equal(bodyReads, 0);
});

test('Paperclip HTTP Module 通过同一 Interface 装配普通 heartbeat', async () => {
  const calls = [];
  const handlers = {
    paperclipHeartbeat:handler('heartbeat', calls),
    paperclipCampaignDaily:handler('daily', calls),
    paperclipParallelWork:handler('parallel', calls),
    paperclipRetrospective:handler('retrospective', calls),
    paperclipLearningLifecycle:handler('learning', calls),
  };

  for (const [url, expected] of [
    ['/api/paperclip/heartbeat', 'heartbeat'],
    ['/api/paperclip/m5-daily-heartbeat', 'daily'],
    ['/api/paperclip/m5-parallel-heartbeat', 'parallel'],
    ['/api/paperclip/m5-retrospective-heartbeat', 'retrospective'],
    ['/api/paperclip/m5-learning-heartbeat', 'learning'],
  ]) {
    assert.deepEqual(await routePaperclipHttp({
      request:request('POST', url),
      paperclip:handlers,
      local:true,
      readBody:async () => ({ route:expected }),
    }), { status:202, payload:{ handled:expected } });
  }

  assert.deepEqual(calls, [
    ['heartbeat', { route:'heartbeat' }],
    ['daily', { route:'daily' }],
    ['parallel', { route:'parallel' }],
    ['retrospective', { route:'retrospective' }],
    ['learning', { route:'learning' }],
  ]);
});

test('指标 heartbeat 先解析 Run 再进入 current Run scope 并保留审批上下文', async () => {
  const calls = [];
  const heartbeat = { issueId:'issue-1', context:{ approvalId:'approval-1' } };
  const paperclip = {
    paperclipMetricRunContext:{
      async resolve(input) {
        calls.push(['resolve', input]);
        return { runId:'run-1', issueId:'issue-1', agentId:'agent-1', companyId:'company-1' };
      },
    },
    paperclipCurrentRunScope:{
      async run(scope, execute) {
        calls.push(['scope', scope]);
        return execute();
      },
    },
    canonicalPaperclipHeartbeat(input, canonical) {
      calls.push(['canonical', input, canonical]);
      return { ...input, runId:canonical.runId };
    },
    paperclipMetricMonitor:{
      async handle(input) {
        calls.push(['handle', input]);
        return { status:'collected' };
      },
    },
  };

  assert.deepEqual(await routePaperclipHttp({
    request:request('POST', '/api/paperclip/m5-metrics-heartbeat', 'Bearer run.jwt'),
    paperclip,
    local:true,
    readBody:async () => heartbeat,
  }), { status:202, payload:{ status:'collected' } });
  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'scope', 'canonical', 'handle']);
  assert.deepEqual(calls[0][1], { heartbeat, bearerToken:'run.jwt' });
  assert.deepEqual(calls[1][1], {
    apiKey:'run.jwt',
    runId:'run-1',
    issueId:'issue-1',
    agentId:'agent-1',
    companyId:'company-1',
    approvalId:'approval-1',
  });
});

function request(method, url, authorization = '') {
  return { method, url, headers:{ authorization } };
}

function handler(name, calls) {
  return {
    async handle(input) {
      calls.push([name, input]);
      return { handled:name };
    },
  };
}

function unreachable() {
  return new Proxy({}, {
    get(_target, name) {
      throw new Error(`unexpected ${String(name)} access`);
    },
  });
}
