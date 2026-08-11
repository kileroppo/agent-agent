import fs from 'node:fs/promises';
import path from 'node:path';
import { composeDelivery } from './domain.js';
import { larkDeliveryUncertainFailure } from './recovery.js';
import { confirmedTranscriptDocument } from './transcript-evidence.js';

export async function createTranscriptConfirmationFiles({
  directory,
  jobId,
  title,
  transcript,
  machineChecksum,
  confirmationMode = 'human',
  confirmerRef,
  confirmedAt = new Date().toISOString(),
  version = 1,
  correctionApplied = false,
  basedOnVersion = null,
  correctionSummary = ''
} = {}) {
  const mode = confirmationMode === 'automatic' ? 'automatic' : 'human';
  const confirmed = confirmedTranscriptDocument({
    title,
    transcript,
    machineChecksum,
    confirmationMode:mode,
    confirmerRef,
    confirmedAt,
    version,
    correctionApplied,
    basedOnVersion
  });
  const confirmedTranscriptPath = path.join(requiredPath(directory), `confirmed-transcript-v${version}.md`);
  const attestationPath = path.join(
    directory,
    mode === 'human'
      ? `human-review-attestation-v${version}.json`
      : `automatic-confirmation-attestation-v${version}.json`
  );
  const attestation = {
    schemaVersion:'agent.army/transcript-confirmation/v1',
    jobId,
    confirmationMode:mode,
    confirmerRef:safeIdentity(confirmerRef || (mode === 'automatic' ? 'xiaod-quality-gate' : 'local-owner')),
    confirmedAt,
    completeListen:mode === 'human',
    machineTranscriptChecksum:machineChecksum || null,
    confirmedTranscriptChecksum:confirmed.checksum,
    correctionApplied:Boolean(correctionApplied),
    basedOnVersion:Number.isSafeInteger(basedOnVersion) && basedOnVersion > 0 ? basedOnVersion : null,
    correctionSummary:safeSummary(correctionSummary),
    version
  };
  await fs.writeFile(confirmedTranscriptPath, confirmed.markdown, { encoding:'utf8', flag:'wx', mode:0o600 });
  try {
    await fs.writeFile(attestationPath, JSON.stringify(attestation, null, 2), { encoding:'utf8', flag:'wx', mode:0o600 });
  } catch (error) {
    await fs.rm(confirmedTranscriptPath, { force:true }).catch(() => {});
    throw error;
  }
  return {
    confirmationMode:mode,
    confirmedTranscriptPath,
    confirmedTranscriptChecksum:confirmed.checksum,
    confirmedTranscriptVersion:version,
    confirmationAttestationPath:attestationPath,
    ...(mode === 'human' ? { humanReviewAttestationPath:attestationPath } : {})
  };
}

export async function readTranscriptRevision(job) {
  if (!job) throw new TranscriptReviewError('任务不存在。', 404);
  const filePath = requiredPath(job.output?.confirmedTranscriptPath);
  const markdown = await fs.readFile(filePath, 'utf8');
  return {
    jobId:job.id,
    title:job.title,
    transcript:stripConfirmedTranscriptDocument(markdown),
    version:positiveVersion(job.output?.confirmedTranscriptVersion),
    confirmationMode:job.output?.confirmationMode === 'human' ? 'human' : 'automatic',
    completeListen:job.output?.confirmationMode === 'human',
    correctionApplied:job.output?.transcriptCorrection?.applied === true,
    canRevise:['completed', 'awaiting_delivery'].includes(job.status)
      && job.output?.confirmationMode === 'automatic',
  };
}

