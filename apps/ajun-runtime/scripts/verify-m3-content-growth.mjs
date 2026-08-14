import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalContentCreator, LocalVideoContentAnalyst } from '../src/local-content-growth.ts';
import { HermesContentGrowthAdvisor } from '../src/hermes-content-growth-advisor.ts';
import { KnowledgeArchiveWriter } from '../src/knowledge-archive-writer.ts';
import { LocalOfficeAssistant } from '../src/local-office-assistant.ts';

const writeRealVault = process.argv.includes('--write-real-vault');
const withHermes = process.argv.includes('--with-hermes');
const root = path.resolve(new URL('../../..', import.meta.url).pathname);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-m3-acceptance-'));
const artifactsDir = path.join(workspace, 'artifacts');
const transcriptPath = path.join(workspace, 'confirmed-transcript-v2.md');
const now = () => new Date('2026-07-27T10:30:00.000+08:00');

const transcript = [
  '---',
  'schemaVersion: agent.army/confirmed-transcript/v1',
  'humanConfirmed: true',
  'reviewNote: 本机纵向验收样本，不代表真实视频已经完成真人听审。',
  '---',
  '',
  '# Agent军团 M3 本机验收确认稿',
  '',
  '[00:00] 先把原始素材、机器转录、人工确认稿分开，后续判断才有证据边界。',
  '[00:12] 视频拆解必须引用时间点或来源片段，不能凭印象声称结论。',
  '[00:25] 内容创作只读取确认稿和正式拆解，并且只生成待审草稿。',
  '[00:39] 发布继续由真人决定，真实指标回来后再做版本关联复盘。',
  '[00:52] 最终由办公助理把结论、决定、待办和来源写入统一知识库。',
  ''
].join('\n');
await fs.writeFile(transcriptPath, transcript, { encoding:'utf8', mode:0o600 });

const transcriptArtifact = {
  artifactId:'confirmed-transcript:m3-local-acceptance:v2',
  taskId:'m3-source-0002',
  type:'confirmed_transcript',
  title:'M3 本机验收确认稿',
  location:pathToFileURL(transcriptPath).href,
  mimeType:'text/markdown',
  checksum:sha256(transcript),
  accessScope:'local-owner',
  validation:{ exists:true, readable:true, nonEmpty:true, humanConfirmed:true },
  createdAt:now().toISOString()
};

const tasks = [{
  taskId:'m3-source-0002',
  taskType:'media.transcribe-and-refine',
  assigneeAgentId:'xiaod',
  status:'succeeded',
  input:{ title:'M3 本机验收素材' },
  artifactRefs:[transcriptArtifact],
  createdAt:now().toISOString()
}];
const store = { async list() { return tasks; } };

const analysisTask = {
  taskId:'m3-analysis-0002',
  idempotencyKey:'m3-local-analysis-v2',
  taskType:'content.video-benchmark-analysis',
  assigneeAgentId:'video-content-analyst',
  status:'running',
  input:{
    title:'Agent军团内容增长证据链',
    depth:'full',
    evidenceMode:'formal',
    focus:'证据、人工门禁和发布边界',
    context:{ sourceTaskIds:['m3-source-0002'] }
  }
};
const analyst = new LocalVideoContentAnalyst({
  store,
  artifactsDir,
  allowedArtifactRoots:[workspace],
  advisor:withHermes ? new HermesContentGrowthAdvisor({
    hermesHome:path.join(os.homedir(), '.hermes/profiles/video-content-analyst'),
    timeoutMs:720_000
  }) : null,
  now
});
const analysisResult = await analyst.execute(analysisTask);
assert.equal(analysisResult.status, 'succeeded');
assert.equal(analysisResult.artifactRefs[0].validation.moduleCount, 13);
assert.equal(analysisResult.artifactRefs[0].validation.formalSourceConfirmed, true);
if (withHermes) {
  assert.equal(analysisResult.artifactRefs[0].validation.advisorApplied, true);
  assert.equal(analysisResult.usage.model.provider, 'openai-codex');
  assert.equal(analysisResult.usage.model.apiCalls, 1);
}
tasks.push({ ...analysisTask, status:'succeeded', artifactRefs:analysisResult.artifactRefs, createdAt:now().toISOString() });

