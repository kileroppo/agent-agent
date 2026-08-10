import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipBridge } from '../src/paperclip-bridge.js';
import { paperclipHermesAdapterConfig } from '../src/governance-hermes-runtime.js';

test('PaperclipBridge 可只读回查单条审批，用于响应丢失后的收口', async () => {
  const bridge = new PaperclipBridge();
  bridge.request = async (requestPath, options) => {
    assert.equal(requestPath, '/api/approvals/approval%2F1');
    assert.equal(options, undefined);
    return { id:'approval/1', status:'approved' };
  };
  assert.equal((await bridge.getApproval('approval/1')).status, 'approved');
  await assert.rejects(() => bridge.getApproval('  '), /不能为空/);
});

test('PaperclipBridge 只预约当前日期之后最早的未执行日期Case作为单条灰度', async () => {
  const bridge = new PaperclipBridge();
  bridge.getPipelineCase = async (caseId) => caseId === 'current-case'
    ? {
        case:{
          id:'current-case',
          pipelineId:'pipeline-1',
          fields:{
            campaignId:'campaign-1',
            scheduledDate:'2026-08-05',
            platform:'douyin',
          },
        },
        pipeline:{ id:'pipeline-1', projectId:'project-1' },
      }
    : {
        case:{
          id:'day-6',
          pipelineId:'pipeline-1',
          parentCaseId:'campaign-case-1',
          stageKey:'topic',
          fields:{ campaignId:'campaign-1', scheduledDate:'2026-08-06' },
        },
        pipeline:{ id:'pipeline-1', projectId:'project-1' },
        stage:{ key:'topic', kind:'working' },
      };
  bridge.request = async (requestPath) => {
    assert.equal(requestPath, '/api/pipelines/pipeline-1/cases');
    return [
      {
        case:{
          id:'day-7',
          pipelineId:'pipeline-1',
          fields:{ campaignId:'campaign-1', scheduledDate:'2026-08-07' },
        },
        stage:{ key:'topic' },
      },
      {
        case:{
          id:'platform-day-6',
          pipelineId:'pipeline-1',
          parentCaseId:'day-6',
          fields:{
            campaignId:'campaign-1',
            scheduledDate:'2026-08-06',
            platform:'douyin',
          },
        },
        stage:{ key:'machine_review' },
      },
      {
        case:{
          id:'day-6',
          pipelineId:'pipeline-1',
          fields:{ campaignId:'campaign-1', scheduledDate:'2026-08-06' },
        },
        stage:{ key:'topic' },
      },
    ];
  };
  assert.deepEqual(await bridge.getNextM5GrayTargetCase('current-case'), {
    caseId:'platform-day-6',
    dayCaseId:'day-6',
    scheduledDate:'2026-08-06',
    platform:'douyin',
  });
});

test('PaperclipBridge 灰度目标在父日期 Case 漂移、阻塞或终态时失败关闭', async (t) => {
  const scenarios = [
    ['父链漂移', (fixture) => { fixture.day.case.parentCaseId = null; }],
    ['日期漂移', (fixture) => { fixture.day.case.fields.scheduledDate = '2026-08-07'; }],
    ['平台Pipeline漂移', (fixture) => { fixture.platform.case.pipelineId = 'pipeline-other'; }],
    ['Pipeline漂移', (fixture) => { fixture.day.case.pipelineId = 'pipeline-other'; }],
    ['项目漂移', (fixture) => { fixture.day.pipeline.projectId = 'project-other'; }],
    ['活动漂移', (fixture) => { fixture.day.case.fields.campaignId = 'campaign-other'; }],
    ['父阶段不允许', (fixture) => { fixture.day.case.stageKey = 'draft'; fixture.day.stage.key = 'draft'; }],
    ['父Case阻塞', (fixture) => { fixture.day.case.status = 'blocked'; }],
    ['父Case终态', (fixture) => { fixture.day.case.terminalKind = 'done'; }],
    ['平台Case阻塞', (fixture) => { fixture.platform.case.status = 'blocked'; }],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const fixture = grayTargetFixture();
      mutate(fixture);
      await assert.rejects(
        fixture.bridge.getNextM5GrayTargetCase('current-case'),
        /父日期 Case 链、日期、项目、活动或可执行状态复核失败/,
      );
    });
  }
});

function grayTargetFixture() {
  const current = {
    case:{
      id:'current-case',
      pipelineId:'pipeline-1',
      fields:{
        campaignId:'campaign-1',
        scheduledDate:'2026-08-05',
        platform:'douyin',
      },
    },
    pipeline:{ id:'pipeline-1', projectId:'project-1' },
  };
  const day = {
    case:{
      id:'day-6',
      pipelineId:'pipeline-1',
      parentCaseId:'campaign-case-1',
      stageKey:'render',
      fields:{ campaignId:'campaign-1', scheduledDate:'2026-08-06' },
    },
    pipeline:{ id:'pipeline-1', projectId:'project-1' },
    stage:{ key:'render', kind:'working' },
  };
  const platform = {
    case:{
      id:'platform-day-6',
      pipelineId:'pipeline-1',
      parentCaseId:'day-6',
      fields:{
        campaignId:'campaign-1',
        scheduledDate:'2026-08-06',
        platform:'douyin',
      },
    },
    stage:{ key:'machine_review', kind:'review' },
  };
  const bridge = new PaperclipBridge();
  bridge.getPipelineCase = async (caseId) => {
    if (caseId === 'current-case') return current;
    assert.equal(caseId, 'day-6');
    return day;
  };
  bridge.request = async (requestPath) => {
    assert.equal(requestPath, '/api/pipelines/pipeline-1/cases');
    return [platform];
  };
  return { bridge, current, day, platform };
}

