import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  ContentCampaignService,
} from '../src/content-campaign-service.ts';
import { m5ProductionTemplateBindingHash } from '../src/m5-production-template-resolver.ts';

const BINDING_VALUE = {
  schemaVersion:'agent.army/production-template-binding/v1',
  templateVersionId:'template-v2',
  source:'approved_learning_decision',
  decisionStatus:'validated',
  decisionWorkProductId:'decision-1',
  productionDefault:true,
  contentGuidance:['只调整前三秒开场。'],
  controls:{
    promptMutation:false,
    permissionExpansion:false,
    frequencyIncrease:false,
    paidPromotion:false,
  },
};
const BINDING = {
  ...BINDING_VALUE,
  bindingHash:m5ProductionTemplateBindingHash(BINDING_VALUE),
};
const DAY_CASE_ID = '22222222-2222-4222-8222-222222222222';
const DOUYIN_CASE_ID = '33333333-3333-4333-8333-333333333333';
const SCHEDULED_DATE = '2026-08-09';

test('渲染重新解析生产模板并把同一绑定写入三份props', async () => {
  const service = serviceWithBinding(BINDING);
  const parameters = await service.m5StageToolParameters({
    contract:{ stageKey:'render' },
    campaignCase:{ id:'campaign-case-1' },
    targetCase:{ id:'target-case-1', version:4 },
    outputs:renderInputs(BINDING),
  });
  assert.equal(parameters.renders.length, 3);
  assert.ok(parameters.renders.every((item) =>
    item.props.templateBinding.templateVersionId === 'template-v2'));
  assert.ok(parameters.renders.every((item) => item.variantKey === 'baseline'));
  assert.ok(parameters.renders.every((item) =>
    item.templateBindingHash === BINDING.bindingHash
    && /^sha256:[0-9a-f]{64}$/.test(item.scriptHash)
    && /^sha256:[0-9a-f]{64}$/.test(item.audioHash)));
  assert.equal(parameters.socialCard.props.templateBinding.bindingHash, BINDING.bindingHash);
  assert.equal(parameters.socialCard.props.platform, 'xiaohongshu');
  assert.equal(parameters.socialCard.props.cards.length, 3);
});

test('脚本模板绑定与当前决定漂移时拒绝渲染', async () => {
  const service = serviceWithBinding(BINDING);
  await assert.rejects(
    service.m5StageToolParameters({
      contract:{ stageKey:'render' },
      campaignCase:{ id:'campaign-case-1' },
      targetCase:{ id:'target-case-1', version:4 },
      outputs:renderInputs({
        ...BINDING,
        templateVersionId:'forged-template',
      }),
    }),
    /模板绑定与当前只读生产模板决定不一致/,
  );
});

test('模板身份相同但contentGuidance变化时也拒绝渲染', async () => {
  const service = serviceWithBinding(BINDING);
  const changed = {
    ...BINDING_VALUE,
    contentGuidance:['改成未经批准的开场。'],
  };
  const changedWithHash = {
    ...changed,
    bindingHash:m5ProductionTemplateBindingHash(changed),
  };
  await assert.rejects(
    service.m5StageToolParameters({
      contract:{ stageKey:'render' },
      campaignCase:{ id:'campaign-case-1' },
      targetCase:{ id:'target-case-1', version:4 },
      outputs:renderInputs(changedWithHash),
    }),
    /模板绑定与当前只读生产模板决定不一致/,
  );
});

test('灰度日配音参数派生两条独立幂等TTS动作并绑定脚本哈希', async () => {
  const gray = grayFixture();
  const parameters = await serviceWithBinding(BINDING).m5StageToolParameters({
    contract:{ stageKey:'voice' },
    campaignCase:{ id:'campaign-case-1' },
    targetCase:{
      id:DAY_CASE_ID,
      version:4,
      fields:{ scheduledDate:SCHEDULED_DATE },
    },
    outputs:[product('video_script_package', gray.script, 1)],
  });
  assert.deepEqual(
    parameters.voices.map((item) => ({
      variantKey:item.variantKey,
      actionId:item.actionId,
      scriptHash:item.scriptHash,
      outputPath:item.outputPath,
    })),
    [
      {
        variantKey:'baseline',
        actionId:`${DAY_CASE_ID}:voice:baseline:v4`,
        scriptHash:gray.script.variants.baseline.scriptHash,
        outputPath:`campaigns/campaign-case-1/${DAY_CASE_ID}/voice-baseline.mp3`,
      },
      {
        variantKey:'gray_douyin',
        actionId:`${DAY_CASE_ID}:voice:gray_douyin:v4`,
        scriptHash:gray.script.variants.gray_douyin.scriptHash,
        outputPath:`campaigns/campaign-case-1/${DAY_CASE_ID}/voice-gray-douyin.mp3`,
      },
    ],
  );
});

