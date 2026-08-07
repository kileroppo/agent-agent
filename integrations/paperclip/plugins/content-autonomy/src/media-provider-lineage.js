import fs from 'node:fs/promises';
import { M5_STEPFUN_MODELS } from '@agent-army/m5-contracts';
import { coded, safeRelativePath, sha256 } from './policy.js';
import { paidActionStateKey } from './stepfun-tools.js';
import { mediaRuntime } from './media-runtime.js';

const PROVIDER_MODELS = M5_STEPFUN_MODELS;
const { existing:existingWorkspacePath } = mediaRuntime.workspace;

async function verifyProviderAction(ctx, params, run) {
  const keys = Object.keys(params || {}).sort();
  if (keys.join(',') !== 'actionId,companyId,costEventId,operation,runContext') {
    throw coded(
      'provider_action_verify_input_denied',
      'Provider action 只读核验只接受 Paperclip 注入的 companyId、actionId、costEventId、operation 和 runContext。',
    );
  }
  const actionId = String(params.actionId || '');
  const costEventId = String(params.costEventId || '');
  const operation = String(params.operation || '');
  const expectedModel = PROVIDER_MODELS[operation];
  if (
    !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(costEventId)
    || !expectedModel
    || params.companyId !== run.companyId
  ) {
    throw coded('provider_action_verify_input_denied', 'Provider action 只读核验参数无效。');
  }
  const state = await ctx.state.get(paidActionStateKey(run.projectId, actionId));
  const data = state?.resultData;
  const record = data?.callRecord;
  const callCost = record?.costEvent;
  const commit = data?.costCommit;
  const committedCost = commit?.costEvent;
  if (
    state?.state !== 'confirmed'
    || state.actionId !== actionId
    || state.operation !== operation
    || state.agentId !== run.agentId
    || state.companyId !== run.companyId
    || state.projectId !== run.projectId
    || state.runId !== run.runId
    || state.costEventId !== costEventId
    || data?.actionId !== actionId
    || data?.operation !== operation
    || data?.model !== expectedModel
    || record?.actionId !== actionId
    || record?.operation !== operation
    || record?.provider !== 'stepfun'
    || record?.model !== expectedModel
    || !/^sha256:[0-9a-f]{64}$/i.test(String(record?.promptChecksum || ''))
    || callCost?.provider !== 'stepfun'
    || callCost?.biller !== 'stepfun'
    || callCost?.billingType !== 'metered_api'
    || callCost?.billingCode !== `m5:${operation}`
    || callCost?.model !== expectedModel
    || callCost?.agentId !== run.agentId
    || callCost?.projectId !== run.projectId
    || callCost?.heartbeatRunId !== run.runId
    || commit?.status !== 'confirmed'
    || commit?.costEventId !== costEventId
    || committedCost?.provider !== 'stepfun'
    || committedCost?.biller !== 'stepfun'
    || committedCost?.billingType !== 'metered_api'
    || committedCost?.billingCode !== `m5:${operation}`
    || committedCost?.model !== expectedModel
    || committedCost?.agentId !== run.agentId
    || committedCost?.projectId !== run.projectId
    || committedCost?.heartbeatRunId !== run.runId
    || !Number.isInteger(callCost?.costCents)
    || callCost.costCents <= 0
    || committedCost?.costCents !== callCost.costCents
  ) {
    throw coded(
      'provider_action_unconfirmed',
      `StepFun ${operation} action 无法由原 Paperclip Run 的已确认插件状态证明。`,
    );
  }
  return {
    content:'Provider action 已由原 Paperclip Run 的只读状态核验。',
    data:{
      confirmed:true,
      actionId,
      costEventId,
      operation,
      provider:'stepfun',
      model:expectedModel,
      projectId:run.projectId,
      heartbeatRunId:run.runId,
      costCents:callCost.costCents,
    },
  };
}
async function buildStepFunArtifactLineageFromConfirmedActions({
  ctx,
  run,
  actionRefs,
  sources,
  lineage,
}) {
  const refs = confirmedActionRefs(actionRefs);
  const [image, vision, tts] = await Promise.all([
    confirmedProviderAction(ctx, run, refs.image, 'image_generate'),
    confirmedProviderAction(ctx, run, refs.vision, 'vision'),
    confirmedProviderAction(ctx, run, refs.tts, 'tts'),
  ]);
  const imagePath = safeRelativePath(image.resultData?.relativePath);
  const imageChecksum = String(image.resultData?.checksum || '');
  const visionPath = safeRelativePath(vision.resultData?.sourcePath);
  const visionChecksum = String(vision.resultData?.sourceChecksum || '');
  const narrationPath = safeRelativePath(tts.resultData?.relativePath);
  const narrationChecksum = String(tts.resultData?.checksum || '');
  if (visionPath !== imagePath || visionChecksum !== imageChecksum) {
    throw coded(
      'provider_vision_source_mismatch',
      'StepFun 视觉 action 没有核验本次选用的生成图片。',
    );
  }
  await Promise.all([
    assertWorkspaceChecksum(ctx, run, imagePath, imageChecksum),
    assertWorkspaceChecksum(ctx, run, narrationPath, narrationChecksum),
  ]);

  const nextSources = structuredClone(sources);
  const generated = nextSources?.aiGeneratedMedia?.find((item) =>
    item?.ref === imagePath
    || item?.sourceChecksum === imageChecksum
    || item?.checksum === imageChecksum
  );
  if (
    !generated
    || generated.model !== image.resultData?.model
    || !nextSources?.narration
    || nextSources.narration.provider !== 'StepFun'
    || nextSources.narration.model !== tts.resultData?.model
    || nextSources.narration.checksum !== narrationChecksum
  ) {
    throw coded(
      'provider_artifact_binding_mismatch',
      '来源账本中的 StepFun 图片或旁白与 confirmed action 不一致。',
    );
  }
  const bindingDocument = {
    schemaVersion:'agent.army/stepfun-confirmed-actions/v1',
    provider:'stepfun',
    projectId:run.projectId,
    actions:[
      providerActionSummary(image),
      providerActionSummary(vision),
      providerActionSummary(tts),
    ],
  };
  const bindingChecksum = sha256(Buffer.from(stableJson(bindingDocument)));
  Object.assign(generated, {
    sourceTaskId:image.actionId,
    checksum:imageChecksum,
    promptChecksum:image.resultData.callRecord.promptChecksum,
    costEventId:image.costEventId,
    providerBindingChecksum:bindingChecksum,
    vision:{
      sourceTaskId:vision.actionId,
      model:vision.resultData.model,
      costEventId:vision.costEventId,
      observationChecksum:sha256(Buffer.from(String(vision.resultData.observation || ''))),
    },
  });
  Object.assign(nextSources.narration, {
    sourceTaskId:tts.actionId,
    promptChecksum:tts.resultData.callRecord.promptChecksum,
    costEventId:tts.costEventId,
    providerBindingChecksum:bindingChecksum,
  });

  const nextLineage = structuredClone(lineage);
  const parent = {
    kind:'stepfun_confirmed_actions',
    checksum:bindingChecksum,
    actionIds:[image.actionId, vision.actionId, tts.actionId],
  };
  nextLineage.parents = [
    ...(Array.isArray(nextLineage.parents)
      ? nextLineage.parents.filter((item) => item?.kind !== parent.kind)
      : []),
    parent,
  ];
  return {
    sources:nextSources,
    lineage:nextLineage,
    providerBinding:{
      bindingChecksum,
      imageActionId:image.actionId,
      imageCostEventId:image.costEventId,
      visionActionId:vision.actionId,
      visionCostEventId:vision.costEventId,
      ttsActionId:tts.actionId,
      ttsCostEventId:tts.costEventId,
    },
  };
}