test('PaperclipBridge 以当前 Publisher Run 和 Case 父链闭合授权、批准、Secret、预算与费用上报', async () => {
  const fixture = publisherAccessFixture();
  const authorization = {
    action:'publisher.publish',
    runId:fixture.ids.run,
    issueId:fixture.ids.issue,
    campaignId:fixture.ids.campaign,
    agentId:fixture.ids.agent,
    authorizationId:`paperclip:${fixture.ids.run}:${fixture.ids.issue}:publisher.publish`,
  };

  assert.deepEqual(await fixture.bridge.authorizePublisherRequest(authorization), {
    schemaVersion:'agent.army/publisher-authorization/v1',
    ...authorization,
    authorized:true,
    replayed:false,
  });
  assert.equal(fixture.patchCalls.length, 1);
  assert.equal(fixture.patchCalls[0].expectedVersion, 4);
  assert.equal(JSON.stringify(fixture.patchCalls).includes(fixture.runJwt), false);

  const replay = await fixture.bridge.authorizePublisherRequest(authorization);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.patchCalls.length, 1);

  const snapshot = await fixture.bridge.getPublisherConnectorApprovalSnapshot(authorization);
  assert.equal(snapshot.source, 'paperclip');
  assert.match(snapshot.snapshotId, /^paperclip:publisher-approvals:[0-9a-f]{64}$/);
  assert.deepEqual(snapshot.approvals, [{
    status:'approved',
    approvalRef:`paperclip:approval:${fixture.ids.approval}`,
    platform:'douyin',
    capability:'publish',
    connectorKind:'douyin_official_api',
    expiresAt:'2026-08-02T00:00:00.000Z',
  }]);

  const credential = await fixture.bridge.resolvePublisherCredentialReference({
    accountRef:'account:douyin:owner',
    platform:'douyin',
    purpose:'publish',
  });
  assert.deepEqual(credential, {
    accessToken:'memory-only-token',
    openId:'owner-open-id',
  });
  const secretCall = fixture.requestCalls.find((call) => call.path.includes('/secrets/'));
  assert.equal(secretCall.path, '/api/agents/me/secrets/douyin_owner/value');
  assert.equal(secretCall.options.method, 'POST');
  assert.equal(secretCall.options.apiKey, fixture.runJwt);
  await assert.rejects(
    fixture.bridge.resolvePublisherCredentialReference({
      accountRef:'account:douyin:owner',
      platform:'douyin',
      purpose:'read_own_metrics',
    }),
    /不能读取另一类 connector 凭据/,
  );

  const identity = await fixture.bridge.verifyPublisherAccountIdentity({
    platform:'douyin',
    accountRef:'account:douyin:owner',
    providerIdentity:fixture.providerIdentity,
  });
  assert.equal(identity.verified, true);
  assert.equal(identity.verificationRef, `paperclip:approval:${fixture.ids.approval}:account-identity`);

  const budget = await fixture.bridge.assertPublisherCampaignBudget({
    campaignId:fixture.ids.campaign,
    connectorMode:'real:douyin_official_api',
    operation:'publish',
    checkedAt:'2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(budget, {
    campaignId:fixture.ids.campaign,
    allowed:true,
    hardStopEnabled:true,
    remainingAmountUsd:5,
  });
  await assert.rejects(
    fixture.bridge.assertPublisherCampaignBudget({
      campaignId:fixture.ids.campaign,
      connectorMode:'real:douyin_official_api',
      operation:'read_own_metrics',
      checkedAt:'2026-08-01T00:00:00.000Z',
    }),
    /预算操作与当前控制器能力不一致/,
  );

  const cost = {
    costRecordId:'publisher-cost-upload-1',
    campaignId:fixture.ids.campaign,
    connectorMode:'real:douyin_official_api',
    operation:'upload_video',
    providerRequestId:'douyin-request-upload-1',
    receiptRef:null,
    amountUsd:0.25,
    occurredAt:'2026-08-01T00:00:00.000Z',
  };
  assert.deepEqual(await fixture.bridge.recordPublisherConnectorAttempt(cost), {
    reportRef:`paperclip:cost-event:${fixture.ids.costEvent}`,
  });
  const costCalls = fixture.requestCalls.filter((call) => call.path.endsWith('/cost-events'));
  assert.equal(costCalls.length, 1);
  assert.equal(costCalls[0].options.body.costCents, 25);
  assert.equal(costCalls[0].options.body.heartbeatRunId, fixture.ids.run);
  assert.deepEqual(await fixture.bridge.recordPublisherConnectorAttempt(cost), {
    reportRef:`paperclip:cost-event:${fixture.ids.costEvent}`,
  });
  assert.equal(
    fixture.requestCalls.filter((call) => call.path.endsWith('/cost-events')).length,
    1,
  );
  await assert.rejects(
    fixture.bridge.recordPublisherConnectorAttempt({
      ...cost,
      costRecordId:'publisher-cost-metric-1',
      operation:'read_video_metrics',
      providerRequestId:'douyin-request-metric-1',
    }),
    /费用步骤与当前控制器能力不一致/,
  );
});

