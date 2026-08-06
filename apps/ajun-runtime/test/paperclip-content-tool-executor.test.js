import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M5ToolExecutorRouter,
  PaperclipContentToolExecutor,
  PaperclipContentToolExecutorError,
} from '../src/paperclip-content-tool-executor.js';
import { buildContentAutonomyApprovalSnapshot } from '../src/content-autonomy-plugin-snapshot.js';

const ids = Object.freeze({
  company:'11111111-1111-4111-8111-111111111111',
  campaign:'22222222-2222-4222-8222-222222222222',
  contentCase:'33333333-3333-4333-8333-333333333333',
  outsiderCase:'44444444-4444-4444-8444-444444444444',
  pipeline:'55555555-5555-4555-8555-555555555555',
  project:'66666666-6666-4666-8666-666666666666',
  issue:'77777777-7777-4777-8777-777777777777',
  agent:'88888888-8888-4888-8888-888888888888',
  run:'99999999-9999-4999-8999-999999999999',
  costEvent:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  submission:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});

const toolId = 'agent-army.content-autonomy:stepfun-image-generate';
const actionId = 'campaign:day1:image:cover';
const pluginRecord = Object.freeze({
  id:'agent-army.content-autonomy',
  pluginKey:'agent-army.content-autonomy',
  version:'0.2.0',
  status:'ready',
  manifestJson:{ id:'agent-army.content-autonomy', version:'0.2.0', tools:['fixture'] },
});
const configRecord = Object.freeze({
  configJson:{
    costRatesCents:{
      visionInputPerMillionTokens:100,
      visionOutputPerMillionTokens:200,
      imagePerGeneration:3,
      ttsPerThousandCharacters:4,
    },
  },
});
const pluginApproval = Object.freeze(buildContentAutonomyApprovalSnapshot({
  plugin:pluginRecord,
  configRecord,
}));
const budgetTicketAuthority = Object.freeze({
  sign:({ actionId, maximumCostCents }) => `fixture-ticket:${actionId}:${maximumCostCents}`,
});

function contentExecutor(adapter) {
  return new PaperclipContentToolExecutor({ adapter, budgetTicketAuthority });
}

test('A君从Paperclip活动子Case派生真实运行并完成费用pending到confirmed', async () => {
  const adapter = new ContentToolFakeAdapter();
  const executor = contentExecutor(adapter);
  const input = executionInput();

  const first = await executor.execute(input);
  const replay = await executor.execute(input);

  assert.equal(first.costCommit.status, 'confirmed');
  assert.equal(first.costCommit.costEventId, ids.costEvent);
  assert.equal(first.nextStageAllowed, true);
  assert.equal(replay.replayed, true);
  assert.equal(adapter.costPosts, 1);
  assert.equal(adapter.providerCalls, 1);

  const pluginCalls = adapter.calls.filter((item) =>
    item.method === 'POST' && item.path === '/api/plugins/tools/execute'
  );
  assert.deepEqual(pluginCalls[0].body.runContext, {
    companyId:ids.company,
    projectId:ids.project,
    agentId:ids.agent,
    runId:ids.run,
  });
  assert.equal(pluginCalls[0].body.tool, toolId);
  assert.equal(
    pluginCalls[0].body.parameters.budgetTicket,
    `fixture-ticket:${actionId}:3`,
  );
  assert.equal(adapter.calls.some((item) =>
    item.path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-claim'
    && item.body.companyId === ids.company
    && item.body.params.runContext.runId === ids.run
  ), true);
  assert.equal(adapter.calls.some((item) =>
    item.path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-confirm'
    && item.body.params.costEventId === ids.costEvent
  ), true);
});

test('A君缺少预算票据私钥时在Provider前失败关闭', async () => {
  const adapter = new ContentToolFakeAdapter();
  const executor = new PaperclipContentToolExecutor({ adapter });
  await assert.rejects(
    executor.execute(executionInput()),
    (error) => error?.code === 'paperclip_budget_ticket_unavailable',
  );
  assert.equal(adapter.providerCalls, 0);
  assert.equal(adapter.costPosts, 0);
});