function confirmedActionRefs(value) {
  const refs = {
    image:String(value?.image || ''),
    vision:String(value?.vision || ''),
    tts:String(value?.tts || ''),
  };
  if (Object.values(refs).some((actionId) => !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId))) {
    throw coded(
      'provider_action_refs_invalid',
      '逐阶段 Provider 血缘必须同时提供有效的 image、vision、tts actionId。',
    );
  }
  if (new Set(Object.values(refs)).size !== 3) {
    throw coded('provider_action_refs_invalid', '三条 Provider actionId 必须互不相同。');
  }
  return refs;
}

async function confirmedProviderAction(ctx, run, actionId, operation) {
  const state = await ctx.state.get(paidActionStateKey(run.projectId, actionId));
  const data = state?.resultData;
  const record = data?.callRecord;
  const costCommit = data?.costCommit;
  if (
    state?.state !== 'confirmed'
    || state.actionId !== actionId
    || state.operation !== operation
    || state.projectId !== run.projectId
    || state.companyId !== run.companyId
    || state.costEventId !== costCommit?.costEventId
    || costCommit?.status !== 'confirmed'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(state.costEventId || ''))
    || record?.actionId !== actionId
    || record?.operation !== operation
    || record?.model !== data?.model
    || !/^sha256:[a-f0-9]{64}$/.test(String(record?.promptChecksum || ''))
    || record?.costEvent?.costCents !== costCommit?.costEvent?.costCents
    || record?.costEvent?.provider !== 'stepfun'
    || record?.costEvent?.projectId !== run.projectId
  ) {
    throw coded(
      'provider_action_unconfirmed',
      `StepFun ${operation} action 无法由当前 Project 的插件状态证明已确认费用。`,
    );
  }
  return state;
}

function providerActionSummary(state) {
  return {
    actionId:state.actionId,
    operation:state.operation,
    model:state.resultData.model,
    promptChecksum:state.resultData.callRecord.promptChecksum,
    costEventId:state.costEventId,
    costCents:state.resultData.costCommit.costEvent.costCents,
  };
}