test('PaperclipBridge Publisher 核心 access 对伪造 Run、过期 Grant、重复批准和未决费用失败关闭', async (t) => {
  await t.test('请求中的 Run 身份不能覆盖 current Run', async () => {
    const fixture = publisherAccessFixture();
    await assert.rejects(
      fixture.bridge.authorizePublisherRequest({
        action:'publisher.publish',
        runId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        issueId:fixture.ids.issue,
        campaignId:fixture.ids.campaign,
        agentId:fixture.ids.agent,
        authorizationId:`paperclip:${fixture.ids.run}:${fixture.ids.issue}:publisher.publish`,
      }),
      /当前 Paperclip Run 身份不一致/,
    );
  });

  await t.test('Grant 日期结构无效时不能被当成永久有效', async () => {
    const fixture = publisherAccessFixture();
    fixture.campaign.fields.campaignGrant.expiresAt = 'not-a-date';
    await assert.rejects(
      fixture.bridge.assertPublisherCampaignBudget({
        campaignId:fixture.ids.campaign,
        connectorMode:'real:douyin_official_api',
        operation:'publish',
        checkedAt:'2026-08-01T00:00:00.000Z',
      }),
      /未激活或已经过期/,
    );
  });

  await t.test('同一账号存在两个有效批准时拒绝读取 Secret', async () => {
    const fixture = publisherAccessFixture();
    fixture.approvals.push({
      ...structuredClone(fixture.approvals[0]),
      id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await assert.rejects(
      fixture.bridge.resolvePublisherCredentialReference({
        accountRef:'account:douyin:owner',
        platform:'douyin',
        purpose:'publish',
      }),
      /批准缺失或不唯一/,
    );
  });

  await t.test('费用处于 submitting 时不自动重试外部扣费', async () => {
    const fixture = publisherAccessFixture();
    fixture.target.fields.m5PublisherCostRecords = {
      'publisher-cost-upload-1':{
        schemaVersion:'agent.army/publisher-cost-record/v1',
        costRecordId:'publisher-cost-upload-1',
        campaignId:fixture.ids.campaign,
        connectorMode:'real:douyin_official_api',
        operation:'upload_video',
        sourceRef:'douyin-request-upload-1',
        amountUsd:0.25,
        occurredAt:'2026-08-01T00:00:00.000Z',
        state:'submitting',
      },
    };
    await assert.rejects(
      fixture.bridge.recordPublisherConnectorAttempt({
        costRecordId:'publisher-cost-upload-1',
        campaignId:fixture.ids.campaign,
        connectorMode:'real:douyin_official_api',
        operation:'upload_video',
        providerRequestId:'douyin-request-upload-1',
        receiptRef:null,
        amountUsd:0.25,
        occurredAt:'2026-08-01T00:00:00.000Z',
      }),
      /状态未决，禁止自动重试/,
    );
    assert.equal(
      fixture.requestCalls.filter((call) => call.path.endsWith('/cost-events')).length,
      0,
    );
  });
});

function publisherAccessFixture() {
  const ids = Object.freeze({
    company:'11111111-1111-4111-8111-111111111111',
    run:'22222222-2222-4222-8222-222222222222',
    issue:'33333333-3333-4333-8333-333333333333',
    agent:'44444444-4444-4444-8444-444444444444',
    target:'55555555-5555-4555-8555-555555555555',
    day:'66666666-6666-4666-8666-666666666666',
    campaign:'77777777-7777-4777-8777-777777777777',
    project:'88888888-8888-4888-8888-888888888888',
    approval:'99999999-9999-4999-8999-999999999999',
    costEvent:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const runJwt = 'current-run-jwt-never-persist';
  const providerIdentity = Object.freeze({
    kind:'open_id_sha256',
    value:`sha256:${'b'.repeat(64)}`,
  });
  const target = {
    id:ids.target,
    version:4,
    pipelineId:'m5-pipeline-1',
    projectId:ids.project,
    parentCaseId:ids.day,
    stageKey:'publish',
    fields:{},
  };
  const day = {
    id:ids.day,
    version:3,
    pipelineId:'m5-pipeline-1',
    projectId:ids.project,
    parentCaseId:ids.campaign,
    stageKey:'platform_adapt',
    fields:{ scheduledDate:'2026-08-01' },
  };
  const campaign = {
    id:ids.campaign,
    version:2,
    pipelineId:'m5-pipeline-1',
    projectId:ids.project,
    parentCaseId:null,
    stageKey:'campaign_active',
    fields:{
      campaignGrant:{
        status:'active',
        startsAt:'2026-07-31T00:00:00.000Z',
        expiresAt:'2026-08-02T00:00:00.000Z',
        platforms:['douyin'],
        accountRefs:{ douyin:'account:douyin:owner' },
        allowedActions:['schedule_or_publish', 'read_own_metrics'],
        budgetCents:625,
      },
    },
  };
  const approvals = [{
    id:ids.approval,
    status:'approved',
    payload:{
      governanceKind:'publisher_connector_approval_v1',
      campaignId:ids.campaign,
      platform:'douyin',
      capability:'publish',
      connectorKind:'douyin_official_api',
      accountRef:'account:douyin:owner',
      expiresAt:'2026-08-02T00:00:00.000Z',
      secretKey:'douyin_owner',
      providerIdentity,
    },
  }];
  const patchCalls = [];
  const requestCalls = [];
  const bridge = new PaperclipBridge({
    clock:() => new Date('2026-08-01T00:00:00.000Z'),
    publisherRunCredentialProvider:async () => ({
      apiKey:runJwt,
      runId:ids.run,
      issueId:ids.issue,
      agentId:ids.agent,
      companyId:ids.company,
    }),
  });
  bridge.verifySystemAssignment = async ({ systemRole }) => {
    if (systemRole !== 'm5-publisher-controller') {
      throw new Error('role mismatch');
    }
    return {
      issue:{
        id:ids.issue,
        companyId:ids.company,
        description:`[agent-army:m5:routine:m5-publish] 当前 Case 为 ${ids.target}，版本为 4。`,
      },
      systemRole,
    };
  };
  bridge.assertCaseIssueLink = async (caseId, issueId) => {
    assert.equal(caseId, ids.target);
    assert.equal(issueId, ids.issue);
  };
  bridge.getPipelineCase = async (caseId) => {
    if (caseId === ids.target) return { case:structuredClone(target) };
    if (caseId === ids.day) return { case:structuredClone(day) };
    if (caseId === ids.campaign) return { case:structuredClone(campaign) };
    throw new Error(`unexpected case ${caseId}`);
  };
  bridge.patchPipelineCaseFields = async (caseId, input) => {
    assert.equal(caseId, ids.target);
    assert.equal(input.runId, ids.run);
    assert.equal(input.expectedVersion, target.version);
    patchCalls.push(structuredClone(input));
    target.fields = structuredClone(input.fields);
    target.version += 1;
    return { case:structuredClone(target) };
  };
  bridge.request = async (requestPath, options = {}) => {
    requestCalls.push({ path:requestPath, options:structuredClone(options) });
    if (requestPath.endsWith('/approvals')) return structuredClone(approvals);
    if (requestPath.includes('/secrets/')) {
      return { value:JSON.stringify({ accessToken:'memory-only-token', openId:'owner-open-id' }) };
    }
    if (requestPath.endsWith('/budgets/overview')) {
      return {
        policies:[
          budgetPolicy('company', ids.company, 1000, 1000),
          budgetPolicy('agent', ids.agent, 800, 800),
          budgetPolicy('project', ids.project, 625, 500),
        ],
      };
    }
    if (requestPath.endsWith('/cost-events')) {
      return {
        id:ids.costEvent,
        agentId:ids.agent,
        projectId:ids.project,
        heartbeatRunId:ids.run,
        costCents:options.body.costCents,
      };
    }
    throw new Error(`unexpected request ${requestPath}`);
  };
  return {
    bridge,
    ids,
    runJwt,
    providerIdentity,
    target,
    day,
    campaign,
    approvals,
    patchCalls,
    requestCalls,
  };
}

function budgetPolicy(scopeType, scopeId, amount, remainingAmount) {
  return {
    scopeType,
    scopeId,
    metric:'billed_cents',
    amount,
    remainingAmount,
    hardStopEnabled:true,
    isActive:true,
    paused:false,
    status:'ok',
  };
}

test('PaperclipBridge 对 M5 HTTP 控制器核验当前运行中的 active run、agent、issue 和 company 四方绑定', async () => {
  const issueId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const agentId = '33333333-3333-4333-8333-333333333333';
  const companyId = '44444444-4444-4444-8444-444444444444';
  const bridge = new PaperclipBridge();
  bridge.getPaperclipIssue = async () => ({
    id:issueId,
    companyId,
    assigneeAgentId:agentId,
    status:'in_progress',
  });
  bridge.getPaperclipAgent = async () => ({
    id:agentId,
    companyId,
    metadata:{ agentArmySystemRole:'m5-daily-controller' },
  });
  bridge.getPaperclipIssueActiveRun = async () => ({
    id:runId,
    companyId,
    agentId,
    status:'running',
  });
  bridge.getPaperclipHeartbeatRun = async () => ({
    id:runId,
    companyId,
    agentId,
    status:'running',
  });

  const verified = await bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  });
  assert.equal(verified.issue.id, issueId);
  assert.equal(verified.run.id, runId);
  assert.equal(verified.paperclipAgent.id, agentId);

  bridge.getPaperclipIssueActiveRun = async () => null;
  await assert.rejects(() => bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  }), /当前活跃运行与 HTTP 系统控制器指派不一致/);
});

