import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentCampaignService } from '../src/content-campaign-service.js';
import { m5WorkProductArtifactHash } from '../src/m5-work-product-integrity.js';
import { getM5RoutineExecutionContract } from '../src/m5-routine-execution-contract.js';
import { defaultDefinition } from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';

const campaignId = '11111111-1111-4111-8111-111111111111';
const caseId = '22222222-2222-4222-8222-222222222222';
const PIPELINE = Object.freeze({
  id:'pipeline-m5',
  key:defaultDefinition.key,
  projectId:'project-m5',
});
const LOCAL_FIXTURE_PROVENANCE = Object.freeze({
  kind:'local_fixture',
  fixtureId:'m5-hermes-stage-fixture',
  externalSideEffects:0,
});

function confirmedProviderReceipt(
  actionId,
  operation,
  model,
  costEventId,
  {
    projectId = '',
    heartbeatRunId = '',
    status = 'confirmed',
  } = {},
) {
  const costEvent = {
    provider:'stepfun',
    projectId,
    heartbeatRunId,
    costCents:1,
  };
  return {
    actionId,
    operation,
    model,
    callRecord:{
      actionId,
      operation,
      model,
      promptChecksum:`sha256:${'f'.repeat(64)}`,
      costEvent,
    },
    costCommit:{
      status,
      costEventId,
      costEvent,
    },
  };
}

function withActivePipeline(adapter) {
  const request = adapter.request.bind(adapter);
  return {
    ...adapter,
    companyId:adapter.companyId,
    async request(method, path, body) {
      if (method === 'GET' && path === `/api/pipelines/${PIPELINE.id}`) return PIPELINE;
      const result = await request(method, path, body);
      if (
        method === 'GET'
        && /^\/api\/cases\/[^/]+$/.test(path)
        && result
        && typeof result === 'object'
        && !Array.isArray(result)
      ) {
        return result.case
          ? { ...result, case:{ ...result.case, pipelineId:PIPELINE.id }, pipeline:PIPELINE }
          : { ...result, pipelineId:PIPELINE.id };
      }
      return result;
    },
  };
}

function trustedOutput(artifactKind, artifact, provider = 'agent-army.ajun-runtime') {
  const artifactHash = `sha256:${'b'.repeat(64)}`;
  return {
    kind:'work_product',
    type:'artifact',
    provider,
    externalId:artifactHash,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/test-artifact/v1',
      kind:'TestArtifact',
      artifactKind,
      artifact,
      sourceTaskId:`source-task-${artifactKind}`,
      sourceArtifactId:`source-artifact-${artifactKind}`,
      artifactHash,
    },
  };
}

async function voiceReplayFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-voice-replay-'));
  t.after(() => fs.rm(workspace, { recursive:true, force:true }));
  const relativePath = `campaigns/${campaignId}/${caseId}/voice.mp3`;
  const absolutePath = path.join(workspace, relativePath);
  const fileBytes = Buffer.from('verified StepFun voice bytes');
  await fs.mkdir(path.dirname(absolutePath), { recursive:true });
  await fs.writeFile(absolutePath, fileBytes);
  const sourceRunId = 'run-m5-source-voice';
  const currentRunId = 'run-m5-current-recovery';
  const sourceAgentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const issueId = 'issue-m5-voice';
  const taskId = 'task-m5-voice';
  const artifact = {
    model:'stepaudio-2.5-tts',
    voice:'official-voice-1',
    relativePath,
    checksum:`sha256:${crypto.createHash('sha256').update(fileBytes).digest('hex')}`,
    bytes:fileBytes.length,
    providerReceipt:confirmedProviderReceipt(
      'm5:tts:confirmed:replay',
      'tts',
      'stepaudio-2.5-tts',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      { projectId:PIPELINE.projectId, heartbeatRunId:sourceRunId },
    ),
  };
  const metadata = {
    schemaVersion:'agent.army/voice-package/v1',
    kind:'VoicePackage',
    stageKey:'voice',
    routineKey:'m5-voice',
    sourceTaskId:taskId,
    sourceArtifactId:'source-artifact-voice',
    sourceIssueId:issueId,
    pipelineCaseId:caseId,
    projectId:PIPELINE.projectId,
    sourceRunId,
    artifactKind:'voice_package',
    artifact,
  };
  const product = {
    id:'work-product-voice',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    createdByRunId:sourceRunId,
    metadata,
  };
  const seal = () => {
    metadata.artifactHash = m5WorkProductArtifactHash(metadata);
    product.externalId = metadata.artifactHash;
  };
  seal();
  const products = [product];
  let executions = 0;
  const authority = {
    plugin:{
      confirmed:true,
      actionId:'m5:tts:confirmed:replay',
      costEventId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operation:'tts',
      provider:'stepfun',
      model:'stepaudio-2.5-tts',
      projectId:PIPELINE.projectId,
      heartbeatRunId:sourceRunId,
      costCents:1,
    },
    activity:[{
      id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      companyId:'company-test',
      actorType:'user',
      actorId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      action:'cost.reported',
      entityType:'cost_event',
      entityId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      details:{ model:'stepaudio-2.5-tts', costCents:1 },
      createdAt:'2026-07-30T00:00:00.000Z',
    }],
    pluginError:false,
    activityError:false,
    outputsError:false,
    outputsResponse:undefined,
  };
  const adapter = {
    companyId:'company-test',
    async request(method, requestPath, body) {
      if (method === 'GET' && requestPath === `/api/cases/${caseId}`) {
        return { id:caseId, parentCaseId:campaignId, version:4, stageKey:'voice', fields:{} };
      }
      if (method === 'GET' && requestPath === `/api/cases/${campaignId}`) {
        return { id:campaignId, parentCaseId:null, version:3, fields:{ campaignGrant:{ status:'active' } } };
      }
      if (method === 'GET' && requestPath === `/api/cases/${caseId}/outputs`) {
        if (authority.outputsError) throw new Error('outputs unavailable');
        if (authority.outputsResponse !== undefined) {
          return structuredClone(authority.outputsResponse);
        }
        return products;
      }
      if (method === 'GET' && requestPath === `/api/cases/${campaignId}/outputs`) return [];
      if (method === 'GET' && requestPath === `/api/issues/${issueId}/runs`) {
        return [
          { id:sourceRunId, agentId:sourceAgentId, status:'completed' },
          { id:currentRunId, agentId:sourceAgentId, status:'running' },
        ];
      }
      if (
        method === 'POST'
        && requestPath === '/api/plugins/agent-army.content-autonomy/actions/provider-action-verify'
      ) {
        if (authority.pluginError) throw new Error('plugin unavailable');
        assert.deepEqual(body, {
          companyId:'company-test',
          params:{
            actionId:artifact.providerReceipt.actionId,
            costEventId:artifact.providerReceipt.costCommit.costEventId,
            operation:'tts',
            runContext:{
              agentId:sourceAgentId,
              runId:sourceRunId,
              companyId:'company-test',
              projectId:PIPELINE.projectId,
            },
          },
        });
        return { data:{ data:structuredClone(authority.plugin) } };
      }
      if (
        method === 'GET'
        && requestPath.startsWith('/api/companies/company-test/activity?')
      ) {
        if (authority.activityError) throw new Error('activity unavailable');
        const query = new URL(requestPath, 'http://paperclip.local').searchParams;
        assert.equal(query.get('entityType'), 'cost_event');
        assert.equal(query.get('entityId'), artifact.providerReceipt.costCommit.costEventId);
        assert.equal(query.get('limit'), '500');
        return structuredClone(authority.activity);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    contentWorkspaceRoot:workspace,
    toolExecutor:{ async execute() { executions += 1; } },
  });
  const execute = () => service.executeHermesStage({
    assignment:{
      agentId:'content-creator',
      issueId,
      runId:currentRunId,
      projectId:PIPELINE.projectId,
    },
    task:{
      taskId,
      governance:{ paperclipIssueId:issueId },
      taskType:'content.campaign-voice',
      input:{ context:{
        paperclipRoutineKey:'m5-voice',
        pipelineCaseId:caseId,
        paperclipProjectId:PIPELINE.projectId,
      } },
    },
  });
  return {
    absolutePath,
    artifact,
    authority,
    execute,
    executions:() => executions,
    metadata,
    product,
    products,
    seal,
    sourceRunId,
    currentRunId,
  };
}

