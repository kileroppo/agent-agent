import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ContentCampaignKernel } from '../src/content-campaign-kernel.js';
import { createFakeM5ControlPlane } from '../src/control-plane.js';
import {
  normalizePaperclipCase,
  normalizePaperclipWorkProduct,
} from '../src/paperclip-control-plane.js';

const PIPELINE = {
  id:'22222222-2222-4222-8222-222222222222',
  key:'m5-content-pipeline',
  projectId:'project-m5',
  stages:[],
};

test('M5业务内核只依赖规范化控制面，不含Paperclip URL或原始envelope字段', async () => {
  const sources = await Promise.all([
    new URL('../src/content-campaign-kernel.js', import.meta.url),
    new URL('../src/parallel-work-coordinator.js', import.meta.url),
  ].map((url) => fs.readFile(url, 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /adapter\.request|\/api\/|\.fields\b|\.metadata\b|\.items\b/);
    assert.doesNotMatch(source, /apps\/ajun-runtime/);
  }
});

test('Fake M5ControlPlane可在无Paperclip环境驱动业务内核', async () => {
  const calls = [];
  const controlPlane = createFakeM5ControlPlane({
    async findPipelineByKey(key) {
      calls.push(['findPipelineByKey', key]);
      return PIPELINE;
    },
    async listPipelineCases(id) {
      calls.push(['listPipelineCases', id]);
      return [];
    },
  });
  const kernel = new ContentCampaignKernel({
    controlPlane,
    definition:{ key:PIPELINE.key, stages:[] },
  });
  assert.deepEqual(await kernel.list(), []);
  assert.deepEqual(calls, [
    ['findPipelineByKey', PIPELINE.key],
    ['listPipelineCases', PIPELINE.id],
  ]);
});

test('Paperclip Adapter在边界归一化Case与Work Product', () => {
  assert.deepEqual(normalizePaperclipCase({
    id:'case-1', pipelineId:'pipeline-1', caseKey:'campaign:day', stageKey:'voice', version:3,
    fields:{ campaignId:'campaign', scheduledDate:'2026-08-03' },
  }), {
    id:'case-1', version:3, pipelineId:'pipeline-1', projectId:'', parentCaseId:null,
    caseKey:'campaign:day', stageKey:'voice', stageKind:'', campaignGrant:null,
    campaignPlan:null, campaignId:'campaign', scheduledDate:'2026-08-03', theme:'',
    assetRightsBasis:'', platform:'', contentVersion:'', workBranch:null,
    parallelJoin:null, contentRecovery:null, stageRecovery:null, activeWork:null,
    blocked:false, terminal:false, terminalKind:'',
  });
  const product = normalizePaperclipWorkProduct({
    id:'product-1', kind:'work_product', type:'artifact', provider:'agent-army.ajun-runtime',
    sourceTrust:null, status:'active', healthStatus:'healthy',
    metadata:{
      kind:'VoicePackage', artifactKind:'voice_package', stageKey:'voice',
      schemaVersion:'agent.army/voice-package/v1', artifactHash:`sha256:${'a'.repeat(64)}`,
      sourceTaskId:'task-1', sourceArtifactId:'artifact-1', artifact:{ data:{ voice:'official' } },
    },
  });
  assert.equal(product.recordKind, 'work_product');
  assert.equal(product.kind, 'VoicePackage');
  assert.equal(product.artifactKind, 'voice_package');
  assert.deepEqual(product.artifact, { voice:'official' });
  assert.equal(Object.hasOwn(product, 'metadata'), false);
});