test('PaperclipBridge 拒绝历史、排队、终态或身份漂移的 M5 系统控制器 Run', async (t) => {
  const issueId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const agentId = '33333333-3333-4333-8333-333333333333';
  const companyId = '44444444-4444-4444-8444-444444444444';
  const otherAgentId = '55555555-5555-4555-8555-555555555555';
  const otherCompanyId = '66666666-6666-4666-8666-666666666666';

  const setup = ({
    issueStatus = 'in_progress',
    activeRun = { id:runId, status:'running', agentId, companyId },
    heartbeatRun = { id:runId, status:'running', agentId, companyId },
  } = {}) => {
    const bridge = new PaperclipBridge();
    bridge.getPaperclipIssue = async () => ({
      id:issueId,
      companyId,
      assigneeAgentId:agentId,
      status:issueStatus,
    });
    bridge.getPaperclipAgent = async () => ({
      id:agentId,
      companyId,
      metadata:{ agentArmySystemRole:'m5-daily-controller' },
    });
    bridge.getPaperclipIssueActiveRun = async () => activeRun;
    bridge.getPaperclipHeartbeatRun = async () => heartbeatRun;
    return bridge;
  };
  const verify = (bridge) => bridge.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole:'m5-daily-controller',
  });

  await t.test('历史 Run 即使曾属于该 Issue 也不能执行', async () => {
    const bridge = setup({ activeRun:null });
    bridge.getPaperclipIssueRuns = async () => ({
      runs:[{ id:runId, status:'succeeded', agentId, companyId }],
    });
    await assert.rejects(verify(bridge), /当前活跃运行与 HTTP 系统控制器指派不一致/);
  });

  await t.test('queued Run 不能冒充正在执行的 controller', async () => {
    await assert.rejects(
      verify(setup({
        activeRun:{ id:runId, status:'queued', agentId, companyId },
        heartbeatRun:{ id:runId, status:'queued', agentId, companyId },
      })),
      /当前活跃运行与 HTTP 系统控制器指派不一致/,
    );
  });

  await t.test('Issue 已结束时拒绝仍显示 running 的旧 Run', async () => {
    await assert.rejects(
      verify(setup({ issueStatus:'done' })),
      /当前活跃运行与 HTTP 系统控制器指派不一致/,
    );
  });

  await t.test('active-run 与权威 heartbeat 状态不一致时拒绝', async () => {
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'succeeded', agentId, companyId },
      })),
      /当前活跃运行身份无效/,
    );
  });

  await t.test('Run 岗位或公司身份漂移时拒绝', async () => {
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'running', agentId:otherAgentId, companyId },
      })),
      /当前活跃运行身份无效/,
    );
    await assert.rejects(
      verify(setup({
        heartbeatRun:{ id:runId, status:'running', agentId, companyId:otherCompanyId },
      })),
      /当前活跃运行身份无效/,
    );
  });
});

