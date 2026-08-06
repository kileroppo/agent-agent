import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TaskStore } from '../src/task-store.js';

const root = path.resolve(new URL('../../..', import.meta.url).pathname);
const dataDir = path.join(root, 'apps/ajun-runtime/data');
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const evidenceDir = path.join(dataDir, 'm3-acceptance-evidence', `paperclip-${runId}`);
const transcriptPath = path.join(evidenceDir, 'confirmed-acceptance-transcript.md');
const baseUrl = 'http://127.0.0.1:4321';
const store = new TaskStore(path.join(dataDir, 'runtime.json'));

await fs.mkdir(evidenceDir, { recursive:true, mode:0o700 });
const transcript = [
  '---',
  'schemaVersion: agent.army/restricted-acceptance-transcript/v1',
  'humanConfirmed: true',
  'realVideoReview: false',
  'purpose: paperclip-heartbeat-technical-acceptance-only',
  '---',
  '',
  '# Paperclip heartbeat 受限技术验收稿',
  '',
  '[00:00] 原始素材、机器转录和人工确认稿必须分开保存。',
  '[00:10] 正式拆解中的每个判断都要引用时间点或来源片段。',
  '[00:20] 内容创作只能读取确认稿和正式拆解，并且只生成待审草稿。',
  '[00:30] 发布继续由真人决定，真实指标回来后再做版本关联复盘。',
  '[00:40] 结论、决定、待办和来源最终写入统一知识库。',
  ''
].join('\n');
await fs.writeFile(transcriptPath, transcript, { encoding:'utf8', mode:0o600 });

const sourceTask = await store.createTask({
  taskType:'media.transcribe-and-refine',
  idempotencyKey:`m3-paperclip-heartbeat-source:${runId}`,
  requester:{ kind:'local-owner', ref:'A君' },
  source:{ channel:'restricted-technical-acceptance', realVideoReview:false },
  assigneeAgentId:'xiaod',
  input:{ title:'Paperclip heartbeat 受限确认稿', reviewPolicy:'required' },
  status:'succeeded',
  currentStage:'restricted_acceptance_source_ready',
  routing:{ requestedAgentId:'xiaod', candidateAgentIds:['xiaod'], reason:'只用于 Paperclip heartbeat 技术验收，不代表真实视频听审。' },
  artifactRefs:[{
    artifactId:`confirmed-transcript:paperclip-heartbeat:${runId}`,
    type:'confirmed_transcript',
    title:'Paperclip heartbeat 受限确认稿（非真实视频听审）',
    location:pathToFileURL(transcriptPath).href,
    mimeType:'text/markdown',
    checksum:sha256(transcript),
    accessScope:'local-owner',
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      humanConfirmed:true,
      restrictedAcceptanceOnly:true,
      realVideoReview:false
    },
    createdAt:new Date().toISOString()
  }]
});

const analysis = await post('/api/tasks', {
  title:'M3 Paperclip heartbeat 小拆验收',
  description:'使用受限确认稿验证真实 Paperclip heartbeat、Hermes Profile 和 A君证据化拆解桥；不代表真实视频听审。',
  taskType:'content.video-benchmark-analysis',
  agentId:'video-content-analyst',
  requesterName:'A君',
  idempotencyKey:`m3-paperclip-heartbeat-analysis:${runId}`,
  depth:'full',
  evidenceMode:'formal',
  focus:'证据边界、人工门禁和发布边界',
  context:{ sourceTaskIds:[sourceTask.taskId], restrictedTechnicalAcceptance:true }
});
const completedAnalysis = await waitForTask(analysis.task.taskId, 12 * 60_000);
assert.equal(completedAnalysis.status, 'succeeded');
const analysisArtifact = completedAnalysis.artifactRefs.find((item) => item.type === 'video_content_analysis_report');
assert.ok(analysisArtifact);
assert.equal(analysisArtifact.validation.advisorApplied, true);
assert.equal(completedAnalysis.usage?.model?.status, 'reported');
assert.equal(completedAnalysis.usage?.model?.apiCalls, 1);

const draft = await post('/api/tasks', {
  title:'M3 Paperclip heartbeat 小创验收',
  description:'依据受限确认稿和正式拆解生成两个平台待审草稿，不发布。',
  taskType:'content.platform-draft',
  agentId:'content-creator',
  requesterName:'A君',
  idempotencyKey:`m3-paperclip-heartbeat-draft:${runId}`,
  platforms:['douyin', 'xiaohongshu'],
  contentGoal:'说明证据化内容生产为什么必须保留人工门禁。',
  context:{ sourceTaskIds:[sourceTask.taskId, completedAnalysis.taskId], restrictedTechnicalAcceptance:true }
});
const completedDraft = await waitForTask(draft.task.taskId, 5 * 60_000);
assert.equal(completedDraft.status, 'succeeded');
const draftArtifact = completedDraft.artifactRefs.find((item) => item.type === 'platform_content_draft');
assert.ok(draftArtifact);
assert.equal(draftArtifact.validation.advisorApplied, true);
assert.equal(draftArtifact.validation.externalSideEffects, 0);
assert.equal(completedDraft.usage?.model?.status, 'reported');
assert.equal(completedDraft.usage?.model?.apiCalls, 1);

await preserveArtifact(analysisArtifact, 'video_content_analysis_report.md');
await preserveArtifact(draftArtifact, 'platform_content_draft.md');

process.stdout.write(`${JSON.stringify({
  status:'passed',
  evidenceScope:'paperclip-hermes-controlled-heartbeat',
  doesNotProve:['真实视频完整听审', '飞书原会话交付', '人工内容质量'],
  sourceTaskId:sourceTask.taskId,
  analysis:{
    taskId:completedAnalysis.taskId,
    paperclipIssue:completedAnalysis.governance?.paperclipIssueIdentifier || null,
    artifactChecksum:analysisArtifact.checksum,
    advisorApplied:analysisArtifact.validation.advisorApplied,
    usage:completedAnalysis.usage
  },
  draft:{
    taskId:completedDraft.taskId,
    paperclipIssue:completedDraft.governance?.paperclipIssueIdentifier || null,
    artifactChecksum:draftArtifact.checksum,
    externalSideEffects:draftArtifact.validation.externalSideEffects,
    advisorApplied:draftArtifact.validation.advisorApplied,
    usage:completedDraft.usage
  },
  evidenceDir
}, null, 2)}\n`);

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(10_000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

async function waitForTask(taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStage = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/overview`, { signal:AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`A君概览读取失败：HTTP ${response.status}`);
    const task = (await response.json()).tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error(`找不到验收任务：${taskId}`);
    if (task.currentStage !== lastStage) {
      process.stderr.write(`[${task.taskId}] ${task.status} / ${task.currentStage}\n`);
      lastStage = task.currentStage;
    }
    if (['succeeded', 'failed', 'waiting_test', 'needs_input', 'cancelled'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`验收任务超时：${taskId}`);
}

async function preserveArtifact(artifact, targetName) {
  const sourcePath = fileURLToPath(artifact.location);
  const allowedRoot = path.join(dataDir, 'content-growth-artifacts');
  if (!sourcePath.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('内容产物不在受控目录。');
  const targetPath = path.join(evidenceDir, targetName);
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, 0o600);
  assert.equal(sha256(await fs.readFile(targetPath)), artifact.checksum);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