test('调用方不能伪造agentId、runId、companyId、projectId或runContext', async () => {
  for (const forbidden of ['agentId', 'runId', 'companyId', 'projectId', 'runContext']) {
    const adapter = new ContentToolFakeAdapter();
    const executor = contentExecutor(adapter);
    await assert.rejects(
      executor.execute({ ...executionInput(), [forbidden]:'forged' }),
      (error) => error instanceof PaperclipContentToolExecutorError
        && /执行身份只能从 Paperclip 当前活动子 Case 派生/.test(error.message),
    );
    assert.equal(adapter.calls.length, 0);
  }
});

test('调用方不能提交campaignCase或campaignGrant冒充Paperclip活动授权', async () => {
  for (const forged of [
    { campaignCase:caseDetail(ids.campaign, null) },
    { campaignGrant:{ status:'active', pluginApproval } },
  ]) {
    const adapter = new ContentToolFakeAdapter();
    const executor = contentExecutor(adapter);
    await assert.rejects(
      executor.execute({ ...executionInput(), ...forged }),
      /不得提交权限字段/,
    );
    assert.equal(adapter.calls.length, 0);
    assert.equal(adapter.providerCalls, 0);
  }
});

test('Paperclip父Case缺少CampaignGrant时不接受调用方补交并在插件前失败', async () => {
  const adapter = new ContentToolFakeAdapter();
  adapter.campaignGrant = null;
  const executor = contentExecutor(adapter);
  await assert.rejects(
    executor.execute(executionInput()),
    /缺少可信 CampaignGrant/,
  );
  assert.equal(adapter.providerCalls, 0);
});

test('HTTP工具入口必须用当前短期Run凭证匹配canonical岗位和公司', async () => {
  const validRunJwt = runJwt();
  const missing = new ContentToolFakeAdapter();
  await assert.rejects(
    contentExecutor(missing).execute(
      executionInput(),
      { requireRunAuthentication:true },
    ),
    (error) => error.code === 'paperclip_run_auth_required',
  );
  assert.equal(missing.providerCalls, 0);

  const opaque = new ContentToolFakeAdapter();
  await assert.rejects(
    contentExecutor(opaque).execute(
      executionInput(),
      { requireRunAuthentication:true, paperclipApiKey:'long-lived-agent-api-key' },
    ),
    (error) => error.code === 'paperclip_run_auth_invalid',
  );
  assert.deepEqual(opaque.authCalls, []);
  assert.equal(opaque.providerCalls, 0);

  const invalid = new ContentToolFakeAdapter();
  invalid.authError = true;
  await assert.rejects(
    contentExecutor(invalid).execute(
      executionInput(),
      { requireRunAuthentication:true, paperclipApiKey:validRunJwt },
    ),
    (error) => error.code === 'paperclip_run_auth_invalid',
  );
  assert.equal(invalid.providerCalls, 0);

  const mismatch = new ContentToolFakeAdapter();
  mismatch.authActor = { id:ids.outsiderCase, companyId:ids.company };
  await assert.rejects(
    contentExecutor(mismatch).execute(
      executionInput(),
      { requireRunAuthentication:true, paperclipApiKey:validRunJwt },
    ),
    (error) => error.code === 'paperclip_run_auth_mismatch',
  );
  assert.equal(mismatch.providerCalls, 0);

  const accepted = new ContentToolFakeAdapter();
  await contentExecutor(accepted).execute(
    executionInput(),
    { requireRunAuthentication:true, paperclipApiKey:validRunJwt },
  );
  assert.deepEqual(accepted.authCalls, [{
    apiKey:validRunJwt,
    runId:ids.run,
  }]);
  assert.equal(accepted.providerCalls, 1);
});