test('M5 阶段恢复只用 Case 字段和同一 Run 重开或阻塞原 Issue', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return { ok:true }; } };
  } });

  await bridge.getPipelineCaseEvents('case-recovery-1');
  await bridge.patchPipelineCaseFields('case-recovery-1', {
    expectedVersion:7,
    fields:{ m5StageRecovery:{ status:'scheduled' } },
    runId:'run-recovery-1',
  });
  await bridge.reopenM5StageIssue('issue-recovery-1', {
    runId:'run-recovery-1',
    comment:'安排安全重试。',
  });
  await bridge.blockM5StageIssue('issue-recovery-1', {
    runId:'run-recovery-1',
    comment:'恢复上限已达到。',
  });

  assert.equal(
    new URL(requests[0].url).pathname + new URL(requests[0].url).search,
    '/api/cases/case-recovery-1/events?limit=100&order=desc',
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    expectedVersion:7,
    fields:{ m5StageRecovery:{ status:'scheduled' } },
  });
  assert.equal(requests[1].options.headers['x-paperclip-run-id'], 'run-recovery-1');
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    status:'todo',
    comment:'安排安全重试。',
  });
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    status:'blocked',
    comment:'恢复上限已达到。',
  });
});

test('复盘桥接只从当前 Case 的 Pipeline 聚合 Work Product，并沿用原 Run 写回', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload = {};
    if (pathname === '/api/cases/case-1') payload = { id:'case-1', pipelineId:'pipeline-1' };
    else if (pathname === '/api/pipelines/pipeline-1/cases') {
      payload = { items:[{ id:'case-1' }, { id:'case-2' }] };
    } else if (pathname === '/api/cases/case-1/outputs') {
      payload = { items:[{ id:'metric-1' }] };
    } else if (pathname === '/api/cases/case-2/outputs') {
      payload = [{ id:'metric-2' }];
    }
    return { ok:true, status:200, async json(){ return payload; } };
  } });

  assert.deepEqual(await bridge.getRetrospectiveMetricOutputs('case-1'), {
    items:[{ id:'metric-1' }, { id:'metric-2' }],
  });
  await bridge.transitionPipelineCase('case-1', {
    expectedVersion:7,
    toStageKey:'done',
  }, { runId:'run-1' });
  await bridge.completeRetrospectiveIssue('issue-1', {
    runId:'run-1',
    comment:'复盘完成。',
  });

  const transition = requests.find((item) =>
    new URL(item.url).pathname === '/api/cases/case-1/transition');
  assert.equal(transition.options.headers['x-paperclip-run-id'], 'run-1');
  assert.deepEqual(JSON.parse(transition.options.body), {
    expectedVersion:7,
    toStageKey:'done',
  });
  const completion = requests.find((item) =>
    new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(completion.options.headers['x-paperclip-run-id'], 'run-1');
  assert.deepEqual(JSON.parse(completion.options.body), {
    status:'done',
    comment:'复盘完成。',
  });
});