test('灰度渲染严格把master和小红书接baseline、抖音接gray_douyin', async () => {
  const gray = grayFixture();
  const parameters = await serviceWithBinding(BINDING).m5StageToolParameters({
    contract:{ stageKey:'render' },
    campaignCase:{ id:'campaign-case-1' },
    targetCase:{
      id:DAY_CASE_ID,
      version:4,
      fields:{ scheduledDate:SCHEDULED_DATE },
    },
    outputs:renderInputs(BINDING, gray),
  });
  const byComposition = Object.fromEntries(
    parameters.renders.map((item) => [item.composition, item]),
  );
  for (const composition of ['M5Master', 'M5Xiaohongshu']) {
    assert.equal(byComposition[composition].variantKey, 'baseline');
    assert.equal(
      byComposition[composition].props.voiceoverSrc,
      gray.voice.variants.baseline.relativePath,
    );
    assert.equal(
      byComposition[composition].props.templateBinding.bindingHash,
      BINDING.bindingHash,
    );
  }
  assert.equal(parameters.socialCard.props.templateBinding.bindingHash, BINDING.bindingHash);
  assert.equal(byComposition.M5Douyin.variantKey, 'gray_douyin');
  assert.equal(
    byComposition.M5Douyin.props.voiceoverSrc,
    gray.voice.variants.gray_douyin.relativePath,
  );
  assert.equal(
    byComposition.M5Douyin.props.templateBinding.bindingHash,
    gray.grayBinding.bindingHash,
  );
  assert.equal(
    byComposition.M5Douyin.props.variantLineage.scriptHash,
    gray.script.variants.gray_douyin.scriptHash,
  );
});

test('灰度双变体半包或音频脚本跨接时在渲染前失败关闭', async () => {
  const gray = grayFixture();
  const service = serviceWithBinding(BINDING);
  const partial = structuredClone(gray);
  delete partial.voice.variants.gray_douyin;
  await assert.rejects(
    service.m5StageToolParameters({
      contract:{ stageKey:'render' },
      campaignCase:{ id:'campaign-case-1' },
      targetCase:{ id:DAY_CASE_ID, version:4, fields:{ scheduledDate:SCHEDULED_DATE } },
      outputs:renderInputs(BINDING, partial),
    }),
    /必须且只能包含 baseline 与 gray_douyin|完整双变体/,
  );
  const crossed = structuredClone(gray);
  crossed.voice.variants.gray_douyin.scriptHash =
    crossed.script.variants.baseline.scriptHash;
  await assert.rejects(
    service.m5StageToolParameters({
      contract:{ stageKey:'render' },
      campaignCase:{ id:'campaign-case-1' },
      targetCase:{ id:DAY_CASE_ID, version:4, fields:{ scheduledDate:SCHEDULED_DATE } },
      outputs:renderInputs(BINDING, crossed),
    }),
    /无法回到同一脚本/,
  );
});

function serviceWithBinding(binding) {
  return new ContentCampaignService({
    adapter:{
      companyId:'company-test',
      async request(method, path) {
        if (method === 'GET' && path === '/api/plugins') {
          return [{ id:'content-plugin-id', pluginKey:'agent-army.content-autonomy' }];
        }
        if (method === 'GET' && path.startsWith('/api/plugins/content-plugin-id/config?')) {
          return { configJson:{ officialTtsVoices:['official-voice-1'] } };
        }
        throw new Error(`unexpected adapter request ${method} ${path}`);
      },
    },
    definition:{ key:'m5-test' },
    templateResolver:{ async resolve() { return structuredClone(binding); } },
  });
}