test('Run JWT在Paperclip验签前拒绝错误算法、跨范围、过期和超长有效期', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    'malformed.jwt',
    runJwt({}, { alg:'none' }),
    runJwt({ sub:ids.outsiderCase }),
    runJwt({ company_id:ids.outsiderCase }),
    runJwt({ run_id:ids.outsiderCase }),
    runJwt({ exp:now - 1, iat:now - 60 }),
    runJwt({ exp:now + 7_201, iat:now }),
    runJwt({ iat:now + 61, exp:now + 120 }),
  ];
  for (const token of cases) {
    const adapter = new ContentToolFakeAdapter();
    await assert.rejects(
      contentExecutor(adapter).execute(
        executionInput(),
        { requireRunAuthentication:true, paperclipApiKey:token },
      ),
      (error) => error.code === 'paperclip_run_auth_invalid',
    );
    assert.deepEqual(adapter.authCalls, []);
    assert.equal(adapter.providerCalls, 0);
  }
});

test('嵌套CampaignGrant、账号、平台、预算和限额在接触插件前拒绝', async () => {
  for (const parameters of [
    { campaignGrant:{ status:'active' } },
    { nested:{ accountRef:'account:forged' } },
    { contentVersion:{ platform:'xiaohongshu' } },
    { grant:{ budgetCents:999999 } },
    { limits:{ totalPublishLimit:999 } },
  ]) {
    const adapter = new ContentToolFakeAdapter();
    const executor = contentExecutor(adapter);
    await assert.rejects(
      executor.execute({ ...executionInput(), parameters }),
      /不得携带权限字段/,
    );
    assert.equal(adapter.calls.length, 0);
    assert.equal(adapter.providerCalls, 0);
  }
  const adapter = new ContentToolFakeAdapter();
  const executor = contentExecutor(adapter);
  await assert.rejects(
    executor.execute({
      ...executionInput(),
      reviewReport:{ status:'passed', nested:{ campaignGrant:{ budgetCents:999999 } } },
    }),
    /不得携带权限字段/,
  );
  assert.equal(adapter.calls.length, 0);
});

test('campaign-preflight与publish-preflight只接收Paperclip覆盖的活动和平台范围', async () => {
  const adapter = new ContentToolFakeAdapter();
  const executor = contentExecutor(adapter);
  await executor.execute({
    ...executionInput(),
    toolId:'agent-army.content-autonomy:campaign-preflight',
    parameters:{},
  });
  adapter.targetFields = {
    platform:'douyin',
    scheduledDate:'2026-07-30',
  };
  await executor.execute({
    ...executionInput(),
    toolId:'agent-army.content-autonomy:publish-preflight',
    parameters:{
      contentVersion:{ contentVersionId:'v1', checksum:'sha256:fixture' },
      reviewReport:{ status:'passed', checks:{} },
    },
  });

  const pluginCalls = adapter.calls.filter((item) =>
    item.method === 'POST' && item.path === '/api/plugins/tools/execute'
  );
  assert.equal(pluginCalls[0].body.parameters.campaign.status, 'active');
  assert.deepEqual(pluginCalls[1].body.parameters, {
    campaignId:ids.campaign,
    campaign:{ status:'active', pluginApproval },
    contentVersion:{
      contentVersionId:'v1',
      checksum:'sha256:fixture',
      platform:'douyin',
    },
    reviewReport:{ status:'passed', checks:{} },
    platform:'douyin',
    scheduledDate:'2026-07-30',
  });
});