test('学习控制器只能把 Issue 更新为运行、审核或完成状态', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return { ok:true }; } };
  } });
  await bridge.updateLearningIssue('issue-learning-1', {
    runId:'run-learning-1',
    status:'in_review',
    comment:'等待审核官。',
  });
  const request = requests[0];
  assert.equal(request.options.headers['x-paperclip-run-id'], 'run-learning-1');
  assert.deepEqual(JSON.parse(request.options.body), {
    status:'in_review',
    comment:'等待审核官。',
  });
  await assert.rejects(
    bridge.updateLearningIssue('issue-learning-1', {
      status:'blocked',
      comment:'伪造状态',
    }),
    /学习任务状态无效/,
  );
});

test('技术修复任务会分配给 Paperclip 中受控 Codex 技术专家', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{ id:'paperclip-tech-1', name:'技术专家', status:'idle', metadata:{ agentArmyId:'technical-expert', paperclipProjectId:'project-repair-1' } }];
    else if (pathname === '/api/companies/company-1/issues') payload = { id:'issue-1', identifier:'AGE-100' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.project({ taskId:'task-tech', taskType:'operations.technical-repair', status:'queued', priority:'normal', assigneeAgentId:'technical-expert', input:{ title:'修复执行器故障', description:'自动恢复无法完成。', context:{ failure:{ code:'executor_failed', stage:'execution', category:'manual', retryable:false } } } });
  const issueRequest = requests.find((item) => new URL(item.url).pathname === '/api/companies/company-1/issues');
  const body = JSON.parse(issueRequest.options.body);
  assert.equal(body.assigneeAgentId, 'paperclip-tech-1');
  assert.equal(body.status, 'todo');
  assert.match(body.description, /脱敏故障信息/);
  assert.match(body.description, /必须运行相关测试/);
  assert.equal(result.paperclipAssigneeAgentId, 'paperclip-tech-1');
  assert.equal(body.projectId, 'project-repair-1');
});

test('已交给 Paperclip Codex 的修复任务不会被 A君本地状态提前关闭', async () => {
  let patches = 0;
  const bridge = new PaperclipBridge({ fetchImpl:async () => { patches += 1; throw new Error('should not patch'); } });
  const projection = await bridge.update({ taskType:'operations.technical-repair', status:'running', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'agent-1' } });
  assert.equal(projection.status, 'delegated');
  assert.equal(patches, 0);
});

test('技术修复转为待测试时，A君会同步 Paperclip 为阻塞而不是继续显示待开始', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  const projection = await bridge.update({ taskType:'operations.technical-repair', status:'waiting_test', currentStage:'repair_waiting_for_test', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'agent-1' } });
  assert.equal(projection.status, 'synced');
  const request = requests.find((item) => new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(JSON.parse(request.options.body).status, 'blocked');
});

test('任务因过期确认关闭时，Paperclip 也显示为阻塞', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.update({ taskType:'army.route-task', status:'cancelled', governance:{ paperclipIssueId:'issue-1' } });
  const request = requests.find((item) => new URL(item.url).pathname === '/api/issues/issue-1');
  assert.equal(JSON.parse(request.options.body).status, 'blocked');
});

test('任务等待补充信息或已过期时，Paperclip 不会继续显示为待开始', async () => {
  for (const status of ['needs_input', 'expired']) {
    const requests = [];
    const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
      requests.push({ url, options });
      return { ok:true, status:200, async json(){ return {}; } };
    } });
    await bridge.update({ taskType:'army.route-task', status, governance:{ paperclipIssueId:`issue-${status}` } });
    const request = requests.find((item) => new URL(item.url).pathname === `/api/issues/issue-${status}`);
    assert.equal(JSON.parse(request.options.body).status, 'blocked', status);
  }
});

test('Hermes heartbeat 回写沿用 Paperclip run 身份，不触发重复唤醒', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.completePaperclipIssue('issue-1', {
    runId:'run-1234',
    agentId:'architect',
    result:{
      status:'succeeded',
      currentStage:'paperclip_hermes_completed',
      execution:{ owner:'paperclip-hermes' },
      artifactRefs:[{ type:'employee_role_report', data:{ summary:'复用评估完成' } }]
    }
  });
  assert.equal(requests[0].options.headers['x-paperclip-run-id'], 'run-1234');
  assert.equal(JSON.parse(requests[0].options.body).status, 'done');
});

test('成功的系统巡检可在保留任务记录的同时退出 Paperclip 大盘', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.completePaperclipIssue('issue-health-1', {
    runId:'run-health-1',
    agentId:'operator',
    hideFromDashboard:true,
    result:{
      status:'succeeded',
      currentStage:'health_report_ready',
      execution:{ owner:'paperclip-http-adapter' },
      artifactRefs:[{ type:'health_report', data:{ overall:'healthy' } }],
    },
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.status, 'done');
  assert.match(body.hiddenAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.comment, /系统巡检已归档/);
});

