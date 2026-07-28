import fs from 'node:fs/promises';
import path from 'node:path';
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
  correctionApplied = false
} = {}) {
  const mode = confirmationMode === 'automatic' ? 'automatic' : 'human';
  const confirmed = confirmedTranscriptDocument({
    title,
    transcript,
    machineChecksum,
    confirmationMode:mode,
    confirmerRef,
    confirmedAt,
    version
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
    version
  };
  await fs.writeFile(confirmedTranscriptPath, confirmed.markdown, { encoding:'utf8', flag:'wx' });
  await fs.writeFile(attestationPath, JSON.stringify(attestation, null, 2), { encoding:'utf8', flag:'wx' });
  return {
    confirmationMode:mode,
    confirmedTranscriptPath,
    confirmedTranscriptChecksum:confirmed.checksum,
    confirmedTranscriptVersion:version,
    confirmationAttestationPath:attestationPath,
    ...(mode === 'human' ? { humanReviewAttestationPath:attestationPath } : {})
  };
}

export async function reviewTranscript({ store, job, input = {}, now = () => new Date() } = {}) {
  if (!job) throw new TranscriptReviewError('任务不存在。', 404);
  if (job.status === 'completed' && job.output?.confirmedTranscriptPath) return { job, duplicate:true };
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
  const updated = await store.update(job.id, {
    status:'completed',
    progress:100,
    stageMessage:'人工完整听审已确认',
    completedAt:reviewedAt,
    output:{
      ...(job.output || {}),
      reviewStatus:'confirmed',
      ...confirmation
    }
  }, { stage:'completed', message:'人工完整听审已确认，确认稿已生成' });
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

function requiredPath(value) {
  const filePath = String(value || '').trim();
  if (!path.isAbsolute(filePath)) throw new TranscriptReviewError('任务缺少受控转录产物。', 409);
  return filePath;
}

function stripDocumentHeading(value) {
  return String(value || '').replace(/^#\s+[^\n]+\n+/m, '').trim();
}

function safeIdentity(value) {
  return String(value || 'local-owner').replace(/[\r\n]/g, '').trim().slice(0, 120) || 'local-owner';
}
