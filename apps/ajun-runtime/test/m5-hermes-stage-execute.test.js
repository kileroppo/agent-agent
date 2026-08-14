import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentCampaignService } from '../src/content-campaign-service.ts';
import { LocalContentCreator } from '../src/local-content-growth.ts';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.ts';
import { M5LearningLifecycle } from '../src/m5-learning-lifecycle.ts';
import { m5WorkProductArtifactHash } from '@agent-army/m5-kernel/work-product-integrity';
import {
  defaultM5ProductionTemplateBinding,
  m5GrayProductionTemplateBinding,
  m5ProductionTemplateBindingHash,
} from '../src/m5-production-template-resolver.ts';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import { defaultDefinition } from '../../../integrations/paperclip/m5-content-pipeline/src/index.ts';

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

function testTemplateBinding(overrides = {}) {
  const value = {
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'template-test-v1',
    source:'built_in_default',
    decisionStatus:'default',
    decisionWorkProductId:null,
    productionDefault:true,
    contentGuidance:[],
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
    ...overrides,
    contentGuidance:overrides.contentGuidance
      ?? (overrides.source === 'approved_single_gray'
        || (
          overrides.source === 'approved_learning_decision'
          && overrides.decisionStatus === 'validated'
        )
        ? ['只调整目标平台前三秒开场。']
        : []),
  };
  return {
    ...value,
    bindingHash:m5ProductionTemplateBindingHash(value),
  };
}

function testScriptVariant(variantKey, fullScript, templateBinding) {
  return {
    variantKey,
    headline:`${variantKey} 标题`,
    hook:`${variantKey} 开场`,
    fullScript,
    shots:[{ startSeconds:0, endSeconds:45, narration:fullScript }],
    templateBinding,
    templateGuidanceHash:templateBinding.bindingHash,
    scriptHash:`sha256:${crypto.createHash('sha256').update(fullScript).digest('hex')}`,
  };
}