test('失败的系统巡检即使请求降噪也必须继续留在 Paperclip 大盘', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    return { ok:true, status:200, async json(){ return {}; } };
  } });
  await bridge.completePaperclipIssue('issue-health-2', {
    runId:'run-health-2',
    agentId:'operator',
    hideFromDashboard:true,
    result:{ status:'failed', currentStage:'health_failed', execution:{ outcome:'unhealthy' } },
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.status, 'blocked');
  assert.equal('hiddenAt' in body, false);
});

test('多人协作的子工作会挂在同一张 Paperclip 总任务下', async () => {
  const requests = [];
  const bridge = new PaperclipBridge({ fetchImpl:async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'paperclip-operator',
      name:'运维官',
      status:'idle',
      metadata:{ agentArmyId:'operator' }
    }];
    else if (pathname === '/api/issues/parent-1/children') payload = { id:'child-1', identifier:'AGE-201' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  } });
  const projection = await bridge.projectChild({ taskId:'child-local-1', priority:'normal', taskType:'operations.health-review', assigneeAgentId:'operator', status:'queued', input:{ title:'检查军团本机运行状态', description:'来自军团盘点。' } }, 'parent-1');
  const create = requests.find((item) => new URL(item.url).pathname === '/api/issues/parent-1/children');
  const body = JSON.parse(create.options.body);
  assert.equal(body.blockParentUntilDone, true);
  assert.equal(body.assigneeAgentId, 'paperclip-operator');
  assert.equal(projection.paperclipParentIssueId, 'parent-1');
  assert.equal(projection.paperclipAssigneeAgentId, 'paperclip-operator');
});

test('Paperclip 会登记已有军团岗位，但不会把本机岗位变成可自行启动的重复执行器', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') {
      payload = options.method === 'POST'
        ? { id:`created-${body.metadata.agentArmyId}`, name:body.name, status:'idle' }
        : [{ id:'operator-runtime', name:'A君本机健康官', adapterType:'http', status:'idle', metadata:null }, { id:'technical-runtime', name:'技术专家', adapterType:'codex_local', status:'paused', metadata:{ agentArmyId:'technical-expert' } }];
    } else if (pathname === '/api/agents/operator-runtime') payload = { id:'operator-runtime', name:'A君本机健康官', status:'idle' };
    else if (pathname.startsWith('/api/agents/created-')) payload = { id:pathname.split('/').at(-1), name:'同步岗位', status:'paused' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([
    { agentId:'operator', name:'运维官', role:'安全恢复', status:'active', responsibilities:['检查本机状态'] },
    { agentId:'technical-expert', name:'技术专家', role:'受控修复', status:'active', responsibilities:['修复故障'] },
    { agentId:'reviewer', name:'审核官', role:'范围审查', status:'active', responsibilities:['审查风险'] }
  ]);
  assert.equal(result.status, 'synced');
  assert.equal(result.agents.length, 3);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'operator').created, false);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'technical-expert').created, false);
  assert.equal(result.agents.find((item) => item.agentArmyId === 'reviewer').created, true);
  const operatorPatch = requests.find((item) => new URL(item.url).pathname === '/api/agents/operator-runtime');
  assert.equal(JSON.parse(operatorPatch.options.body).metadata.agentArmyId, 'operator');
  const reviewerCreate = requests.find((item) => new URL(item.url).pathname === '/api/companies/company-1/agents' && item.options.method === 'POST');
  const reviewerBody = JSON.parse(reviewerCreate.options.body);
  assert.equal(reviewerBody.adapterType, 'http');
  assert.equal(reviewerBody.metadata.agentArmyManagedOnly, true);
  const reviewerPause = requests.find((item) => new URL(item.url).pathname === '/api/agents/created-reviewer');
  assert.equal(JSON.parse(reviewerPause.options.body).status, 'paused');
});

test('已登记的新员工会按真实职责刷新岗位标签，但保持暂停不自行运行', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'public-reporter', name:'公开资料报告员', role:'general', title:'公开资料报告', icon:'bot', capabilities:'整理公开网页', status:'paused',
      metadata:{ agentArmyId:'public-reporter', agentArmyRole:'公开资料报告', agentArmyManagedOnly:true }
    }];
    else if (pathname === '/api/agents/public-reporter') payload = { id:'public-reporter', status:'paused' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'public-reporter', name:'公开资料报告员', role:'只读公开网页中文摘要', status:'active',
    acceptedTaskTypes:['report.public-material'], responsibilities:['读取公开网页并交付中文重点']
  }]);
  assert.equal(result.status, 'synced');
  const refresh = requests.find((item) => new URL(item.url).pathname === '/api/agents/public-reporter');
  const body = JSON.parse(refresh.options.body);
  assert.equal(body.role, 'researcher');
  assert.equal(body.icon, 'search');
  assert.equal(body.metadata.agentArmyManagedOnly, true);
  assert.equal(Object.hasOwn(body, 'status'), false);
});