test('目标Case必须属于活动且恰好存在一个匹配岗位的运行中Run', async (context) => {
  await context.test('拒绝活动外Case', async () => {
    const adapter = new ContentToolFakeAdapter();
    const executor = contentExecutor(adapter);
    await assert.rejects(
      executor.execute({ ...executionInput(), caseId:ids.outsiderCase }),
      /不属于当前活动/,
    );
    assert.equal(adapter.providerCalls, 0);
  });

  await context.test('拒绝多个运行中Run', async () => {
    const adapter = new ContentToolFakeAdapter();
    adapter.liveRuns.push({ ...adapter.liveRuns[0], id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const executor = contentExecutor(adapter);
    await assert.rejects(executor.execute(executionInput()), /必须恰好存在一个/);
    assert.equal(adapter.providerCalls, 0);
  });
});

test('费用草稿与可信runContext不一致时不提交Paperclip费用', async () => {
  const adapter = new ContentToolFakeAdapter();
  adapter.costAgentOverride = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const executor = contentExecutor(adapter);
  await assert.rejects(executor.execute(executionInput()), /费用事件与当前 Paperclip 运行不一致/);
  assert.equal(adapter.costPosts, 0);
});

test('Paperclip费用提交结果不确定时占住租约，重试不再调用模型或重复记账', async () => {
  const adapter = new ContentToolFakeAdapter();
  adapter.failCostPost = true;
  const executor = contentExecutor(adapter);
  await assert.rejects(executor.execute(executionInput()), /提交租约保持占用且不会自动重试/);
  await assert.rejects(executor.execute(executionInput()), /预算门闩.*关闭|禁止自动重试/);
  assert.equal(adapter.providerCalls, 1);
  assert.equal(adapter.costPosts, 1);
});

test('Paperclip项目预算不足时在调用Provider前拒绝', async () => {
  const adapter = new BudgetGateFakeAdapter({ remainingAmount:2 });
  const executor = contentExecutor(adapter);

  await assert.rejects(
    executor.execute(executionInput()),
    (error) => error.code === 'paperclip_budget_insufficient',
  );
  assert.equal(adapter.providerCalls, 0);
  assert.equal(adapter.costPosts, 0);
});

test('公司、岗位、Project任一预算缺失时都在调用Provider前拒绝', async () => {
  for (const missingScope of ['company', 'agent', 'project']) {
    const adapter = new BudgetGateFakeAdapter({ remainingAmount:30, missingScope });
    const executor = contentExecutor(adapter);
    await assert.rejects(
      executor.execute(executionInput()),
      (error) => error.code === 'paperclip_budget_insufficient',
    );
    assert.equal(adapter.providerCalls, 0);
    assert.equal(adapter.costPosts, 0);
  }
});

test('活动批准后插件版本或配置漂移时在调用Provider前拒绝', async () => {
  const adapter = new ContentToolFakeAdapter();
  adapter.configDrift = true;
  const executor = contentExecutor(adapter);

  await assert.rejects(
    executor.execute(executionInput()),
    (error) => error.code === 'content_plugin_approval_drift',
  );
  assert.equal(adapter.providerCalls, 0);
  assert.equal(adapter.costPosts, 0);
});

test('2到4个并发付费调用按Paperclip remaining串行，最多只放行预算覆盖的调用', async () => {
  const adapter = new BudgetGateFakeAdapter({ remainingAmount:3 });
  const executor = contentExecutor(adapter);
  const attempts = await Promise.allSettled(
    [1, 2, 3, 4].map((index) => executor.execute({
      ...executionInput(),
      parameters:{
        ...executionInput().parameters,
        actionId:`campaign:day1:image:cover:${index}`,
      },
    })),
  );

  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) =>
    item.status === 'rejected' && item.reason?.code === 'paperclip_budget_insufficient'
  ).length, 3);
  assert.equal(adapter.providerCalls, 1);
  assert.equal(adapter.costPosts, 1);
  assert.equal(adapter.maxConcurrentProviderCalls, 1);
  assert.ok(adapter.budgetReads >= 4);
});

test('路由器保留fake Publisher并只把内容插件命名空间交给Paperclip适配器', async () => {
  const calls = [];
  const trustedContext = {
    campaignCaseId:ids.campaign,
    targetCase:{
      id:ids.contentCase,
      stageKey:'publish',
      fields:{ platform:'douyin', scheduledDate:'2026-07-30' },
    },
    runContext:{ runId:ids.run },
  };
  const router = new M5ToolExecutorRouter({
    publisherExecutor:{
      execute:async (input, context) => {
        assert.equal(context, trustedContext);
        calls.push(['publisher', input.toolId]);
        return 'publisher';
      },
    },
    contentExecutor:{
      resolveContext:async () => trustedContext,
      execute:async (input) => { calls.push(['content', input.toolId]); return 'content'; },
    },
  });
  assert.equal(await router.execute({
    toolId:'publisher.fake_publish',
    platform:'douyin',
    scheduledDate:'2026-07-30',
  }), 'publisher');
  await assert.rejects(router.execute({
    toolId:'publisher.fake_publish',
    platform:'xiaohongshu',
    scheduledDate:'2026-07-30',
  }), /平台.*不一致/);
  assert.equal(await router.execute({ toolId }), 'content');
  await assert.rejects(router.execute({ toolId:'other.tool' }), /不在 M5 受控工具范围/);
  assert.deepEqual(calls, [
    ['publisher', 'publisher.fake_publish'],
    ['content', toolId],
  ]);
});

