import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentCampaignError, ContentCampaignService } from '../src/content-campaign-service.js';
import { createM5PublisherBindings } from '../src/m5-publisher-bindings.js';
import { routeM5PublisherApi } from '../src/m5-publisher-api.js';
import { M5ToolExecutorRouter } from '../src/paperclip-content-tool-executor.js';
import {
  M5_ROUTINE_EXECUTION_CONTRACTS,
  getM5RoutineExecutionContract,
} from '../src/m5-routine-execution-contract.js';
import { defaultDefinition, FakePaperclipAdapter } from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';
import {
  M5_CONTENT_ROLES,
  M5_ROLE_TOOL_BUNDLES,
} from '../../../integrations/paperclip/plugins/content-autonomy/src/role-tool-bundles.js';

const m5Owners = [...new Set([
  ...M5_CONTENT_ROLES,
])];
const agentIdFor = (owner) => `agent-${owner}`;
const routineIdFor = (key) => `routine-${key}`;
const contentSecretId = '55555555-5555-4555-8555-555555555555';

function readyM5Agents() {
  const hermesContracts = M5_ROUTINE_EXECUTION_CONTRACTS.filter(
    (contract) => contract.executionMode === 'hermes',
  );
  const employees = m5Owners.map((owner) => {
    const contracts = hermesContracts.filter((contract) => contract.agentId === owner);
    const taskTypes = [...new Set(contracts.map((contract) => contract.taskType))];
    const mcpTools = [...new Set([
      'paperclip_assignment_get',
      'paperclip_assignment_complete',
      ...contracts
        .filter((contract) => contract.executionTool?.kind === 'agent_army_mcp')
        .map((contract) => contract.executionTool.id),
    ])];
    return {
      id:agentIdFor(owner),
      name:owner,
      status:'idle',
      adapterType:'hermes_local',
      adapterConfig:{
        provider:'stepfun',
        model:'step-3.5-flash-2603',
        env:{
          AGENT_ARMY_ALLOWED_TASK_TYPES:taskTypes.join(','),
          AGENT_ARMY_ALLOWED_MCP_TOOLS:mcpTools.join(','),
        },
      },
      metadata:{ agentArmyId:owner },
    };
  });
  const controllers = [
    ['m5-daily-controller', '/api/paperclip/m5-daily-heartbeat'],
    ['m5-parallel-controller', '/api/paperclip/m5-parallel-heartbeat'],
    ['m5-publisher-controller', '/api/paperclip/m5-publisher-heartbeat'],
    ['m5-metrics-controller', '/api/paperclip/m5-metrics-heartbeat'],
    ['m5-retrospective-controller', '/api/paperclip/m5-retrospective-heartbeat'],
  ].map(([role, url]) => ({
    id:`agent-${role}`,
    name:role,
    status:'idle',
    adapterType:'http',
    adapterConfig:{ url:`http://127.0.0.1:4321${url}` },
    metadata:{ agentArmySystemRole:role },
  }));
  return [...employees, ...controllers];
}

function readyM5Routines() {
  return [
    {
      id:'routine-daily',
      projectId:'project-m5',
      title:'M5 / 每日内容活动入口',
      description:'[agent-army:m5:routine:m5-daily-campaign]',
      status:'active',
      assigneeAgentId:'agent-m5-daily-controller',
      triggers:[{ id:'trigger-daily', kind:'schedule', enabled:false }],
    },
    ...defaultDefinition.stages
      .filter((stage) => stage.routineKey)
      .map((stage) => ({
        ...(() => {
          const contract = getM5RoutineExecutionContract(stage.routineKey);
          return {
            assigneeAgentId:contract.executionMode === 'system_controller'
              ? `agent-${contract.systemController}`
              : agentIdFor(contract.agentId),
          };
        })(),
        id:routineIdFor(stage.routineKey),
        projectId:'project-m5',
        title:`M5 / ${stage.name}`,
        description:`[agent-army:m5:routine:${stage.routineKey}]`,
        status:'active',
      })),
    ...M5_ROUTINE_EXECUTION_CONTRACTS
      .filter((contract) => contract.parallelOnly)
      .map((contract) => ({
        id:routineIdFor(contract.routineKey),
        projectId:'project-m5',
        title:`M5 / ${contract.stageKey}`,
        description:`[agent-army:m5:routine:${contract.routineKey}]`,
        status:'active',
        assigneeAgentId:agentIdFor(contract.agentId),
      })),
  ];
}

function readyM5Stages() {
  return defaultDefinition.stages.map((stage) => ({
    id:`stage-${stage.key}`,
    key:stage.key,
    name:stage.name,
    kind:stage.kind,
    config:stage.routineKey
      ? { onEnter:{ routineId:routineIdFor(stage.routineKey) } }
      : {},
  }));
}