export async function reviseTranscript({ store, job, input = {}, now = () => new Date() } = {}) {
  if (!job) throw new TranscriptReviewError('任务不存在。', 404);
  if (!['completed', 'awaiting_delivery'].includes(job.status) || !job.output?.confirmedTranscriptPath) {
    throw new TranscriptReviewError('只有已经生成确认稿的完成任务才能补正字幕。', 409);
  }
  if (job.output?.confirmationMode !== 'automatic') {
    throw new TranscriptReviewError('这份字幕已经完成整段人工听审，不能用局部补正覆盖其听审事实；请重新走完整听审。', 409);
  }
  const expectedVersion = Number(input.expectedVersion);
  const currentVersion = positiveVersion(job.output.confirmedTranscriptVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== currentVersion) {
    throw new TranscriptReviewError('字幕版本已经变化，请刷新后再保存。', 409);
  }
  const correctedTranscript = normalizeCorrection(input.correctedTranscript);
  if (correctedTranscript.length < 20) throw new TranscriptReviewError('补正后的字幕正文过短，未保存。', 422);
  const currentMarkdown = await fs.readFile(requiredPath(job.output.confirmedTranscriptPath), 'utf8');
  if (correctedTranscript === stripConfirmedTranscriptDocument(currentMarkdown)) {
    throw new TranscriptReviewError('字幕没有变化，无需生成新版本。', 422);
  }
  const version = currentVersion + 1;
  const correctedAt = now().toISOString();
  const directory = path.dirname(requiredPath(job.output.confirmedTranscriptPath));
  let confirmation;
  try {
    confirmation = await createTranscriptConfirmationFiles({
      directory,
      jobId:job.id,
      title:job.title,
      transcript:correctedTranscript,
      machineChecksum:job.output?.transcriptChecksum,
      confirmationMode:'automatic',
      confirmerRef:input.editorRef || 'local-owner',
      confirmedAt:correctedAt,
      version,
      correctionApplied:true,
      basedOnVersion:currentVersion,
      correctionSummary:input.correctionSummary,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new TranscriptReviewError('字幕版本已经变化，请刷新后再保存。', 409);
    throw error;
  }
  const proofreadPath = path.join(directory, `完整校对文本-v${version}.md`);
  const guide = await readText(job.output?.guidePath);
  const markdownPath = path.join(directory, `分享式补正版-v${version}.md`);
  const revisedMarkdown = guide
    ? composeDelivery(job.title, guide, correctedTranscript)
    : `# ${job.title}\n\n## 完整校对文本\n\n${correctedTranscript}\n`;
  const createdFiles = [
    confirmation.confirmedTranscriptPath,
    confirmation.confirmationAttestationPath,
  ];
  try {
    await fs.writeFile(proofreadPath, `${correctedTranscript}\n`, { encoding:'utf8', flag:'wx', mode:0o600 });
    createdFiles.push(proofreadPath);
    await fs.writeFile(markdownPath, revisedMarkdown, { encoding:'utf8', flag:'wx', mode:0o600 });
    createdFiles.push(markdownPath);
    const previous = transcriptVersionRecord(job.output, currentVersion);
    const revision = {
      version,
      basedOnVersion:currentVersion,
      correctedAt,
      correctedBy:safeIdentity(input.editorRef),
      correctionSummary:safeSummary(input.correctionSummary),
      confirmationMode:'automatic',
      completeListen:false,
      checksum:confirmation.confirmedTranscriptChecksum,
      path:confirmation.confirmedTranscriptPath,
    };
    const updated = await store.update(job.id, {
      stageMessage:'AI 字幕初稿已人工补正；后续分析可按需使用最新版本',
      output:{
        ...(job.output || {}),
        ...confirmation,
        proofreadPath,
        markdownPath,
        reviewStatus:'auto_confirmed',
        transcriptCorrection:{ applied:true, ...revision },
        transcriptVersions:mergeTranscriptVersions(job.output?.transcriptVersions, previous, revision),
        larkRevisionStatus:job.output?.larkUrl ? 'stale' : 'not_delivered',
      },
    }, { stage:job.status, message:`字幕已在 AI 初稿基础上补正为 v${version}，未调用模型、未自动外发` });
    return { job:updated, revision, duplicate:false };
  } catch (error) {
    await Promise.all(createdFiles.map((filePath) => fs.rm(filePath, { force:true }).catch(() => {})));
    if (error?.code === 'EEXIST') throw new TranscriptReviewError('字幕版本已经变化，请刷新后再保存。', 409);
    throw error;
  }
}

export async function reviewTranscript({ store, job, input = {}, now = () => new Date(), delivery = null } = {}) {
  if (!job) throw new TranscriptReviewError('任务不存在。', 404);
  if (['completed', 'awaiting_delivery'].includes(job.status) && job.output?.confirmedTranscriptPath) return { job, duplicate:true };
  if (job.status !== 'awaiting_review') throw new TranscriptReviewError('这条任务当前不在人工听审阶段。', 409);
  const decision = String(input.decision || '').trim().toLowerCase();
  if (!['confirm', 'reject'].includes(decision)) throw new TranscriptReviewError('听审决定只支持 confirm 或 reject。', 422);
  if (decision === 'reject') {
    const updated = await store.update(job.id, {
      status:'failed',
      progress:100,
      stageMessage:'人工听审未通过',
      error:'人工听审发现机器稿不能作为确认稿。',
      failure:{ category:'manual', retryable:false, recovery:'请修正素材或重新转录后创建新任务。' },
      output:{ ...(job.output || {}), reviewStatus:'rejected' }
    }, { stage:'failed', message:'人工听审未通过，未生成确认稿' });
    return { job:updated, duplicate:false };
  }
  if (input.completeListen !== true) throw new TranscriptReviewError('必须明确确认已经完整听审，才能生成确认稿。', 422);
  const quality = await readJson(job.output?.qualityReportPath);
  if (Array.isArray(quality?.hardFailures) && quality.hardFailures.length) {
    throw new TranscriptReviewError('机器完整性硬门禁未通过，不能用人工确认绕过。', 409);
  }
  const machineTranscript = await fs.readFile(requiredPath(job.output?.timedTranscriptPath || job.output?.transcriptPath), 'utf8');
  const corrected = typeof input.correctedTranscript === 'string' ? input.correctedTranscript.trim() : '';
  const transcript = corrected || stripDocumentHeading(machineTranscript);
  if (transcript.length < 20) throw new TranscriptReviewError('确认稿正文过短，未生成文件。', 422);
  const reviewedAt = now().toISOString();
  const version = Number(job.output?.confirmedTranscriptVersion || 0) + 1;
  const directory = path.dirname(requiredPath(job.output?.transcriptPath));
  const confirmation = await createTranscriptConfirmationFiles({
    directory,
    jobId:job.id,
    title:job.title,
    transcript,
    machineChecksum:job.output?.transcriptChecksum,
    confirmationMode:'human',
    confirmerRef:input.reviewerRef,
    confirmedAt:reviewedAt,
    version,
    correctionApplied:Boolean(corrected)
  });
  const guide = await readText(job.output?.guidePath);
  const reviewedMarkdown = guide
    ? composeDelivery(job.title, guide, transcript)
    : `# ${job.title}\n\n## 完整校对文本\n\n${transcript}\n`;
  const reviewedMarkdownPath = path.join(directory, `分享式确认稿-v${version}.md`);
  await fs.writeFile(reviewedMarkdownPath, reviewedMarkdown, { encoding:'utf8', flag:'wx', mode:0o600 });
  const localOnly = job.deliveryMode === 'local_only';
  const status = localOnly ? 'completed' : 'awaiting_delivery';
  let updated = await store.update(job.id, {
    status,
    progress:localOnly ? 100 : 92,
    stageMessage:localOnly ? '人工完整听审已确认' : '人工完整听审已确认，正在准备飞书交付',
    completedAt:localOnly ? reviewedAt : null,
    output:{
      ...(job.output || {}),
      reviewStatus:'confirmed',
      previousMarkdownPath:job.output?.markdownPath || null,
      markdownPath:reviewedMarkdownPath,
      larkUrl:localOnly ? job.output?.larkUrl || null : null,
      larkPermissionGranted:localOnly && job.output?.larkPermissionGranted === true,
      ...confirmation
    }
  }, { stage:status, message:localOnly ? '人工完整听审已确认，确认稿已生成' : '人工确认稿已生成，准备飞书交付' });

  if (delivery && !localOnly) {
    try {
      const lark = await delivery.deliver({ jobId:job.id, title:job.title, markdown:reviewedMarkdown });
      const delivered = Boolean(lark.url && lark.permissionGranted);
      updated = await store.update(job.id, {
        status:delivered ? 'completed' : 'awaiting_delivery',
        progress:delivered ? 100 : 92,
        stageMessage:delivered ? '人工确认稿已完成飞书交付' : '人工确认稿已生成，等待飞书权限确认',
        completedAt:delivered ? reviewedAt : null,
        output:{
          ...store.get(job.id).output,
          larkUrl:lark.url || null,
          larkPermissionGranted:lark.permissionGranted === true
        },
        warnings:delivered
          ? job.warnings || []
          : [...(job.warnings || []), lark.configured === false ? '飞书尚未配置；人工确认稿已安全保存在本地。' : '飞书文档权限尚未确认。']
      }, { stage:delivered ? 'completed' : 'awaiting_delivery', message:delivered ? '人工确认稿飞书交付已确认' : '飞书交付尚未完成' });
    } catch (error) {
      const uncertain = error?.code === 'lark_delivery_uncertain';
      const failure = uncertain ? larkDeliveryUncertainFailure() : null;
      updated = await store.update(job.id, {
        status:'awaiting_delivery', progress:92,
        stageMessage:uncertain ? '人工确认稿已生成，飞书交付结果待人工核对' : '人工确认稿已生成，等待飞书恢复后交付',
        error:uncertain ? error.message : null,
        failure,
        warnings:[...(job.warnings || []), uncertain ? '飞书可能已接收交付，请先人工核对，禁止盲目重试。' : '飞书交付暂时失败，未创建文档，可稍后继续。']
      }, { stage:'awaiting_delivery', message:uncertain ? '飞书交付结果不确定，已停止自动重试' : '飞书交付未开始，确认稿保留在本地' });
    }
  }
  return { job:updated, duplicate:false };
}

export class TranscriptReviewError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(requiredPath(filePath), 'utf8')); }
  catch { return null; }
}