const draftTask = {
  taskId:'m3-draft-0002',
  idempotencyKey:'m3-local-draft-v2',
  taskType:'content.platform-draft',
  assigneeAgentId:'content-creator',
  status:'running',
  input:{
    title:'Agent军团内容增长证据链',
    contentGoal:'说明可信内容生产为什么必须经过证据和人工门禁。',
    platforms:['douyin', 'xiaohongshu'],
    context:{ sourceTaskIds:['m3-source-0002', 'm3-analysis-0002'] }
  }
};
const creator = new LocalContentCreator({
  store,
  artifactsDir,
  allowedArtifactRoots:[workspace],
  advisor:withHermes ? new HermesContentGrowthAdvisor({
    hermesHome:path.join(os.homedir(), '.hermes/profiles/content-creator'),
    timeoutMs:300_000
  }) : null,
  now
});
const draftResult = await creator.execute(draftTask);
assert.equal(draftResult.status, 'succeeded');
assert.equal(draftResult.artifactRefs[0].validation.platformCount, 2);
assert.equal(draftResult.artifactRefs[0].validation.externalSideEffects, 0);
if (withHermes) {
  assert.equal(draftResult.artifactRefs[0].validation.advisorApplied, true);
  assert.equal(draftResult.usage.model.provider, 'openai-codex');
  assert.equal(draftResult.usage.model.apiCalls, 1);
}
tasks.push({ ...draftTask, status:'succeeded', artifactRefs:draftResult.artifactRefs, createdAt:now().toISOString() });

const archiveRoot = writeRealVault ? null : path.join(workspace, 'content-library');
const writer = new KnowledgeArchiveWriter({
  autoWorkRoot:path.resolve(root, '../auto-work'),
  contentRoot:archiveRoot,
  now
});
const office = new LocalOfficeAssistant({ store, artifactsDir, knowledgeArchive:writer, now });
const archiveTask = {
  taskId:'m3-archive-0002',
  idempotencyKey:'m3-local-archive-v2',
  taskType:'office.knowledge-summary',
  assigneeAgentId:'office-assistant',
  status:'running',
  input:{
    title:'Agent军团 M3 内容增长本机纵向验收 v2',
    description:'本笔记只证明本机受控产物链和真实知识库写入，不代表飞书、Hermes、Paperclip 或真人听审已经验收。',
    context:{ sourceTaskIds:['m3-analysis-0002', 'm3-draft-0002'] }
  }
};
const archiveResult = await office.execute(archiveTask);
assert.equal(archiveResult.status, 'succeeded');
assert.equal(archiveResult.artifactRefs[0].validation.readable, true);
assert.equal(archiveResult.artifactRefs[0].validation.pathRestricted, true);

const report = {
  status:'passed',
  evidenceScope:'local-controlled-vertical-slice',
  hermesAdvisorEnabled:withHermes,
  doesNotProve:withHermes
    ? ['真实视频完整听审', 'Paperclip 真实 heartbeat 指派', '飞书原会话交付', '人工内容质量']
    : ['真实视频完整听审', 'Hermes 模型执行', 'Paperclip 真实 heartbeat 指派', '飞书原会话交付', '人工内容质量'],
  analysis:{
    artifactId:analysisResult.artifactRefs[0].artifactId,
    moduleCount:analysisResult.artifactRefs[0].validation.moduleCount,
    checksum:analysisResult.artifactRefs[0].checksum,
    advisorApplied:analysisResult.artifactRefs[0].validation.advisorApplied,
    model:analysisResult.usage.model || null
  },
  draft:{
    artifactId:draftResult.artifactRefs[0].artifactId,
    platformCount:draftResult.artifactRefs[0].validation.platformCount,
    externalSideEffects:draftResult.artifactRefs[0].validation.externalSideEffects,
    checksum:draftResult.artifactRefs[0].checksum,
    advisorApplied:draftResult.artifactRefs[0].validation.advisorApplied,
    model:draftResult.usage.model || null
  },
  knowledgeNote:{
    location:archiveResult.artifactRefs[0].location,
    checksum:archiveResult.artifactRefs[0].checksum,
    readable:archiveResult.artifactRefs[0].validation.readable,
    duplicate:archiveResult.artifactRefs[0].validation.duplicate
  },
  temporaryArtifactsRoot:workspace
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