class CampaignFakeAdapter extends FakePaperclipAdapter {
  constructor() {
    super({
      pipelines:[{
        id:'pipeline-m5',
        key:defaultDefinition.key,
        projectId:'project-m5',
        stages:readyM5Stages(),
      }],
      routines:readyM5Routines(),
    });
    this.companyId = 'company-m5';
    this.agents = readyM5Agents();
    this.plugins = [{
      id:'plugin-content-autonomy',
      pluginKey:'agent-army.content-autonomy',
      version:'0.2.0',
      manifestJson:{
        id:'agent-army.content-autonomy',
        version:'0.2.0',
        tools:['campaign-preflight', 'stepfun-tts', 'remotion-render'],
      },
      status:'ready',
    }];
    this.contentPluginConfig = {
      pluginId:this.plugins[0].id,
      companyId:this.companyId,
      configJson:{
        stepfunSecretRef:{ type:'secret_ref', secretId:contentSecretId, version:'latest' },
        stepfunBaseUrl:'https://api.stepfun.com/v1',
        officialTtsVoices:['official-test-voice'],
        costRatesCents:{
          visionInputPerMillionTokens:100,
          visionOutputPerMillionTokens:200,
          imagePerGeneration:3,
          ttsPerThousandCharacters:4,
        },
        agentRoleBindings:Object.fromEntries(
          m5Owners.map((owner) => [owner, agentIdFor(owner)]),
        ),
        agentToolGrants:Object.fromEntries(
          M5_CONTENT_ROLES.map((role) => [
            agentIdFor(role),
            [...M5_ROLE_TOOL_BUNDLES[role]],
          ]),
        ),
      },
    };
    this.contentSecrets = [{ id:contentSecretId, status:'active', provider:'local_encrypted' }];
    this.contentSecretProviders = [{ id:'local_encrypted', configured:true }];
    this.contentSecretUsage = {
      secretId:contentSecretId,
      bindings:[{
        targetType:'plugin',
        targetId:this.plugins[0].id,
        configPath:'stepfunSecretRef',
        versionSelector:'latest',
      }],
    };
    this.contentWorkspace = {
      folderKey:'content-workspace',
      configured:true,
      healthy:true,
      readable:true,
      writable:true,
    };
    this.budgetOverview = {
      companyId:this.companyId,
      policies:[{
        id:'budget-m5',
        scopeType:'project',
        scopeId:'project-m5',
        metric:'billed_cents',
        amount:625,
        observedAmount:0,
        remainingAmount:625,
        hardStopEnabled:true,
        isActive:true,
        status:'ok',
        paused:false,
      }],
      activeIncidents:[],
    };
    this.failNextCasePatch = false;
  }

  async request(method, path, body) {
    this.calls.push({ action:'request', method, path, body:structuredClone(body) });
    if (method === 'GET' && path === '/api/pipelines/pipeline-m5/cases') {
      return this.state.cases.map((item) => caseEnvelope(item, this.state.pipelines[0]));
    }
    if (method === 'GET' && path === '/api/pipelines/pipeline-m5') return this.state.pipelines[0];
    const caseMatch = path.match(/^\/api\/cases\/([^/?]+)$/);
    if (method === 'GET' && caseMatch) {
      const item = this.state.cases.find((entry) => entry.id === caseMatch[1]);
      return item ? caseEnvelope(item, this.state.pipelines[0]) : null;
    }
    if (method === 'PATCH' && caseMatch) {
      const item = this.state.cases.find((entry) => entry.id === caseMatch[1]);
      assert.equal(body.expectedVersion, item.version);
      if (this.failNextCasePatch) {
        this.failNextCasePatch = false;
        throw new Error('injected case patch failure');
      }
      item.fields = structuredClone(body.fields);
      item.version += 1;
      return caseEnvelope(item, this.state.pipelines[0]);
    }
    const treeMatch = path.match(/^\/api\/cases\/([^/]+)\/children\/tree$/);
    if (method === 'GET' && treeMatch) return treeFor(this.state.cases, treeMatch[1]);
    if (method === 'GET' && /\/events\?/.test(path)) return { items:[], pagination:{} };
    if (method === 'GET' && /\/outputs$/.test(path)) return [];
    if (method === 'GET' && path === '/api/plugins') return this.plugins;
    if (method === 'GET' && path.startsWith('/api/plugins/plugin-content-autonomy/config?')) {
      return this.contentPluginConfig;
    }
    if (method === 'GET' && path === '/api/companies/company-m5/secrets') return this.contentSecrets;
    if (method === 'GET' && path === '/api/companies/company-m5/secret-providers') return this.contentSecretProviders;
    if (method === 'GET' && path === `/api/secrets/${contentSecretId}/usage`) return this.contentSecretUsage;
    if (
      method === 'GET'
      && path === '/api/plugins/plugin-content-autonomy/companies/company-m5/local-folders/content-workspace/status'
    ) return this.contentWorkspace;
    if (method === 'GET' && path === '/api/companies/company-m5/routines') return this.state.routines;
    if (method === 'GET' && path === '/api/companies/company-m5/agents') return this.agents;
    if (method === 'GET' && path === '/api/companies/company-m5/budgets/overview') return this.budgetOverview;
    if (method === 'GET' && path === '/api/routines/routine-daily') {
      return this.state.routines.find((item) => item.id === 'routine-daily');
    }
    if (method === 'PATCH' && path === '/api/routine-triggers/trigger-daily') {
      const daily = this.state.routines.find((item) => item.id === 'routine-daily');
      daily.triggers[0].enabled = body.enabled;
      return daily.triggers[0];
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

const draftInput = {
  campaignId:'m5-week-01',
  startDate:'2026-08-03',
  themes:['目标闭环', '岗位边界', '工具证据', '失败恢复', '内容生产', '机器审核', '指标复盘'],
  accountRefs:{ douyin:'connection:dy-owner', xiaohongshu:'connection:xhs-owner' },
  budgetUsd:6.25,
};
const approvalInput = { confirmActivityGrant:true, confirmHighBudget:true };

test('活动草案只写入无Routine父Case，执行Case和平台幂等键延迟到批准后', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-01T00:00:00Z') });
  const campaign = await service.createDraft(draftInput);

  assert.equal(adapter.state.cases.length, 1);
  assert.equal(adapter.state.cases[0].stageKey, 'draft');
  assert.equal(adapter.state.cases.filter((item) => item.fields?.platform).length, 0);
  assert.deepEqual(adapter.state.cases[0].fields.campaignPlan, {
    schemaVersion:'agent.army/campaign-plan/v1',
    startDate:draftInput.startDate,
    themes:draftInput.themes,
    assetRightsBasis:'活动声明：仅使用本机自产素材与活动授权生成素材。',
  });
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.grant.totalPublishLimit, 14);
  assert.equal(campaign.grant.dailyPublishLimitPerPlatform, 1);
  assert.deepEqual(campaign.grant.platforms, ['douyin', 'xiaohongshu']);
  assert.equal(campaign.grant.startsAt, '2026-08-02T16:00:00.000Z');
  assert.equal(campaign.grant.expiresAt, '2026-08-09T15:59:59.999Z');
  assert.equal(
    Date.parse(campaign.grant.expiresAt) - Date.parse(campaign.grant.startsAt) + 1,
    7 * 24 * 60 * 60 * 1000,
  );
  assert.deepEqual(campaign.grant.prohibitedActions, ['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history']);
});

test('重复创建同一 campaignId 复用稳定 caseKey，不产生第二批活动状态', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-01T00:00:00Z') });
  const first = await service.createDraft(draftInput);
  const second = await service.createDraft(draftInput);

  assert.equal(adapter.state.cases.length, 1);
  assert.equal(first.campaignId, second.campaignId);
  assert.equal(first.caseKey, draftInput.campaignId);
  assert.equal(second.caseKey, draftInput.campaignId);
  assert.equal(adapter.calls.filter((call) => call.action === 'ingest-case').length, 1);
});