async function assetReplayFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-asset-replay-'));
  t.after(() => fs.rm(workspace, { recursive:true, force:true }));
  const sourceRunId = 'run-m5-source-assets';
  const issueId = 'issue-m5-assets';
  const taskId = 'task-m5-assets';
  const assetBytes = [Buffer.from('frame one'), Buffer.from('frame two')];
  const assets = [];
  const absolutePaths = [];
  for (const [index, bytes] of assetBytes.entries()) {
    const relativePath = `campaigns/${campaignId}/${caseId}/assets/frame-00${index + 1}.png`;
    const absolutePath = path.join(workspace, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive:true });
    await fs.writeFile(absolutePath, bytes);
    absolutePaths.push(absolutePath);
    assets.push({
      frameId:`frame-00${index + 1}`,
      relativePath,
      checksum:`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      bytes:bytes.length,
    });
  }
  const metadata = {
    schemaVersion:'agent.army/asset-package/v1',
    kind:'AssetPackage',
    stageKey:'assets',
    routineKey:'m5-assets',
    sourceTaskId:taskId,
    sourceArtifactId:'source-artifact-assets',
    sourceIssueId:issueId,
    pipelineCaseId:caseId,
    projectId:PIPELINE.projectId,
    sourceRunId,
    artifactKind:'asset_package',
    artifact:{
      assets,
      coverSourcePath:assets[0].relativePath,
      rightsBasis:'自产录屏，经活动授权用于内容生产。',
    },
  };
  const product = {
    id:'work-product-assets',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    createdByRunId:sourceRunId,
    metadata,
  };
  const seal = () => {
    metadata.artifactHash = m5WorkProductArtifactHash(metadata);
    product.externalId = metadata.artifactHash;
  };
  seal();
  const service = new ContentCampaignService({
    adapter:{},
    definition:defaultDefinition,
    contentWorkspaceRoot:workspace,
  });
  const validate = () => service.assertReplayableM5WorkProduct({
    contract:getM5RoutineExecutionContract('m5-assets'),
    product,
    targetCaseId:caseId,
    projectId:PIPELINE.projectId,
    assignment:{ issueId, runId:'run-m5-current-assets' },
    task:{ taskId, governance:{ paperclipIssueId:issueId } },
    paperclipRuns:[{ id:sourceRunId, status:'completed' }],
  });
  return { absolutePaths, assets, metadata, seal, validate, workspace };
}

test('m5_stage_execute 从当前 voice Case 和 Work Product 派生固定 TTS 调用', async () => {
  const calls = [];
  const root = {
    id:campaignId,
    parentCaseId:null,
    version:3,
    fields:{
      campaignGrant:{
        schemaVersion:'agent.army/campaign-grant/v1',
        grantId:'grant-test',
        status:'active',
        startsAt:'2026-07-29T00:00:00.000Z',
        expiresAt:'2026-08-10T00:00:00.000Z',
      },
    },
  };
  const child = {
    id:caseId,
    parentCaseId:campaignId,
    version:2,
    stageKey:'voice',
    fields:{ scheduledDate:'2026-07-30', platform:'douyin' },
  };
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [trustedOutput(
          'video_script_package',
          { data:{ fullScript:'这是用于受控配音的真实脚本文本。' } },
        )];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      if (method === 'GET' && path === '/api/plugins') {
        return [{ id:'plugin-content-autonomy', pluginKey:'agent-army.content-autonomy' }];
      }
      if (method === 'GET' && path.startsWith('/api/plugins/plugin-content-autonomy/config?')) {
        return { configJson:{ officialTtsVoices:['official-voice-1'] } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        calls.push(input);
        return { status:'succeeded' };
      },
    },
  });

  const result = await service.executeHermesStage({
    assignment:{ agentId:'content-creator', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-voice',
      input:{ context:{ paperclipRoutineKey:'m5-voice', pipelineCaseId:caseId } },
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolId, 'agent-army.content-autonomy:stepfun-tts');
  assert.equal(calls[0].caseId, caseId);
  assert.equal(calls[0].campaignCaseId, campaignId);
  assert.deepEqual(calls[0].parameters, {
    actionId:`${caseId}:voice:v2`,
    text:'这是用于受控配音的真实脚本文本。',
    voice:'official-voice-1',
    speed:1,
    outputPath:`campaigns/${campaignId}/${caseId}/voice.mp3`,
  });
});

test('m5_stage_execute 缺少可信前置 Work Product 时不调用插件', async () => {
  let executions = 0;
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) {
        return { id:caseId, parentCaseId:campaignId, version:1, stageKey:'voice', fields:{} };
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}`) {
        return {
          id:campaignId,
          parentCaseId:null,
          version:1,
          fields:{ campaignGrant:{
            schemaVersion:'agent.army/campaign-grant/v1',
            status:'active',
            startsAt:'2026-07-29T00:00:00.000Z',
            expiresAt:'2026-08-10T00:00:00.000Z',
          } },
        };
      }
      if (method === 'GET' && path.endsWith('/outputs')) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{ async execute() { executions += 1; } },
  });
  await assert.rejects(
    () => service.executeHermesStage({
      assignment:{ agentId:'content-creator', runId:'run-m5-stage-test' },
      task:{
        taskType:'content.campaign-voice',
        input:{ context:{ paperclipRoutineKey:'m5-voice', pipelineCaseId:caseId } },
      },
    }),
    /缺少可信 ScriptPackage/,
  );
  assert.equal(executions, 0);
});

