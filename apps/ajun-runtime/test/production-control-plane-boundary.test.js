import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createAjunHttpHandler } from '../src/runtime-http-handler.js';

test('M5 每日入口通过真实 HTTP 委托确定性处理器', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {
    paperclipCampaignDaily:{
      async handle(input) {
        calls.push(input);
        return { status:'activated', campaignId:'campaign-1' };
      },
    },
  });

  const response = await fetch(`${fixture.baseUrl}/api/paperclip/m5-daily-heartbeat`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ source:'paperclip' }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status:'activated', campaignId:'campaign-1' });
  assert.deepEqual(calls, [{ source:'paperclip' }]);
});

test('M5 发布入口通过 current Run Seam 调用确定性 Publisher', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {
    paperclipPublisherRunContext:{
      async resolve({ heartbeat, bearerToken }) {
        calls.push(['resolve', heartbeat.issueId, bearerToken]);
        return { runId:'run-1', issueId:heartbeat.issueId, agentId:'agent-1', companyId:'company-1' };
      },
    },
    paperclipCurrentRunScope:{
      async run(scope, execute) {
        calls.push(['scope', scope]);
        return execute();
      },
    },
    canonicalPaperclipHeartbeat:(heartbeat, canonical) => ({ ...heartbeat, canonical }),
    paperclipPublisherController:{
      async handle(heartbeat) {
        calls.push(['publish', heartbeat.canonical.runId]);
        return { status:'published', receiptId:'receipt-1' };
      },
    },
  });

  const response = await fetch(`${fixture.baseUrl}/api/paperclip/m5-publisher-heartbeat`, {
    method:'POST',
    headers:{ authorization:'Bearer run.jwt', 'content-type':'application/json' },
    body:JSON.stringify({ issueId:'issue-1' }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status:'published', receiptId:'receipt-1' });
  assert.deepEqual(calls, [
    ['resolve', 'issue-1', 'run.jwt'],
    ['scope', { apiKey:'run.jwt', runId:'run-1', issueId:'issue-1', agentId:'agent-1', companyId:'company-1' }],
    ['publish', 'run-1'],
  ]);
});

test('M5 复盘入口只返回确定性处理器产生的待审核建议', async (context) => {
  const fixture = await startHandler(context, {
    paperclipRetrospective:{
      async handle(input) {
        assert.deepEqual(input, { caseId:'case-1' });
        return { status:'proposed', automaticProductionMutation:false };
      },
    },
  });

  const response = await fetch(`${fixture.baseUrl}/api/paperclip/m5-retrospective-heartbeat`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ caseId:'case-1' }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    status:'proposed',
    automaticProductionMutation:false,
  });
});

async function startHandler(context, paperclipOverrides = {}) {
  const handler = createAjunHttpHandler({
    environment:{},
    publicDir:new URL('../public', import.meta.url).pathname,
    dataDir:'/tmp/agent-army-http-handler-test',
    detailBaseUrl:'http://127.0.0.1',
    network:{ deploymentMode:'local', lanEnabled:false, lanAccess:{ enabled:false, key:null } },
    paperclip:{
      paperclipHeartbeat:unreachable(),
      paperclipCampaignDaily:unreachable(),
      paperclipParallelWork:unreachable(),
      paperclipMetricRunContext:unreachable(),
      paperclipMetricMonitor:unreachable(),
      paperclipCurrentRunScope:unreachable(),
      paperclipPublisherRunContext:unreachable(),
      paperclipPublisherController:unreachable(),
      paperclipRetrospective:unreachable(),
      paperclipLearningLifecycle:unreachable(),
      canonicalPaperclipHeartbeat:(heartbeat) => heartbeat,
      ...paperclipOverrides,
    },
    work:{
      tasks:unreachable(),
      store:unreachable(),
      proposals:unreachable(),
      missions:unreachable(),
      macWorker:unreachable(),
    },
    connections:{
      employeeFeishuConnections:unreachable(),
      employeeModelSetup:unreachable(),
      accessConnections:unreachable(),
      publicWebFetch:unreachable(),
    },
    feishu:{
      commander:unreachable(),
      officialFeishuChannel:unreachable(),
      hermesNativeCompletionWatcher:unreachable(),
      resolveFeishuApproval:async () => { throw new Error('unexpected call'); },
    },
    m5:{ campaigns:async () => unreachable() },
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { server, baseUrl:`http://127.0.0.1:${address.port}` };
}

function unreachable() {
  return new Proxy({}, {
    get(_target, name) {
      return async () => { throw new Error(`unexpected ${String(name)} call`); };
    },
  });
}