test('显式 activePipelineId 拒绝跨 v1/v2 Case，且 Pipeline key 漂移时失败关闭', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    activePipelineId:'pipeline-m5',
    now:() => new Date('2026-08-01T00:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);
  assert.equal((await service.get(draft.campaignId)).status, 'draft');

  adapter.state.pipelines[0].key = `${defaultDefinition.key}-v2`;
  const v2Service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    activePipelineId:'pipeline-m5',
    activePipelineKey:`${defaultDefinition.key}-v2`,
  });
  assert.equal((await v2Service.list()).length, 1);
  await assert.rejects(() => service.list(), /activePipelineId 指向/);

  adapter.state.pipelines[0].key = defaultDefinition.key;
  adapter.state.cases.find((item) => item.id === draft.campaignId).pipelineId = 'pipeline-v1';
  await assert.rejects(
    () => service.get(draft.campaignId),
    /不属于显式 activePipelineId/,
  );

  adapter.state.pipelines[0].key = 'unexpected-pipeline';
  await assert.rejects(
    () => service.list(),
    /activePipelineId 指向/,
  );
});

test('批准、暂停和恢复只更新 CampaignGrant 并启停已有 Cron', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
  const draft = await service.createDraft(draftInput);

  await assert.rejects(() => service.approve(draft.campaignId, {}), ContentCampaignError);
  await assert.rejects(
    () => service.approve(draft.campaignId, { confirmHighBudget:true }),
    /必须明确确认本次活动授权/,
  );
  await assert.rejects(
    () => service.approve(draft.campaignId, { confirmActivityGrant:true }),
    /预算超过 5 美元/,
  );
  assert.equal((await service.get(draft.campaignId)).status, 'draft');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
  const active = await service.approve(draft.campaignId, approvalInput);
  assert.equal(active.status, 'active');
  assert.equal(adapter.state.cases.length, 22);
  assert.equal(adapter.state.cases.find((item) => item.id === draft.campaignId).stageKey, 'campaign_active');
  assert.equal(adapter.state.cases.filter((item) => item.fields?.platform).length, 14);
  assert.equal(adapter.state.cases.filter((item) => item.parentCaseId).every((item) => item.stageKey === 'draft'), true);
  assert.deepEqual(
    adapter.calls.filter((call) => call.action === 'transition-case').map((call) => call.payload.toStageKey),
    ['campaign_active'],
  );
  assert.equal(new Set(adapter.state.cases.filter((item) => item.fields?.platform).map((item) => item.fields.publishIdempotencyKey)).size, 14);
  assert.equal(adapter.state.routines[0].triggers[0].enabled, true);
  assert.ok(adapter.calls.some((call) =>
    call.method === 'PATCH'
    && call.path === `/api/cases/${draft.campaignId}`
    && Number.isInteger(call.body?.expectedVersion)
    && !Object.hasOwn(call.body || {}, 'version'),
  ));

  const paused = await service.control(draft.campaignId, 'pause', { reason:'预算复核' });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, '预算复核');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, false);

  const resumed = await service.control(draft.campaignId, 'resume');
  assert.equal(resumed.status, 'active');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, true);
});

