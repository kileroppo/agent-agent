import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createAjunHttpHandler,
  isBoomLegacyIntegrationAuthorized,
  isBoomLegacyIntegrationPath,
} from '../src/runtime-http-handler.js';

test('旧版爆款雷达容器只能用回滚凭据访问兼容入口', () => {
  const expectedToken = 'rollback-token-with-enough-entropy';
  assert.equal(isBoomLegacyIntegrationAuthorized({
    remoteAddress:'172.17.0.2',
    authorization:`Bearer ${expectedToken}`,
    expectedToken,
  }), true);
  assert.equal(isBoomLegacyIntegrationAuthorized({
    remoteAddress:'172.17.0.2',
    authorization:'Bearer wrong-token',
    expectedToken,
  }), false);
  assert.equal(isBoomLegacyIntegrationAuthorized({
    remoteAddress:'172.17.0.2',
    authorization:`Bearer ${expectedToken}`,
    expectedToken:'',
  }), false);
  assert.equal(isBoomLegacyIntegrationAuthorized({
    remoteAddress:'127.0.0.1',
    authorization:'',
    expectedToken:'',
  }), true);
  assert.equal(isBoomLegacyIntegrationPath('/api/integrations/boom-monitor/health'), true);
  assert.equal(isBoomLegacyIntegrationPath('/api/integrations/boom-monitor/metrics'), true);
  assert.equal(isBoomLegacyIntegrationPath('/api/overview'), false);
});

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

test('HTTP JSON 入口拒绝畸形和超限请求体且不进入业务处理器', async (context) => {
  let calls = 0;
  const fixture = await startHandler(context, {
    paperclipCampaignDaily:{
      async handle() {
        calls += 1;
        return { status:'unexpected' };
      },
    },
  });

  const malformed = await fetch(`${fixture.baseUrl}/api/paperclip/m5-daily-heartbeat`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:'{"source":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error:'请求体不是有效 JSON。' });

  const oversized = await fetch(`${fixture.baseUrl}/api/paperclip/m5-daily-heartbeat`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ source:'x'.repeat(1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error:'请求体超过 1 MiB 限制。' });
  assert.equal(calls, 0);
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

test('爆款雷达指标入口只代理本机小D的脱敏指标包', async (context) => {
  const expected = { schemaVersion:'agent.army/boom-metrics-bundle/v1', status:'collected' };
  const fixture = await startHandler(context, {}, {
    boomMonitorEnabled:false,
    xiaod:{
      async collectMetrics(input) {
        assert.deepEqual(input, { url:'https://www.douyin.com/video/target', historyLimit:20 });
        return expected;
      },
    },
  });

  const response = await fetch(`${fixture.baseUrl}/api/integrations/boom-monitor/metrics`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ url:'https://www.douyin.com/video/target', historyLimit:20 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { metrics:expected });
});

test('飞书投递不确定只能按原任务会话在本机显式核对', async (context) => {
  const calls = [];
  const task = { taskId:'11111111-1111-4111-a111-111111111111', source:{ channel:'feishu', chatRef:'oc_original' } };
  const fixture = await startHandler(context, {}, {
    store:{ async list() { return [task]; } }
  }, {
    hermesNativeCompletionWatcher:{
      async resolveDelivery(input) { calls.push(input); return { resolved:true, outcome:input.outcome, taskId:input.taskId }; }
    }
  });

  const response = await fetch(`${fixture.baseUrl}/api/mcp/completion-watches/resolve`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ taskId:task.taskId, chatRef:'oc_original', outcome:'delivered' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ taskId:task.taskId, chatId:'oc_original', outcome:'delivered' }]);
});

test('旧版爆款雷达回滚桥提供无副作用健康探针', async (context) => {
  const fixture = await startHandler(context, {}, { boomMonitorEnabled:false });
  const response = await fetch(`${fixture.baseUrl}/api/integrations/boom-monitor/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status:'ready', mode:'legacy_rollback_bridge' });
});

test('native writer 启用时旧版爆款雷达回滚桥失败关闭', async (context) => {
  const fixture = await startHandler(context, {}, { boomMonitorEnabled:true });
  const response = await fetch(`${fixture.baseUrl}/api/integrations/boom-monitor/health`);
  assert.equal(response.status, 503);
});

async function startHandler(context, paperclipOverrides = {}, workOverrides = {}, feishuOverrides = {}) {
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
      xiaod:unreachable(),
      ...workOverrides,
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
      ...feishuOverrides,
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