function executionInput() {
  return {
    campaignCaseId:ids.campaign,
    caseId:ids.contentCase,
    toolId,
    parameters:{
      actionId,
      prompt:'fixture',
      outputPath:'day-1/cover.png',
    },
  };
}

function caseDetail(id, parentCaseId) {
  return {
    id,
    parentCaseId,
    pipelineId:ids.pipeline,
    pipeline:{ id:ids.pipeline, projectId:ids.project },
    ...(parentCaseId ? {} : { fields:{ campaignGrant:{ status:'active', pluginApproval } } }),
  };
}

function runJwt(claimOverrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg:'HS256',
    typ:'JWT',
    ...headerOverrides,
  };
  const claims = {
    sub:ids.agent,
    company_id:ids.company,
    adapter_type:'hermes',
    run_id:ids.run,
    iat:now - 1,
    exp:now + 3_599,
    iss:'paperclip',
    aud:'paperclip-api',
    instance_id:'fixture',
    ...claimOverrides,
  };
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded(header)}.${encoded(claims)}.fixture-signature`;
}

class ContentToolFakeAdapter {
  constructor() {
    this.companyId = ids.company;
    this.calls = [];
    this.costPosts = 0;
    this.providerCalls = 0;
    this.state = 'new';
    this.costAgentOverride = null;
    this.failCostPost = false;
    this.targetFields = {};
    this.configDrift = false;
    this.campaignGrant = { status:'active', pluginApproval };
    this.liveRuns = [{
      id:ids.run,
      companyId:ids.company,
      agentId:ids.agent,
      status:'running',
    }];
    this.authError = false;
    this.authActor = { id:ids.agent, companyId:ids.company };
    this.authCalls = [];
  }

  async authenticateRun(input) {
    this.authCalls.push(structuredClone(input));
    if (this.authError) throw new Error('invalid fixture token');
    return structuredClone(this.authActor);
  }

  async request(method, path, body) {
    this.calls.push({ method, path, body:body ? structuredClone(body) : undefined });
    if (method === 'GET' && path === '/api/plugins') return [pluginRecord];
    if (method === 'GET' && path === `/api/cases/${ids.campaign}`) {
      return {
        case:{
          ...caseDetail(ids.campaign, null),
          fields:this.campaignGrant ? { campaignGrant:this.campaignGrant } : {},
        },
        pipeline:{ id:ids.pipeline, projectId:ids.project },
      };
    }
    if (method === 'GET' && path === `/api/cases/${ids.contentCase}`) {
      return { case:{ ...caseDetail(ids.contentCase, ids.campaign), fields:this.targetFields }, pipeline:{ id:ids.pipeline, projectId:ids.project }, activeWork:{
        issueId:ids.issue,
        agentId:ids.agent,
      } };
    }
    if (method === 'GET' && path === `/api/cases/${ids.outsiderCase}`) {
      return { case:caseDetail(ids.outsiderCase, null), pipeline:{ id:ids.pipeline, projectId:ids.project }, activeWork:{
        issueId:ids.issue,
        agentId:ids.agent,
      } };
    }
    if (method === 'GET' && path === `/api/issues/${ids.issue}/live-runs`) return this.liveRuns;
    if (method === 'GET' && path === `/api/heartbeat-runs/${ids.run}`) return this.liveRuns[0];
    if (
      method === 'GET'
      && path === `/api/plugins/agent-army.content-autonomy/config?companyId=${ids.company}`
    ) {
      const record = structuredClone(configRecord);
      if (this.configDrift) record.configJson.costRatesCents.imagePerGeneration = 9;
      return record;
    }
    if (method === 'GET' && path === `/api/companies/${ids.company}/budgets/overview`) {
      return {
        policies:budgetPolicies({
          remainingAmount:30 - this.costPosts * 3,
        }),
      };
    }
    if (method === 'POST' && path === `/api/companies/${ids.company}/cost-events`) {
      this.costPosts += 1;
      if (this.failCostPost) throw new Error('injected ambiguous cost response');
      return { id:ids.costEvent, companyId:ids.company, ...body };
    }
    if (method === 'POST' && path === '/api/plugins/tools/execute') {
      if (body.tool === toolId) return this.executePaidTool(body);
      if (body.tool === 'agent-army.content-autonomy:campaign-preflight') {
        return routed('campaign-preflight', { content:'ok', data:{ passed:true } });
      }
      if (body.tool === 'agent-army.content-autonomy:publish-preflight') {
        return routed('publish-preflight', { content:'ok', data:{ passed:true } });
      }
    }
    if (method === 'POST' && path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-claim') {
      assert.equal(this.state, 'pending');
      assert.equal(body.companyId, ids.company);
      this.state = 'submitting';
      return {
        data:{
          content:'费用提交租约已领取。',
          data:{
            actionId,
            nextStageAllowed:false,
            costCommit:{
              status:'submitting_core_cost_event',
              submissionId:ids.submission,
              costEvent:this.costEvent(body.params.runContext),
            },
          },
        },
      };
    }
    if (method === 'POST' && path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-confirm') {
      assert.equal(this.state, 'submitting');
      assert.equal(body.params.submissionId, ids.submission);
      assert.equal(body.params.costEventId, ids.costEvent);
      this.state = 'confirmed';
      return {
        data:{
          content:'费用已确认。',
          data:{
            actionId,
            nextStageAllowed:true,
            costCommit:{ status:'confirmed', submissionId:ids.submission, costEventId:ids.costEvent },
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  executePaidTool(body) {
    if (this.state === 'confirmed') {
      return routed('stepfun-image-generate', {
        content:'已复用确认结果。',
        data:{
          actionId,
          replayed:true,
          nextStageAllowed:true,
          costCommit:{ status:'confirmed', submissionId:ids.submission, costEventId:ids.costEvent },
        },
      });
    }
    if (this.state === 'submitting') {
      return routed('stepfun-image-generate', {
        error:'cost_event_submitting: fixture',
        data:{
          actionId,
          nextStageAllowed:false,
          costCommit:{
            status:'submitting_core_cost_event',
            submissionId:ids.submission,
            costEvent:this.costEvent(body.runContext),
          },
        },
      });
    }
    this.providerCalls += 1;
    this.state = 'pending';
    return routed('stepfun-image-generate', {
      error:'cost_event_pending: fixture',
      data:{
        actionId,
        nextStageAllowed:false,
        costCommit:{ status:'pending_core_cost_event', costEvent:this.costEvent(body.runContext) },
      },
    });
  }

  costEvent(runContext) {
    return {
      agentId:this.costAgentOverride || runContext.agentId,
      projectId:runContext.projectId,
      heartbeatRunId:runContext.runId,
      provider:'stepfun',
      biller:'stepfun',
      billingType:'metered_api',
      billingCode:'m5:image_generate',
      model:'step-image-edit-2',
      inputTokens:0,
      cachedInputTokens:0,
      outputTokens:0,
      costCents:3,
      occurredAt:'2026-07-30T00:00:00.000Z',
    };
  }
}

class BudgetGateFakeAdapter {
  constructor({ remainingAmount, missingScope = null }) {
    this.companyId = ids.company;
    this.remainingAmount = remainingAmount;
    this.missingScope = missingScope;
    this.providerCalls = 0;
    this.costPosts = 0;
    this.budgetReads = 0;
    this.concurrentProviderCalls = 0;
    this.maxConcurrentProviderCalls = 0;
  }

  async request(method, path, body) {
    if (method === 'GET' && path === '/api/plugins') return [pluginRecord];
    if (method === 'GET' && path === `/api/cases/${ids.campaign}`) {
      return {
        case:caseDetail(ids.campaign, null),
        pipeline:{ id:ids.pipeline, projectId:ids.project },
      };
    }
    if (method === 'GET' && path === `/api/cases/${ids.contentCase}`) {
      return {
        case:caseDetail(ids.contentCase, ids.campaign),
        pipeline:{ id:ids.pipeline, projectId:ids.project },
        activeWork:{ issueId:ids.issue, agentId:ids.agent },
      };
    }
    if (method === 'GET' && path === `/api/issues/${ids.issue}/live-runs`) {
      return [{ id:ids.run, companyId:ids.company, agentId:ids.agent, status:'running' }];
    }
    if (method === 'GET' && path === `/api/heartbeat-runs/${ids.run}`) {
      return { id:ids.run, companyId:ids.company, agentId:ids.agent, status:'running' };
    }
    if (
      method === 'GET'
      && path === `/api/plugins/agent-army.content-autonomy/config?companyId=${ids.company}`
    ) {
      return structuredClone(configRecord);
    }
    if (method === 'GET' && path === `/api/companies/${ids.company}/budgets/overview`) {
      this.budgetReads += 1;
      return {
        policies:budgetPolicies({
          remainingAmount:this.remainingAmount,
          amount:3,
        }).filter((item) => item.scopeType !== this.missingScope),
      };
    }
    if (method === 'POST' && path === '/api/plugins/tools/execute') {
      this.providerCalls += 1;
      this.concurrentProviderCalls += 1;
      this.maxConcurrentProviderCalls = Math.max(
        this.maxConcurrentProviderCalls,
        this.concurrentProviderCalls,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.concurrentProviderCalls -= 1;
      const currentActionId = body.parameters.actionId;
      return routed('stepfun-image-generate', {
        error:'cost_event_pending: fixture',
        data:{
          actionId:currentActionId,
          nextStageAllowed:false,
          costCommit:{
            status:'pending_core_cost_event',
            costEvent:this.costEvent(body.runContext),
          },
        },
      });
    }
    if (
      method === 'POST'
      && path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-claim'
    ) {
      return {
        data:{
          content:'费用提交租约已领取。',
          data:{
            actionId:body.params.actionId,
            nextStageAllowed:false,
            costCommit:{
              status:'submitting_core_cost_event',
              submissionId:ids.submission,
              costEvent:this.costEvent(body.params.runContext),
            },
          },
        },
      };
    }
    if (method === 'POST' && path === `/api/companies/${ids.company}/cost-events`) {
      this.costPosts += 1;
      this.remainingAmount -= body.costCents;
      return { id:ids.costEvent, companyId:ids.company, ...body };
    }
    if (
      method === 'POST'
      && path === '/api/plugins/agent-army.content-autonomy/actions/cost-event-confirm'
    ) {
      return {
        data:{
          content:'费用已确认。',
          data:{
            actionId:body.params.actionId,
            nextStageAllowed:true,
            costCommit:{
              status:'confirmed',
              submissionId:ids.submission,
              costEventId:ids.costEvent,
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  costEvent(runContext) {
    return {
      agentId:runContext.agentId,
      projectId:runContext.projectId,
      heartbeatRunId:runContext.runId,
      provider:'stepfun',
      biller:'stepfun',
      billingType:'metered_api',
      billingCode:'m5:image_generate',
      model:'step-image-edit-2',
      inputTokens:0,
      cachedInputTokens:0,
      outputTokens:0,
      costCents:3,
      occurredAt:'2026-07-30T00:00:00.000Z',
    };
  }
}

function routed(toolName, result) {
  return {
    pluginId:'agent-army.content-autonomy',
    toolName,
    result,
  };
}

function budgetPolicies({ remainingAmount, amount = 30 }) {
  return [
    ['company', ids.company],
    ['agent', ids.agent],
    ['project', ids.project],
  ].map(([scopeType, scopeId]) => ({
    scopeType,
    scopeId,
    metric:'billed_cents',
    amount,
    observedAmount:amount - remainingAmount,
    remainingAmount,
    hardStopEnabled:true,
    isActive:true,
    status:remainingAmount > 0 ? 'ok' : 'hard_stop',
    paused:remainingAmount <= 0,
  }));
}