test('活动视图公开当前负责人和恢复步骤，批准对非草案及失败预检保持关闭', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);

  assert.equal(draft.currentOwner.label, 'A君');
  assert.match(draft.recoveryStep, /活动草案/);
  assert.equal(draft.approval.allowed, true);

  adapter.plugins[0].status = 'disabled';
  const unavailable = await service.get(draft.campaignId);
  assert.equal(unavailable.approval.allowed, false);
  assert.equal(unavailable.approval.code, 'preflight_failed');
  assert.match(unavailable.approval.reason, /内容插件.*未处于 ready/);

  const parent = adapter.state.cases.find((item) => item.id === draft.campaignId);
  parent.stageKey = 'script';
  parent.fields.campaignGrant.status = 'paused';
  parent.fields.m5ContentRecovery = {
    schemaVersion:'agent.army/m5-content-recovery/v1',
    updatedAt:'2026-08-03T00:30:00.000Z',
    replanCount:3,
    activePlanRevision:null,
    stageRecoveries:{
      [`${parent.id}:script`]:{
        status:'blocked',
        updatedAt:'2026-08-03T00:30:00.000Z',
        recoveryAction:{
          instruction:'负责人核对脚本失败证据后，仅恢复当前 Case 的脚本阶段。',
        },
      },
    },
  };
  const paused = await service.get(draft.campaignId);
  assert.equal(paused.currentOwner.label, '小创');
  assert.match(paused.recoveryStep, /仅恢复当前 Case 的脚本阶段/);
  assert.equal(paused.approval.code, 'campaign_not_draft');
  await assert.rejects(
    () => service.approve(draft.campaignId, approvalInput),
    /当前活动不是草案/,
  );
});

test('M5 每日入口只激活 Asia/Shanghai 当天的唯一日期 Case，重复唤醒幂等', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);
  await service.approve(draft.campaignId, approvalInput);
  adapter.calls.length = 0;

  const first = await service.activateScheduledDay();
  assert.deepEqual(first, {
    campaignCaseId:draft.campaignId,
    dayCaseId:first.dayCaseId,
    scheduledDate:'2026-08-03',
    activated:true,
    replayed:false,
    stageKey:'topic',
    grantExpiresAt:'2026-08-09T15:59:59.999Z',
  });
  const dateCases = adapter.state.cases.filter((item) =>
    item.parentCaseId === draft.campaignId && !item.fields?.platform,
  );
  assert.equal(dateCases.find((item) => item.fields.scheduledDate === '2026-08-03').stageKey, 'topic');
  assert.equal(dateCases.filter((item) => item.fields.scheduledDate !== '2026-08-03').every((item) => item.stageKey === 'draft'), true);
  assert.equal(adapter.state.cases.filter((item) => item.fields?.platform).every((item) => item.stageKey === 'draft'), true);

  const replay = await service.activateScheduledDay();
  assert.equal(replay.activated, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.dayCaseId, first.dayCaseId);
  assert.equal(
    adapter.calls.filter((call) => call.action === 'transition-case' && call.payload.toStageKey === 'topic').length,
    1,
  );
});

test('M5 每日入口对关闭 Cron、非 active、过期、歧义活动和异常阶段全部 fail-closed', async (t) => {
  async function activeFixture() {
    const adapter = new CampaignFakeAdapter();
    const service = new ContentCampaignService({
      adapter,
      definition:defaultDefinition,
      now:() => new Date('2026-08-03T01:00:00Z'),
    });
    const draft = await service.createDraft(draftInput);
    await service.approve(draft.campaignId, approvalInput);
    return { adapter, service, parent:adapter.state.cases.find((item) => item.id === draft.campaignId) };
  }

  await t.test('Cron 关闭', async () => {
    const { adapter, service } = await activeFixture();
    adapter.state.routines[0].triggers[0].enabled = false;
    await assert.rejects(() => service.activateScheduledDay(), /Cron 当前关闭/);
  });

  await t.test('没有 active Grant', async () => {
    const { service, parent } = await activeFixture();
    parent.fields.campaignGrant.status = 'paused';
    await assert.rejects(() => service.activateScheduledDay(), /当前为 0 个/);
  });

  await t.test('Grant 已过期', async () => {
    const { service, parent } = await activeFixture();
    parent.fields.campaignGrant.expiresAt = '2026-08-03T00:59:59.000Z';
    await assert.rejects(() => service.activateScheduledDay(), /授权已经过期/);
  });

  await t.test('存在多个 active Grant', async () => {
    const { adapter, service, parent } = await activeFixture();
    adapter.state.cases.push({
      ...structuredClone(parent),
      id:crypto.randomUUID(),
      caseKey:'m5-week-duplicate',
    });
    await assert.rejects(() => service.activateScheduledDay(), /当前为 2 个/);
  });

  await t.test('当日 Case 阶段异常', async () => {
    const { adapter, service, parent } = await activeFixture();
    const day = adapter.state.cases.find((item) =>
      item.parentCaseId === parent.id
      && !item.fields?.platform
      && item.fields?.scheduledDate === '2026-08-03',
    );
    day.stageKey = 'campaign_active';
    await assert.rejects(() => service.activateScheduledDay(), /不可激活阶段 campaign_active/);
  });
});

