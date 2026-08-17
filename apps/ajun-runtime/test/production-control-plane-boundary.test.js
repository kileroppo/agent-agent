import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createAjunHttpHandler,
  createOwnerActionSession,
  isBoomLegacyIntegrationAuthorized,
  isBoomLegacyIntegrationPath,
} from '../src/runtime-http-handler.ts';

test('本机动作 nonce 只在进程内短期有效', () => {
  let now = Date.parse('2026-08-08T08:00:00.000Z');
  const session = createOwnerActionSession({ clock:() => now, ttlMs:2_000 });
  const issued = session.issue();
  assert.equal(session.authorize(issued.nonce), true);
  assert.equal(session.authorize(`${issued.nonce}x`), false);
  now += 2_001;
  assert.equal(session.authorize(issued.nonce), false);
  assert.notEqual(session.issue().nonce, issued.nonce);
});

test('轻量健康接口不要求局域网口令，只读取裁剪后的健康状态', async (context) => {
  const calls = [];
  const health = {
    schemaVersion:'agent.army/runtime-health/v1',
    status:'healthy',
    core:{ status:'healthy', components:[] },
    optional:{ components:[] },
    summary:{ employeeCount:2 },
  };
  const fixture = await startHandler(context, {}, {
    tasks:{
      async healthOverview(options) {
        calls.push(options);
        return health;
      },
    },
  }, {}, undefined, {
    lanEnabled:true,
    lanAccess:{ enabled:true, key:'lan-secret' },
  });

  const response = await fetch(`${fixture.baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), health);
  assert.deepEqual(calls, [{ optionalModules:[
    { id:'m5-runtime', name:'M5 内容运营', status:'disabled', detail:'需要时设置 AJUN_M5_RUNTIME_ENABLED=true 后重新发布。' },
    { id:'boom-monitor', name:'爆款雷达', status:'disabled', detail:'爆款雷达已关闭；需要时设置 AJUN_BOOM_MONITOR_ENABLED=true。' },
    { id:'product-maturity', name:'产品成熟度验证', status:'disabled', detail:'需要验证时启用 M5 管理工具。' },
  ] }]);
});

test('运行台工作流验收要求本机同源、owner nonce、版本和幂等键', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {}, {
    tasks:{
      async recordWorkflowAcceptance(workflowId, input) {
        if (input.decision === 'revision_required') {
          const error = new Error('这件工作的验收状态刚刚发生变化，请刷新后再操作。');
          error.code = 'workflow_acceptance_version_conflict';
          throw error;
        }
        calls.push([workflowId, input]);
        return { acceptance:{ workflowId, decision:input.decision, version:1 }, duplicate:false };
      },
    },
  });
  const workflowPath = encodeURIComponent('workflow:business-1');
  const url = `${fixture.baseUrl}/api/workflows/${workflowPath}/acceptance`;
  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const baseHeaders = {
    'content-type':'application/json',
    origin:fixture.baseUrl,
    'x-ajun-owner-action':session.nonce,
  };

  const missingOrigin = await fetch(url, {
    method:'POST',
    headers:{ ...baseHeaders, origin:'http://invalid.example', 'idempotency-key':'acceptance-1' },
    body:JSON.stringify({ decision:'accepted', expectedRevision:0 }),
  });
  assert.equal(missingOrigin.status, 403);

  const missingKey = await fetch(url, {
    method:'POST', headers:baseHeaders,
    body:JSON.stringify({ decision:'accepted', expectedRevision:0 }),
  });
  assert.equal(missingKey.status, 422);
  assert.deepEqual(await missingKey.json(), { error:'缺少本次操作编号，请刷新任务详情后重试。' });

  const invalidVersion = await fetch(url, {
    method:'POST', headers:{ ...baseHeaders, 'idempotency-key':'acceptance-1' },
    body:JSON.stringify({ decision:'accepted', expectedRevision:'0' }),
  });
  assert.equal(invalidVersion.status, 422);
  assert.deepEqual(await invalidVersion.json(), { error:'验收版本号无效，请刷新任务详情后重试。' });

  const accepted = await fetch(url, {
    method:'POST', headers:{ ...baseHeaders, 'idempotency-key':'acceptance-1' },
    body:JSON.stringify({ decision:'accepted', note:'可以使用', expectedRevision:0 }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    acceptance:{ workflowId:'workflow:business-1', decision:'accepted', version:1 },
    duplicate:false,
  });
  assert.deepEqual(calls, [['workflow:business-1', {
    decision:'accepted',
    note:'可以使用',
    expectedVersion:0,
    idempotencyKey:'acceptance-1',
    source:'local_console',
  }]]);

  const stale = await fetch(url, {
    method:'POST', headers:{ ...baseHeaders, 'idempotency-key':'acceptance-2' },
    body:JSON.stringify({ decision:'revision_required', expectedRevision:0 }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error:'这件工作的验收状态刚刚发生变化，请刷新后再操作。' });
});

test('内嵌浏览器缺少 Origin 时可用同源 Referer 证明，跨站 Referer 仍被拒绝', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {}, {
    tasks:{
      async recordWorkflowAcceptance(workflowId, input) {
        calls.push([workflowId, input]);
        return { acceptance:{ workflowId, decision:input.decision, version:1 }, duplicate:false };
      },
    },
  });
  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const url = `${fixture.baseUrl}/api/workflows/${encodeURIComponent('workflow:embedded-browser')}/acceptance`;
  const headers = {
    'content-type':'application/json',
    referer:`${fixture.baseUrl}/tasks/00000000-0000-0000-0000-000000000001`,
    'idempotency-key':'embedded-browser-acceptance',
    'x-ajun-owner-action':session.nonce,
  };
  const accepted = await fetch(url, {
    method:'POST', headers,
    body:JSON.stringify({ decision:'accepted', expectedRevision:0 }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);

  const rejected = await fetch(url, {
    method:'POST', headers:{ ...headers, referer:'https://invalid.example/tasks/1', 'idempotency-key':'cross-site-acceptance' },
    body:JSON.stringify({ decision:'accepted', expectedRevision:0 }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 1);
});

test('版本管理写操作只允许本机同源 owner 会话', async (context) => {
  const calls = [];
  const runtimeRelease = {
    async status() { return { state:'idle' }; },
    async action(action, input) {
      calls.push([action, input]);
      return { accepted:true, duplicate:false, status:{ state:'checking' } };
    },
  };
  const fixture = await startHandler(context, {}, {}, {}, runtimeRelease);
  assert.deepEqual(await (await fetch(`${fixture.baseUrl}/api/runtime-release/status`)).json(), { status:{ state:'idle' } });
  const denied = await fetch(`${fixture.baseUrl}/api/runtime-release/check`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:'{}',
  });
  assert.equal(denied.status, 403);
  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const spoofed = await fetch(`${fixture.baseUrl}/api/runtime-release/check`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-ajun-owner-action':session.nonce,
      'x-ajun-console-origin':'http://evil.example',
    },
    body:'{}',
  });
  assert.equal(spoofed.status, 403);
  const webviewAccepted = await fetch(`${fixture.baseUrl}/api/runtime-release/check`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-ajun-owner-action':session.nonce,
      'x-ajun-console-origin':fixture.baseUrl,
    },
    body:'{}',
  });
  assert.equal(webviewAccepted.status, 202);
  const accepted = await fetch(`${fixture.baseUrl}/api/runtime-release/publish`, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:fixture.baseUrl, 'x-ajun-owner-action':session.nonce },
    body:JSON.stringify({ confirm:'publish_current_commit' }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [
    ['check', {}],
    ['publish', { confirm:'publish_current_commit' }],
  ]);
});

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

test('本机 AI 运行事件只通过本机 Paperclip 受保护路由写入', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {}, {
    tasks:{
      async recordPaperclipLocalAiRunEvent(input) {
        calls.push(input);
        return { recorded:true, eventId:'event-local-ai' };
      },
    },
  });
  const response = await fetch(`${fixture.baseUrl}/api/mcp/local-ai-run-event`, {
    method:'POST',
    headers:{ 'content-type':'application/json', authorization:'Bearer paperclip-test-key' },
    body:JSON.stringify({
      issueId:'issue-1', runId:'run-1', paperclipAgentId:'agent-1', agentArmyId:'xiaod',
      taskId:'task-1',
      event:{ eventType:'capability_call_started', capabilityId:'audio.transcribe', status:'running' },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recorded, true);
  assert.equal(calls[0].paperclipApiKey, 'paperclip-test-key');
  assert.equal(calls[0].taskId, 'task-1');
});

test('任务字幕读取与补正仅走本机 owner 会话并返回同步后的源任务', async (context) => {
  const taskId = '123e4567-e89b-42d3-a456-426614174001';
  const calls = [];
  const revision = {
    jobId:'xiaod-1', transcript:'AI 初稿', version:1,
    confirmationMode:'automatic', completeListen:false, correctionApplied:false, canRevise:true,
  };
  const fixture = await startHandler(context, {}, {
    tasks:{
      async getTranscriptRevision(receivedTaskId) {
        calls.push(['get', receivedTaskId]);
        return revision;
      },
      async reviseTranscript(receivedTaskId, input) {
        calls.push(['revise', receivedTaskId, input]);
        return {
          task:{ taskId:receivedTaskId, status:'succeeded', artifactRefs:[{ type:'confirmed_transcript' }] },
          revision:{ ...revision, transcript:input.correctedTranscript, version:2, correctionApplied:true },
          duplicate:false,
        };
      },
    },
  });

  const deniedRead = await fetch(`${fixture.baseUrl}/api/tasks/${taskId}/transcript-revision`);
  assert.equal(deniedRead.status, 403);
  const readSession = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const read = await fetch(`${fixture.baseUrl}/api/tasks/${taskId}/transcript-revision`, {
    headers:{ origin:fixture.baseUrl, 'x-ajun-owner-action':readSession.nonce },
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { revision });

  const rejected = await fetch(`${fixture.baseUrl}/api/tasks/${taskId}/transcript-revisions`, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:fixture.baseUrl },
    body:JSON.stringify({ expectedVersion:1, correctedTranscript:'AI 初稿（已补正）' }),
  });
  assert.equal(rejected.status, 403);

  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const saved = await fetch(`${fixture.baseUrl}/api/tasks/${taskId}/transcript-revisions`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      origin:fixture.baseUrl,
      'x-ajun-owner-action':session.nonce,
    },
    body:JSON.stringify({
      expectedVersion:1,
      correctedTranscript:'AI 初稿（已补正）',
      correctionSummary:'局部纠错',
      editorRef:'A君',
    }),
  });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.task.taskId, taskId);
  assert.equal(payload.revision.version, 2);
  assert.deepEqual(calls, [
    ['get', taskId],
    ['revise', taskId, {
      expectedVersion:1,
      correctedTranscript:'AI 初稿（已补正）',
      correctionSummary:'局部纠错',
      editorRef:'A君',
    }],
  ]);
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

test('恢复 POST 要求本机同源 JSON、短期 nonce 和 header 幂等键', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {}, {
    tasks:{
      async requestRecovery(taskId, input, actor) {
        calls.push({ taskId, input, actor });
        return { status:'accepted', taskId, actionKey:input.actionKey };
      },
    },
  });
  const taskId = '11111111-1111-4111-a111-111111111111';
  const url = `${fixture.baseUrl}/api/tasks/${taskId}/recovery-actions/request_safe_recovery`;
  const sessionResponse = await fetch(`${fixture.baseUrl}/api/owner-action-session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(typeof session.nonce, 'string');
  assert.equal(Number.isFinite(Date.parse(session.expiresAt)), true);

  const missingJson = await fetch(url, { method:'POST', body:'{}' });
  assert.equal(missingJson.status, 415);
  const crossOrigin = await fetch(url, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:'https://evil.example', 'x-ajun-owner-action':session.nonce, 'idempotency-key':'recovery-request-http-1' },
    body:JSON.stringify({ expectedUpdatedAt:'2026-08-08T08:00:00.000Z' }),
  });
  assert.equal(crossOrigin.status, 403);
  const missingNonce = await fetch(url, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:fixture.baseUrl, 'idempotency-key':'recovery-request-http-1' },
    body:JSON.stringify({ expectedUpdatedAt:'2026-08-08T08:00:00.000Z' }),
  });
  assert.equal(missingNonce.status, 403);
  const accepted = await fetch(url, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      origin:fixture.baseUrl,
      'x-ajun-owner-action':session.nonce,
      'idempotency-key':'recovery-request-http-1',
    },
    body:JSON.stringify({ expectedUpdatedAt:'2026-08-08T08:00:00.000Z', requestId:'body-must-not-win' }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { status:'accepted', taskId, actionKey:'request_safe_recovery' });
  const visionSession = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const visionAccepted = await fetch(
    `${fixture.baseUrl}/api/tasks/${taskId}/recovery-actions/retry_visual_analysis_after_recovery`,
    {
      method:'POST',
      headers:{
        'content-type':'application/json',
        origin:fixture.baseUrl,
        'x-ajun-owner-action':visionSession.nonce,
        'idempotency-key':'recovery-request-http-vision-1',
      },
      body:JSON.stringify({ expectedUpdatedAt:'2026-08-08T08:00:00.000Z' }),
    },
  );
  assert.equal(visionAccepted.status, 202);
  assert.deepEqual(calls, [
    {
      taskId,
      input:{ actionKey:'request_safe_recovery', expectedUpdatedAt:'2026-08-08T08:00:00.000Z', requestId:'recovery-request-http-1' },
      actor:{ kind:'local-owner', ref:'A君' },
    },
    {
      taskId,
      input:{ actionKey:'retry_visual_analysis_after_recovery', expectedUpdatedAt:'2026-08-08T08:00:00.000Z', requestId:'recovery-request-http-vision-1' },
      actor:{ kind:'local-owner', ref:'A君' },
    },
  ]);
});

