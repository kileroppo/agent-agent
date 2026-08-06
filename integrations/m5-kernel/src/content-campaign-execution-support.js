import crypto from 'node:crypto';
import {
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
  M5_STEPFUN_MODELS,
} from '@agent-army/m5-contracts';
import { assertM5ControlPlane } from './control-plane.js';
import {
  campaignNextAction as nextAction,
  ContentCampaignError,
  normalizeCampaignDraft as normalizeDraft,
  requireActiveCampaignGrant as requireActiveGrant,
  requireCampaignGrant as requireGrant,
  safeCampaignGrantView as safeGrantView,
  samePluginApproval,
} from './campaign-domain.js';
export { ContentCampaignError } from './campaign-domain.js';
import { M5ParallelWorkCoordinator } from './parallel-work-coordinator.js';
import {
  assertM5RoutineExecutionContracts,
  getM5RoutineExecutionContract,
} from './routine-execution-contract.js';
import {
  buildM5PlatformCopy,
  deriveM5ContentVersionId,
} from './content-version.js';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
} from './stage-recovery-controller.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from './route-execution.js';
import {
  assertM5WorkspaceArtifact,
  M5WorkspaceArtifactError,
  validM5WorkProductArtifactHash,
} from './work-product-integrity.js';
import {
  M5ProductionTemplateResolutionError,
  defaultM5ProductionTemplateBinding,
  validM5ProductionTemplateBinding,
} from './production-template-binding.js';

import { asList, safeText } from './content-campaign-primitives.js';

const CASE_ID = /^[0-9a-f-]{8,80}$/i;
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const M5_PROVIDER_MODELS = M5_STEPFUN_MODELS;

export function workProductArtifact(output) {
  const artifactHash = String(output?.artifactHash || '');
  const sourceTaskId = String(output?.sourceTaskId || '').trim();
  const sourceArtifactId = String(output?.sourceArtifactId || '').trim();
  if (
    output?.recordKind !== 'work_product'
    || output?.type !== 'artifact'
    || !['agent-army.ajun-runtime', 'agent-army.content-autonomy', 'agent-army.publisher-gateway']
      .includes(output?.provider)
    || output?.sourceTrust != null
    || output?.status !== 'active'
    || output?.healthStatus !== 'healthy'
    || !/^agent\.army\/[a-z0-9-]+\/v\d+$/i.test(String(output?.schemaVersion || ''))
    || sourceTaskId.length === 0
    || sourceTaskId.length > 240
    || sourceArtifactId.length === 0
    || sourceArtifactId.length > 240
    || !/^sha256:[0-9a-f]{64}$/i.test(artifactHash)
    || (output.externalId && output.externalId !== artifactHash)
  ) return null;
  const value = output?.artifact?.data || output?.artifact || output?.receipt;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    kind:String(
      output.artifactKind
      || output.artifact?.type
      || snakeKind(output.kind),
    ).trim(),
    data:value,
  };
}