async function readText(filePath) {
  if (!filePath) return null;
  try { return await fs.readFile(requiredPath(filePath), 'utf8'); }
  catch { return null; }
}

function requiredPath(value) {
  const filePath = String(value || '').trim();
  if (!path.isAbsolute(filePath)) throw new TranscriptReviewError('任务缺少受控转录产物。', 409);
  return filePath;
}

function stripDocumentHeading(value) {
  return String(value || '').replace(/^#\s+[^\n]+\n+/m, '').trim();
}

function stripConfirmedTranscriptDocument(value) {
  return stripDocumentHeading(String(value || '').replace(/^---\n[\s\S]*?\n---\n+/m, '')).trim();
}

function normalizeCorrection(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, 1_000_000);
}

function positiveVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function safeSummary(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
}

function transcriptVersionRecord(output = {}, version = 1) {
  return {
    version,
    basedOnVersion:null,
    correctedAt:null,
    correctedBy:null,
    correctionSummary:'',
    confirmationMode:output.confirmationMode === 'human' ? 'human' : 'automatic',
    completeListen:output.confirmationMode === 'human',
    checksum:output.confirmedTranscriptChecksum || null,
    path:output.confirmedTranscriptPath || null,
  };
}

function mergeTranscriptVersions(existing, previous, revision) {
  const versions = Array.isArray(existing) ? existing.filter((item) => item && Number.isSafeInteger(item.version)) : [];
  const byVersion = new Map(versions.map((item) => [item.version, item]));
  byVersion.set(previous.version, previous);
  byVersion.set(revision.version, revision);
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

function safeIdentity(value) {
  return String(value || 'local-owner').replace(/[\r\n]/g, '').trim().slice(0, 120) || 'local-owner';
}