test('真实 children/tree 包装能统计平台完成数，不依赖树节点 fields', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-01T00:00:00Z') });
  const draft = await service.createDraft(draftInput);
  await service.approve(draft.campaignId, approvalInput);
  const platformCases = adapter.state.cases.filter((item) => item.fields?.platform);
  platformCases[0].stageKey = 'done';
  platformCases[1].stageKey = 'done';

  const campaign = await service.get(draft.campaignId);
  assert.deepEqual(campaign.progress, { completedPlatformCases:2, totalPlatformCases:14 });
});

test('项目预算无法核验或与 CampaignGrant 不一致时，批准失败关闭', async (t) => {
  for (const [label, mutate, message] of [
    ['缺少预算策略', (adapter) => { adapter.budgetOverview.policies = []; }, /项目预算必须可用/],
    ['未启用硬停', (adapter) => { adapter.budgetOverview.policies[0].hardStopEnabled = false; }, /启用硬停/],
    ['金额漂移', (adapter) => { adapter.budgetOverview.policies[0].amount = 700; }, /完全一致/],
    ['预算已硬停', (adapter) => {
      adapter.budgetOverview.policies[0].status = 'hard_stop';
      adapter.budgetOverview.policies[0].paused = true;
      adapter.budgetOverview.policies[0].remainingAmount = 0;
    }, /预算必须可用/],
  ]) {
    await t.test(label, async () => {
      const adapter = new CampaignFakeAdapter();
      const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
      const draft = await service.createDraft(draftInput);
      mutate(adapter);

      await assert.rejects(() => service.approve(draft.campaignId, approvalInput), message);
      assert.equal((await service.get(draft.campaignId)).status, 'draft');
      assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
    });
  }
});

test('插件、Routine绑定或岗位调用条件不满足时批准失败关闭', async (t) => {
  for (const [label, mutate, message] of [
    ['插件未安装', (adapter) => { adapter.plugins = []; }, /内容插件.*未处于 ready/],
    ['插件未就绪', (adapter) => { adapter.plugins[0].status = 'disabled'; }, /内容插件.*未处于 ready/],
    ['插件仍是旧字符串Secret', (adapter) => {
      adapter.contentPluginConfig.configJson.stepfunSecretRef = 'legacy-string-ref';
    }, /secret_ref 对象/],
    ['内容工作区不可用', (adapter) => {
      adapter.contentWorkspace.healthy = false;
    }, /content-workspace/],
    ['岗位grant缺失', (adapter) => {
      adapter.contentPluginConfig.configJson.agentToolGrants[agentIdFor('content-creator')] = [];
    }, /content-creator.*grant/],
    ['岗位暂停', (adapter) => {
      adapter.agents.find((item) => item.id === agentIdFor('ajun')).status = 'paused';
    }, /m5-topic.*状态为 paused/],
    ['岗位错误', (adapter) => {
      adapter.agents.find((item) => item.id === agentIdFor('ajun')).status = 'error';
    }, /m5-topic.*状态为 error/],
    ['空HTTP投影', (adapter) => {
      const agent = adapter.agents.find((item) => item.id === agentIdFor('ajun'));
      agent.status = 'idle';
      agent.adapterType = 'http';
      agent.adapterConfig = {};
    }, /m5-topic.*HTTP adapter 缺少受控 url/],
    ['岗位 manifest 缺专用任务类型', (adapter) => {
      const agent = adapter.agents.find((item) => item.id === agentIdFor('content-creator'));
      agent.adapterConfig.env.AGENT_ARMY_ALLOWED_TASK_TYPES = agent.adapterConfig.env
        .AGENT_ARMY_ALLOWED_TASK_TYPES
        .split(',')
        .filter((item) => item !== 'content.campaign-voice')
        .join(',');
    }, /content-creator.*未声明任务类型 content.campaign-voice/],
    ['岗位 manifest 缺专用执行工具', (adapter) => {
      const agent = adapter.agents.find((item) => item.id === agentIdFor('reviewer'));
      agent.adapterConfig.env.AGENT_ARMY_ALLOWED_MCP_TOOLS = agent.adapterConfig.env
        .AGENT_ARMY_ALLOWED_MCP_TOOLS
        .split(',')
        .filter((item) => item !== 'm5_stage_execute')
        .join(',');
    }, /reviewer.*MCP 工具契约缺少 m5_stage_execute/],
    ['系统 Routine 错绑普通岗位', (adapter) => {
      adapter.state.routines.find((item) => item.id === routineIdFor('m5-publish'))
        .assigneeAgentId = agentIdFor('operator');
    }, /m5-publish.*必须绑定系统控制器 m5-publisher-controller/],
    ['阶段绑定漂移', (adapter) => {
      adapter.state.pipelines[0].stages
        .find((item) => item.key === 'topic')
        .config.onEnter.routineId = 'routine-wrong';
    }, /阶段 topic 未绑定声明的 Routine m5-topic/],
  ]) {
    await t.test(label, async () => {
      const adapter = new CampaignFakeAdapter();
      const service = new ContentCampaignService({
        adapter,
        definition:defaultDefinition,
        now:() => new Date('2026-08-03T01:00:00Z'),
      });
      const draft = await service.createDraft(draftInput);
      mutate(adapter);

      await assert.rejects(() => service.approve(draft.campaignId, approvalInput), message);
      assert.equal((await service.get(draft.campaignId)).status, 'draft');
      assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
    });
  }
});