test('受管 Hermes 岗位修正模型配置后会从 error 恢复为 idle', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'video-agent', name:'小拆·视频内容拆解师', role:'general', title:'旧职责', icon:'bot',
      capabilities:'旧能力', adapterType:'hermes_local', adapterConfig:{ model:'auto' }, status:'error',
      metadata:{ agentArmyId:'video-content-analyst', agentArmyManagedOnly:true, executionOwner:'paperclip-hermes' }
    }];
    else if (pathname === '/api/agents/video-agent') payload = { id:'video-agent', status:'idle' };
    else if (pathname === '/api/agents/video-agent/skills/sync') payload = { status:'synced' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'video-content-analyst',
    name:'小拆·视频内容拆解师',
    role:'受控拆解',
    status:'active',
    promptRef:'agents/video-content-analyst/prompts/system.md',
    executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    acceptedTaskTypes:[
      'content.video-benchmark-analysis',
      'content.campaign-visual-analysis'
    ],
    responsibilities:['拆解视频'],
    runtimeCapabilities:{
      modelSelection:{ provider:'openai-codex', model:'gpt-5.6-terra' },
      skills:['paperclip'],
      paperclipToolsets:['agent-army'],
      mcpTools:['video_content_analyze_execute']
    }
  }]);
  assert.equal(result.status, 'synced');
  const refresh = requests.find((item) => new URL(item.url).pathname === '/api/agents/video-agent' && item.options.method === 'PATCH');
  const body = JSON.parse(refresh.options.body);
  assert.equal(body.status, 'idle');
  assert.equal(body.adapterConfig.provider, 'openai-codex');
  assert.equal(body.adapterConfig.model, 'gpt-5.6-terra');
});

test('受管 Hermes 岗位仅运行目录漂移时也会刷新到当前代码根', async () => {
  const requests = [];
  const manifest = {
    agentId:'video-content-analyst',
    name:'小拆·视频内容拆解师',
    role:'受控拆解',
    status:'active',
    promptRef:'agents/video-content-analyst/prompts/system.md',
    executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    acceptedTaskTypes:[
      'content.video-benchmark-analysis',
      'content.campaign-visual-analysis',
    ],
    responsibilities:['拆解视频'],
    runtimeCapabilities:{
      modelSelection:{ provider:'deepseek', model:'deepseek-v4-flash' },
      skills:['paperclip'],
      paperclipToolsets:['agent-army'],
      mcpTools:['video_content_analyze_execute'],
    },
  };
  const desired = paperclipHermesAdapterConfig(manifest);
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [{
      id:'video-agent',
      name:manifest.name,
      role:'general',
      title:manifest.role,
      icon:'bot',
      capabilities:'拆解视频',
      adapterType:'hermes_local',
      adapterConfig:{ ...desired, cwd:'/old/release', instructionsFilePath:'/old/release/system.md' },
      status:'idle',
      metadata:{
        agentArmyId:manifest.agentId,
        agentArmyRole:manifest.role,
        agentArmyManagedOnly:true,
        executionOwner:'paperclip-hermes',
        hermesProfileId:manifest.agentId,
      },
    }];
    else if (pathname === '/api/agents/video-agent') payload = { id:'video-agent', status:'idle' };
    else if (pathname === '/api/agents/video-agent/skills/sync') payload = { status:'synced' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };

  const result = await new PaperclipBridge({ fetchImpl }).syncRoster([manifest]);

  assert.equal(result.status, 'synced');
  const refresh = requests.find((item) => (
    new URL(item.url).pathname === '/api/agents/video-agent'
    && item.options.method === 'PATCH'
  ));
  assert.equal(JSON.parse(refresh.options.body).adapterConfig.cwd, desired.cwd);
  assert.equal(JSON.parse(refresh.options.body).adapterConfig.instructionsFilePath, desired.instructionsFilePath);
});

test('正式 Manifest 已移除的军团员工会终止，测试实例和历史记录不受影响', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    let payload;
    if (pathname === '/api/companies') payload = [{ id:'company-1', name:'Agent军团' }];
    else if (pathname === '/api/companies/company-1/agents') payload = [
      { id:'active-reviewer', name:'审核官', status:'idle', metadata:{ agentArmyId:'reviewer', agentArmyManagedOnly:true } },
      { id:'retired-coordinator', name:'任务协调官', status:'paused', metadata:{ agentArmyId:'task-coordinator', agentArmyManagedOnly:true } },
      { id:'sandbox', name:'技术专家练习实例', status:'idle', metadata:{ agentArmyId:'technical-expert-sandbox', testOnly:true } }
    ];
    else if (pathname === '/api/agents/active-reviewer') payload = { id:'active-reviewer', name:'审核官', status:'idle' };
    else if (pathname === '/api/agents/retired-coordinator/terminate') payload = { id:'retired-coordinator', status:'terminated' };
    else throw new Error(`unexpected request ${pathname}`);
    return { ok:true, status:200, async json(){ return payload; } };
  };
  const bridge = new PaperclipBridge({ fetchImpl });
  const result = await bridge.syncRoster([{
    agentId:'reviewer', name:'审核官', role:'范围审查', status:'active',
    runtime:{ kind:'paperclip-hermes' }, interaction:{ directFeishu:'disabled' },
    acceptedTaskTypes:['governance.approval-review'], responsibilities:['审查风险']
  }]);

  assert.deepEqual(result.retired.map((item) => item.agentArmyId), ['task-coordinator']);
  assert.equal(requests.filter((item) => new URL(item.url).pathname.endsWith('/terminate')).length, 1);
  assert.equal(requests.some((item) => new URL(item.url).pathname.includes('/sandbox/terminate')), false);
});