async function assertWorkspaceChecksum(ctx, run, relativePath, expectedChecksum) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(expectedChecksum || ''))) {
    throw coded('provider_action_artifact_invalid', 'confirmed action 缺少有效产物哈希。');
  }
  const file = await existingWorkspacePath(ctx, run.companyId, relativePath);
  const bytes = await fs.readFile(file.absolute);
  if (sha256(bytes) !== expectedChecksum) {
    throw coded('provider_action_artifact_mismatch', 'confirmed action 的本地产物哈希不匹配。');
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildStepFunArtifactLineage({
  ledger,
  ledgerPath,
  ledgerChecksum,
  themeId,
  sources,
  lineage,
}) {
  if (
    ledger?.schemaVersion !== 'agent.army/stepfun-seven-theme-batch/v1'
    || ledger?.provider !== 'stepfun'
    || ledger?.status !== 'succeeded'
    || ledger?.pendingCostRecovery !== 0
    || !Array.isArray(ledger?.themes)
    || !/^sha256:[a-f0-9]{64}$/.test(String(ledgerChecksum || ''))
  ) {
    throw coded('provider_ledger_unconfirmed', 'StepFun Provider ledger 未完成或费用仍待确认。');
  }
  const theme = ledger.themes.find((item) => item?.id === themeId);
  if (!theme) throw coded('provider_theme_missing', 'Provider ledger 中不存在指定主题。');
  const selected = theme.candidates?.find((candidate) =>
    candidate?.outputPath === theme.selectedPath
    && candidate?.outputChecksum === theme.selectedChecksum
  );
  requireConfirmedProviderAction(selected, 'image_generate');
  requireConfirmedProviderAction(selected?.vision, 'vision');
  requireConfirmedProviderAction(theme.narration, 'tts');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(String(selected.promptChecksum || theme.promptChecksum || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(theme.narrationChecksum || ''))
  ) {
    throw coded('provider_prompt_lineage_missing', 'Provider ledger 缺少图像或旁白 Prompt 哈希。');
  }

  const nextSources = structuredClone(sources);
  const generated = nextSources?.aiGeneratedMedia?.find((item) =>
    item?.ref === selected.outputPath
    || item?.sourceChecksum === selected.outputChecksum
    || item?.checksum === selected.outputChecksum
  );
  if (
    !generated
    || generated.model !== selected.model
    || !nextSources?.narration
    || nextSources.narration.provider !== 'StepFun'
    || nextSources.narration.model !== theme.narration.model
    || nextSources.narration.checksum !== theme.narration.outputChecksum
  ) {
    throw coded(
      'provider_artifact_binding_mismatch',
      '来源账本中的 StepFun 图片或旁白与 Provider ledger 不一致。',
    );
  }
  Object.assign(generated, {
    sourceTaskId:selected.actionId,
    checksum:selected.outputChecksum,
    promptChecksum:selected.promptChecksum || theme.promptChecksum,
    costEventId:selected.costEventId,
    providerLedgerChecksum:ledgerChecksum,
    vision:{
      sourceTaskId:selected.vision.actionId,
      model:selected.vision.model,
      costEventId:selected.vision.costEventId,
      observationChecksum:selected.quality?.observationChecksum,
    },
  });
  Object.assign(nextSources.narration, {
    sourceTaskId:theme.narration.actionId,
    promptChecksum:theme.narrationChecksum,
    costEventId:theme.narration.costEventId,
    providerLedgerChecksum:ledgerChecksum,
  });

  const nextLineage = structuredClone(lineage);
  const parent = {
    kind:'stepfun_provider_ledger',
    path:safeRelativePath(ledgerPath),
    checksum:ledgerChecksum,
    batchVersion:String(ledger.batchVersion || ''),
    themeId,
  };
  nextLineage.parents = [
    ...(Array.isArray(nextLineage.parents)
      ? nextLineage.parents.filter((item) =>
        item?.kind !== parent.kind
        || item?.themeId !== parent.themeId)
      : []),
    parent,
  ];
  return {
    sources:nextSources,
    lineage:nextLineage,
    providerBinding:{
      ledgerPath:parent.path,
      ledgerChecksum,
      batchVersion:parent.batchVersion,
      themeId,
      imageActionId:selected.actionId,
      imageCostEventId:selected.costEventId,
      visionActionId:selected.vision.actionId,
      visionCostEventId:selected.vision.costEventId,
      ttsActionId:theme.narration.actionId,
      ttsCostEventId:theme.narration.costEventId,
    },
  };
}
function requireConfirmedProviderAction(action, operation) {
  if (
    action?.operation !== operation
    || !textWithin(action?.actionId, 1, 160)
    || !textWithin(action?.model, 1, 120)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(action?.costEventId || ''))
    || !Number.isInteger(action?.costCents)
    || action.costCents < 0
    || typeof action.replayed !== 'boolean'
    || action.providerCallReplayed !== false
  ) {
    throw coded('provider_action_unconfirmed', `StepFun ${operation} action 尚未确认费用。`);
  }
}
function textWithin(value, minimum, maximum) {
  const length = [...String(value || '').trim()].length;
  return length >= minimum && length <= maximum;
}

export const mediaProviderLineage = Object.freeze({
  verifyAction:verifyProviderAction,
  fromConfirmedActions:buildStepFunArtifactLineageFromConfirmedActions,
  fromLedger:buildStepFunArtifactLineage,
});