export function replayM5StageWorkProduct(contract, product) {
  const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
  const data = structuredClone(
    product?.artifact
      || product?.contentVersion
      || product?.reviewReport
      || {},
  );
  return {
    toolId:contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5:publish_receipt_verify'
      : `${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
    pluginId:contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5-deterministic'
      : CONTENT_AUTONOMY_PLUGIN_KEY,
    content:`已复用当前 Case 的已验证 ${contract.expectedWorkProduct.type}，未再次执行阶段工具。`,
    artifact:{
      type:artifactKind,
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      data,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        paperclipWorkProductVerified:true,
      },
    },
    replayed:true,
  };
}

export function artifactData(artifacts, kinds) {
  const accepted = new Set(kinds);
  return artifacts.find((artifact) => accepted.has(artifact.kind))?.data || null;
}

export function verifyPublishReceiptArtifact({ contract, targetCase, outputs }) {
  const receipts = outputs
    .filter((output) =>
      output?.recordKind === 'work_product'
      && output?.type === 'artifact'
      && output?.provider === 'agent-army.publisher-gateway'
      && output?.sourceTrust == null
      && output?.status === 'active'
      && output?.healthStatus === 'healthy'
      && output?.schemaVersion === 'agent.army/publish-receipt/v1'
      && output?.kind === 'PublishReceipt',
    )
    .map((output) => output.receipt)
    .filter((receipt) => receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  if (receipts.length !== 1) {
    throw new ContentCampaignError(`发布核验必须且只能读取一个可信 PublishReceipt，当前为 ${receipts.length} 个。`);
  }
  const receipt = receipts[0];
  const platform = String(targetCase?.platform || '').trim();
  const scheduledDate = String(targetCase?.scheduledDate || '').trim();
  if (
    !RECEIPT_ID.test(String(receipt.receiptId || ''))
    || receipt.platform !== platform
    || receipt.scheduledDate !== scheduledDate
    || !String(receipt.contentVersionId || '').trim()
    || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(receipt.contentChecksum || ''))
    || !String(receipt.externalContentId || '').trim()
    || !String(receipt.evidence || '').trim()
    || !Number.isFinite(Date.parse(receipt.publishedAt))
  ) {
    throw new ContentCampaignError('PublishReceipt 与当前 Case 不一致或缺少平台内容ID、成功证据、版本血缘。');
  }
  const data = {
    status:'passed',
    receiptId:receipt.receiptId,
    platform,
    scheduledDate,
    contentVersionId:receipt.contentVersionId,
    contentChecksum:receipt.contentChecksum,
    externalContentId:receipt.externalContentId,
    evidence:receipt.evidence,
    publishedAt:receipt.publishedAt,
  };
  return {
    toolId:'agent-army.m5:publish_receipt_verify',
    pluginId:'agent-army.m5-deterministic',
    content:'发布凭证与当前 Case 已完成确定性核验。',
    artifact:{
      type:contract.expectedWorkProduct.artifactKinds[0],
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      data,
      validation:{ exists:true, readable:true, nonEmpty:true, receiptVerified:true },
    },
  };
}

export function snakeKind(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

export function safeWorkspaceRelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;
  return relative;
}

export function positiveVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

export function boundedDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1 && duration <= 600 ? duration : 45;
}

export function renderPlatformKey(composition) {
  if (composition === 'M5Master') return 'master';
  if (composition === 'M5Douyin') return 'douyin';
  if (composition === 'M5Xiaohongshu') return 'xiaohongshu';
  throw new ContentCampaignError('M5 RenderPackage 包含未知 Composition。');
}

export function selectRenderOutput(renderPackage, platform) {
  const selected = renderPackage?.outputs?.[platform];
  return selected && typeof selected === 'object' && !Array.isArray(selected)
    ? selected
    : renderPackage;
}

export function verifiedM5VisualAssets(assetPackage) {
  const assets = Array.isArray(assetPackage?.assets) ? assetPackage.assets : [];
  return assets.slice(0, 12).flatMap((asset) => {
    const relativePath = safeWorkspaceRelativePath(asset?.relativePath);
    const checksum = String(asset?.checksum || '').trim().toLowerCase();
    if (
      !relativePath
      || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
      || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
      || !Number.isInteger(Number(asset?.bytes))
      || Number(asset.bytes) <= 0
    ) return [];
    return [{
      frameId:safeText(asset?.frameId, 80) || 'verified-frame',
      relativePath,
      checksum,
      bytes:Number(asset.bytes),
    }];
  });
}

export function verifiedM5GeneratedVisual(generatedImage) {
  const relativePath = safeWorkspaceRelativePath(generatedImage?.relativePath);
  const checksum = String(generatedImage?.checksum || '').trim().toLowerCase();
  if (
    generatedImage?.model !== 'step-image-edit-2'
    || !relativePath
    || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
    || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
    || !Number.isInteger(Number(generatedImage?.bytes))
    || Number(generatedImage.bytes) <= 0
  ) return null;
  return {
    frameId:'stepfun-generated-visual',
    relativePath,
    checksum,
    bytes:Number(generatedImage.bytes),
  };
}

export function m5ArtifactPackageVideos(renderPackage) {
  const expected = ['master', 'douyin', 'xiaohongshu'];
  const videos = Object.fromEntries(expected.map((platform) => {
    const render = renderPackage?.outputs?.[platform];
    const relativePath = safeWorkspaceRelativePath(render?.relativePath || render?.outputPath);
    const checksum = String(render?.checksum || '').trim().toLowerCase();
    if (!relativePath || !/^sha256:[0-9a-f]{64}$/i.test(checksum)) {
      throw new ContentCampaignError(`固定产物包缺少可信 ${platform} 成片回执。`);
    }
    return [platform, { path:relativePath, checksum }];
  }));
  return videos;
}

export function m5SourcesLedger({
  evidence,
  assetPackage,
  generatedImage,
  voice,
  fixtureProvenance = null,
}) {
  const sources = asList(evidence?.sources).slice(0, 50).map((source, index) => ({
    ref:safeText(
      source?.url || source?.source || source?.ref || source?.sourceId || `source-${index + 1}`,
      500,
    ),
    kind:safeText(source?.kind || source?.sourceType || 'verified_source', 80),
    fetchedAt:safeText(source?.fetchedAt, 120),
    contentHash:safeText(source?.contentHash, 80),
  })).filter((source) => source.ref && source.kind);
  if (
    sources.length < 2
    || sources.some((source) =>
      source.kind === 'github_metadata'
      || !Number.isFinite(Date.parse(source.fetchedAt))
      || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(source.contentHash)
    )
  ) {
    throw new ContentCampaignError('固定产物来源账本至少需要两个可信来源。');
  }
  const sourceUrl = safeText(assetPackage?.sourceUrl, 500);
  const rightsBasis = safeText(assetPackage?.rightsBasis, 200);
  const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
  const narrationPath = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
  if (!generatedVisual || !narrationPath) {
    throw new ContentCampaignError('固定产物来源账本缺少可信生成图片或旁白路径。');
  }
  if (fixtureProvenance) {
    return {
      sources,
      thirdPartyMedia:sourceUrl
        ? [{ ref:sourceUrl, rightsBasis }]
        : [],
      aiGeneratedMedia:[],
      fixtureProvenance,
    };
  }
  return {
    sources,
    thirdPartyMedia:sourceUrl
      ? [{ ref:sourceUrl, rightsBasis }]
      : [],
    aiGeneratedMedia:[{
      ref:generatedVisual.relativePath,
      sourceChecksum:generatedVisual.checksum,
      model:generatedImage.model,
    }],
    narration:{
      provider:'StepFun',
      model:voice.model,
      checksum:String(voice.checksum || '').trim().toLowerCase(),
      ref:narrationPath,
    },
  };
}

export function m5ProviderProvenance({
  generatedImage,
  visualAnalysis,
  voice,
  allowLocalFixtureProvenance,
}) {
  const stepFunDeclared = generatedImage?.model === 'step-image-edit-2'
    || voice?.model === 'stepaudio-2.5-tts'
    || asList(visualAnalysis?.insights).some((item) =>
      item?.evidenceKind === 'stepfun_vision_frame')
    || visualAnalysis?.providerReceipt?.model === 'step-1o-turbo-vision';
  if (!stepFunDeclared) return { actionRefs:null, fixtureProvenance:null };
  const fixtureEntries = [generatedImage, visualAnalysis, voice]
    .map((item) => item?.fixtureProvenance);
  if (
    allowLocalFixtureProvenance
    && fixtureEntries.every(validM5FixtureProvenance)
    && new Set(fixtureEntries.map((item) => item.fixtureId)).size === 1
  ) {
    return {
      actionRefs:null,
      fixtureProvenance:{
        kind:'local_fixture',
        fixtureId:fixtureEntries[0].fixtureId,
        externalSideEffects:0,
      },
    };
  }
  let image;
  let vision;
  let tts;
  try {
    image = confirmedM5ProviderReceipt(generatedImage?.providerReceipt, 'image_generate');
    vision = confirmedM5ProviderReceipt(visualAnalysis?.providerReceipt, 'vision');
    tts = confirmedM5ProviderReceipt(voice?.providerReceipt || voice, 'tts');
  } catch {
    throw new ContentCampaignError(
      '机器审核发现 StepFun 图片、视觉或配音，但缺少可由内容插件同 Project 状态反查的三条 confirmed action/cost 血缘；活动保持 blocked。',
    );
  }
  return {
    actionRefs:{
      image:image.actionId,
      vision:vision.actionId,
      tts:tts.actionId,
    },
    fixtureProvenance:null,
  };
}

export function confirmedM5ProviderReceipt(value, expectedOperation) {
  const actionId = String(value?.actionId || '').trim();
  const operation = String(value?.operation || '').trim();
  const callRecord = value?.callRecord;
  const costCommit = value?.costCommit;
  const expectedModel = M5_PROVIDER_MODELS[expectedOperation];
  if (
    !expectedModel
    || !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
    || operation !== expectedOperation
    || value?.model !== expectedModel
    || callRecord?.actionId !== actionId
    || callRecord?.operation !== expectedOperation
    || callRecord?.model !== expectedModel
    || !/^sha256:[0-9a-f]{64}$/i.test(String(callRecord?.promptChecksum || ''))
    || costCommit?.status !== 'confirmed'
    || !RECEIPT_ID.test(String(costCommit?.costEventId || ''))
    || costCommit?.costEvent?.provider !== 'stepfun'
    || !Number.isInteger(Number(costCommit?.costEvent?.costCents))
    || Number(costCommit.costEvent.costCents) <= 0
  ) {
    throw new ContentCampaignError(`StepFun ${expectedOperation} 回执尚未确认费用或血缘字段不完整。`);
  }
  return {
    actionId,
    operation,
    model:value.model,
    callRecord:{
      actionId,
      operation,
      model:value.model,
      promptChecksum:String(callRecord.promptChecksum).toLowerCase(),
      ...(callRecord.costEvent && typeof callRecord.costEvent === 'object' ? {
        costEvent:{
          provider:'stepfun',
          projectId:String(callRecord.costEvent.projectId || '').trim(),
          heartbeatRunId:String(callRecord.costEvent.heartbeatRunId || '').trim(),
          costCents:Number(callRecord.costEvent.costCents),
        },
      } : {}),
    },
    costCommit:{
      status:'confirmed',
      costEventId:String(costCommit.costEventId),
      costEvent:{
        provider:'stepfun',
        projectId:String(costCommit.costEvent.projectId || '').trim(),
        heartbeatRunId:String(costCommit.costEvent.heartbeatRunId || '').trim(),
        costCents:Number(costCommit.costEvent.costCents),
      },
    },
  };
}

export function assertReplayProviderReceipt(value, { operation, projectId, sourceRunId }) {
  let receipt;
  try {
    receipt = confirmedM5ProviderReceipt(value, operation);
  } catch {
    throw m5WorkProductDrift(
      { stageKey:operation },
      `StepFun ${operation} action 不是 confirmed`,
    );
  }
  const callCost = receipt.callRecord?.costEvent;
  const commitCost = receipt.costCommit?.costEvent;
  if (
    callCost?.provider !== 'stepfun'
    || commitCost?.provider !== 'stepfun'
    || callCost.projectId !== projectId
    || commitCost.projectId !== projectId
    || callCost.heartbeatRunId !== sourceRunId
    || commitCost.heartbeatRunId !== sourceRunId
    || callCost.costCents !== commitCost.costCents
  ) {
    throw m5WorkProductDrift(
      { stageKey:operation },
      `StepFun ${operation} action 的 Project、source Run 或费用状态漂移`,
    );
  }
  return receipt;
}

export function m5WorkProductDrift(contract, detail) {
  const error = new ContentCampaignError(
    `M5 ${contract?.stageKey || '阶段'} Work Product 漂移：${detail}；禁止重放或覆盖。`,
  );
  error.code = 'work_product_drift';
  error.retryable = false;
  return error;
}

export function validM5FixtureProvenance(value) {
  return value?.kind === 'local_fixture'
    && /^[A-Za-z0-9:_-]{8,120}$/.test(String(value?.fixtureId || ''))
    && value?.externalSideEffects === 0;
}

export function optionalM5GrayScriptVariants(scriptPackage) {
  const variants = scriptPackage?.variants;
  if (variants == null) return null;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
    throw new ContentCampaignError('ScriptPackage variants 必须是受控对象。');
  }
  const keys = Object.keys(variants).sort();
  if (keys.length === 1 && keys[0] === 'baseline') return null;
  return requireM5GrayScriptVariants(scriptPackage);
}

export function requireM5GrayScriptVariants(scriptPackage) {
  const variants = scriptPackage?.variants;
  if (
    !variants
    || typeof variants !== 'object'
    || Array.isArray(variants)
    || JSON.stringify(Object.keys(variants).sort())
      !== JSON.stringify(['baseline', 'gray_douyin'])
  ) {
    throw new ContentCampaignError(
      '灰度 ScriptPackage 必须且只能包含 baseline 与 gray_douyin 两条完整变体。',
    );
  }
  const baseline = validM5ScriptVariant(variants.baseline, 'baseline');
  const gray = validM5ScriptVariant(variants.gray_douyin, 'gray_douyin');
  const topLevelBinding = scriptPackage?.templateLifecycle?.templateBinding;
  if (
    scriptPackage.fullScript !== baseline.fullScript
    || !sameTemplateBinding(topLevelBinding, baseline.templateBinding)
    || baseline.templateBinding.source === 'approved_single_gray'
    || baseline.templateBinding.grayRelease === true
    || gray.templateBinding.source !== 'approved_single_gray'
    || gray.templateBinding.grayRelease !== true
    || gray.templateBinding.applicationScope !== 'full_content_variant'
    || baseline.scriptHash === gray.scriptHash
    || baseline.templateBinding.bindingHash === gray.templateBinding.bindingHash
  ) {
    throw new ContentCampaignError(
      '灰度 ScriptPackage 的 baseline 顶层兼容、模板范围或真实脚本差异不符合契约。',
    );
  }
  return { baseline, gray_douyin:gray };
}

export function validM5ScriptVariant(value, expectedKey) {
  const fullScript = String(value?.fullScript || '');
  const expectedHash = m5ScriptHash(fullScript);
  if (
    value?.variantKey !== expectedKey
    || !safeText(fullScript, 1000)
    || value?.scriptHash !== expectedHash
    || !validM5ProductionTemplateBinding(value?.templateBinding)
  ) {
    throw new ContentCampaignError(`ScriptPackage ${expectedKey} 变体缺少可信脚本、哈希或模板绑定。`);
  }
  return value;
}

export function m5ScriptHash(fullScript) {
  return `sha256:${crypto.createHash('sha256')
    .update(String(fullScript || ''))
    .digest('hex')}`;
}

export function assertM5GrayTargetBinding(binding, targetCase) {
  if (
    binding?.source !== 'approved_single_gray'
    || binding?.grayRelease !== true
    || binding?.applicationScope !== 'full_content_variant'
    || binding?.grayTargetPlatform !== 'douyin'
    || binding?.grayTargetDayCaseId !== targetCase?.id
    || binding?.grayTargetScheduledDate !== String(targetCase?.scheduledDate || '')
    || !CASE_ID.test(String(binding?.grayTargetCaseId || ''))
  ) {
    throw new ContentCampaignError(
      'gray_douyin 模板没有同时绑定当前日期 Case、预约日期和抖音平台 Case。',
    );
  }
}

export function confirmedM5VoiceVariant(value, expected) {
  const data = value?.data && typeof value.data === 'object' ? value.data : value;
  const providerReceipt = confirmedM5ProviderReceipt(data, 'tts');
  if (
    providerReceipt.actionId !== expected.actionId
    || data?.model !== 'stepaudio-2.5-tts'
    || data?.voice !== expected.voice
    || data?.relativePath !== expected.outputPath
    || !/^sha256:[0-9a-f]{64}$/i.test(String(data?.checksum || ''))
    || !Number.isInteger(Number(data?.bytes))
    || Number(data.bytes) <= 0
  ) {
    throw new ContentCampaignError(
      `${expected.variantKey} 配音没有返回匹配动作、官方音色、路径、哈希或字节数。`,
    );
  }
  return {
    variantKey:expected.variantKey,
    scriptHash:expected.scriptHash,
    templateBinding:expected.templateBinding,
    model:data.model,
    voice:data.voice,
    relativePath:data.relativePath,
    checksum:String(data.checksum).toLowerCase(),
    audioHash:String(data.checksum).toLowerCase(),
    bytes:Number(data.bytes),
    providerReceipt,
  };
}

export function assertCompleteM5GrayVoiceVariants(variants, scriptVariants = null) {
  if (
    !variants
    || typeof variants !== 'object'
    || Array.isArray(variants)
    || JSON.stringify(Object.keys(variants).sort())
      !== JSON.stringify(['baseline', 'gray_douyin'])
  ) {
    throw new ContentCampaignError(
      '灰度 VoicePackage 必须且只能包含 baseline 与 gray_douyin 两条独立音频。',
    );
  }
  for (const variantKey of ['baseline', 'gray_douyin']) {
    const voice = variants[variantKey];
    const script = scriptVariants?.[variantKey];
    let providerReceipt = null;
    try {
      providerReceipt = confirmedM5ProviderReceipt(voice?.providerReceipt, 'tts');
    } catch {
      // 统一由下面的变体契约错误关闭，避免接受无Provider费用血缘的音频。
    }
    if (
      voice?.variantKey !== variantKey
      || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.scriptHash || ''))
      || !safeWorkspaceRelativePath(voice?.relativePath)
      || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || ''))
      || voice.audioHash !== voice.checksum
      || !Number.isInteger(Number(voice?.bytes))
      || Number(voice.bytes) <= 0
      || voice.model !== 'stepaudio-2.5-tts'
      || !String(voice.voice || '').trim()
      || !validM5ProductionTemplateBinding(voice.templateBinding)
      || providerReceipt?.actionId !== voice.providerReceipt?.actionId
      || (script && (
        voice.scriptHash !== script.scriptHash
        || !sameTemplateBinding(voice.templateBinding, script.templateBinding)
      ))
    ) {
      throw new ContentCampaignError(
        `VoicePackage ${variantKey} 无法回到同一脚本、模板、音频哈希和Provider回执。`,
      );
    }
  }
  if (
    variants.baseline.scriptHash === variants.gray_douyin.scriptHash
    || variants.baseline.audioHash === variants.gray_douyin.audioHash
    || variants.baseline.providerReceipt?.actionId
      === variants.gray_douyin.providerReceipt?.actionId
  ) {
    throw new ContentCampaignError('灰度 VoicePackage 两条变体没有独立脚本、音频或Provider动作。');
  }
  return variants;
}

export function optionalM5GrayRenderLineage(scriptPackage, voicePackage) {
  const scriptVariants = optionalM5GrayScriptVariants(scriptPackage);
  const hasVoiceVariants = voicePackage?.variants != null;
  if (!scriptVariants && !hasVoiceVariants) return null;
  if (!scriptVariants || !hasVoiceVariants) {
    throw new ContentCampaignError(
      '灰度渲染要求 ScriptPackage 与 VoicePackage 同时包含完整双变体，禁止半包或跨接。',
    );
  }
  const voiceVariants = assertCompleteM5GrayVoiceVariants(
    voicePackage.variants,
    scriptVariants,
  );
  if (
    voicePackage.variantKey !== 'baseline'
    || voicePackage.scriptHash !== voiceVariants.baseline.scriptHash
    || voicePackage.audioHash !== voiceVariants.baseline.audioHash
    || voicePackage.checksum !== voiceVariants.baseline.checksum
  ) {
    throw new ContentCampaignError('VoicePackage 顶层必须精确镜像 baseline 以保持普通链兼容。');
  }
  const item = (variantKey) => ({
    variantKey,
    script:scriptVariants[variantKey],
    scriptHash:scriptVariants[variantKey].scriptHash,
    voiceoverSrc:voiceVariants[variantKey].relativePath,
    audioHash:voiceVariants[variantKey].audioHash,
    templateBinding:scriptVariants[variantKey].templateBinding,
    voiceProviderActionId:voiceVariants[variantKey].providerReceipt.actionId,
  });
  return {
    master:item('baseline'),
    xiaohongshu:item('baseline'),
    douyin:item('gray_douyin'),
  };
}

export function optionalM5BaselineRenderLineage(scriptPackage, voicePackage) {
  if (!scriptPackage?.fullScript || !voicePackage) return null;
  const templateBinding = scriptPackage?.templateLifecycle?.templateBinding
    || scriptPackage?.templateBinding;
  if (!validM5ProductionTemplateBinding(templateBinding)) return null;
  return m5BaselineRenderLineage({
    script:scriptPackage,
    voice:voicePackage,
    templateBinding,
  });
}

export function m5BaselineRenderLineage({ script, voice, templateBinding }) {
  const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
  const audioHash = String(voice?.audioHash || voice?.checksum || '').trim();
  const scriptHash = String(script?.scriptHash || '').trim() || m5ScriptHash(script?.fullScript);
  const voiceProviderActionId = String(
    voice?.providerReceipt?.actionId || voice?.actionId || '',
  ).trim() || null;
  if (
    !script?.fullScript
    || !voiceoverSrc
    || !/^sha256:[0-9a-f]{64}$/i.test(scriptHash)
    || !/^sha256:[0-9a-f]{64}$/i.test(audioHash)
    || !validM5ProductionTemplateBinding(templateBinding)
  ) {
    throw new ContentCampaignError(
      'baseline 渲染缺少脚本、音频或模板的稳定血缘。',
    );
  }
  return {
    variantKey:'baseline',
    script,
    scriptHash,
    voiceoverSrc,
    audioHash,
    templateBinding,
    voiceProviderActionId,
  };
}

export function m5RenderVariantDescriptor({ composition, grayLineage, fallback }) {
  if (!grayLineage) return fallback;
  return grayLineage[renderPlatformKey(composition)];
}

export function hasM5VariantLineage(value) {
  return [
    'variantKey',
    'scriptHash',
    'audioHash',
    'templateBindingHash',
    'voiceProviderActionId',
  ].some((key) => value?.[key] != null);
}

export function assertM5RenderOutputLineage(output, expected, platform) {
  if (
    !expected
    || output?.variantKey !== expected.variantKey
    || output?.scriptHash !== expected.scriptHash
    || output?.audioHash !== expected.audioHash
    || output?.templateBindingHash !== expected.templateBinding.bindingHash
    || output?.voiceProviderActionId !== expected.voiceProviderActionId
  ) {
    throw m5WorkProductDrift(
      { stageKey:'render' },
      `${platform} 成片的脚本、音频或模板变体血缘发生跨接`,
    );
  }
}

export function buildM5RenderProps({
  script,
  voiceoverSrc,
  composition,
  visualAssets,
  templateBinding,
  variantLineage = null,
}) {
  const platform = composition === 'M5Douyin'
    ? 'douyin'
    : composition === 'M5Xiaohongshu' ? 'xiaohongshu' : 'master';
  const sourceShots = Array.isArray(script?.shots) ? script.shots.slice(0, 12) : [];
  const fallbackText = safeText(script?.fullScript, 240);
  const normalizedShots = sourceShots.length
    ? sourceShots
    : [{ startSeconds:0, endSeconds:45, narration:fallbackText, visual:'受控本机口播画面' }];
  const scenes = normalizedShots.map((shot, index) => {
    const startFrame = Math.max(0, Math.min(1349, Math.round(Number(shot?.startSeconds || 0) * 30)));
    const requestedEnd = Math.round(Number(shot?.endSeconds || ((index + 1) * 45 / normalizedShots.length)) * 30);
    const endFrame = Math.max(startFrame + 1, Math.min(1350, requestedEnd));
    return {
      id:`scene-${index + 1}`,
      startFrame,
      durationInFrames:endFrame - startFrame,
      headline:safeText(index === 0 ? script?.hook || script?.headline : `要点 ${index + 1}`, 80) || `要点 ${index + 1}`,
      body:safeText(shot?.narration || fallbackText, 240) || '等待可信脚本内容。',
      imageSrc:visualAssets[index % visualAssets.length].relativePath,
      evidenceRef:visualAssets[index % visualAssets.length].frameId,
    };
  });
  const captions = scenes.map((scene) => ({
    startFrame:scene.startFrame,
    endFrame:scene.startFrame + scene.durationInFrames,
    text:captionSafeText(scene.body),
  }));
  return {
    platform,
    title:safeText(script?.headline || script?.topic || 'AI Agent 实战', 80) || 'AI Agent 实战',
    subtitle:safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
    sourceLabel:'公开来源与本机自产素材',
    voiceoverSrc,
    coverSrc:visualAssets[0].relativePath,
    assetLedger:visualAssets.map((asset) => ({
      relativePath:asset.relativePath,
      checksum:asset.checksum,
    })),
    templateBinding,
    ...(variantLineage ? { variantLineage } : {}),
    scenes,
    captions,
  };
}

export function buildM5SocialCardProps({
  script,
  visualAssets,
  templateBinding,
  rightsBasis,
}) {
  const ledger = visualAssets.slice(0, 12).map((asset) => ({
    relativePath:asset.relativePath,
    checksum:asset.checksum,
  }));
  const shotBullets = asList(script?.shots)
    .map((shot) => safeText(shot?.narration || shot?.visual, 24))
    .filter(Boolean)
    .slice(0, 3);
  const keyPoints = shotBullets.length
    ? shotBullets
    : ['明确任务边界', '保留真实回执', '由人工决定发布'];
  return {
    platform:'xiaohongshu',
    title:safeText(script?.headline || script?.topic || 'AI Agent 实战', 40) || 'AI Agent 实战',
    subtitle:safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
    sourceLabel:'公开来源与本机自产素材',
    rightsBasis:safeText(rightsBasis, 500),
    templateBinding,
    assetLedger:ledger,
    cards:[
      {
        id:'cover',
        kind:'cover',
        headline:safeText(script?.headline || script?.topic || '别把运行当完成', 14) || '别把运行当完成',
        body:safeText(script?.hook || script?.fullScript || '完成必须落到可核验的真实产物。', 60),
        bullets:keyPoints,
      },
      {
        id:'evidence',
        kind:'evidence',
        headline:'证据进入同一条链',
        body:'素材、模板和输出都绑定到同一 Case，可按路径与哈希复核。',
        bullets:keyPoints,
        imageSrc:ledger[0].relativePath,
      },
      {
        id:'checklist',
        kind:'checklist',
        headline:'交付前逐项核对',
        body:'静态卡只是候选产物；审批、启用和发布仍是彼此独立的门禁。',
        bullets:['代码与测试已通过', '素材与版权依据可追溯', '输出尺寸和哈希已核验', '发布需要负责人批准'],
      },
    ],
  };
}

export function validM5SocialCardPackageReceipt(value) {
  const outputDir = safeWorkspaceRelativePath(value?.outputDir);
  const cards = asList(value?.cards);
  const checks = value?.checks;
  return value?.schemaVersion === M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE
    && value?.platform === 'xiaohongshu'
    && outputDir
    && safeWorkspaceRelativePath(value?.propsPath)
    && String(value.propsPath).endsWith('/social-card.props.json')
    && validM5Sha256(value?.propsChecksum)
    && safeWorkspaceRelativePath(value?.manifestPath)
    && String(value.manifestPath).endsWith('/social-card-render-manifest.json')
    && validM5Sha256(value?.manifestChecksum)
    && validM5Sha256(value?.templateBindingHash)
    && safeText(value?.rightsBasis, 500)
    && value?.rightsBasisHash === m5TextHash(value.rightsBasis)
    && cards.length >= 3
    && cards.length <= 9
    && cards.every((card) =>
      /^[a-z0-9][a-z0-9-]{1,48}$/i.test(String(card?.id || ''))
      && safeWorkspaceRelativePath(card?.relativePath)
      && String(card.relativePath).startsWith(`${outputDir}/`)
      && String(card.relativePath).toLowerCase().endsWith('.png')
      && Number(card?.width) === 1080
      && Number(card?.height) === 1440
      && Number.isInteger(Number(card?.bytes))
      && Number(card.bytes) > 0
      && validM5Sha256(card?.checksum)
    )
    && checks?.dimensions === true
    && checks?.fileHashes === true
    && checks?.assetLineage === true
    && checks?.rightsBasis === true
    && checks?.externalNetworkUsed === false;
}

export function validM5Sha256(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}

export function m5TextHash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

export async function resolveM5TemplateForRender({
  resolver,
  pipelineCaseId,
  scriptBinding,
}) {
  let resolved = defaultM5ProductionTemplateBinding('resolver_unavailable');
  if (typeof resolver?.resolve === 'function') {
    try {
      resolved = await resolver.resolve(pipelineCaseId);
    } catch (error) {
      if (error instanceof M5ProductionTemplateResolutionError
        || error?.code === 'm5_production_template_blocked') throw error;
      resolved = defaultM5ProductionTemplateBinding('resolver_read_failed');
    }
  }
  if (!scriptBinding) {
    if (resolved.source === 'built_in_default') return resolved;
    throw new ContentCampaignError(
      '渲染阶段发现已批准生产模板，但 ScriptPackage 没有模板绑定，必须从脚本阶段恢复。',
    );
  }
  if (!sameTemplateBinding(scriptBinding, resolved)) {
    throw new ContentCampaignError(
      'ScriptPackage 模板绑定与当前只读生产模板决定不一致，必须从脚本阶段恢复。',
    );
  }
  return resolved;
}

export function sameTemplateBinding(left, right) {
  return validM5ProductionTemplateBinding(left)
    && validM5ProductionTemplateBinding(right)
    && left.bindingHash === right.bindingHash;
}

export function captionSafeText(value) {
  const compact = String(value || '').replace(/\s+/g, '').trim().slice(0, 60);
  if (!compact) return '等待可信字幕';
  const lines = [];
  for (let index = 0; index < compact.length && lines.length < 3; index += 20) {
    lines.push(compact.slice(index, index + 20));
  }
  return lines.join('\n');
}

export function deterministicM5ReviewChecks({
  campaignCase,
  targetCase,
  render,
  script,
  evidence,
  voice,
  assetPackage,
  generatedImage,
  media,
  subtitles,
}) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const sourceById = new Map(
    sources
      .filter(validM5ReviewSource)
      .map((source) => [String(source.sourceId), source]),
  );
  const bindings = Array.isArray(script?.factBindings) ? script.factBindings : [];
  const evidenceClaims = new Map(
    (Array.isArray(evidence?.claims) ? evidence.claims : [])
      .map((claim) => [String(claim?.claimId || ''), claim])
      .filter(([claimId]) => claimId),
  );
  const facts = evidence?.schemaVersion === 'agent.army/evidence-package/v2'
    && sources.length >= 2
    && sourceById.size === sources.length
    && bindings.length >= 1
    && bindings.every((binding) =>
      String(binding?.statement || '').trim()
      && String(script.fullScript || '').includes(String(binding.statement))
      && Array.isArray(binding.sourceIds)
      && binding.sourceIds.length >= 2
      && binding.sourceIds.every((sourceId) => sourceById.has(String(sourceId)))
      && bindingMatchesEvidenceClaim(binding, evidenceClaims.get(String(binding.claimId || ''))),
    );
  const privacy = !containsSensitiveM5Text([
    script?.headline,
    script?.hook,
    script?.fullScript,
  ].join('\n'));
  const rights = render?.composition
    && safeWorkspaceRelativePath(render?.propsPath)
    && voice?.model === 'stepaudio-2.5-tts'
    && String(voice?.voice || '').trim()
    && !/clone|克隆|复刻/i.test(String(voice.voice));
  const visualAssets = verifiedM5VisualAssets(assetPackage);
  const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
  const claims = facts
    && !containsUnsupportedPromise(script?.fullScript)
    && (!Array.isArray(script?.qualityReview?.unresolved) || script.qualityReview.unresolved.length === 0);
  const grant = campaignCase?.campaignGrant;
  const platform = String(targetCase?.platform || '').trim();
  const scheduledDate = String(targetCase?.scheduledDate || '').trim();
  const grantScope = grant?.status === 'active'
    && Array.isArray(grant.platforms)
    && grant.platforms.includes(platform)
    && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate);
  const receipts = Array.isArray(grant?.receipts) ? grant.receipts : [];
  const duplicate = /^sha256:[0-9a-f]{64}$/i.test(String(render?.checksum || ''))
    && !receipts.some((receipt) =>
      receipt?.platform === platform
      && receipt?.contentChecksum === render.checksum,
    );
  return {
    facts,
    privacy,
    rights:Boolean(
      rights
      && generatedVisual
      && visualAssets.length
      && String(assetPackage?.rightsBasis || '').trim(),
    ),
    media:media?.passed === true && subtitles?.passed === true,
    claims,
    grantScope,
    duplicate,
  };
}

export function validM5ReviewSource(source) {
  let url;
  try { url = new URL(String(source?.url || '')); } catch { return false; }
  return Boolean(
    String(source?.sourceId || '').trim()
    && ['http:', 'https:'].includes(url.protocol)
    && !url.username
    && !url.password
    && source?.kind !== 'github_metadata'
    && Number.isFinite(Date.parse(String(source?.fetchedAt || '')))
    && /^(?:sha256:)?[0-9a-f]{64}$/i.test(String(source?.contentHash || ''))
    && Array.isArray(source?.evidenceFragments)
    && source.evidenceFragments.some((fragment) =>
      String(fragment?.fragmentId || '').trim()
      && String(fragment?.text || '').trim()
    )
  );
}

export function bindingMatchesEvidenceClaim(binding, claim) {
  if (
    !claim
    || String(binding?.statement || '').trim() !== String(claim?.text || '').trim()
    || !sameStringSet(binding?.sourceIds, claim?.sourceIds)
    || !Array.isArray(binding?.evidenceFragments)
    || !Array.isArray(claim?.evidenceFragments)
  ) return false;
  const claimFragments = new Set(claim.evidenceFragments.map(evidenceFragmentKey));
  const bindingFragments = new Set(binding.evidenceFragments.map(evidenceFragmentKey));
  if (!claimFragments.size || !sameStringSet([...bindingFragments], [...claimFragments])) return false;
  const fragmentSources = new Set(binding.evidenceFragments.map((fragment) => String(fragment?.sourceId || '')));
  return binding.sourceIds.every((sourceId) => fragmentSources.has(String(sourceId)));
}

export function evidenceFragmentKey(fragment) {
  return [
    String(fragment?.sourceId || '').trim(),
    String(fragment?.fragmentId || '').trim(),
    String(fragment?.text || '').replace(/\s+/g, ' ').trim(),
  ].join('\u0000');
}

export function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = new Set(left.map(String));
  const b = new Set(right.map(String));
  return a.size === b.size && [...a].every((item) => b.has(item));
}

export function containsSensitiveM5Text(value) {
  const text = String(value || '');
  return /(?:\b(?:sk|api)[-_][A-Za-z0-9]{12,}\b|Bearer\s+[A-Za-z0-9._-]{12,}|(?:token|cookie|password|secret|api[_ -]?key)\s*[:=]\s*\S{6,}|file:\/\/|\/Users\/|[A-Za-z]:\\|聊天原文|客户数据|内部账号)/i.test(text);
}

export function containsUnsupportedPromise(value) {
  return /(?:保证|必然|百分之百|100%|稳赚|无风险|一定能|立刻暴涨|播放量翻倍)/i.test(String(value || ''));
}

export function m5HermesRouteExecution({
  assignment,
  task,
  contract,
  strategy,
  toolIds,
  inputs,
}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const execution = createM5RouteExecution({
    runId:assignment?.runId || task?.execution?.paperclipRunId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds,
    inputs,
  });
  if (recovery) {
    try {
      assertChangedM5RecoveryRoute(execution, recovery);
    } catch (error) {
      if (error && typeof error === 'object') error.m5RouteExecution = execution;
      throw error;
    }
  }
  return execution;
}

export function m5HermesStrategy(task, contract) {
  return task?.input?.context?.m5Recovery?.nextRoute?.kind
    || `default:${contract.pluginEntryTool || contract.deterministicEntry}`;
}

export function m5HermesStageToolIds(contract) {
  if (contract.stageKey === 'render') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-props-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-render`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:social-card-render`,
    ];
  }
  if (contract.stageKey === 'machine_review') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:subtitle-layout-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-package-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-lineage-validate`,
    ];
  }
  return [`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`];
}

export async function executeM5Route(routeExecution, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === 'object') {
      error.m5RouteExecution = routeExecution;
    }
    throw error;
  }
}

export function routeCaseInput(caseItem) {
  return {
    id:String(caseItem?.id || ''),
    version:Number(caseItem?.version) || 0,
    stageKey:String(caseItem?.stageKey || ''),
    campaignId:String(caseItem?.campaignId || ''),
    scheduledDate:String(caseItem?.scheduledDate || ''),
    platform:String(caseItem?.platform || ''),
  };
}

export function routeOutputHashes(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((item) => String(
      item?.artifactHash
      || item?.externalId
      || item?.id
      || '',
    ).trim())
    .filter(Boolean)
    .sort();
}
