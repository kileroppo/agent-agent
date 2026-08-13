import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVerifiedVideoAnalysisArtifact } from './task-completion-contract.ts';

const MAX_SOURCE_TRANSCRIPT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_TRANSCRIPT_CHARS = 12_000;

export async function resolveRequiredSourceContext({
  task,
  tasks,
  allowedRoots,
}: {
  task: any;
  tasks: any[];
  allowedRoots: string[];
}) {
  const requiredTaskIds = uniqueTextList(task.input?.context?.requiredSourceTaskIds, 120);
  if (!requiredTaskIds.length) return { sourceContext:null, error:null };
  const requiredTasks = requiredTaskIds.map((taskId) =>
    tasks.find((item) => String(item?.taskId || '') === taskId));
  if (requiredTasks.some((sourceTask) => !sourceTask || sourceTask.status !== 'succeeded')) {
    return sourceContextFailure(
      'script_required_source_task_unavailable',
      '声明的来源任务不存在或尚未成功，不能生成脚本。',
    );
  }
  if (requiredTasks.some((sourceTask) => !(sourceTask.artifactRefs || []).some(isStrictlyReadableArtifact))) {
    return sourceContextFailure(
      'script_required_source_artifact_unreadable',
      '声明的来源任务缺少通过可读性门禁的产物，不能生成脚本。',
    );
  }

  const entries = requiredTasks.flatMap((sourceTask) => (sourceTask.artifactRefs || [])
    .filter(isStrictlyReadableArtifact)
    .map((artifact: any) => ({ task:sourceTask, artifact })));
  const transcripts = entries.filter(({ artifact }) => artifact.type === 'confirmed_transcript');
  if (!transcripts.length) {
    return sourceContextFailure(
      'script_confirmed_transcript_required',
      '声明的来源中没有可读确认稿，不能生成脚本。',
    );
  }
  const analyses = entries.filter(({ task:sourceTask, artifact }) =>
    artifact.type === 'video_content_analysis_report'
    && (artifact.data?.evidenceMode === 'formal' || artifact.validation?.evidenceMode === 'formal')
    && artifact.data?.reportVersion === 'video-analysis/v2'
    && artifact.validation?.reportVersion === 'video-analysis/v2'
    && text(artifact.data?.summary, 2_000)
    && isVerifiedVideoAnalysisArtifact(sourceTask, artifact));
  if (!analyses.length) {
    return sourceContextFailure(
      'script_formal_analysis_required',
      '声明的来源中没有带摘要的正式视频分析，不能生成脚本。',
    );
  }
  const matches = analyses.flatMap((analysis) => transcripts
    .filter(({ artifact:transcript }) =>
      String(analysis.artifact.data?.sourceTranscriptArtifactId || '') === String(transcript.artifactId || '')
      && String(analysis.artifact.data?.sourceTranscriptChecksum || '')
        === String(transcript.checksum || ''))
    .map((transcript) => ({ transcript, analysis })))
    .filter(({ transcript, analysis }) => {
      const pairTaskIds = new Set([String(transcript.task.taskId), String(analysis.task.taskId)]);
      return pairTaskIds.size === requiredTaskIds.length
        && requiredTaskIds.every((taskId) => pairTaskIds.has(taskId));
    });
  if (matches.length !== 1) {
    return sourceContextFailure(
      'script_source_lineage_mismatch',
      '确认稿与正式视频分析的产物标识或校验和血缘不一致，不能生成脚本。',
    );
  }

  let transcriptExcerpt;
  try {
    transcriptExcerpt = await readControlledTranscript(
      matches[0].transcript.artifact,
      allowedRoots,
    );
  } catch (error: any) {
    return sourceContextFailure(
      error?.code || 'script_source_artifact_unreadable',
      error?.userMessage || '确认稿无法从受控来源目录读取，不能生成脚本。',
    );
  }
  const { transcript, analysis } = matches[0];
  return {
    error:null,
    sourceContext:Object.freeze({
      schemaVersion:'agent.army/video-script-source-context/v1',
      requiredSourceTaskIds:requiredTaskIds,
      confirmedTranscript:Object.freeze({
        taskId:transcript.task.taskId,
        artifactId:transcript.artifact.artifactId,
        title:text(transcript.artifact.title, 300) || null,
        checksum:String(transcript.artifact.checksum || ''),
        confirmationMode:text(transcript.artifact.validation?.confirmationMode, 40) || null,
        excerpt:transcriptExcerpt,
      }),
      formalAnalysis:Object.freeze({
        taskId:analysis.task.taskId,
        artifactId:analysis.artifact.artifactId,
        title:text(analysis.artifact.title, 300) || null,
        summary:text(analysis.artifact.data.summary, 2_000),
        analysisIntent:text(analysis.artifact.data?.analysisIntent, 80) || null,
        reportVersion:text(
          analysis.artifact.data?.reportVersion || analysis.artifact.validation?.reportVersion,
          80,
        ) || null,
      }),
      lineage:Object.freeze({
        sourceTranscriptArtifactId:analysis.artifact.data.sourceTranscriptArtifactId,
        sourceTranscriptChecksum:analysis.artifact.data.sourceTranscriptChecksum,
      }),
    }),
  };
}