test('批准兼容 Paperclip typed plain env 契约值', async () => {
  const adapter = new CampaignFakeAdapter();
  for (const agent of adapter.agents.filter((item) => item.adapterType === 'hermes_local')) {
    for (const key of [
      'AGENT_ARMY_ALLOWED_TASK_TYPES',
      'AGENT_ARMY_ALLOWED_MCP_TOOLS',
    ]) {
      agent.adapterConfig.env[key] = {
        type:'plain',
        value:agent.adapterConfig.env[key],
      };
    }
  }
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);

  const active = await service.approve(draft.campaignId, approvalInput);

  assert.equal(active.status, 'active');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, true);
});

test('恢复活动会重新检查插件和岗位可调用状态', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);
  await service.approve(draft.campaignId, approvalInput);
  await service.control(draft.campaignId, 'pause', { reason:'等待复核' });
  adapter.agents.find((item) => item.id === agentIdFor('intel-researcher')).status = 'paused';

  await assert.rejects(
    () => service.control(draft.campaignId, 'resume'),
    /m5-research.*状态为 paused/,
  );
  assert.equal((await service.get(draft.campaignId)).status, 'paused');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
});

test('恢复活动会重新检查公司级插件Secret绑定且失败关闭', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const draft = await service.createDraft(draftInput);
  await service.approve(draft.campaignId, approvalInput);
  await service.control(draft.campaignId, 'pause', { reason:'等待 Secret 复核' });
  adapter.contentSecretUsage.bindings = [];

  await assert.rejects(
    () => service.control(draft.campaignId, 'resume'),
    /重新保存插件配置/,
  );
  assert.equal((await service.get(draft.campaignId)).status, 'paused');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
});

test('共享 Cron 同时只允许一个 active 活动', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
  const first = await service.createDraft(draftInput);
  await service.approve(first.campaignId, approvalInput);
  const second = await service.createDraft({
    ...draftInput,
    campaignId:'m5-week-02',
    startDate:'2026-08-10',
  });

  await assert.rejects(
    () => service.approve(second.campaignId, approvalInput),
    /共享 M5 Cron 已被活动 m5-week-01 占用/,
  );
  assert.equal((await service.get(second.campaignId)).status, 'draft');
});

test('控制串行锁下并发批准两个不同草案时只能一个 active', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
  const first = await service.createDraft(draftInput);
  const second = await service.createDraft({
    ...draftInput,
    campaignId:'m5-week-02',
    startDate:'2026-08-10',
  });

  const settled = await Promise.allSettled([
    service.approve(first.campaignId, approvalInput),
    service.approve(second.campaignId, approvalInput),
  ]);
  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  const rejected = settled.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /共享 M5 Cron 已被活动/);

  const campaigns = await service.list();
  assert.equal(campaigns.filter((campaign) => campaign.status === 'active').length, 1);
  assert.equal(campaigns.filter((campaign) => campaign.status === 'draft').length, 1);
  assert.equal(adapter.state.routines[0].triggers[0].enabled, true);
});

test('Cron 缺失时批准和恢复必须失败关闭，不能留下 active 假状态', async (t) => {
  await t.test('批准失败仍保持 draft', async () => {
    const adapter = new CampaignFakeAdapter();
    const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
    const draft = await service.createDraft(draftInput);
    adapter.state.routines = [];

    await assert.rejects(() => service.approve(draft.campaignId, approvalInput), /Routine 不存在/);
    assert.equal((await service.get(draft.campaignId)).status, 'draft');
  });

  await t.test('恢复失败仍保持 paused', async () => {
    const adapter = new CampaignFakeAdapter();
    const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
    const draft = await service.createDraft(draftInput);
    await service.approve(draft.campaignId, approvalInput);
    await service.control(draft.campaignId, 'pause', { reason:'等待恢复' });
    adapter.state.routines = [];

    await assert.rejects(() => service.control(draft.campaignId, 'resume'), /Routine 不存在/);
    assert.equal((await service.get(draft.campaignId)).status, 'paused');
  });
});

