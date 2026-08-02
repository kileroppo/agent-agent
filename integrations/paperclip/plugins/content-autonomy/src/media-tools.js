import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { M5_STEPFUN_MODELS } from '@agent-army/m5-contracts';
import { coded, safeRelativePath, sha256 } from './policy.js';
import { paidActionStateKey } from './stepfun-tools.js';

const executeFile = promisify(execFile);
const REQUIRED_ARTIFACTS = Object.freeze([
  'master.mp4',
  'douyin.mp4',
  'xiaohongshu.mp4',
  'douyin.copy.json',
  'xiaohongshu.copy.json',
  'cover.png',
  'sources.json',
  'review.json',
  'lineage.json'
]);
const PROVIDER_MODELS = M5_STEPFUN_MODELS;

export async function verifyProviderAction(ctx, params, run) {
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

export async function mediaProbe(ctx, params, run) {
  const { absolute, relative } = await existingWorkspacePath(ctx, run.companyId, params.relativePath);
  const probe = await probeFile(absolute);
  const bytes = await fs.readFile(absolute);
  return {
    content:'音视频规格检查完成。',
    data:{ relativePath:relative, checksum:sha256(bytes), probe }
  };
}

export async function mediaValidate(ctx, params, run) {
  const { absolute, relative } = await existingWorkspacePath(ctx, run.companyId, params.relativePath);
  const probe = await probeFile(absolute);
  const video = probe.streams.find((item) => item.codec_type === 'video');
  const audio = probe.streams.find((item) => item.codec_type === 'audio');
  const duration = Number(probe.format?.duration || 0);
  const videoDuration = Number(video?.duration || 0);
  const audioDuration = Number(audio?.duration || 0);
  const errors = [];
  if (video?.codec_name !== 'h264') errors.push('视频编码不是 H.264。');
  if (video?.width !== 1080 || video?.height !== 1920) errors.push('视频不是 1080×1920 竖屏。');
  if (audio?.codec_name !== 'aac') errors.push('音频编码不是 AAC。');
  if (!audio) errors.push('缺少音轨。');
  if (
    videoDuration > 0
    && audioDuration > 0
    && Math.abs(videoDuration - audioDuration) > 0.25
  ) {
    errors.push('音轨与画面时长相差超过 0.25 秒。');
  }
  if (duration < 30 || duration > 60) errors.push('成片时长不在 30–60 秒。');
  if (params.expectedDurationSeconds != null && Math.abs(duration - Number(params.expectedDurationSeconds)) > 0.25) {
    errors.push('音画时长与预期相差超过 0.25 秒。');
  }

  const black = await detectBlackFrames(absolute);
  if (black.totalSeconds > 0.1 || black.startsWithBlack || black.endsWithBlack) errors.push('检测到不可接受的黑帧。');
  const loudness = await detectLoudness(absolute);
  if (loudness.integratedLufs == null) errors.push('无法读取综合响度。');
  else if (loudness.integratedLufs < -18 || loudness.integratedLufs > -12) errors.push('综合响度不在 -18 到 -12 LUFS。');
  if (loudness.truePeakDb != null && loudness.truePeakDb > -1) errors.push('真实峰值高于 -1 dBTP。');

  return {
    content:errors.length ? '成片机器检查未通过。' : '成片机器检查通过。',
    data:{
      passed:errors.length === 0,
      errors,
      relativePath:relative,
      durationSeconds:duration,
      blackFrames:black,
      loudness,
      specification:{
        width:video?.width,
        height:video?.height,
        videoCodec:video?.codec_name,
        audioCodec:audio?.codec_name,
        videoDurationSeconds:videoDuration || null,
        audioDurationSeconds:audioDuration || null,
      }
    }
  };
}

export async function mediaFinalize(ctx, params, run) {
  const input = await existingWorkspacePath(ctx, run.companyId, params.inputPath);
  const output = await writableWorkspacePath(ctx, run.companyId, params.outputPath);
  if (!/\.mp4$/i.test(output.relative)) throw coded('invalid_media_output', '最终成片必须输出为 .mp4。');
  const temporary = `${output.absolute}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`;
  const args = buildFinalEncodeArgs(input.absolute, temporary);
  try {
    await executeFile('ffmpeg', args, { timeout:10 * 60_000, maxBuffer:2_000_000 });
    await replaceFile(temporary, output.absolute);
  } catch (error) {
    await fs.rm(temporary, { force:true });
    throw coded('ffmpeg_finalize_failed', `最终编码失败：${String(error?.code || 'ffmpeg_error')}。`);
  }
  const bytes = await fs.readFile(output.absolute);
  return {
    content:'最终编码已写入受控内容工作区。',
    data:{
      inputPath:input.relative,
      outputPath:output.relative,
      checksum:sha256(bytes),
      bytes:bytes.length,
      command:{ executable:'ffmpeg', profile:'m5-vertical-h264-aac-v1' }
    }
  };
}

export async function writeM5ArtifactPackage(ctx, params, run, options = {}) {
  const outputDir = safeRelativePath(params.outputDir);
  let sources = structuredClone(params.sources);
  let lineage = structuredClone(params.lineage);
  let providerBinding = null;
  if (
    params.providerActionRefs != null
    && (params.providerLedgerPath != null || params.providerThemeId != null)
  ) {
    throw coded(
      'provider_lineage_binding_conflict',
      '逐阶段 confirmed action 与七主题 Provider ledger 不能同时绑定。',
    );
  }
  if (params.providerLedgerPath != null || params.providerThemeId != null) {
    if (!params.providerLedgerPath || !params.providerThemeId) {
      throw coded(
        'provider_lineage_binding_invalid',
        'providerLedgerPath 与 providerThemeId 必须同时提供。',
      );
    }
    const providerLedger = await existingWorkspacePath(
      ctx,
      run.companyId,
      params.providerLedgerPath,
    );
    const providerLedgerBytes = await fs.readFile(providerLedger.absolute);
    let ledger;
    try {
      ledger = JSON.parse(providerLedgerBytes.toString('utf8'));
    } catch {
      throw coded('provider_ledger_invalid', 'StepFun Provider ledger 不是有效 JSON。');
    }
    const built = buildStepFunArtifactLineage({
      ledger,
      ledgerPath:providerLedger.relative,
      ledgerChecksum:sha256(providerLedgerBytes),
      themeId:params.providerThemeId,
      sources,
      lineage,
    });
    sources = built.sources;
    lineage = built.lineage;
    providerBinding = built.providerBinding;
  }
  if (params.providerActionRefs != null) {
    const built = await buildStepFunArtifactLineageFromConfirmedActions({
      ctx,
      run,
      actionRefs:params.providerActionRefs,
      sources,
      lineage,
    });
    sources = built.sources;
    lineage = built.lineage;
    providerBinding = built.providerBinding;
  }
  const videoInputs = {
    'master.mp4':params.videos?.master,
    'douyin.mp4':params.videos?.douyin,
    'xiaohongshu.mp4':params.videos?.xiaohongshu,
  };
  const jsonInputs = {
    'douyin.copy.json':params.copies?.douyin,
    'xiaohongshu.copy.json':params.copies?.xiaohongshu,
    'sources.json':sources,
    'review.json':params.review,
    'lineage.json':lineage,
  };
  const structuralErrors = [];
  validatePlatformCopy(jsonInputs['douyin.copy.json'], 'douyin.copy.json', structuralErrors);
  validatePlatformCopy(jsonInputs['xiaohongshu.copy.json'], 'xiaohongshu.copy.json', structuralErrors);
  validateSourcesLedger(jsonInputs['sources.json'], structuralErrors);
  validateReviewReport(jsonInputs['review.json'], structuralErrors);
  validateLineageDocument(jsonInputs['lineage.json'], lineage, structuralErrors);
  validateProviderLineageBinding(jsonInputs['sources.json'], lineage, structuralErrors);
  if (structuralErrors.length) throw coded('artifact_package_invalid', structuralErrors.join(' '));
  const files = {};
  for (const [fileName, input] of Object.entries(videoInputs)) {
    if (!input || !/^sha256:[a-f0-9]{64}$/.test(String(input.checksum || ''))) {
      throw coded('artifact_video_receipt_invalid', `${fileName} 缺少可信来源路径或哈希。`);
    }
    const source = await existingWorkspacePath(ctx, run.companyId, input.path);
    const bytes = await fs.readFile(source.absolute);
    if (sha256(bytes) !== input.checksum) {
      throw coded('artifact_video_checksum_mismatch', `${fileName} 来源文件哈希不匹配。`);
    }
    files[fileName] = await writeArtifactBytes(
      ctx,
      run,
      path.posix.join(outputDir, fileName),
      bytes,
    );
  }

  const coverSource = await existingWorkspacePath(ctx, run.companyId, params.coverSourcePath);
  const coverBytes = await coverPngBytes(coverSource.absolute, options.executeFile || executeFile);
  files['cover.png'] = await writeArtifactBytes(
    ctx,
    run,
    path.posix.join(outputDir, 'cover.png'),
    coverBytes,
  );

  for (const [fileName, value] of Object.entries(jsonInputs)) {
    files[fileName] = await writeArtifactBytes(
      ctx,
      run,
      path.posix.join(outputDir, fileName),
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    );
  }
  const manifest = {
    schemaVersion:1,
    files:Object.fromEntries(Object.entries(files).map(([fileName, entry]) => [
      fileName,
      { path:fileName, checksum:entry.checksum },
    ])),
    lineage,
  };
  const manifestEntry = await writeArtifactBytes(
    ctx,
    run,
    path.posix.join(outputDir, 'artifact-manifest.json'),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  return {
    content:'固定产物包已写入受控内容工作区。',
    data:{
      manifestPath:manifestEntry.relativePath,
      manifestChecksum:manifestEntry.checksum,
      ...(providerBinding ? { providerBinding } : {}),
      files:Object.fromEntries(Object.entries(files).map(([fileName, entry]) => [
        fileName,
        {
          relativePath:entry.relativePath,
          checksum:entry.checksum,
          bytes:entry.bytes,
        },
      ])),
    },
  };
}

export async function buildStepFunArtifactLineageFromConfirmedActions({
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

export function buildStepFunArtifactLineage({
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

export function buildFinalEncodeArgs(inputPath, outputPath) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
    '-af', 'loudnorm=I=-15:LRA=7:TP=-1.5',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest',
    outputPath
  ];
}

export async function validateArtifactLineage(ctx, params, run) {
  const manifestFile = await existingWorkspacePath(ctx, run.companyId, params.manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestFile.absolute, 'utf8'));
  const manifestDirectory = path.posix.dirname(manifestFile.relative);
  const errors = [];
  const artifacts = {};
  if (manifest.schemaVersion !== 1) errors.push('产物清单 schemaVersion 必须为 1。');
  for (const fileName of REQUIRED_ARTIFACTS) {
    const entry = manifest.files?.[fileName];
    if (!entry || entry.path !== fileName || !/^sha256:[a-f0-9]{64}$/.test(String(entry.checksum || ''))) {
      errors.push(`${fileName} 缺少固定路径或有效哈希。`);
      continue;
    }
    try {
      const file = await existingWorkspacePath(
        ctx,
        run.companyId,
        manifestDirectory === '.'
          ? entry.path
          : path.posix.join(manifestDirectory, entry.path),
      );
      const bytes = await fs.readFile(file.absolute);
      artifacts[fileName] = { ...file, bytes };
      const actual = sha256(bytes);
      if (actual !== entry.checksum) errors.push(`${fileName} 文件哈希与清单不一致。`);
    } catch {
      errors.push(`${fileName} 文件不存在或越界。`);
    }
  }
  const lineage = manifest.lineage;
  if (!lineage?.contentVersionId || !lineage?.sourceTaskId || !lineage?.generatedBy || !Date.parse(lineage?.createdAt)) {
    errors.push('缺少 contentVersionId、sourceTaskId、generatedBy 或 createdAt 血缘字段。');
  }
  if (!Array.isArray(lineage?.parents)) errors.push('血缘 parents 必须是数组。');
  const douyinCopy = parseJsonArtifact(artifacts['douyin.copy.json'], 'douyin.copy.json', errors);
  const xiaohongshuCopy = parseJsonArtifact(artifacts['xiaohongshu.copy.json'], 'xiaohongshu.copy.json', errors);
  validatePlatformCopy(douyinCopy, 'douyin.copy.json', errors);
  validatePlatformCopy(xiaohongshuCopy, 'xiaohongshu.copy.json', errors);
  const sources = parseJsonArtifact(artifacts['sources.json'], 'sources.json', errors);
  validateSourcesLedger(sources, errors);
  const review = parseJsonArtifact(artifacts['review.json'], 'review.json', errors);
  validateReviewReport(review, errors);
  const lineageDocument = parseJsonArtifact(artifacts['lineage.json'], 'lineage.json', errors);
  validateLineageDocument(lineageDocument, lineage, errors);
  validateProviderLineageBinding(sources, lineageDocument, errors);
  return {
    content:errors.length ? '固定产物与血缘检查未通过。' : '固定产物与血缘检查通过。',
    data:{ passed:errors.length === 0, errors, requiredArtifacts:REQUIRED_ARTIFACTS, manifestPath:manifestFile.relative }
  };
}

function parseJsonArtifact(artifact, fileName, errors) {
  if (!artifact?.bytes) return null;
  try {
    const parsed = JSON.parse(artifact.bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
    return parsed;
  } catch {
    errors.push(`${fileName} 必须是有效 JSON 对象。`);
    return null;
  }
}

function validatePlatformCopy(value, fileName, errors) {
  if (!value) return;
  if (!textWithin(value.title, 1, 100) || !textWithin(value.body, 1, 2000)
    || !Array.isArray(value.tags) || value.tags.length < 1 || value.tags.length > 10
    || value.tags.some((tag) => !textWithin(tag, 1, 40))) {
    errors.push(`${fileName} 必须包含非空 title、body 和 1–10 个有效 tags。`);
  }
}

function validateSourcesLedger(value, errors) {
  if (!value) return;
  if (!Array.isArray(value.sources) || value.sources.length < 2
    || value.sources.some((source) => !textWithin(source?.ref, 1, 500) || !textWithin(source?.kind, 1, 80))) {
    errors.push('sources.json 必须包含至少两个带 ref 和 kind 的来源。');
  }
  if (!Array.isArray(value.thirdPartyMedia) || !Array.isArray(value.aiGeneratedMedia)) {
    errors.push('sources.json 必须明确提供 thirdPartyMedia 和 aiGeneratedMedia 版权账本数组。');
    return;
  }
  if (value.thirdPartyMedia.some((item) =>
    !textWithin(item?.ref, 1, 500) || !textWithin(item?.rightsBasis, 1, 200))) {
    errors.push('sources.json 的第三方素材必须记录 ref 和 rightsBasis。');
  }
  if (value.aiGeneratedMedia.some((item) =>
    !textWithin(item?.model, 1, 120)
    || !textWithin(item?.sourceTaskId, 1, 160)
    || !/^sha256:[a-f0-9]{64}$/.test(String(item?.checksum || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(item?.promptChecksum || '')))) {
    errors.push('sources.json 的 AI 素材必须记录模型、来源任务、文件哈希和 Prompt 哈希。');
  }
  if (
    value.narration?.provider === 'StepFun'
    && (
      !textWithin(value.narration?.model, 1, 120)
      || !textWithin(value.narration?.sourceTaskId, 1, 160)
      || !/^sha256:[a-f0-9]{64}$/.test(String(value.narration?.checksum || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(value.narration?.promptChecksum || ''))
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value.narration?.costEventId || ''))
    )
  ) {
    errors.push('sources.json 的 StepFun 旁白必须记录模型、来源任务、文件哈希、Prompt 哈希和费用事件。');
  }
}

function validateProviderLineageBinding(sources, lineage, errors) {
  if (!sources) return;
  const generated = Array.isArray(sources.aiGeneratedMedia)
    ? sources.aiGeneratedMedia
    : [];
  const stepFunNarration = sources.narration?.provider === 'StepFun'
    ? sources.narration
    : null;
  if (!generated.length && !stepFunNarration) return;
  const bindingChecksums = new Set([
    ...generated.map((item) =>
      item?.providerBindingChecksum || item?.providerLedgerChecksum),
    stepFunNarration?.providerBindingChecksum || stepFunNarration?.providerLedgerChecksum,
  ].filter(Boolean));
  if (
    bindingChecksums.size !== 1
    || generated.some((item) =>
      !/^sha256:[a-f0-9]{64}$/.test(String(
        item?.providerBindingChecksum || item?.providerLedgerChecksum || '',
      ))
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(item?.costEventId || ''))
      || !textWithin(item?.vision?.sourceTaskId, 1, 160)
      || !textWithin(item?.vision?.model, 1, 120)
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(item?.vision?.costEventId || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(item?.vision?.observationChecksum || '')))
    || (
      stepFunNarration
      && (
        !/^sha256:[a-f0-9]{64}$/.test(String(
          stepFunNarration.providerBindingChecksum
          || stepFunNarration.providerLedgerChecksum
          || '',
        ))
        || (
          stepFunNarration.providerBindingChecksum
          || stepFunNarration.providerLedgerChecksum
        ) !== [...bindingChecksums][0]
      )
    )
  ) {
    errors.push('StepFun 素材必须绑定图像、视觉、TTS action/costEvent 和同一 Provider 证明。');
    return;
  }
  const [bindingChecksum] = bindingChecksums;
  const parent = Array.isArray(lineage?.parents)
    ? lineage.parents.find((item) =>
      (
        item?.kind === 'stepfun_provider_ledger'
        && item?.checksum === bindingChecksum
        && textWithin(item?.path, 1, 500)
        && textWithin(item?.themeId, 1, 120)
      )
      || (
        item?.kind === 'stepfun_confirmed_actions'
        && item?.checksum === bindingChecksum
        && Array.isArray(item?.actionIds)
        && item.actionIds.length === 3
        && new Set(item.actionIds).size === 3
        && item.actionIds.every((actionId) => textWithin(actionId, 8, 160))
      ))
    : null;
  if (!parent) {
    errors.push('内容血缘缺少与 StepFun 素材一致的 Provider 父引用。');
  }
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

function validateReviewReport(value, errors) {
  if (!value) return;
  if (value.schemaVersion !== 1 || value.passed !== true
    || !Array.isArray(value.failures) || value.failures.length
    || value.checks?.subtitleLayout?.passed !== true) {
    errors.push('review.json 必须 passed=true、failures 为空且字幕布局门禁通过。');
  }
}

function validateLineageDocument(value, manifestLineage, errors) {
  if (!value) return;
  if (value.schemaVersion !== 1
    || !Date.parse(value.createdAt)
    || !Array.isArray(value.parents)
    || value.contentVersionId !== manifestLineage?.contentVersionId
    || value.sourceTaskId !== manifestLineage?.sourceTaskId
    || value.generatedBy !== manifestLineage?.generatedBy
    || JSON.stringify(value.parents) !== JSON.stringify(manifestLineage?.parents)) {
    errors.push('lineage.json 必须与产物清单中的内容版本、来源任务、生成者和父版本一致。');
  }
}

function textWithin(value, minimum, maximum) {
  const length = [...String(value || '').trim()].length;
  return length >= minimum && length <= maximum;
}

async function writeArtifactBytes(ctx, run, relativePath, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw coded('artifact_file_empty', '固定产物文件不能为空。');
  }
  const output = await writableWorkspacePath(ctx, run.companyId, relativePath);
  await atomicWriteFile(output.absolute, bytes);
  const readBack = await fs.readFile(output.absolute);
  if (!readBack.equals(bytes)) throw coded('artifact_write_mismatch', '固定产物写回校验失败。');
  return {
    relativePath:output.relative,
    checksum:sha256(readBack),
    bytes:readBack.length,
  };
}

async function coverPngBytes(sourcePath, runFile) {
  const source = await fs.readFile(sourcePath);
  if (isPng(source)) return source;
  const temporary = `${sourcePath}.${process.pid}.${crypto.randomUUID()}.cover.png`;
  try {
    await runFile('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', sourcePath,
      '-frames:v', '1',
      temporary,
    ], { timeout:60_000, maxBuffer:1_000_000 });
    const converted = await fs.readFile(temporary);
    if (!isPng(converted)) throw new Error('invalid_png');
    return converted;
  } catch (error) {
    throw coded(
      'cover_conversion_failed',
      `封面转换为 PNG 失败：${String(error?.code || 'ffmpeg_error')}。`,
    );
  } finally {
    await fs.rm(temporary, { force:true });
  }
}

function isPng(bytes) {
  return bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function probeFile(absolute) {
  const { stdout } = await executeFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration',
    '-of', 'json',
    absolute
  ], { timeout:30_000, maxBuffer:1_000_000 });
  return JSON.parse(stdout);
}

async function detectBlackFrames(absolute) {
  const { stderr } = await executeFile('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', absolute,
    '-vf', 'blackdetect=d=0.04:pix_th=0.10',
    '-an', '-f', 'null', '-'
  ], { timeout:120_000, maxBuffer:2_000_000 });
  return parseBlackDetect(stderr);
}