function renderInputs(binding, gray = null) {
  const hash = `sha256:${'a'.repeat(64)}`;
  return [
    product('video_script_package', gray?.script || {
      fullScript:'这是一个完整的 AI Agent 实战脚本，用真实产物说明流程。',
      headline:'AI Agent 实战',
      templateLifecycle:{ templateBinding:binding },
      shots:[{
        startSeconds:0,
        endSeconds:45,
        narration:'这是一个完整的 AI Agent 实战脚本，用真实产物说明流程。',
      }],
    }, 1),
    product('voice_package', gray?.voice || {
      relativePath:'voice/voice.mp3',
      checksum:hash,
    }, 2),
    product('generated_image_package', {
      model:'step-image-edit-2',
      relativePath:'images/generated.png',
      checksum:hash,
      bytes:100,
    }, 3),
    product('asset_package', {
      rightsBasis:'本机自产素材',
      assets:[{
        frameId:'frame-1',
        relativePath:'images/local.png',
        checksum:hash,
        bytes:100,
      }],
    }, 4),
  ];
}

function grayFixture() {
  const grayValue = {
    schemaVersion:'agent.army/production-template-binding/v1',
    templateVersionId:'template-gray-v3',
    source:'approved_single_gray',
    decisionStatus:'gray_ready',
    decisionWorkProductId:null,
    templateWorkProductId:'template-product-gray-v3',
    productionDefault:false,
    grayRelease:true,
    grayTargetCaseId:DOUYIN_CASE_ID,
    grayTargetDayCaseId:DAY_CASE_ID,
    grayTargetScheduledDate:SCHEDULED_DATE,
    grayTargetPlatform:'douyin',
    applicationScope:'full_content_variant',
    contentGuidance:['重写前三秒开场。'],
    controls:{ ...BINDING_VALUE.controls },
  };
  const grayBinding = {
    ...grayValue,
    bindingHash:m5ProductionTemplateBindingHash(grayValue),
  };
  const baselineScript = '这是旧模板的稳定口播脚本，用真实产物说明执行流程。';
  const grayScript = '别再把会聊天当Agent，前三秒直接展示真实执行产物。';
  const variants = {
    baseline:scriptVariant('baseline', baselineScript, BINDING),
    gray_douyin:scriptVariant('gray_douyin', grayScript, grayBinding),
  };
  const voiceVariants = {
    baseline:voiceVariant('baseline', variants.baseline, 'a'),
    gray_douyin:voiceVariant('gray_douyin', variants.gray_douyin, 'b'),
  };
  return {
    grayBinding,
    script:{
      ...variants.baseline,
      templateLifecycle:{ templateBinding:BINDING },
      variants,
    },
    voice:{
      ...voiceVariants.baseline,
      variantMode:'douyin_single_gray_v1',
      variants:voiceVariants,
    },
  };
}

function scriptVariant(variantKey, fullScript, templateBinding) {
  return {
    variantKey,
    headline:variantKey === 'baseline' ? '旧模板标题' : '灰度模板标题',
    hook:variantKey === 'baseline' ? '稳定开场' : '灰度强开场',
    fullScript,
    shots:[{ startSeconds:0, endSeconds:45, narration:fullScript }],
    templateBinding,
    templateGuidanceHash:templateBinding.bindingHash,
    scriptHash:`sha256:${crypto.createHash('sha256').update(fullScript).digest('hex')}`,
  };
}

function voiceVariant(variantKey, script, checksumChar) {
  const checksum = `sha256:${checksumChar.repeat(64)}`;
  return {
    variantKey,
    scriptHash:script.scriptHash,
    templateBinding:script.templateBinding,
    model:'stepaudio-2.5-tts',
    voice:'official-voice-1',
    relativePath:`voice/voice-${variantKey}.mp3`,
    checksum,
    audioHash:checksum,
    bytes:100,
    providerReceipt:providerReceipt(`action:tts:${variantKey}`),
  };
}

function providerReceipt(actionId) {
  return {
    actionId,
    operation:'tts',
    model:'stepaudio-2.5-tts',
    callRecord:{
      actionId,
      operation:'tts',
      model:'stepaudio-2.5-tts',
      promptChecksum:`sha256:${'f'.repeat(64)}`,
    },
    costCommit:{
      status:'confirmed',
      costEventId:actionId.endsWith('baseline')
        ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      costEvent:{ provider:'stepfun', costCents:1 },
    },
  };
}

function product(artifactKind, data, index) {
  const artifactHash = `sha256:${String(index).repeat(64)}`;
  return {
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    externalId:artifactHash,
    metadata:{
      schemaVersion:'agent.army/test-artifact/v1',
      artifactKind,
      artifactHash,
      sourceTaskId:`task-${index}`,
      sourceArtifactId:`artifact-${index}`,
      artifact:{ data },
    },
  };
}