test('CampaignGrant 写入失败时精确恢复 Cron 原状态，不做简单反转', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => new Date('2026-08-03T01:00:00Z') });
  const draft = await service.createDraft(draftInput);
  adapter.state.routines[0].triggers[0].enabled = true;
  adapter.failNextCasePatch = true;

  await assert.rejects(
    () => service.approve(draft.campaignId, approvalInput),
    /injected case patch failure/,
  );
  assert.equal(adapter.state.routines[0].triggers[0].enabled, true);
  assert.equal((await service.get(draft.campaignId)).status, 'draft');
});

test('拒绝凭据字段和伪装成账号引用的登录态', async (t) => {
  for (const [label, input] of [
    ['token', { ...draftInput, token:'should-never-be-accepted' }],
    ['嵌套 Cookie', { ...draftInput, metadata:{ cookies:['should-never-be-accepted'] } }],
    ['credentials', { ...draftInput, credentials:{ session:'should-never-be-accepted' } }],
    ['Bearer 登录态', {
      ...draftInput,
      accountRefs:{ ...draftInput.accountRefs, douyin:'Bearer should-never-be-accepted' },
    }],
  ]) {
    await t.test(label, async () => {
      const service = new ContentCampaignService({ adapter:new CampaignFakeAdapter(), definition:defaultDefinition });
      await assert.rejects(
        () => service.createDraft(input),
        (error) => error instanceof ContentCampaignError && /(?:禁止|不能)提交/.test(error.message),
      );
    });
  }
});

test('插件未安装时工具执行保持关闭且不读取活动状态', async () => {
  const adapter = new CampaignFakeAdapter();
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition });
  const callsBeforeTool = adapter.calls.length;
  await assert.rejects(
    () => service.executeTool({ campaignId:'12345678-1234-1234-1234-123456789012', toolId:'stepfun.vision' }),
    /尚未通过安装门禁/,
  );
  assert.equal(adapter.calls.length, callsBeforeTool);
});

test('内容工具只接收服务端覆盖的活动父Case与CampaignGrant', async () => {
  const adapter = new CampaignFakeAdapter();
  const calls = [];
  const service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    toolExecutor:{ execute:async (input) => { calls.push(input); return { accepted:true }; } },
    now:() => new Date('2026-08-03T01:00:00Z'),
  });
  const campaign = await service.createDraft(draftInput);
  await service.approve(campaign.campaignId, approvalInput);
  const result = await service.executeTool({
    campaignId:campaign.campaignId,
    campaignCase:{ id:'forged' },
    campaignGrant:{ status:'forged' },
    caseId:adapter.state.cases.find((item) => item.parentCaseId === campaign.campaignId).id,
    toolId:'agent-army.content-autonomy:campaign-preflight',
    parameters:{ campaign:{} },
  });
  assert.deepEqual(result, { accepted:true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].campaignCase, undefined);
  assert.equal(calls[0].campaignGrant, undefined);
  assert.equal(calls[0].campaignCaseId, campaign.campaignId);
});

test('只向 Publisher 查询确定性十六进制回执标识，非法标识不下发', async (t) => {
  const receiptCalls = [];
  const publisher = {
    async getReceipt(receiptId) {
      receiptCalls.push(receiptId);
      return { receiptId, status:'recorded' };
    },
  };
  const service = new ContentCampaignService({
    adapter:new CampaignFakeAdapter(),
    definition:defaultDefinition,
    publisher,
  });
  const validId = '01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(await service.getPublishReceipt(validId), {
    receiptId:validId,
    status:'recorded',
  });

  for (const invalidId of [
    'receipt_abc',
    '01234567-89ab-cdef-0123-456789abcdeg',
    '../01234567-89ab-cdef-0123-456789abcdef',
    '0123456789abcdefabcdef01',
  ]) {
    await t.test(invalidId, async () => {
      await assert.rejects(() => service.getPublishReceipt(invalidId), /发布凭证标识无效/);
    });
  }
  assert.deepEqual(receiptCalls, [validId]);
});