export function parseBlackDetect(stderr) {
  const ranges = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
    .map((match) => ({ start:Number(match[1]), end:Number(match[2]), duration:Number(match[3]) }));
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  return {
    ranges,
    totalSeconds:ranges.reduce((sum, range) => sum + range.duration, 0),
    startsWithBlack:ranges.some((range) => range.start <= 0.04),
    endsWithBlack:duration > 0 && ranges.some((range) => duration - range.end <= 0.04)
  };
}

async function detectLoudness(absolute) {
  const { stderr } = await executeFile('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', absolute,
    '-filter_complex', 'ebur128=peak=true',
    '-f', 'null', '-'
  ], { timeout:120_000, maxBuffer:2_000_000 });
  return parseEbur128(stderr);
}

export function parseEbur128(stderr) {
  const summary = stderr.slice(Math.max(0, stderr.lastIndexOf('Summary:')));
  const integrated = summary.match(/Integrated loudness:\s*I:\s*(-?[\d.]+)\s*LUFS/);
  const truePeak = summary.match(/True peak:\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  return {
    integratedLufs:integrated ? Number(integrated[1]) : null,
    truePeakDb:truePeak ? Number(truePeak[1]) : null
  };
}

async function workspaceRoot(ctx, companyId, writable = false) {
  const status = await ctx.localFolders.status(companyId, 'content-workspace');
  if (!status.healthy || !status.realPath || (writable && !status.writable)) {
    throw coded('content_workspace_unavailable', writable
      ? '内容生产工作区不可写。'
      : '内容生产工作区尚未配置。');
  }
  return fs.realpath(status.realPath);
}

async function existingWorkspacePath(ctx, companyId, relativePath) {
  const root = await workspaceRoot(ctx, companyId);
  const relative = safeRelativePath(relativePath);
  const absolute = await fs.realpath(path.resolve(root, relative));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw coded('symlink_escape', '媒体路径逃逸了工作区。');
  return { root, absolute, relative };
}

async function writableWorkspacePath(ctx, companyId, relativePath) {
  const root = await workspaceRoot(ctx, companyId, true);
  const relative = safeRelativePath(relativePath);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw coded('path_escape', '输出路径逃逸了工作区。');
  await fs.mkdir(path.dirname(candidate), { recursive:true });
  const realParent = await fs.realpath(path.dirname(candidate));
  if (!realParent.startsWith(`${root}${path.sep}`) && realParent !== root) {
    throw coded('symlink_escape', '输出目录通过符号链接逃逸了工作区。');
  }
  const absolute = path.join(realParent, path.basename(candidate));
  return { root, absolute, relative };
}

async function atomicWriteFile(destination, bytes) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode:0o600, flag:'wx' });
    await replaceFile(temporary, destination);
  } finally {
    await fs.rm(temporary, { force:true });
  }
}

async function replaceFile(source, destination) {
  await fs.rename(source, destination);
  await fs.chmod(destination, 0o600);
}
