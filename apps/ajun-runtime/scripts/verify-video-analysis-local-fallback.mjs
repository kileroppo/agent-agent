#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalVideoContentAnalyst } from '../src/local-content-growth.ts';

export const DEFAULT_SOURCE_TASK_ID = '10e4f814-8c03-4c51-ad5a-79b8328dd6e5';
export const DEFAULT_RUNTIME_DATABASE_PATH = fileURLToPath(new URL('../data/runtime.sqlite', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_ALLOWED_ARTIFACT_ROOTS = Object.freeze([
  path.join(PROJECT_ROOT, 'apps/ajun-runtime/data'),
  path.join(PROJECT_ROOT, 'apps/xiaod-media-transcriber/data'),
  path.join(PROJECT_ROOT, 'work'),
]);

const REQUIRED_LIVE_ARTIFACT_TYPES = Object.freeze([
  'confirmed_transcript',
  'visual_evidence_package',
]);

export function loadSourceTaskReadOnly({
  databasePath = DEFAULT_RUNTIME_DATABASE_PATH,
  taskId = DEFAULT_SOURCE_TASK_ID,
} = {}) {
  let database;
  try {
    database = new DatabaseSync(path.resolve(databasePath), { readOnly:true });
    const row = database.prepare('SELECT data_json FROM tasks WHERE task_id = ?').get(taskId);
    ensure(typeof row?.data_json === 'string', '只读运行库中没有找到目标任务。');
    const task = JSON.parse(row.data_json);
    ensure(task?.taskId === taskId, '只读运行库返回了非目标任务。');
    ensure(task?.status === 'succeeded', 'live 来源任务不是 succeeded。');
    ensure(task?.taskType === 'media.transcribe-and-refine', 'live 来源任务类型不符合预期。');
    assertRequiredSourceArtifacts(task);
    return task;
  } finally {
    database?.close();
  }
}

export function summarizeSourceTask(task) {
  ensure(task?.taskId === DEFAULT_SOURCE_TASK_ID || typeof task?.taskId === 'string', '来源任务标识无效。');
  ensure(task?.status === 'succeeded', 'live 来源任务不是 succeeded。');
  ensure(task?.taskType === 'media.transcribe-and-refine', 'live 来源任务类型不符合预期。');
  const artifactRefs = Array.isArray(task?.artifactRefs) ? task.artifactRefs : [];
  const verifiedTypes = REQUIRED_LIVE_ARTIFACT_TYPES.filter((type) => {
    const artifact = artifactRefs.find((item) => item?.type === type);
    return artifact?.validation?.exists === true
      && artifact.validation.readable === true
      && artifact.validation.nonEmpty === true;
  });
  ensure(verifiedTypes.length === REQUIRED_LIVE_ARTIFACT_TYPES.length, 'live 来源任务缺少已确认转录或可读视觉证据包。');
  return Object.freeze({
    taskId:task.taskId,
    status:task.status,
    taskType:task.taskType,
    verifiedArtifactTypes:verifiedTypes,
    databaseMode:'read_only',
  });
}

export async function replaySyntheticFallback() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-video-fallback-'));
  let summary;
  try {
    const transcriptPath = path.join(root, 'confirmed.md');
    const visualDir = path.join(root, 'visual');
    const storyboardDir = path.join(visualDir, 'storyboards');
    const storyboardPath = path.join(storyboardDir, 'board.jpg');
    const visualManifestPath = path.join(visualDir, 'visual-evidence.json');
    await fs.mkdir(storyboardDir, { recursive:true, mode:0o700 });
    await fs.writeFile(
      transcriptPath,
      '[00:00] 合成样例先给出可核验结论。\n[00:08] 随后说明方法、边界和唯一下一步。\n',
      { encoding:'utf8', mode:0o600 },
    );
    await fs.writeFile(storyboardPath, 'synthetic-storyboard', { encoding:'utf8', mode:0o600 });
    await fs.writeFile(visualManifestPath, JSON.stringify({
      schemaVersion:'agent.army/visual-evidence/v1',
      frames:[
        { frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' },
        { frameId:'frame-002', timestamp:'00:08', reason:'transcript_cue' },
      ],
      storyboards:[{
        storyboardId:'storyboard-001',
        localRef:'storyboards/board.jpg',
        frameRefs:['frame-001', 'frame-002'],
      }],
      coverage:{ firstFrameAt:'00:00', lastFrameAt:'00:08' },
    }), { encoding:'utf8', mode:0o600 });

    const sourceTask = {
      taskId:'synthetic-source-task',
      status:'succeeded',
      artifactRefs:[
        {
          artifactId:'synthetic-confirmed-transcript',
          taskId:'synthetic-source-task',
          type:'confirmed_transcript',
          location:pathToFileURL(transcriptPath).href,
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            confirmationMode:'automatic',
            automaticConfirmed:true,
          },
        },
        {
          artifactId:'synthetic-visual-evidence',
          taskId:'synthetic-source-task',
          type:'visual_evidence_package',
          location:pathToFileURL(visualManifestPath).href,
          validation:{ exists:true, readable:true, nonEmpty:true },
        },
      ],
    };
    const analyst = new LocalVideoContentAnalyst({
      store:{ list:async () => [sourceTask] },
      artifactsDir:path.join(root, 'reports'),
      allowedArtifactRoots:[root],
      advisor:null,
      visionExecution:null,
    });
    const result = await analyst.execute({
      taskId:'synthetic-video-analysis',
      taskType:'content.video-benchmark-analysis',
      assigneeAgentId:'video-content-analyst',
      input:{
        title:'合成视频拆解回放',
        analysisIntent:'deep',
        evidenceMode:'formal',
        depth:'full',
        visualMode:'auto',
        context:{ sourceTaskIds:[sourceTask.taskId] },
      },
    }, {
      allowAdvisor:false,
      providerVision:null,
    });
    ensure(result?.status === 'succeeded', '合成本地回放没有成功生成报告。');
    const report = result.artifactRefs?.find((item) => item?.type === 'video_content_analysis_report');
    ensure(report?.data?.generationMode === 'deterministic_fallback', '回放没有使用确定性纯文本兜底。');
    ensure(report?.data?.completeness === 'partial', '视觉不可用时报告完整性没有标记为 partial。');
    ensure(report?.data?.visualCoverage?.status === 'unavailable', '视觉不可用状态没有写入报告。');
    ensure(report?.validation?.visualMode === 'auto', '回放没有保持 visualMode=auto。');
    ensure(report?.validation?.advisorApplied === false, '关闭 advisor 后仍出现 advisor 调用结果。');
    ensure(report?.validation?.controlledVisionInvoked === false, '关闭视觉 provider 后仍出现视觉调用凭证。');
    ensure(report?.validation?.visualAnalysisApplied === false, '视觉不可用时不应声称已完成画面分析。');
    ensure(!result.usage?.model, '无 Provider 回放不应产生模型用量。');
    const markdown = await fs.readFile(new URL(report.location), 'utf8');
    ensure(markdown.length > 0, '合成报告为空。');
    ensure(markdown.includes('图片分析：未使用图片分析'), '合成报告没有如实标记未使用图片分析。');
    ensure(markdown.includes('本报告没有使用图片生成画面结论'), '合成报告没有明确说明未生成画面结论。');
    ensure(Array.isArray(report.data.modules) && report.data.modules.length > 0, '纯文本兜底报告缺少可验证分析模块。');
    summary = Object.freeze({
      taskType:'content.video-benchmark-analysis',
      visualMode:'auto',
      status:result.status,
      generationMode:report.data.generationMode,
      completeness:report.data.completeness,
      visualCoverage:report.data.visualCoverage.status,
      reportReadable:true,
      reportNonEmpty:true,
      reportModuleCount:report.data.modules.length,
      advisorApplied:false,
      providerCalls:0,
      modelUsageRecorded:false,
    });
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
  const tempDirectoryRemoved = await fs.stat(root).then(() => false, () => true);
  ensure(tempDirectoryRemoved, '临时回放目录清理失败。');
  return Object.freeze({ ...summary, tempDirectoryRemoved });
}

export async function replayActualSourceFallback(task, {
  allowedArtifactRoots = DEFAULT_ALLOWED_ARTIFACT_ROOTS,
} = {}) {
  assertRequiredSourceArtifacts(task);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-video-live-fallback-'));
  let summary;
  let sourceArtifactReads = 0;
  let temporaryFileWrites = 0;
  let temporaryArtifactReads = 0;
  try {
    const artifacts = task.artifactRefs;
    const transcriptArtifact = artifacts.find((item) => item?.type === 'confirmed_transcript');
    const visualArtifact = artifacts.find((item) => item?.type === 'visual_evidence_package');
    const transcriptSourcePath = await regularFileFromArtifact(transcriptArtifact, allowedArtifactRoots);
    const visualSourcePath = await regularFileFromArtifact(visualArtifact, allowedArtifactRoots);
    const transcript = await fs.readFile(transcriptSourcePath, 'utf8');
    sourceArtifactReads += 1;
    ensure(transcript.trim().length >= 20, '实际确认稿为空或过短，不能执行正式回放。');
    const visualPayload = JSON.parse(await fs.readFile(visualSourcePath, 'utf8'));
    sourceArtifactReads += 1;
    assertVisualEvidencePayload(visualPayload);

    const sourceDir = path.join(root, 'source');
    const transcriptPath = path.join(sourceDir, 'confirmed.md');
    const visualDir = path.join(sourceDir, 'visual');
    const visualManifestPath = path.join(visualDir, 'visual-evidence.json');
    await fs.mkdir(visualDir, { recursive:true, mode:0o700 });
    await fs.writeFile(transcriptPath, transcript, { encoding:'utf8', mode:0o600 });
    temporaryFileWrites += 1;
    for (const storyboard of visualPayload.storyboards) {
      const sourcePath = await controlledStoryboardPath(visualSourcePath, storyboard.localRef);
      const bytes = await fs.readFile(sourcePath);
      sourceArtifactReads += 1;
      const targetPath = controlledTemporaryPath(visualDir, storyboard.localRef);
      await fs.mkdir(path.dirname(targetPath), { recursive:true, mode:0o700 });
      await fs.writeFile(targetPath, bytes, { mode:0o600 });
      temporaryFileWrites += 1;
    }
    await fs.writeFile(visualManifestPath, JSON.stringify(visualPayload), { encoding:'utf8', mode:0o600 });
    temporaryFileWrites += 1;

    const replaySourceTask = {
      taskId:'read-only-live-source-copy',
      status:'succeeded',
      artifactRefs:[
        {
          artifactId:'read-only-confirmed-transcript-copy',
          taskId:'read-only-live-source-copy',
          type:'confirmed_transcript',
          location:pathToFileURL(transcriptPath).href,
          checksum:transcriptArtifact.checksum || null,
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            confirmationMode:transcriptArtifact.validation?.confirmationMode === 'automatic' ? 'automatic' : 'human',
            automaticConfirmed:transcriptArtifact.validation?.confirmationMode === 'automatic',
            humanConfirmed:transcriptArtifact.validation?.confirmationMode !== 'automatic',
          },
        },
        {
          artifactId:'read-only-visual-evidence-copy',
          taskId:'read-only-live-source-copy',
          type:'visual_evidence_package',
          location:pathToFileURL(visualManifestPath).href,
          validation:{ exists:true, readable:true, nonEmpty:true },
        },
      ],
    };
    const analyst = new LocalVideoContentAnalyst({
      store:{ list:async () => [replaySourceTask] },
      artifactsDir:path.join(root, 'reports'),
      allowedArtifactRoots:[root],
      advisor:null,
      visionExecution:null,
    });
    const result = await analyst.execute({
      taskId:'read-only-live-video-analysis-replay',
      taskType:'content.video-benchmark-analysis',
      assigneeAgentId:'video-content-analyst',
      input:{
        title:'实际产物脱敏回放',
        analysisIntent:'deep',
        evidenceMode:'formal',
        depth:'full',
        visualMode:'auto',
        context:{ sourceTaskIds:[replaySourceTask.taskId] },
      },
    }, {
      allowAdvisor:false,
      providerVision:null,
    });
    ensure(result?.status === 'succeeded', '实际数据本地回放没有成功生成报告。');
    const report = result.artifactRefs?.find((item) => item?.type === 'video_content_analysis_report');
    ensure(report?.data?.generationMode === 'deterministic_fallback', '实际回放没有使用确定性纯文本兜底。');
    ensure(report?.data?.completeness === 'partial', '实际回放没有标记视觉降级后的 partial 完整性。');
    ensure(report?.data?.visualCoverage?.status === 'unavailable', '实际回放没有记录视觉能力不可用。');
    ensure(report?.validation?.advisorApplied === false, '实际回放关闭 advisor 后仍出现 advisor 结果。');
    ensure(report?.validation?.controlledVisionInvoked === false, '实际回放关闭 Provider 后仍出现视觉执行凭证。');
    ensure(report?.validation?.visualAnalysisApplied === false, '实际回放不应声称完成画面分析。');
    ensure(!result.usage?.model, '实际无 Provider 回放不应产生模型用量。');
    const markdown = await fs.readFile(new URL(report.location), 'utf8');
    temporaryArtifactReads += 1;
    temporaryFileWrites += 1;
    ensure(markdown.length > 0, '实际回放报告为空。');
    ensure(markdown.includes('图片分析：未使用图片分析'), '实际回放报告没有如实标记未使用图片分析。');
    ensure(markdown.includes('本报告没有使用图片生成画面结论'), '实际回放报告没有明确说明未生成画面结论。');
    ensure(Array.isArray(report.data.modules) && report.data.modules.length === 13, '实际回放报告没有形成完整的纯文本拆解模块。');
    summary = Object.freeze({
      taskType:'content.video-benchmark-analysis',
      visualMode:'auto',
      status:result.status,
      generationMode:report.data.generationMode,
      completeness:report.data.completeness,
      visualCoverage:report.data.visualCoverage.status,
      reportReadable:true,
      reportNonEmpty:true,
      reportModuleCount:report.data.modules.length,
      confirmedTranscriptLoaded:true,
      visualFrameCount:visualPayload.frames.length,
      visualStoryboardCount:visualPayload.storyboards.length,
      advisorApplied:false,
      modelUsageRecorded:false,
      io:Object.freeze({
        sourceArtifactReads,
        temporaryArtifactReads,
        temporaryFileWrites,
        liveTaskStoreWrites:0,
        providerCalls:0,
        paidCalls:0,
      }),
    });
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
  const tempDirectoryRemoved = await fs.stat(root).then(() => false, () => true);
  ensure(tempDirectoryRemoved, '实际回放临时目录清理失败。');
  return Object.freeze({ ...summary, tempDirectoryRemoved });
}

export async function verifyVideoAnalysisLocalFallback(options = {}) {
  const sourceTask = loadSourceTaskReadOnly(options);
  const sourceEvidence = summarizeSourceTask(sourceTask);
  const replay = await replayActualSourceFallback(sourceTask, options);
  return Object.freeze({
    schemaVersion:'agent.army/video-analysis-local-fallback-verification/v1',
    sourceEvidence,
    replay,
    safety:Object.freeze({
      databaseReadQueries:1,
      databaseWrites:0,
      liveTaskStoreWrites:0,
      providerCalls:0,
      paidCalls:0,
      externalSideEffects:0,
      privateContentPrinted:false,
      absoluteArtifactPathPrinted:false,
    }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) throw new Error('本地降级验证不接收外部目标、凭据或写入参数。');
  return verifyVideoAnalysisLocalFallback();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRequiredSourceArtifacts(task) {
  const artifacts = Array.isArray(task?.artifactRefs) ? task.artifactRefs : [];
  for (const type of REQUIRED_LIVE_ARTIFACT_TYPES) {
    const artifact = artifacts.find((item) => item?.type === type);
    ensure(
      artifact?.validation?.exists === true
        && artifact.validation.readable === true
        && artifact.validation.nonEmpty === true,
      `来源任务缺少已验证的 ${type}。`,
    );
    ensure(String(artifact.location || '').startsWith('file://'), `${type} 不是受控本机文件引用。`);
  }
}

async function regularFileFromArtifact(artifact, allowedArtifactRoots) {
  const filePath = path.resolve(fileURLToPath(String(artifact.location)));
  const realPath = await fs.realpath(filePath);
  const realRoots = await Promise.all((allowedArtifactRoots || []).map((root) => fs.realpath(path.resolve(root))));
  ensure(realRoots.some((root) => realPath.startsWith(`${root}${path.sep}`)), '来源产物超出允许的本机数据目录。');
  const stat = await fs.stat(realPath);
  ensure(stat.isFile(), '来源产物引用不是普通文件。');
  return realPath;
}

function assertVisualEvidencePayload(payload) {
  ensure(payload?.schemaVersion === 'agent.army/visual-evidence/v1', '实际视觉证据包版本无效。');
  ensure(Array.isArray(payload.frames) && payload.frames.length > 0, '实际视觉证据包缺少关键帧。');
  ensure(Array.isArray(payload.storyboards) && payload.storyboards.length > 0, '实际视觉证据包缺少故事板。');
  payload.storyboards.forEach((item) => controlledRelativePath(item?.localRef));
}

async function controlledStoryboardPath(manifestPath, localRef) {
  const relativePath = controlledRelativePath(localRef);
  const baseDir = await fs.realpath(path.dirname(manifestPath));
  const candidate = await fs.realpath(path.resolve(baseDir, relativePath));
  ensure(candidate.startsWith(`${baseDir}${path.sep}`), '故事板引用超出实际视觉证据目录。');
  const stat = await fs.stat(candidate);
  ensure(stat.isFile(), '故事板引用不是普通文件。');
  return candidate;
}

function controlledTemporaryPath(baseDir, localRef) {
  const candidate = path.resolve(baseDir, controlledRelativePath(localRef));
  ensure(candidate.startsWith(`${path.resolve(baseDir)}${path.sep}`), '故事板临时目标超出隔离目录。');
  return candidate;
}

function controlledRelativePath(value) {
  const relativePath = String(value || '').trim().replaceAll('\\', '/');
  ensure(
    relativePath
      && !path.posix.isAbsolute(relativePath)
      && relativePath.split('/').every((part) => part && part !== '.' && part !== '..'),
    '故事板相对路径无效。',
  );
  return relativePath;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || '本地视频分析降级验证失败。')}\n`);
    process.exitCode = 1;
  }
}