test('显式 fake Publisher 可经现有工具与回执接口返回本地回执和指标', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-ajun-publisher-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('ajun-controlled-fake-video');
  await fs.writeFile(path.join(root, 'douyin.mp4'), media);
  const contentChecksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  let now = new Date('2026-08-03T01:00:00Z');
  let service;
  const bindings = createM5PublisherBindings({
    env:{
      AJUN_M5_PUBLISHER_MODE:'fake',
      AJUN_M5_PUBLISHER_WORKSPACE_ROOT:root,
      AJUN_M5_PUBLISHER_LEDGER_PATH:path.join(root, 'ledger.json'),
    },
    dataDir:root,
    clock:() => new Date(now),
    getCampaignService:async () => service,
  });
  const adapter = new CampaignFakeAdapter();
  const contentExecutor = {
    async resolveContext(input) {
      const targetCase = adapter.state.cases.find((item) => item.id === input.caseId);
      const campaignCase = adapter.state.cases.find((item) => item.id === input.campaignCaseId);
      return {
        campaignCaseId:input.campaignCaseId,
        campaignGrant:campaignCase?.fields?.campaignGrant,
        targetCase,
        runContext:{ runId:'fake-paperclip-running-run' },
      };
    },
  };
  service = new ContentCampaignService({
    adapter,
    definition:defaultDefinition,
    publisher:bindings.publisher,
    toolExecutor:new M5ToolExecutorRouter({
      publisherExecutor:bindings.toolExecutor,
      contentExecutor,
    }),
    now:() => new Date(now),
  });
  const campaign = await service.createDraft(draftInput);
  await service.approve(campaign.campaignId, approvalInput);
  const platformCase = adapter.state.cases.find((item) =>
    item.fields?.platform === 'douyin'
    && item.fields?.scheduledDate === '2026-08-03'
  );
  platformCase.stageKey = 'publish';
  const input = {
    campaignId:campaign.campaignId,
    caseId:platformCase.id,
    toolId:'publisher.fake_publish',
    platform:'douyin',
    contentVersionId:'content-v1-douyin',
    contentChecksum,
    scheduledDate:'2026-08-03',
    mediaPath:'douyin.mp4',
    title:'A君本地 fake 发布',
    body:'不访问真实平台。',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
      checks:{ facts:true, privacy:true, rights:true, media:true, claims:true, grantScope:true, duplicate:true },
    },
  };
  const callApi = (payload) => routeM5PublisherApi({
    method:'POST',
    url:'/api/tool-executions',
    local:true,
    getService:async () => service,
    readBody:async () => payload,
    paperclipApiKey:'fixture-short-lived-run-jwt',
  });
  await assert.rejects(
    callApi({ ...input, platform:'xiaohongshu' }),
    /平台.*不一致/,
  );
  const firstResponse = await callApi(input);
  const replayResponse = await callApi(input);
  const first = firstResponse.payload.execution;
  const replay = replayResponse.payload.execution;
  now = new Date(Date.parse(first.receipt.publishedAt) + 72 * 3_600_000);
  await bindings.runtime.collectMetricSnapshot({
    campaignId:first.receipt.campaignId,
    receiptId:first.receipt.receiptId,
    collectionKey:`${first.receipt.receiptId}:72h`,
    collectedAt:new Date(
      Date.parse(first.receipt.publishedAt) + 72 * 3_600_000,
    ).toISOString(),
  });
  const receiptResponse = await routeM5PublisherApi({
    method:'GET',
    url:`/api/publish-receipts/${first.receipt.receiptId}`,
    local:true,
    getService:async () => service,
  });
  const receipt = receiptResponse.payload.receipt;

  assert.equal(firstResponse.status, 200);
  assert.equal(receiptResponse.status, 200);
  assert.equal(first.mode, 'fake');
  assert.equal(replay.replayed, true);
  assert.equal(receipt.connectorMode, 'fake');
  assert.equal(receipt.metricSnapshots.length, 1);
});

test('过期 CampaignGrant 拒绝恢复并保持 Cron 关闭', async () => {
  const adapter = new CampaignFakeAdapter();
  let current = new Date('2026-08-03T01:00:00Z');
  const service = new ContentCampaignService({ adapter, definition:defaultDefinition, now:() => current });
  const draft = await service.createDraft(draftInput);
  await service.approve(draft.campaignId, approvalInput);
  await service.control(draft.campaignId, 'pause', { reason:'等待复核' });
  current = new Date('2026-08-10T00:00:00Z');

  await assert.rejects(() => service.control(draft.campaignId, 'resume'), /已经过期，不能恢复/);
  assert.equal((await service.get(draft.campaignId)).status, 'paused');
  assert.equal(adapter.state.routines[0].triggers[0].enabled, false);
});

function treeFor(cases, parentId) {
  const root = cases.find((item) => item.id === parentId);
  const caseNode = treeNode(cases, root);
  return {
    case:caseNode,
    rollup:caseNode.rollup,
    childGroups:caseNode.childGroups,
    truncated:false,
    totalNodes:countTreeNodes(caseNode),
  };
}

function treeNode(cases, item) {
  const children = cases.filter((entry) => entry.parentCaseId === item.id).map((entry) => treeNode(cases, entry));
  const done = item.stageKey === 'done';
  return {
    id:item.id,
    caseKey:item.caseKey,
    title:item.title,
    terminalKind:done ? 'done' : null,
    createdAt:item.createdAt || null,
    updatedAt:item.updatedAt || null,
    pipeline:{ id:item.pipelineId },
    stage:{ key:item.stageKey, name:item.stageKey, kind:done ? 'done' : 'work' },
    rollup:{ total:children.length },
    childGroups:children.length ? [{ stageKey:'children', cases:children }] : [],
  };
}

function countTreeNodes(item) {
  return 1 + item.childGroups.reduce(
    (total, group) => total + group.cases.reduce((sum, child) => sum + countTreeNodes(child), 0),
    0,
  );
}

function caseEnvelope(item, pipeline) {
  const done = item.stageKey === 'done';
  return {
    case:item,
    stage:{ key:item.stageKey, name:item.stageKey, kind:done ? 'done' : 'work' },
    pipeline,
    parentCase:item.parentCaseId
      ? { id:item.parentCaseId }
      : null,
    activeWork:null,
    descendantActiveWorkCount:0,
  };
}