test('m5_stage_execute 跨当前 Run 仍复用同 Issue/Case/Project 和 source creator 的已验证产物', async (t) => {
  const fixture = await voiceReplayFixture(t);
  assert.notEqual(fixture.sourceRunId, fixture.currentRunId);
  const result = await fixture.execute();
  assert.equal(result.replayed, true);
  assert.equal(result.artifact.type, 'voice_package');
  assert.deepEqual(result.artifact.data, fixture.artifact);
  assert.equal(fixture.executions(), 0);
});

test('m5_stage_execute 同阶段合法加漂移、两个合法都硬停，无关阶段输出不影响重放', async (t) => {
  for (const variant of ['valid-plus-drift', 'drift-plus-valid', 'two-valid', 'unrelated']) {
    await t.test(variant, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      const extra = structuredClone(fixture.product);
      extra.id = `work-product-${variant}`;
      if (variant.includes('drift')) {
        extra.metadata.artifactHash = `sha256:${'a'.repeat(64)}`;
        extra.externalId = extra.metadata.artifactHash;
      } else if (variant === 'unrelated') {
        extra.metadata.stageKey = 'research';
        extra.metadata.schemaVersion = 'agent.army/evidence-package/v1';
        extra.metadata.kind = 'EvidencePackage';
      }
      fixture.products.push(extra);
      if (variant === 'drift-plus-valid') fixture.products.reverse();
      if (variant === 'unrelated') {
        assert.equal((await fixture.execute()).replayed, true);
      } else {
        await assert.rejects(fixture.execute, /多个 Work Product 候选|未解决漂移/);
      }
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('m5_stage_execute Case outputs读取失败或非官方裸数组时在工具调用前硬停', async (t) => {
  for (const variant of ['unavailable', 'wrapped', 'object']) {
    await t.test(variant, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      if (variant === 'unavailable') fixture.authority.outputsError = true;
      else if (variant === 'wrapped') fixture.authority.outputsResponse = { items:fixture.products };
      else fixture.authority.outputsResponse = {};
      await assert.rejects(
        fixture.execute,
        /无法读取 Case .*Work Product.*工具调用前停止/,
      );
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('m5_stage_execute 拒绝 canonical artifactHash 伪造且不覆盖产物', async (t) => {
  const fixture = await voiceReplayFixture(t);
  fixture.metadata.artifactHash = `sha256:${'a'.repeat(64)}`;
  fixture.product.externalId = fixture.metadata.artifactHash;
  await assert.rejects(fixture.execute, /Work Product 漂移.*artifactHash/);
  assert.equal(fixture.executions(), 0);
});

test('m5_stage_execute 拒绝跨 Issue 或 Project 的 Work Product', async (t) => {
  for (const field of ['sourceIssueId', 'projectId']) {
    await t.test(field, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      fixture.metadata[field] = `other-${field}`;
      fixture.seal();
      await assert.rejects(fixture.execute, /Work Product 漂移.*Issue、Case、Project/);
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('m5_stage_execute 拒绝已验证后被替换的工作区文件', async (t) => {
  const fixture = await voiceReplayFixture(t);
  await fs.writeFile(fixture.absolutePath, Buffer.from('replaced after verification'));
  await assert.rejects(fixture.execute, /Work Product 漂移.*bytes 或 sha256 已漂移/);
  assert.equal(fixture.executions(), 0);
});

test('m5_stage_execute 拒绝 pending 或错 source Run 的 Provider 回执', async (t) => {
  for (const variant of ['pending', 'wrong-run']) {
    await t.test(variant, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      if (variant === 'pending') {
        fixture.artifact.providerReceipt.costCommit.status = 'pending_core_cost_event';
      } else {
        fixture.artifact.providerReceipt.callRecord.costEvent.heartbeatRunId = 'run-other';
        fixture.artifact.providerReceipt.costCommit.costEvent.heartbeatRunId = 'run-other';
      }
      fixture.seal();
      await assert.rejects(fixture.execute, /Work Product 漂移.*StepFun tts action/);
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('m5_stage_execute Provider 回放必须同时匹配插件confirmed状态和Paperclip核心费用活动', async (t) => {
  for (const variant of ['plugin-unavailable', 'plugin-action', 'plugin-cost', 'plugin-run', 'plugin-project']) {
    await t.test(variant, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      if (variant === 'plugin-unavailable') {
        fixture.authority.pluginError = true;
      } else if (variant === 'plugin-action') {
        fixture.authority.plugin.actionId = 'm5:tts:other:action';
      } else if (variant === 'plugin-cost') {
        fixture.authority.plugin.costEventId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      } else if (variant === 'plugin-run') {
        fixture.authority.plugin.heartbeatRunId = 'run-other';
      } else {
        fixture.authority.plugin.projectId = 'project-other';
      }
      await assert.rejects(
        fixture.execute,
        /Work Product 漂移.*(?:只读 confirmed 状态证明|权威 confirmed 回执不一致)/,
      );
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('m5_stage_execute 核心费用活动允许无关审计事件但要求唯一合法cost.reported', async (t) => {
  const passing = await voiceReplayFixture(t);
  passing.authority.activity.unshift({
    id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    companyId:'company-test',
    actorType:'user',
    actorId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    action:'cost.viewed',
    entityType:'cost_event',
    entityId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    details:{},
    createdAt:'2026-07-30T00:01:00.000Z',
  });
  assert.equal((await passing.execute()).replayed, true);

  for (const variant of [
    'empty',
    'duplicate',
    'wrapped',
    'wrong-action',
    'wrong-id',
    'wrong-company',
    'wrong-entity',
    'wrong-model',
    'wrong-cost',
    'wrong-actor-type',
    'missing-actor',
    'bad-created-at',
    'unavailable',
  ]) {
    await t.test(variant, async (subtest) => {
      const fixture = await voiceReplayFixture(subtest);
      const row = fixture.authority.activity[0];
      if (variant === 'empty') fixture.authority.activity = [];
      else if (variant === 'duplicate') {
        fixture.authority.activity.push({ ...structuredClone(row), id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
      } else if (variant === 'wrapped') fixture.authority.activity = { items:[row] };
      else if (variant === 'wrong-action') row.action = 'cost.viewed';
      else if (variant === 'wrong-id') row.id = 'not-a-uuid';
      else if (variant === 'wrong-company') row.companyId = 'company-other';
      else if (variant === 'wrong-entity') row.entityId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      else if (variant === 'wrong-model') row.details.model = 'forged-model';
      else if (variant === 'wrong-cost') row.details.costCents = 999;
      else if (variant === 'wrong-actor-type') row.actorType = 'system';
      else if (variant === 'missing-actor') row.actorId = '';
      else if (variant === 'bad-created-at') row.createdAt = 'not-a-date';
      else fixture.authority.activityError = true;
      await assert.rejects(
        fixture.execute,
        /Work Product 漂移.*(?:核心费用活动反查|唯一匹配的 Paperclip 核心费用事件)/,
      );
      assert.equal(fixture.executions(), 0);
    });
  }
});

test('AssetPackage 回放逐个核验当前受控工作区真实资产', async (t) => {
  const fixture = await assetReplayFixture(t);
  await fixture.validate();
});

test('AssetPackage 回放拒绝删除、替换、越界和符号链接资产', async (t) => {
  for (const variant of ['deleted', 'replaced', 'traversal', 'symlink']) {
    await t.test(variant, async (subtest) => {
      const fixture = await assetReplayFixture(subtest);
      if (variant === 'deleted') {
        await fs.rm(fixture.absolutePaths[0]);
      } else if (variant === 'replaced') {
        await fs.writeFile(fixture.absolutePaths[0], Buffer.from('replaced asset'));
      } else if (variant === 'traversal') {
        fixture.assets[0].relativePath = '../outside.png';
        fixture.seal();
      } else {
        const target = path.join(fixture.workspace, 'symlink-target.png');
        await fs.writeFile(target, Buffer.from('frame one'));
        await fs.rm(fixture.absolutePaths[0]);
        await fs.symlink(target, fixture.absolutePaths[0]);
      }
      await assert.rejects(fixture.validate, /Work Product 漂移/);
    });
  }
});

test('m5_stage_execute 发现缺少血缘的同阶段 VoicePackage 时硬停且不覆盖', async () => {
  const calls = [];
  const root = {
    id:campaignId,
    parentCaseId:null,
    version:3,
    fields:{
      campaignGrant:{
        schemaVersion:'agent.army/campaign-grant/v1',
        grantId:'grant-test',
        status:'active',
        startsAt:'2026-07-29T00:00:00.000Z',
        expiresAt:'2026-08-10T00:00:00.000Z',
      },
    },
  };
  const child = {
    id:caseId,
    parentCaseId:campaignId,
    version:4,
    stageKey:'voice',
    fields:{},
  };
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [
          {
            id:'forged-work-product-voice',
            kind:'work_product',
            type:'artifact',
            provider:'agent-army.ajun-runtime',
            sourceTrust:null,
            status:'active',
            healthStatus:'healthy',
            metadata:{
              schemaVersion:'agent.army/voice-package/v1',
              kind:'VoicePackage',
              stageKey:'voice',
              artifact:{
                relativePath:`campaigns/${campaignId}/${caseId}/voice.mp3`,
                checksum:`sha256:${'a'.repeat(64)}`,
                bytes:2048,
              },
            },
          },
          trustedOutput(
            'video_script_package',
            { data:{ fullScript:'缺少血缘的声音产物不能绕过本次受控配音执行。' } },
          ),
        ];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      if (method === 'GET' && path === '/api/plugins') {
        return [{ id:'plugin-content-autonomy', pluginKey:'agent-army.content-autonomy' }];
      }
      if (method === 'GET' && path.startsWith('/api/plugins/plugin-content-autonomy/config?')) {
        return { configJson:{ officialTtsVoices:['official-voice-1'] } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        calls.push(input);
        return { status:'succeeded' };
      },
    },
  });

  await assert.rejects(
    () => service.executeHermesStage({
      assignment:{ agentId:'content-creator', runId:'run-m5-stage-test' },
      task:{
        taskType:'content.campaign-voice',
        input:{ context:{ paperclipRoutineKey:'m5-voice', pipelineCaseId:caseId } },
      },
    }),
    /Work Product 漂移/,
  );
  assert.equal(calls.length, 0);
});

test('m5_stage_execute 渲染前先确定性写入并回读 props 哈希', async () => {
  const calls = [];
  const root = {
    id:campaignId,
    parentCaseId:null,
    version:1,
    fields:{ campaignGrant:{
      schemaVersion:'agent.army/campaign-grant/v1',
      status:'active',
      startsAt:'2026-07-29T00:00:00.000Z',
      expiresAt:'2026-08-10T00:00:00.000Z',
    } },
  };
  const child = {
    id:caseId,
    parentCaseId:campaignId,
    version:1,
    stageKey:'render',
    fields:{ platform:'douyin' },
  };
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [
          trustedOutput('video_script_package', {
            headline:'AI Agent 实战',
            hook:'Agent 不是会说就算完成。',
            fullScript:'真实工具结果必须进入下一步，失败时还要能恢复。',
            shots:[{ startSeconds:0, endSeconds:45, narration:'真实工具结果必须进入下一步。' }],
          }),
          trustedOutput('voice_package', {
            relativePath:`campaigns/${campaignId}/${caseId}/voice.mp3`,
            checksum:`sha256:${'a'.repeat(64)}`,
            fixtureProvenance:LOCAL_FIXTURE_PROVENANCE,
          }),
          trustedOutput('generated_image_package', {
            model:'step-image-edit-2',
            relativePath:`campaigns/${caseId}/generated-visual.png`,
            checksum:`sha256:${'e'.repeat(64)}`,
            bytes:2048,
            fixtureProvenance:LOCAL_FIXTURE_PROVENANCE,
          }),
          trustedOutput('asset_package', {
            rightsBasis:'自产录屏，经活动授权用于内容生产。',
            assets:[{
              frameId:'frame-001',
              relativePath:`campaigns/${caseId}/assets/frame-001.png`,
              checksum:`sha256:${'d'.repeat(64)}`,
              bytes:1024,
            }],
          }),
        ];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        calls.push(input);
        if (input.toolId.endsWith(':remotion-props-write')) {
          return {
            propsPath:input.parameters.outputPath,
            checksum:`sha256:${'b'.repeat(64)}`,
          };
        }
        return {
          toolId:input.toolId,
          composition:input.parameters.composition,
          propsPath:input.parameters.propsPath,
          outputPath:input.parameters.outputPath,
          checksum:`sha256:${'c'.repeat(64)}`,
          bytes:4096,
        };
      },
    },
  });
  const result = await service.executeHermesStage({
    assignment:{ agentId:'content-creator', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-render',
      input:{ context:{ paperclipRoutineKey:'m5-render', pipelineCaseId:caseId } },
    },
  });
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call.toolId.endsWith(':remotion-props-write')).length, 3);
  assert.equal(calls.filter((call) => call.toolId.endsWith(':remotion-render')).length, 3);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.artifact.data.outputs).map(([platform, output]) => [
      platform,
      output.outputPath,
    ])),
    {
      master:`campaigns/${campaignId}/${caseId}/master.mp4`,
      douyin:`campaigns/${campaignId}/${caseId}/douyin.mp4`,
      xiaohongshu:`campaigns/${campaignId}/${caseId}/xiaohongshu.mp4`,
    },
  );
  assert.equal(result.artifact.validation.fixedOutputsVerified, true);
  for (const call of calls.filter((item) => item.toolId.endsWith(':remotion-props-write'))) {
    assert.equal(call.parameters.props.coverSrc, `campaigns/${caseId}/generated-visual.png`);
    assert.ok(call.parameters.props.scenes.every((scene) =>
      scene.imageSrc === `campaigns/${caseId}/generated-visual.png`,
    ));
    assert.deepEqual(
      call.parameters.props.assetLedger.map((asset) => asset.relativePath),
      [
        `campaigns/${caseId}/generated-visual.png`,
        `campaigns/${caseId}/assets/frame-001.png`,
      ],
    );
  }
});

test('m5_stage_execute 已有真实 AssetPackage 但缺少 GeneratedImagePackage 时拒绝渲染', async () => {
  let executions = 0;
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) {
        return {
          id:caseId,
          parentCaseId:campaignId,
          version:1,
          stageKey:'render',
          fields:{},
        };
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}`) {
        return {
          id:campaignId,
          parentCaseId:null,
          fields:{ campaignGrant:{ status:'active' } },
        };
      }
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [
          trustedOutput('video_script_package', {
            fullScript:'只有脚本和声音，没有真实画面。',
          }),
          trustedOutput('voice_package', {
            relativePath:'campaigns/voice.mp3',
            checksum:`sha256:${'a'.repeat(64)}`,
          }),
          trustedOutput('asset_package', {
            rightsBasis:'自产录屏，经活动授权用于内容生产。',
            assets:[{
              frameId:'frame-001',
              relativePath:'campaigns/assets/frame-001.png',
              checksum:`sha256:${'d'.repeat(64)}`,
              bytes:1024,
            }],
          }),
        ];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    toolExecutor:{ async execute() { executions += 1; } },
  });

  await assert.rejects(
    () => service.executeHermesStage({
      assignment:{ agentId:'content-creator', runId:'run-m5-stage-test' },
      task:{
        taskType:'content.campaign-render',
        input:{ context:{ paperclipRoutineKey:'m5-render', pipelineCaseId:caseId } },
      },
    }),
    /拒绝白生成图片/,
  );
  assert.equal(executions, 0);
});

test('m5_stage_execute 机器审核组合真实媒体与字幕结果后才生成七项报告', async () => {
  const calls = [];
  const root = {
    id:campaignId,
    parentCaseId:null,
    version:1,
    fields:{ campaignGrant:{
      schemaVersion:'agent.army/campaign-grant/v1',
      status:'active',
      platforms:['douyin'],
      receipts:[],
      startsAt:'2026-07-29T00:00:00.000Z',
      expiresAt:'2026-08-10T00:00:00.000Z',
    } },
  };
  const child = {
    id:caseId,
    parentCaseId:campaignId,
    version:1,
    stageKey:'machine_review',
    fields:{ platform:'douyin', scheduledDate:'2026-07-30' },
  };
  const script = {
    headline:'AI Agent 实战',
    hook:'看真实结果。',
    fullScript:'真实工具结果必须进入下一步。\n\n可核验结论：Paperclip 管流程，Hermes 执行岗位任务。',
    factBindings:[{
      claimId:'claim-1',
      statement:'Paperclip 管流程，Hermes 执行岗位任务。',
      sourceIds:['source-1', 'source-2'],
      evidenceFragments:[
        { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
        { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
      ],
    }],
    qualityReview:{ unresolved:[] },
  };
  const outputs = [
    trustedOutput('video_script_package', script),
    trustedOutput('evidence_package', {
      schemaVersion:'agent.army/evidence-package/v2',
      sources:[
        {
          sourceId:'source-1',
          url:'https://example.com/a',
          fetchedAt:'2026-07-30T00:00:00.000Z',
          contentHash:'a'.repeat(64),
          kind:'public_web',
          evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'来源 A 原文。' }],
        },
        {
          sourceId:'source-2',
          url:'https://example.com/b',
          fetchedAt:'2026-07-30T00:00:00.000Z',
          contentHash:'b'.repeat(64),
          kind:'public_pdf',
          evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'来源 B 原文。' }],
        },
      ],
      claims:[{
        claimId:'claim-1',
        text:'Paperclip 管流程，Hermes 执行岗位任务。',
        sourceIds:['source-1', 'source-2'],
        evidenceFragments:[
          { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
          { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
        ],
      }],
    }),
    trustedOutput('voice_package', {
      model:'stepaudio-2.5-tts',
      voice:'official-voice-1',
      relativePath:'campaigns/voice.mp3',
      checksum:`sha256:${'a'.repeat(64)}`,
      fixtureProvenance:LOCAL_FIXTURE_PROVENANCE,
    }),
    trustedOutput('generated_image_package', {
      model:'step-image-edit-2',
      relativePath:'campaigns/generated-visual.png',
      checksum:`sha256:${'e'.repeat(64)}`,
      bytes:2048,
      fixtureProvenance:LOCAL_FIXTURE_PROVENANCE,
    }),
    trustedOutput('visual_analysis_package', {
      schemaVersion:'agent.army/visual-analysis-package/v1',
      insights:[{
        insightId:'visual-001',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }],
      fixtureProvenance:LOCAL_FIXTURE_PROVENANCE,
    }),
    trustedOutput('asset_package', {
      rightsBasis:'自产录屏，经活动授权用于内容生产。',
      assets:[{
        frameId:'frame-001',
        relativePath:'campaigns/assets/frame-001.png',
        checksum:`sha256:${'d'.repeat(64)}`,
        bytes:1024,
      }],
    }),
    trustedOutput('render_package', {
      outputs:{
        master:{
          composition:'M5Master',
          propsPath:'campaigns/M5Master.props.json',
          relativePath:'campaigns/master.mp4',
          checksum:`sha256:${'1'.repeat(64)}`,
          durationSeconds:45,
        },
        douyin:{
          composition:'M5Douyin',
          propsPath:'campaigns/M5Douyin.props.json',
          relativePath:'campaigns/douyin.mp4',
          checksum:`sha256:${'2'.repeat(64)}`,
          durationSeconds:45,
        },
        xiaohongshu:{
          composition:'M5Xiaohongshu',
          propsPath:'campaigns/M5Xiaohongshu.props.json',
          relativePath:'campaigns/xiaohongshu.mp4',
          checksum:`sha256:${'3'.repeat(64)}`,
          durationSeconds:45,
        },
      },
    }),
  ];
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) return outputs;
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    allowLocalFixtureProvenance:true,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        calls.push(input);
        if (input.toolId.endsWith(':media-validate')) {
          return { passed:true, relativePath:input.parameters.relativePath, errors:[] };
        }
        if (input.toolId.endsWith(':artifact-package-write')) {
          return {
            manifestPath:`campaigns/${campaignId}/${caseId}/package/artifact-manifest.json`,
            manifestChecksum:`sha256:${'e'.repeat(64)}`,
          };
        }
        if (input.toolId.endsWith(':artifact-lineage-validate')) {
          return {
            passed:true,
            errors:[],
            requiredArtifacts:[
              'master.mp4',
              'douyin.mp4',
              'xiaohongshu.mp4',
              'douyin.copy.json',
              'xiaohongshu.copy.json',
              'cover.png',
              'sources.json',
              'review.json',
              'lineage.json',
            ],
          };
        }
        return { passed:true, propsPath:input.parameters.propsPath, errors:[] };
      },
    },
  });
  const result = await service.executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-machine-review',
      input:{ context:{ paperclipRoutineKey:'m5-machine-review', pipelineCaseId:caseId } },
    },
  });
  assert.equal(calls.length, 4);
  assert.match(calls[0].toolId, /:media-validate$/);
  assert.match(calls[1].toolId, /:subtitle-layout-validate$/);
  assert.match(calls[2].toolId, /:artifact-package-write$/);
  assert.deepEqual(calls[2].parameters.sources.fixtureProvenance, LOCAL_FIXTURE_PROVENANCE);
  assert.equal(calls[2].parameters.providerActionRefs, undefined);
  assert.deepEqual(
    calls[2].parameters.sources.sources.map((source) => ({
      ref:source.ref,
      fetchedAt:source.fetchedAt,
      contentHash:source.contentHash,
    })),
    [
      {
        ref:'https://example.com/a',
        fetchedAt:'2026-07-30T00:00:00.000Z',
        contentHash:'a'.repeat(64),
      },
      {
        ref:'https://example.com/b',
        fetchedAt:'2026-07-30T00:00:00.000Z',
        contentHash:'b'.repeat(64),
      },
    ],
  );
  assert.match(calls[3].toolId, /:artifact-lineage-validate$/);
  assert.equal(result.artifact.type, 'machine_review_report');
  assert.equal(result.artifact.data.reviewReport.status, 'passed');
  assert.ok(Object.values(result.artifact.data.reviewReport.checks).every(Boolean));
  assert.match(result.artifact.data.reviewReport.contentVersionId, /^m5:douyin:/);
  assert.match(
    result.artifact.data.reviewReport.evidence.artifactPackage.manifestPath,
    /artifact-manifest\.json$/,
  );

  let productionExecutions = 0;
  const productionService = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute() {
        productionExecutions += 1;
        throw new Error('生产门禁应在任何插件调用前关闭。');
      },
    },
  });
  await assert.rejects(
    () => productionService.executeHermesStage({
      assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
      task:{
        taskType:'content.campaign-machine-review',
        input:{ context:{ paperclipRoutineKey:'m5-machine-review', pipelineCaseId:caseId } },
      },
    }),
    /缺少可由内容插件同 Project 状态反查的三条 confirmed action\/cost 血缘/,
  );
  assert.equal(productionExecutions, 0);

  const confirmedOutputs = structuredClone(outputs);
  const confirmedKinds = Object.fromEntries(confirmedOutputs.map((output) => [
    output.metadata?.artifactKind,
    output.metadata?.artifact,
  ]));
  for (const value of [
    confirmedKinds.generated_image_package,
    confirmedKinds.visual_analysis_package,
    confirmedKinds.voice_package,
  ]) delete value.fixtureProvenance;
  confirmedKinds.generated_image_package.providerReceipt = confirmedProviderReceipt(
    'm5:image:confirmed:1',
    'image_generate',
    'step-image-edit-2',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  confirmedKinds.visual_analysis_package.providerReceipt = confirmedProviderReceipt(
    'm5:vision:confirmed:1',
    'vision',
    'step-1o-turbo-vision',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  confirmedKinds.voice_package.providerReceipt = confirmedProviderReceipt(
    'm5:tts:confirmed:1',
    'tts',
    'stepaudio-2.5-tts',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  const confirmedCalls = [];
  const confirmedService = new ContentCampaignService({
    adapter:withActivePipeline({
      companyId:'company-test',
      async request(method, path) {
        if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
        if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
        if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) return confirmedOutputs;
        if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        confirmedCalls.push(input);
        if (input.toolId.endsWith(':media-validate')) {
          return { passed:true, relativePath:input.parameters.relativePath, errors:[] };
        }
        if (input.toolId.endsWith(':artifact-package-write')) {
          return {
            manifestPath:`campaigns/${campaignId}/${caseId}/package/artifact-manifest.json`,
            manifestChecksum:`sha256:${'e'.repeat(64)}`,
          };
        }
        if (input.toolId.endsWith(':artifact-lineage-validate')) {
          return {
            passed:true,
            errors:[],
            requiredArtifacts:[
              'master.mp4',
              'douyin.mp4',
              'xiaohongshu.mp4',
              'douyin.copy.json',
              'xiaohongshu.copy.json',
              'cover.png',
              'sources.json',
              'review.json',
              'lineage.json',
            ],
          };
        }
        return { passed:true, propsPath:input.parameters.propsPath, errors:[] };
      },
    },
  });
  await confirmedService.executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-machine-review',
      input:{ context:{ paperclipRoutineKey:'m5-machine-review', pipelineCaseId:caseId } },
    },
  });
  const confirmedPackageCall = confirmedCalls.find((call) =>
    call.toolId.endsWith(':artifact-package-write')
  );
  assert.deepEqual(confirmedPackageCall.parameters.providerActionRefs, {
    image:'m5:image:confirmed:1',
    vision:'m5:vision:confirmed:1',
    tts:'m5:tts:confirmed:1',
  });
  assert.equal(confirmedPackageCall.parameters.sources.fixtureProvenance, undefined);

  const tamperedOutputs = structuredClone(outputs);
  const tamperedEvidence = tamperedOutputs.find((output) =>
    output.metadata?.artifactKind === 'evidence_package'
  );
  const tamperedData = tamperedEvidence.metadata.artifact;
  tamperedData.claims[0].evidenceFragments[0].text = '被改写的证据片段。';
  const rejectedCalls = [];
  const rejected = await new ContentCampaignService({
    adapter:withActivePipeline({
      companyId:'company-test',
      async request(method, path) {
        if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
        if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
        if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) return tamperedOutputs;
        if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    allowLocalFixtureProvenance:true,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        rejectedCalls.push(input);
        return input.toolId.endsWith(':media-validate')
          ? { passed:true, relativePath:input.parameters.relativePath, errors:[] }
          : { passed:true, propsPath:input.parameters.propsPath, errors:[] };
      },
    },
  }).executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-machine-review',
      input:{ context:{ paperclipRoutineKey:'m5-machine-review', pipelineCaseId:caseId } },
    },
  });
  assert.equal(rejected.artifact.data.reviewReport.status, 'failed');
  assert.equal(rejected.artifact.data.reviewReport.checks.facts, false);
  assert.deepEqual(rejectedCalls.map((call) => call.toolId.endsWith(':artifact-package-write')), [false, false]);
});

test('发布审批会解包 ContentVersion 和 MachineReview 后再交固定 preflight', async () => {
  const calls = [];
  const contentVersion = {
    contentVersionId:'m5:douyin:version-1',
    platform:'douyin',
    checksum:`sha256:${'a'.repeat(64)}`,
    mediaPath:'campaigns/douyin.mp4',
    title:'AI Agent 实战',
    body:'只讲可核验结果。',
    tags:['AI Agent'],
  };
  const reviewReport = {
    status:'passed',
    contentVersionId:contentVersion.contentVersionId,
    checks:{
      facts:true,
      privacy:true,
      rights:true,
      media:true,
      claims:true,
      grantScope:true,
      duplicate:true,
    },
  };
  const root = {
    id:campaignId,
    parentCaseId:null,
    fields:{ campaignGrant:{
      schemaVersion:'agent.army/campaign-grant/v1',
      status:'active',
      startsAt:'2026-07-29T00:00:00.000Z',
      expiresAt:'2026-08-10T00:00:00.000Z',
    } },
  };
  const child = {
    id:caseId,
    parentCaseId:campaignId,
    version:1,
    stageKey:'publish_approval',
    fields:{ platform:'douyin', scheduledDate:'2026-07-30' },
  };
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && path === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [
          trustedOutput('platform_content_draft', { contentVersion }, 'agent-army.content-autonomy'),
          trustedOutput('machine_review_report', { reviewReport }, 'agent-army.content-autonomy'),
        ];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    toolExecutor:{ async execute(input) {
      calls.push(input);
      return { passed:true, errors:[], idempotencyKey:'campaign:douyin:version:date' };
    } },
  });
  await service.executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-publish-approval',
      input:{ context:{ paperclipRoutineKey:'m5-publish-approval', pipelineCaseId:caseId } },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, { contentVersion, reviewReport });
});

test('verify 阶段只读核验同 Case 唯一 PublishReceipt，不调用插件或外部平台', async () => {
  let executions = 0;
  const receiptId = '33333333-3333-4333-8333-333333333333';
  const receipt = {
    receiptId,
    platform:'douyin',
    scheduledDate:'2026-07-30',
    contentVersionId:'content-v1',
    contentChecksum:'b'.repeat(64),
    externalContentId:'douyin-content-1',
    evidence:'https://creator.example/success/1',
    publishedAt:'2026-07-30T02:00:00.000Z',
  };
  const adapter = {
    companyId:'company-test',
    async request(method, path) {
      if (method === 'GET' && path === `/api/cases/${caseId}`) {
        return {
          id:caseId,
          parentCaseId:campaignId,
          version:1,
          stageKey:'verify',
          fields:{ platform:'douyin', scheduledDate:'2026-07-30' },
        };
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}`) {
        return { id:campaignId, parentCaseId:null, fields:{ campaignGrant:{ status:'active' } } };
      }
      if (method === 'GET' && path === `/api/cases/${caseId}/outputs`) {
        return [{
          kind:'work_product',
          type:'artifact',
          provider:'agent-army.publisher-gateway',
          sourceTrust:null,
          status:'active',
          healthStatus:'healthy',
          metadata:{
            schemaVersion:'agent.army/publish-receipt/v1',
            kind:'PublishReceipt',
            receipt,
          },
        }];
      }
      if (method === 'GET' && path === `/api/cases/${campaignId}/outputs`) return [];
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    toolExecutor:{ async execute() { executions += 1; } },
  });
  const result = await service.executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-m5-stage-test' },
    task:{
      taskType:'content.campaign-verify',
      input:{ context:{ paperclipRoutineKey:'m5-verify', pipelineCaseId:caseId } },
    },
  });
  assert.equal(result.toolId, 'agent-army.m5:publish_receipt_verify');
  assert.equal(result.artifact.type, 'publish_verification_report');
  assert.equal(result.artifact.data.receiptId, receiptId);
  assert.equal(executions, 0);
});