test('恢复业务非合资格响应保持可分支状态，静态刷新模块可访问', async (context) => {
  const fixture = await startHandler(context, {}, {
    tasks:{ async requestRecovery(taskId, input) { return { status:'requires_external', taskId, actionKey:input.actionKey }; } },
  });
  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const taskId = '11111111-1111-4111-a111-111111111111';
  const response = await fetch(`${fixture.baseUrl}/api/tasks/${taskId}/recovery-actions/request_safe_recovery`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      origin:fixture.baseUrl,
      'x-ajun-owner-action':session.nonce,
      'idempotency-key':'recovery-request-http-2',
    },
    body:JSON.stringify({ expectedUpdatedAt:'2026-08-08T08:00:00.000Z' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'requires_external');
  const staticModule = await fetch(`${fixture.baseUrl}/refresh-scheduler.js`);
  assert.equal(staticModule.status, 200);
  assert.match(staticModule.headers.get('content-type'), /text\/javascript/);
});

test('产品成熟度批次透传接受资格，accepted 拒绝保持 409 且 revision_required 仍可登记', async (context) => {
  const calls = [];
  const fixture = await startHandler(context, {}, {
    productMaturity:{
      async create() {
        calls.push(['create']);
        return {
          batchId:'maturity-11111111-1111-4111-8111-111111111111',
          status:'ready_for_decision',
          acceptanceEligible:false,
        };
      },
      async decide(batchId, input) {
        calls.push(['decide', batchId, input]);
        if (input.decision === 'accepted') {
          throw Object.assign(new Error('当前批次没有全部通过验证，不能登记 accepted；可以登记 revision_required。'), {
            code:'maturity_batch_not_acceptance_eligible',
            httpStatus:409,
          });
        }
        return { batchId, status:input.decision, acceptanceEligible:false };
      },
    },
  });
  const denied = await fetch(`${fixture.baseUrl}/api/product-maturity/validation-batches`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:'{}',
  });
  assert.equal(denied.status, 403);
  const session = await (await fetch(`${fixture.baseUrl}/api/owner-action-session`)).json();
  const headers = { 'content-type':'application/json', origin:fixture.baseUrl, 'x-ajun-owner-action':session.nonce };
  const created = await fetch(`${fixture.baseUrl}/api/product-maturity/validation-batches`, { method:'POST', headers, body:'{}' });
  assert.equal(created.status, 202);
  const batch = await created.json();
  assert.equal(batch.status, 'ready_for_decision');
  assert.equal(batch.acceptanceEligible, false);
  const rejected = await fetch(`${fixture.baseUrl}/api/product-maturity/validation-batches/${batch.batchId}/decision`, {
    method:'POST', headers, body:JSON.stringify({ decision:'accepted', evidenceHash:'hash-1' }),
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error:'当前批次没有全部通过验证，不能登记 accepted；可以登记 revision_required。',
  });
  const decided = await fetch(`${fixture.baseUrl}/api/product-maturity/validation-batches/${batch.batchId}/decision`, {
    method:'POST', headers, body:JSON.stringify({ decision:'revision_required', evidenceHash:'hash-1' }),
  });
  assert.equal(decided.status, 200);
  assert.deepEqual(await decided.json(), {
    batchId:batch.batchId,
    status:'revision_required',
    acceptanceEligible:false,
  });
  assert.deepEqual(calls, [
    ['create'],
    ['decide', batch.batchId, { decision:'accepted', evidenceHash:'hash-1' }],
    ['decide', batch.batchId, { decision:'revision_required', evidenceHash:'hash-1' }],
  ]);
});

async function startHandler(context, paperclipOverrides = {}, workOverrides = {}, feishuOverrides = {}, runtimeRelease = undefined, networkOverrides = {}) {
  const handler = createAjunHttpHandler({
    environment:{},
    publicDir:new URL('../public', import.meta.url).pathname,
    dataDir:'/tmp/agent-army-http-handler-test',
    detailBaseUrl:'http://127.0.0.1',
    network:{ deploymentMode:'local', lanEnabled:false, lanAccess:{ enabled:false, key:null }, ...networkOverrides },
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
    runtimeRelease,
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