function socialCardReceipt(parameters) {
  const outputDir = parameters.outputDir;
  const cards = parameters.props.cards.map((card, index) => ({
    id:card.id,
    relativePath:`${outputDir}/xhs-${String(index + 1).padStart(2, '0')}-${card.id}.png`,
    width:1080,
    height:1440,
    bytes:2048 + index,
    checksum:`sha256:${String(index + 4).repeat(64)}`,
  }));
  return {
    schemaVersion:'agent.army/social-card-package/v1',
    platform:'xiaohongshu',
    outputDir,
    propsPath:`${outputDir}/social-card.props.json`,
    propsChecksum:`sha256:${'4'.repeat(64)}`,
    manifestPath:`${outputDir}/social-card-render-manifest.json`,
    manifestChecksum:`sha256:${'5'.repeat(64)}`,
    templateBindingHash:parameters.props.templateBinding.bindingHash,
    rightsBasis:parameters.props.rightsBasis,
    rightsBasisHash:`sha256:${crypto.createHash('sha256').update(parameters.props.rightsBasis).digest('hex')}`,
    cards,
    checks:{
      dimensions:true,
      fileHashes:true,
      assetLineage:true,
      rightsBasis:true,
      externalNetworkUsed:false,
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

test('m5_stage_execute 灰度日用两条独立幂等动作生成并封装双 Voice 变体', async () => {
  const calls = [];
  const scheduledDate = '2026-07-30';
  const douyinCaseId = '33333333-3333-4333-8333-333333333333';
  const baselineBinding = testTemplateBinding({
    templateVersionId:'baseline-template-v1',
    source:'built_in_default',
    decisionStatus:'default',
    productionDefault:true,
  });
  const grayBinding = testTemplateBinding({
    templateVersionId:'gray-template-v2',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:douyinCaseId,
    grayTargetDayCaseId:caseId,
    grayTargetScheduledDate:scheduledDate,
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
  });
  const baseline = testScriptVariant(
    'baseline',
    'baseline 真实脚本用于稳定内容生产。',
    baselineBinding,
  );
  const gray = testScriptVariant(
    'gray_douyin',
    'gray_douyin 真实脚本只用于目标抖音成片。',
    grayBinding,
  );
  const scriptPackage = {
    ...baseline,
    templateLifecycle:{ templateBinding:baselineBinding },
    variants:{ baseline, gray_douyin:gray },
  };
  const root = {
    id:campaignId,
    parentCaseId:null,
    version:3,
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
    version:4,
    stageKey:'voice',
    fields:{ scheduledDate },
  };
  const adapter = {
    companyId:'company-test',
    async request(method, requestPath) {
      if (method === 'GET' && requestPath === `/api/cases/${caseId}`) return child;
      if (method === 'GET' && requestPath === `/api/cases/${campaignId}`) return root;
      if (method === 'GET' && requestPath === `/api/cases/${caseId}/outputs`) {
        return [trustedOutput('video_script_package', { data:scriptPackage })];
      }
      if (method === 'GET' && requestPath === `/api/cases/${campaignId}/outputs`) return [];
      if (method === 'GET' && requestPath === '/api/plugins') {
        return [{ id:'plugin-content-autonomy', pluginKey:'agent-army.content-autonomy' }];
      }
      if (method === 'GET' && requestPath.startsWith('/api/plugins/plugin-content-autonomy/config?')) {
        return { configJson:{ officialTtsVoices:['official-voice-1'] } };
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
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
        const variantKey = input.parameters.variantKey;
        const checksum = `sha256:${variantKey === 'baseline' ? 'a'.repeat(64) : 'b'.repeat(64)}`;
        return {
          model:'stepaudio-2.5-tts',
          voice:'official-voice-1',
          relativePath:input.parameters.outputPath,
          checksum,
          bytes:1024,
          ...confirmedProviderReceipt(
            input.parameters.actionId,
            'tts',
            'stepaudio-2.5-tts',
            variantKey === 'baseline'
              ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
              : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ),
        };
      },
    },
  });

  const result = await service.executeHermesStage({
    assignment:{ agentId:'content-creator', runId:'run-m5-gray-voice' },
    task:{
      taskType:'content.campaign-voice',
      input:{ context:{ paperclipRoutineKey:'m5-voice', pipelineCaseId:caseId } },
    },
  });

  assert.deepEqual(
    calls.map((call) => call.parameters.actionId),
    [
      `${caseId}:voice:baseline:v4`,
      `${caseId}:voice:gray_douyin:v4`,
    ],
  );
  assert.equal(result.artifact.data.variantKey, 'baseline');
  assert.equal(result.artifact.data.variants.baseline.scriptHash, baseline.scriptHash);
  assert.equal(result.artifact.data.variants.gray_douyin.scriptHash, gray.scriptHash);
  assert.notEqual(
    result.artifact.data.variants.baseline.audioHash,
    result.artifact.data.variants.gray_douyin.audioHash,
  );
  assert.equal(result.artifact.validation.variantLineageVerified, true);
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

test('m5_stage_execute 灰度 VoicePackage 回放时拒绝被换接的 scriptHash', async (t) => {
  const fixture = await voiceReplayFixture(t);
  const baselineBinding = testTemplateBinding({
    templateVersionId:'baseline-replay-v1',
    source:'built_in_default',
    decisionStatus:'default',
    productionDefault:true,
  });
  const grayBinding = testTemplateBinding({
    templateVersionId:'gray-replay-v2',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:'33333333-3333-4333-8333-333333333333',
    grayTargetDayCaseId:caseId,
    grayTargetScheduledDate:'2026-07-30',
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
  });
  const baseline = testScriptVariant(
    'baseline',
    '用于回放的 baseline 脚本。',
    baselineBinding,
  );
  const gray = testScriptVariant(
    'gray_douyin',
    '用于回放的 gray_douyin 脚本。',
    grayBinding,
  );
  const baselineVoice = {
    ...fixture.artifact,
    variantKey:'baseline',
    scriptHash:baseline.scriptHash,
    templateBinding:baselineBinding,
    audioHash:fixture.artifact.checksum,
  };
  fixture.metadata.artifact = {
    ...baselineVoice,
    variantMode:'douyin_single_gray_v1',
    variants:{
      baseline:baselineVoice,
      gray_douyin:{
        ...baselineVoice,
        variantKey:'gray_douyin',
        // 模拟持久化后被换接到 baseline 脚本。
        scriptHash:baseline.scriptHash,
        templateBinding:grayBinding,
      },
    },
  };
  fixture.products.push(trustedOutput('video_script_package', {
    ...baseline,
    templateLifecycle:{ templateBinding:baselineBinding },
    variants:{ baseline, gray_douyin:gray },
  }));
  fixture.seal();

  await assert.rejects(fixture.execute, /无法回到同一脚本|Work Product 漂移/);
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
        if (input.toolId.endsWith(':social-card-render')) {
          return socialCardReceipt(input.parameters);
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
  assert.equal(calls.length, 7);
  assert.equal(calls.filter((call) => call.toolId.endsWith(':remotion-props-write')).length, 3);
  assert.equal(calls.filter((call) => call.toolId.endsWith(':remotion-render')).length, 3);
  assert.equal(calls.filter((call) => call.toolId.endsWith(':social-card-render')).length, 1);
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
  assert.equal(result.artifact.validation.socialCardsVerified, true);
  assert.equal(result.artifact.data.socialCardPackage.cards.length, 3);
  for (const output of Object.values(result.artifact.data.outputs)) {
    assert.equal(output.variantKey, 'baseline');
    assert.match(output.scriptHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(output.audioHash, `sha256:${'a'.repeat(64)}`);
    assert.match(output.templateBindingHash, /^sha256:[0-9a-f]{64}$/);
  }
  for (const call of calls.filter((item) => item.toolId.endsWith(':remotion-props-write'))) {
    assert.equal(call.parameters.props.variantLineage.variantKey, 'baseline');
    assert.match(
      call.parameters.props.variantLineage.templateBindingHash,
      /^sha256:[0-9a-f]{64}$/,
    );
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
  assert.deepEqual(result.artifact.data.reviewReport.variantLineage, {
    variantKey:'baseline',
    scriptHash:`sha256:${crypto.createHash('sha256').update(script.fullScript).digest('hex')}`,
    templateBindingHash:null,
    renderChecksum:`sha256:${'2'.repeat(64)}`,
  });
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

test('机器审核按平台锁定脚本声音和单平台copy，灰度抖音与baseline小红书互不派生文案', async () => {
  const scheduledDate = '2026-07-30';
  const statement = 'Paperclip 管流程，Hermes 执行岗位任务。';
  const baselineBinding = testTemplateBinding({
    templateVersionId:'baseline-review-v1',
    source:'built_in_default',
    decisionStatus:'default',
    productionDefault:true,
  });
  const grayBinding = testTemplateBinding({
    templateVersionId:'gray-review-v2',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:caseId,
    grayTargetDayCaseId:campaignId,
    grayTargetScheduledDate:scheduledDate,
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
  });
  const factBindings = [{
    claimId:'claim-1',
    statement,
    sourceIds:['source-1', 'source-2'],
    evidenceFragments:[
      { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
      { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
    ],
  }];
  const baseline = {
    ...testScriptVariant('baseline', `稳定脚本。\n${statement}`, baselineBinding),
    factBindings,
    qualityReview:{ unresolved:[] },
  };
  const gray = {
    ...testScriptVariant(
      'gray_douyin',
      `token=abcdefghi\n灰度脚本。\n${statement}`,
      grayBinding,
    ),
    factBindings,
    qualityReview:{ unresolved:[] },
  };
  const voiceVariant = (variant, checksumChar, actionId, costEventId) => ({
    variantKey:variant.variantKey,
    scriptHash:variant.scriptHash,
    templateBinding:variant.templateBinding,
    model:'stepaudio-2.5-tts',
    voice:'official-voice-1',
    relativePath:`campaigns/voice-${variant.variantKey}.mp3`,
    checksum:`sha256:${checksumChar.repeat(64)}`,
    audioHash:`sha256:${checksumChar.repeat(64)}`,
    bytes:1024,
    providerReceipt:confirmedProviderReceipt(
      actionId,
      'tts',
      'stepaudio-2.5-tts',
      costEventId,
    ),
  });
  const baselineVoice = voiceVariant(
    baseline,
    'a',
    'm5:tts:baseline:review',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  const grayVoice = voiceVariant(
    gray,
    'b',
    'm5:tts:gray:review',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const lineage = (variant, voice) => ({
    variantKey:variant.variantKey,
    scriptHash:variant.scriptHash,
    audioHash:voice.audioHash,
    templateBindingHash:variant.templateBinding.bindingHash,
    voiceProviderActionId:voice.providerReceipt.actionId,
  });
  const outputs = [
    trustedOutput('video_script_package', {
      ...baseline,
      templateLifecycle:{ templateBinding:baselineBinding },
      variants:{ baseline, gray_douyin:gray },
    }),
    trustedOutput('voice_package', {
      ...baselineVoice,
      variantMode:'douyin_single_gray_v1',
      variants:{ baseline:baselineVoice, gray_douyin:grayVoice },
    }),
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
        text:statement,
        sourceIds:['source-1', 'source-2'],
        evidenceFragments:factBindings[0].evidenceFragments,
      }],
    }),
    trustedOutput('generated_image_package', {
      model:'step-image-edit-2',
      relativePath:'campaigns/generated-visual.png',
      checksum:`sha256:${'e'.repeat(64)}`,
      bytes:2048,
      providerReceipt:confirmedProviderReceipt(
        'm5:image:gray-review',
        'image_generate',
        'step-image-edit-2',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ),
    }),
    trustedOutput('visual_analysis_package', {
      insights:[{ evidenceKind:'stepfun_vision_frame' }],
      providerReceipt:confirmedProviderReceipt(
        'm5:vision:gray-review',
        'vision',
        'step-1o-turbo-vision',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ),
    }),
    trustedOutput('asset_package', {
      rightsBasis:'本机自产素材',
      assets:[{
        frameId:'frame-1',
        relativePath:'campaigns/frame.png',
        checksum:`sha256:${'d'.repeat(64)}`,
        bytes:1024,
      }],
    }),
    trustedOutput('render_package', {
      outputs:{
        master:{
          composition:'M5Master',
          propsPath:'campaigns/master.props.json',
          relativePath:'campaigns/master.mp4',
          checksum:`sha256:${'1'.repeat(64)}`,
          durationSeconds:45,
          ...lineage(baseline, baselineVoice),
        },
        douyin:{
          composition:'M5Douyin',
          propsPath:'campaigns/douyin.props.json',
          relativePath:'campaigns/douyin.mp4',
          checksum:`sha256:${'2'.repeat(64)}`,
          durationSeconds:45,
          ...lineage(gray, grayVoice),
        },
        xiaohongshu:{
          composition:'M5Xiaohongshu',
          propsPath:'campaigns/xhs.props.json',
          relativePath:'campaigns/xhs.mp4',
          checksum:`sha256:${'3'.repeat(64)}`,
          durationSeconds:45,
          ...lineage(baseline, baselineVoice),
        },
      },
    }),
  ];
  const campaignCase = {
    id:campaignId,
    fields:{ campaignGrant:{
      schemaVersion:'agent.army/campaign-grant/v1',
      grantId:'grant-gray-review',
      status:'active',
      platforms:['douyin', 'xiaohongshu'],
      receipts:[],
      startsAt:'2026-07-29T00:00:00.000Z',
      expiresAt:'2026-08-10T00:00:00.000Z',
    } },
  };
  const calls = [];
  const service = new ContentCampaignService({
    adapter:{},
    definition:defaultDefinition,
    now:() => new Date('2026-07-30T00:00:00.000Z'),
    toolExecutor:{
      async execute(input) {
        calls.push(input);
        if (input.toolId.endsWith(':media-validate')) {
          return { passed:true, relativePath:input.parameters.relativePath, errors:[] };
        }
        if (input.toolId.endsWith(':artifact-package-write')) {
          return {
            manifestPath:'campaigns/package/artifact-manifest.json',
            manifestChecksum:`sha256:${'e'.repeat(64)}`,
          };
        }
        if (input.toolId.endsWith(':artifact-lineage-validate')) {
          return { passed:true, errors:[], requiredArtifacts:[] };
        }
        return { passed:true, propsPath:input.parameters.propsPath, errors:[] };
      },
    },
  });
  service.getRawCase = async () => campaignCase;

  const douyin = await service.executeM5MachineReview({
    campaignCase,
    targetCase:{
      id:caseId,
      parentCaseId:campaignId,
      fields:{ platform:'douyin', scheduledDate },
    },
    targetCaseId:caseId,
    outputs,
    parameters:{ relativePath:'campaigns/douyin.mp4', expectedDurationSeconds:45 },
    sourceTaskId:'task-review-gray',
  });
  assert.equal(douyin.artifact.data.reviewReport.status, 'failed');
  assert.equal(douyin.artifact.data.reviewReport.checks.privacy, false);
  assert.deepEqual(douyin.artifact.data.reviewReport.variantLineage, {
    variantKey:'gray_douyin',
    scriptHash:gray.scriptHash,
    templateBindingHash:grayBinding.bindingHash,
    renderChecksum:`sha256:${'2'.repeat(64)}`,
  });
  assert.equal(calls.some((call) => call.toolId.endsWith(':artifact-package-write')), false);

  calls.length = 0;
  const xhs = await service.executeM5MachineReview({
    campaignCase,
    targetCase:{
      id:caseId,
      parentCaseId:campaignId,
      fields:{ platform:'xiaohongshu', scheduledDate },
    },
    targetCaseId:caseId,
    outputs,
    parameters:{ relativePath:'campaigns/xhs.mp4', expectedDurationSeconds:45 },
    sourceTaskId:'task-review-baseline',
  });
  assert.equal(xhs.artifact.data.reviewReport.status, 'passed');
  assert.deepEqual(xhs.artifact.data.reviewReport.variantLineage, {
    variantKey:'baseline',
    scriptHash:baseline.scriptHash,
    templateBindingHash:baselineBinding.bindingHash,
    renderChecksum:`sha256:${'3'.repeat(64)}`,
  });
  const packageCall = calls.find((call) => call.toolId.endsWith(':artifact-package-write'));
  assert.ok(packageCall);
  assert.equal(packageCall.parameters.copies.douyin, null);
  assert.equal(packageCall.parameters.copies.xiaohongshu.title, baseline.hook);
  assert.doesNotMatch(JSON.stringify(packageCall.parameters.copies), /token=abcdefghi/);
  assert.equal(packageCall.parameters.sources.narration.ref, baselineVoice.relativePath);

  const cleanGray = {
    ...testScriptVariant(
      'gray_douyin',
      `灰度脚本。\n${statement}`,
      grayBinding,
    ),
    factBindings,
    qualityReview:{ unresolved:[] },
  };
  const cleanGrayVoice = {
    ...grayVoice,
    scriptHash:cleanGray.scriptHash,
  };
  const scriptArtifact = outputs.find((output) =>
    output.metadata.artifactKind === 'video_script_package');
  const voiceArtifact = outputs.find((output) =>
    output.metadata.artifactKind === 'voice_package');
  const renderArtifact = outputs.find((output) =>
    output.metadata.artifactKind === 'render_package');
  scriptArtifact.metadata.artifact.variants.gray_douyin = cleanGray;
  voiceArtifact.metadata.artifact.variants.gray_douyin = cleanGrayVoice;
  renderArtifact.metadata.artifact.outputs.douyin.scriptHash = cleanGray.scriptHash;

  calls.length = 0;
  const cleanDouyin = await service.executeM5MachineReview({
    campaignCase,
    targetCase:{
      id:caseId,
      parentCaseId:campaignId,
      fields:{ platform:'douyin', scheduledDate },
    },
    targetCaseId:caseId,
    outputs,
    parameters:{ relativePath:'campaigns/douyin.mp4', expectedDurationSeconds:45 },
    sourceTaskId:'task-review-clean-gray',
  });
  assert.equal(cleanDouyin.artifact.data.reviewReport.status, 'passed');
  const douyinPackageCall = calls.find((call) =>
    call.toolId.endsWith(':artifact-package-write'));
  assert.ok(douyinPackageCall);
  assert.equal(douyinPackageCall.parameters.copies.douyin.title, cleanGray.hook);
  assert.equal(douyinPackageCall.parameters.copies.xiaohongshu, null);
  assert.equal(
    douyinPackageCall.parameters.sources.narration.ref,
    cleanGrayVoice.relativePath,
  );
});

test('灰度抖音真实阶段产物贯穿 Script→Voice→Render→MachineReview→ContentVersion→Learning', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-gray-full-chain-'));
  t.after(() => fs.rm(workspace, { recursive:true, force:true }));
  const dayCaseId = caseId;
  const douyinCaseId = '33333333-3333-4333-8333-333333333333';
  const learningCaseId = '44444444-4444-4444-8444-444444444444';
  const learningIssueId = '55555555-5555-4555-8555-555555555555';
  const learningRunId = '66666666-6666-4666-8666-666666666666';
  const scheduledDate = '2026-08-09';
  const statement = 'Paperclip 管流程，Hermes 执行岗位任务。';
  const templateWorkProductId = 'template-work-product-full-chain';
  const templateVersion = {
    templateVersionId:'template_full_chain_v2',
    version:2,
    previousTemplateVersionId:'m5-template-default-v1',
    sourceProposalId:'proposal-full-chain',
    sourceOfflineReplayId:'replay-full-chain',
    state:'gray_ready',
    grayReleaseLimit:1,
    productionDefault:false,
    grayTargetCaseId:douyinCaseId,
    grayTargetDayCaseId:dayCaseId,
    grayTargetScheduledDate:scheduledDate,
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
    suggestedChanges:['前三秒直接展示失败恢复和最终交付。'],
    approvedAt:'2026-08-08T00:00:00.000Z',
    controls:{
      promptMutation:false,
      permissionExpansion:false,
      frequencyIncrease:false,
      paidPromotion:false,
    },
  };
  const baselineBinding = defaultM5ProductionTemplateBinding('full_chain_baseline');
  const grayBinding = m5GrayProductionTemplateBinding({
    templateVersion,
    templateWorkProductId,
  });
  const evidenceTask = {
    taskId:'full-chain-evidence',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'evidence:full-chain',
      type:'evidence_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        schemaVersion:'agent.army/evidence-package/v2',
        sources:[
          {
            sourceId:'source-1',
            url:'https://example.com/a',
            fetchedAt:'2026-08-08T00:00:00.000Z',
            contentHash:'a'.repeat(64),
            kind:'public_web',
            evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'来源 A 原文。' }],
          },
          {
            sourceId:'source-2',
            url:'https://example.com/b',
            fetchedAt:'2026-08-08T00:00:00.000Z',
            contentHash:'b'.repeat(64),
            kind:'public_pdf',
            evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'来源 B 原文。' }],
          },
        ],
        claims:[{
          claimId:'claim-1',
          text:statement,
          sourceIds:['source-1', 'source-2'],
          evidenceFragments:[
            { sourceId:'source-1', fragmentId:'source-1-fragment-1', text:'来源 A 原文。' },
            { sourceId:'source-2', fragmentId:'source-2-fragment-1', text:'来源 B 原文。' },
          ],
        }],
        prohibitedStatements:['无来源效果承诺'],
      },
    }],
  };
  const visualTask = {
    taskId:'full-chain-visual',
    status:'succeeded',
    artifactRefs:[{
      artifactId:'visual:full-chain',
      type:'visual_analysis_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{
        insights:[{
          insightId:'visual-1',
          finding:'用真实失败恢复画面承接结论。',
          frameRef:'frame-1',
          timestamp:'00:03',
          evidenceKind:'keyframe',
        }],
      },
    }],
  };
  const scriptExecutor = new LocalVideoScriptPackage({
    store:{ list:async () => [evidenceTask, visualTask] },
    artifactsDir:path.join(workspace, 'script'),
    advisor:{
      async scriptPackage({ templateBinding }) {
        const gray = templateBinding.source === 'approved_single_gray';
        const guidance = templateBinding.contentGuidance[0];
        const guidanceFragment = '前三秒直接展示失败恢复和最终交付';
        return {
          data:{
            headline:gray ? '灰度标题' : '稳定标题',
            platform:'douyin',
            durationSeconds:45,
            aspectRatio:'9:16',
            audience:'希望验证 Agent 真实能力的人',
            hook:gray ? guidanceFragment : '先看真实执行结果。',
            fullScript:gray
              ? `${guidanceFragment}。${statement} 这条独立脚本只用于目标抖音 Case，并保留来源、纠错、审核结果和可恢复状态。`
              : `先看真实执行结果。${statement} 这条稳定脚本用于 master 和小红书，并保留来源、纠错和审核结果。`,
            shootingNotes:['展示真实产物和恢复证据。'],
            shots:[{
              startSeconds:0,
              endSeconds:45,
              narration:gray ? guidanceFragment : '展示真实执行结果。',
              visual:'产品流程画面',
            }],
            qualityReview:{
              factuality:'绑定来源',
              imitation:'不复制',
              shootability:'可执行',
              unresolved:[],
            },
            structure:['开场', '证据', '结论'],
            templateBindingHash:templateBinding.bindingHash,
            templateApplicationEvidence:guidance
              ? [{ guidance, scriptFragment:guidanceFragment }]
              : [],
          },
        };
      },
    },
    templateResolver:{
      async resolve(requestedCaseId) {
        assert.equal(requestedCaseId, dayCaseId);
        return baselineBinding;
      },
      async resolveGrayForDay(requestedCaseId) {
        assert.equal(requestedCaseId, dayCaseId);
        return grayBinding;
      },
    },
  });
  const scriptResult = await scriptExecutor.execute({
    taskId:'full-chain-script',
    taskType:'content.video-script-package',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-script',
        pipelineCaseId:dayCaseId,
        sourceTaskIds:[evidenceTask.taskId, visualTask.taskId],
      },
    },
  });
  assert.equal(scriptResult.status, 'succeeded', JSON.stringify(scriptResult));
  const scriptArtifact = scriptResult.artifactRefs[0];
  const scriptPackage = scriptArtifact.data;
  const baselineScript = scriptPackage.variants.baseline;
  const grayScript = scriptPackage.variants.gray_douyin;
  assert.equal(grayScript.templateBinding.bindingHash, grayBinding.bindingHash);
  assert.notEqual(grayScript.scriptHash, baselineScript.scriptHash);

  const campaignCase = {
    id:campaignId,
    parentCaseId:null,
    version:1,
    fields:{
      campaignGrant:{
        schemaVersion:'agent.army/campaign-grant/v1',
        grantId:'grant-full-chain',
        status:'active',
        platforms:['douyin', 'xiaohongshu'],
        receipts:[],
        startsAt:'2026-08-01T00:00:00.000Z',
        expiresAt:'2026-08-20T00:00:00.000Z',
      },
    },
  };
  const dayCase = {
    id:dayCaseId,
    parentCaseId:campaignId,
    version:4,
    stageKey:'voice',
    fields:{ campaignId:'campaign-full-chain', scheduledDate },
  };
  const douyinCase = {
    id:douyinCaseId,
    parentCaseId:dayCaseId,
    version:2,
    stageKey:'machine_review',
    fields:{
      campaignId:'campaign-full-chain',
      scheduledDate,
      platform:'douyin',
    },
  };
  const evidenceOutput = trustedOutput(
    'evidence_package',
    evidenceTask.artifactRefs[0].data,
  );
  const visualOutput = trustedOutput(
    'visual_analysis_package',
    {
      ...visualTask.artifactRefs[0].data,
      providerReceipt:confirmedProviderReceipt(
        'm5:vision:full-chain',
        'vision',
        'step-1o-turbo-vision',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ),
    },
  );
  const generatedOutput = trustedOutput('generated_image_package', {
    model:'step-image-edit-2',
    relativePath:'campaigns/full-chain/generated.png',
    checksum:`sha256:${'e'.repeat(64)}`,
    bytes:2048,
    providerReceipt:confirmedProviderReceipt(
      'm5:image:full-chain',
      'image_generate',
      'step-image-edit-2',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ),
  });
  const assetOutput = trustedOutput('asset_package', {
    rightsBasis:'本机自产素材，经活动授权用于内容生产。',
    assets:[{
      frameId:'frame-1',
      relativePath:'campaigns/full-chain/frame-1.png',
      checksum:`sha256:${'d'.repeat(64)}`,
      bytes:1024,
    }],
  });
  const outputsByCase = new Map([
    [campaignId, []],
    [dayCaseId, [
      trustedOutput('video_script_package', scriptPackage),
      evidenceOutput,
      visualOutput,
      generatedOutput,
      assetOutput,
    ]],
    [douyinCaseId, []],
  ]);
  const adapter = {
    companyId:'company-test',
    async request(method, requestPath) {
      if (method === 'GET' && requestPath === `/api/cases/${campaignId}`) {
        return campaignCase;
      }
      if (method === 'GET' && requestPath === `/api/cases/${dayCaseId}`) {
        return dayCase;
      }
      if (method === 'GET' && requestPath === `/api/cases/${douyinCaseId}`) {
        return douyinCase;
      }
      const outputMatch = requestPath.match(/^\/api\/cases\/([^/]+)\/outputs$/);
      if (method === 'GET' && outputMatch) {
        return outputsByCase.get(outputMatch[1]) || [];
      }
      if (method === 'GET' && requestPath === '/api/plugins') {
        return [{ id:'plugin-content-autonomy', pluginKey:'agent-army.content-autonomy' }];
      }
      if (
        method === 'GET'
        && requestPath.startsWith('/api/plugins/plugin-content-autonomy/config?')
      ) {
        return { configJson:{ officialTtsVoices:['official-voice-1'] } };
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    },
  };
  const toolCalls = [];
  const service = new ContentCampaignService({
    adapter:withActivePipeline(adapter),
    activePipelineId:PIPELINE.id,
    definition:defaultDefinition,
    allowLocalFixtureProvenance:true,
    now:() => new Date('2026-08-09T00:00:00.000Z'),
    templateResolver:{ async resolve() { return baselineBinding; } },
    toolExecutor:{
      async execute(input) {
        toolCalls.push(input);
        if (input.toolId.endsWith(':stepfun-tts')) {
          const gray = input.parameters.variantKey === 'gray_douyin';
          return {
            model:'stepaudio-2.5-tts',
            voice:'official-voice-1',
            relativePath:input.parameters.outputPath,
            checksum:`sha256:${gray ? 'b'.repeat(64) : 'a'.repeat(64)}`,
            bytes:1024,
            ...confirmedProviderReceipt(
              input.parameters.actionId,
              'tts',
              'stepaudio-2.5-tts',
              gray
                ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            ),
          };
        }
        if (input.toolId.endsWith(':remotion-props-write')) {
          return {
            propsPath:input.parameters.outputPath,
            checksum:`sha256:${'c'.repeat(64)}`,
          };
        }
        if (input.toolId.endsWith(':remotion-render')) {
          const checksumChar = {
            M5Master:'1',
            M5Douyin:'2',
            M5Xiaohongshu:'3',
          }[input.parameters.composition];
          return {
            composition:input.parameters.composition,
            propsPath:input.parameters.propsPath,
            outputPath:input.parameters.outputPath,
            checksum:`sha256:${checksumChar.repeat(64)}`,
            bytes:4096,
            durationSeconds:45,
          };
        }
        if (input.toolId.endsWith(':social-card-render')) {
          return socialCardReceipt(input.parameters);
        }
        if (input.toolId.endsWith(':media-validate')) {
          return {
            passed:true,
            relativePath:input.parameters.relativePath,
            errors:[],
          };
        }
        if (input.toolId.endsWith(':subtitle-layout-validate')) {
          return { passed:true, propsPath:input.parameters.propsPath, errors:[] };
        }
        if (input.toolId.endsWith(':artifact-package-write')) {
          return {
            manifestPath:'campaigns/full-chain/package/artifact-manifest.json',
            manifestChecksum:`sha256:${'f'.repeat(64)}`,
          };
        }
        if (input.toolId.endsWith(':artifact-lineage-validate')) {
          return { passed:true, errors:[], requiredArtifacts:[] };
        }
        throw new Error(`unexpected tool ${input.toolId}`);
      },
    },
  });

  const voiceResult = await service.executeHermesStage({
    assignment:{ agentId:'content-creator', runId:'run-full-chain-voice' },
    task:{
      taskId:'full-chain-voice',
      taskType:'content.campaign-voice',
      input:{
        context:{
          paperclipRoutineKey:'m5-voice',
          pipelineCaseId:dayCaseId,
        },
      },
    },
  });
  const voiceArtifact = voiceResult.artifact;
  const voicePackage = voiceArtifact.data;
  assert.equal(
    voicePackage.variants.gray_douyin.scriptHash,
    grayScript.scriptHash,
  );
  assert.notEqual(
    voicePackage.variants.gray_douyin.audioHash,
    voicePackage.variants.baseline.audioHash,
  );
  outputsByCase.get(dayCaseId).push(
    trustedOutput('voice_package', voicePackage),
  );

  dayCase.stageKey = 'render';
  const renderResult = await service.executeHermesStage({
    assignment:{ agentId:'content-creator', runId:'run-full-chain-render' },
    task:{
      taskId:'full-chain-render',
      taskType:'content.campaign-render',
      input:{
        context:{
          paperclipRoutineKey:'m5-render',
          pipelineCaseId:dayCaseId,
        },
      },
    },
  });
  const renderArtifact = renderResult.artifact;
  const renderPackage = renderArtifact.data;
  assert.equal(renderPackage.socialCardPackage.templateBindingHash, baselineBinding.bindingHash);
  const douyinRender = renderPackage.outputs.douyin;
  assert.equal(douyinRender.variantKey, 'gray_douyin');
  assert.equal(douyinRender.scriptHash, grayScript.scriptHash);
  assert.equal(
    douyinRender.audioHash,
    voicePackage.variants.gray_douyin.audioHash,
  );
  assert.equal(douyinRender.templateBindingHash, grayBinding.bindingHash);
  outputsByCase.get(dayCaseId).push(
    trustedOutput('render_package', renderPackage),
  );

  const reviewResult = await service.executeHermesStage({
    assignment:{ agentId:'reviewer', runId:'run-full-chain-review' },
    task:{
      taskId:'full-chain-review',
      taskType:'content.campaign-machine-review',
      input:{
        context:{
          paperclipRoutineKey:'m5-machine-review',
          pipelineCaseId:douyinCaseId,
        },
      },
    },
  });
  const reviewArtifact = reviewResult.artifact;
  const reviewReport = reviewArtifact.data.reviewReport;
  assert.equal(reviewReport.status, 'passed', JSON.stringify(reviewReport.failures));
  assert.deepEqual(reviewReport.variantLineage, {
    variantKey:'gray_douyin',
    scriptHash:grayScript.scriptHash,
    templateBindingHash:grayBinding.bindingHash,
    renderChecksum:douyinRender.checksum,
  });

  const contentCreator = new LocalContentCreator({
    store:{
      list:async () => [{
        taskId:'full-chain-script',
        status:'succeeded',
        artifactRefs:[scriptArtifact],
      }, {
        taskId:'full-chain-render',
        status:'succeeded',
        artifactRefs:[renderArtifact],
      }],
    },
    artifactsDir:path.join(workspace, 'content-version'),
  });
  const contentResult = await contentCreator.execute({
    taskId:'full-chain-content-version',
    taskType:'content.platform-draft',
    input:{
      title:'AI Agent 实战',
      context:{
        paperclipRoutineKey:'m5-platform-adapt',
        pipelineCaseId:douyinCaseId,
        sourceTaskIds:['full-chain-script', 'full-chain-render'],
        pipelineCase:{
          parentCaseId:dayCaseId,
          fields:{ platform:'douyin', scheduledDate },
        },
      },
    },
  });
  assert.equal(contentResult.status, 'succeeded', JSON.stringify(contentResult));
  const contentArtifact = contentResult.artifactRefs[0];
  const contentVersion = contentArtifact.data.contentVersion;
  assert.equal(contentVersion.platformCaseId, douyinCaseId);
  assert.equal(contentVersion.dayCaseId, dayCaseId);
  assert.equal(contentVersion.scheduledDate, scheduledDate);
  assert.equal(contentVersion.checksum, douyinRender.checksum);
  assert.equal(contentVersion.templateBindingHash, grayBinding.bindingHash);
  assert.equal(
    contentVersion.templateApplication.scriptHash,
    grayScript.scriptHash,
  );
  assert.equal(
    contentVersion.templateApplication.renderChecksum,
    douyinRender.checksum,
  );
  assert.equal(reviewReport.contentVersionId, contentVersion.contentVersionId);

  const safeControls = {
    promptMutation:false,
    permissionExpansion:false,
    frequencyIncrease:false,
    paidPromotion:false,
  };
  const learningProduct = ({
    id,
    provider,
    schemaVersion,
    kind,
    metadata,
    type = 'document',
    status = 'active',
    reviewState = 'none',
  }) => ({
    id,
    kind:'work_product',
    type,
    provider,
    sourceTrust:null,
    status,
    reviewState,
    healthStatus:'healthy',
    metadata:{ schemaVersion, kind, ...metadata },
  });
  const retrospective = learningProduct({
    id:'retrospective-full-chain',
    provider:'agent-army.m5-retrospective',
    schemaVersion:'agent.army/m5-retrospective/v1',
    kind:'Retrospective',
    metadata:{ report:{ status:'proposal_ready' } },
  });
  const offlineReplay = learningProduct({
    id:'offline-full-chain',
    provider:'agent-army.m5-learning',
    schemaVersion:'agent.army/m5-offline-replay/v1',
    kind:'OfflineReplay',
    metadata:{
      replay:{
        replayId:'replay-full-chain',
        proposalId:'proposal-full-chain',
        status:'passed_for_review',
        primaryMetric:'views',
        baselineMetrics:{ views:100 },
      },
    },
  });
  const proposal = learningProduct({
    id:'proposal-product-full-chain',
    provider:'agent-army.m5-learning',
    schemaVersion:'agent.army/learning-proposal/v1',
    kind:'LearningProposal',
    status:'approved',
    reviewState:'approved',
    metadata:{
      proposal:{
        proposalId:'proposal-full-chain',
        offlineReplayId:'replay-full-chain',
        requestedChangeCount:1,
        suggestedChanges:[...templateVersion.suggestedChanges],
        baseTemplateVersionId:'m5-template-default-v1',
        controls:safeControls,
      },
    },
  });
  const templateProduct = learningProduct({
    id:templateWorkProductId,
    provider:'agent-army.m5-learning',
    schemaVersion:'agent.army/template-version/v1',
    kind:'TemplateVersion',
    metadata:{ templateVersion },
  });
  const contentProduct = learningProduct({
    id:'content-version-full-chain',
    provider:'agent-army.content-autonomy',
    schemaVersion:'agent.army/content-version/v1',
    kind:'ContentVersion',
    type:'artifact',
    metadata:{ contentVersion },
  });
  const reviewProduct = learningProduct({
    id:'machine-review-full-chain',
    provider:'agent-army.content-autonomy',
    schemaVersion:'agent.army/machine-review/v1',
    kind:'MachineReview',
    type:'artifact',
    metadata:{ reviewReport },
  });
  const publishedAt = '2026-08-10T00:00:00.000Z';
  const dueAt = '2026-08-13T00:00:00.000Z';
  const receiptId = '77777777-7777-4777-8777-777777777777';
  const receiptProduct = learningProduct({
    id:'publish-receipt-full-chain',
    provider:'agent-army.publisher-gateway',
    schemaVersion:'agent.army/publish-receipt/v1',
    kind:'PublishReceipt',
    type:'artifact',
    metadata:{
      receipt:{
        receiptId,
        contentVersionId:contentVersion.contentVersionId,
        platform:'douyin',
        publishedAt,
        contentChecksum:contentVersion.checksum,
        scheduledDate,
      },
    },
  });
  const metricProduct = learningProduct({
    id:'metric-full-chain',
    provider:'agent-army.publisher-gateway',
    schemaVersion:'agent.army/metric-snapshot/v1',
    kind:'MetricSnapshot',
    type:'artifact',
    metadata:{
      checkpoint:'72h',
      receiptId,
      collectionKey:`${receiptId}:72h`,
      dueAt,
      snapshot:{
        snapshotId:'snapshot-full-chain',
        contentVersionId:contentVersion.contentVersionId,
        platform:'douyin',
        collectedAt:dueAt,
        receiptId,
        collectionKey:`${receiptId}:72h`,
        metrics:{ views:1000 },
      },
    },
  });
  const caseOutputs = [
    retrospective,
    offlineReplay,
    proposal,
    templateProduct,
  ];
  const pipelineOutputs = [
    ...caseOutputs,
    contentProduct,
    reviewProduct,
    receiptProduct,
    metricProduct,
  ];
  const governance = {
    async getPipelineCaseOutputs(requestedCaseId) {
      assert.equal(requestedCaseId, learningCaseId);
      return { items:structuredClone(caseOutputs) };
    },
    async getRetrospectiveMetricOutputs(requestedCaseId) {
      assert.equal(requestedCaseId, learningCaseId);
      return { items:structuredClone(pipelineOutputs) };
    },
    async getNextM5GrayTargetCase() {
      throw new Error('模板版本已存在，不应重新选择灰度目标。');
    },
    async createIssueWorkProduct(requestedIssueId, value, options) {
      assert.equal(requestedIssueId, learningIssueId);
      assert.equal(options.runId, learningRunId);
      const product = {
        id:`learning-created-${caseOutputs.length + 1}`,
        kind:'work_product',
        sourceTrust:null,
        ...structuredClone(value),
      };
      caseOutputs.push(product);
      pipelineOutputs.push(structuredClone(product));
      return structuredClone(product);
    },
  };
  const learning = new M5LearningLifecycle({
    governance,
    now:() => new Date('2026-08-13T00:00:00.000Z'),
  });
  const grayRelease = await learning.advance({
    caseId:learningCaseId,
    issueId:learningIssueId,
    runId:learningRunId,
  });
  assert.equal(grayRelease.createdKind, 'TemplateGrayRelease');
  const grayReleaseProduct = caseOutputs.find((item) =>
    item.metadata?.kind === 'TemplateGrayRelease');
  assert.equal(
    grayReleaseProduct.metadata.grayRelease.contentVersionId,
    contentVersion.contentVersionId,
  );
  const decision = await learning.advance({
    caseId:learningCaseId,
    issueId:learningIssueId,
    runId:learningRunId,
  });
  assert.equal(decision.createdKind, 'TemplateDecision');
  const decisionProduct = caseOutputs.find((item) =>
    item.metadata?.kind === 'TemplateDecision');
  assert.equal(decisionProduct.metadata.decision.status, 'validated');
  assert.deepEqual(decisionProduct.metadata.decision.grayLineage, {
    dayCaseId,
    platformCaseId:douyinCaseId,
    platform:'douyin',
    scheduledDate,
    checksum:contentVersion.checksum,
    templateWorkProductId,
    templateBindingHash:grayBinding.bindingHash,
    variantKey:'gray_douyin',
    scriptHash:grayScript.scriptHash,
    renderChecksum:douyinRender.checksum,
  });
  assert.ok(toolCalls.some((call) => call.toolId.endsWith(':stepfun-tts')));
  assert.ok(toolCalls.some((call) => call.toolId.endsWith(':remotion-render')));
  assert.ok(toolCalls.some((call) => call.toolId.endsWith(':media-validate')));
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
    now:() => new Date('2026-07-30T02:00:00.000Z'),
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