async function readControlledTranscript(artifact: any, allowedRoots: string[]) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) {
    throw sourceReadError(
      'script_source_artifact_roots_unconfigured',
      '确认稿受控来源目录未配置，不能读取来源。',
    );
  }
  let filePath;
  try {
    const location = new URL(String(artifact?.location || ''));
    if (location.protocol !== 'file:' || (location.hostname && location.hostname !== 'localhost')) throw new Error('invalid file URL');
    filePath = path.resolve(fileURLToPath(location));
  } catch {
    throw sourceReadError(
      'script_source_artifact_location_invalid',
      '确认稿必须使用受控 file:// 产物地址。',
    );
  }
  const lexicalRoot = allowedRoots.find((root) => pathInside(root, filePath));
  if (!lexicalRoot) {
    throw sourceReadError(
      'script_source_artifact_path_not_allowed',
      '确认稿不在允许的来源目录内，已拒绝读取。',
    );
  }
  let realFile;
  let realRoot;
  try {
    [realFile, realRoot] = await Promise.all([fs.realpath(filePath), fs.realpath(lexicalRoot)]);
  } catch {
    throw sourceReadError(
      'script_source_artifact_unreadable',
      '确认稿文件不存在或不可读取。',
    );
  }
  if (!pathInside(realRoot, realFile)) {
    throw sourceReadError(
      'script_source_artifact_path_not_allowed',
      '确认稿真实路径越出允许的来源目录，已拒绝读取。',
    );
  }
  let handle;
  try {
    const beforeOpen = await fs.lstat(filePath);
    if (beforeOpen.isSymbolicLink()) {
      throw sourceReadError(
        'script_source_artifact_symlink_not_allowed',
        '确认稿最终路径不能是符号链接，已拒绝读取。',
      );
    }
    if (!beforeOpen.isFile()) {
      throw sourceReadError(
        'script_source_artifact_size_invalid',
        '确认稿必须是普通文件。',
      );
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (stat.dev !== beforeOpen.dev || stat.ino !== beforeOpen.ino) {
      throw sourceReadError(
        'script_source_artifact_replaced',
        '确认稿在安全检查后被替换，已停止生成。',
      );
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_TRANSCRIPT_FILE_BYTES) {
      throw sourceReadError(
        'script_source_artifact_size_invalid',
        '确认稿必须是非空且不超过 5MB 的普通文件。',
      );
    }
    const buffer = await handle.readFile();
    const confirmed = parseConfirmedTranscriptDocument(buffer.toString('utf8'));
    if (!confirmed) {
      throw sourceReadError(
        'script_source_artifact_format_invalid',
        '确认稿不符合小D确认稿文档格式，已停止生成。',
      );
    }
    const expectedChecksum = normalizeSha256(artifact.checksum);
    const actualChecksum = crypto.createHash('sha256').update(confirmed.body, 'utf8').digest('hex');
    if (
      !expectedChecksum
      || confirmed.embeddedChecksum !== expectedChecksum
      || actualChecksum !== expectedChecksum
    ) {
      throw sourceReadError(
        'script_source_artifact_checksum_mismatch',
        '确认稿文件内容与产物校验和不一致，已停止生成。',
      );
    }
    const excerpt = confirmed.body.slice(0, MAX_SOURCE_TRANSCRIPT_CHARS);
    if (!excerpt) throw new Error('empty transcript');
    return excerpt;
  } catch (error: any) {
    if (String(error?.code || '').startsWith('script_')) throw error;
    throw sourceReadError(
      'script_source_artifact_unreadable',
      '确认稿文件为空或不可读取。',
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function isStrictlyReadableArtifact(artifact: any) {
  return artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true;
}

function normalizeSha256(value: unknown) {
  const checksum = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(checksum) ? checksum : '';
}

function parseConfirmedTranscriptDocument(value: unknown) {
  const markdown = String(value || '');
  if (!markdown.startsWith('---\n')) return null;
  const frontmatterEnd = markdown.indexOf('\n---\n', 4);
  if (frontmatterEnd < 0) return null;
  const frontmatter = markdown.slice(4, frontmatterEnd);
  if (!/^schemaVersion:\s*agent\.army\/confirmed-transcript\/v1\s*$/m.test(frontmatter)) return null;
  const checksumMatch = frontmatter.match(/^checksum:\s*([0-9a-f]{64})\s*$/im);
  if (!checksumMatch) return null;
  const documentBody = markdown.slice(frontmatterEnd + 5).replace(/^\n+/, '');
  const headingEnd = documentBody.indexOf('\n');
  if (headingEnd < 0 || !documentBody.slice(0, headingEnd).startsWith('# ')) return null;
  const body = documentBody.slice(headingEnd + 1).trim();
  if (!body) return null;
  return {
    body,
    embeddedChecksum:checksumMatch[1].toLowerCase(),
  };
}

function sourceContextFailure(code: string, userMessage: string) {
  return { sourceContext:null, error:{ code, userMessage } };
}

function sourceReadError(code: string, userMessage: string) {
  const error = new Error(userMessage) as Error & { code:string; userMessage:string };
  error.code = code;
  error.userMessage = userMessage;
  return error;
}

function pathInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function uniqueTextList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, limit)).filter(Boolean))];
}

function text(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
