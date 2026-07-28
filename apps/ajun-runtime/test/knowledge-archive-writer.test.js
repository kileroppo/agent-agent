import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeArchiveWriter } from '../src/knowledge-archive-writer.js';
import { LocalOfficeAssistant } from '../src/local-office-assistant.js';

test('知识归档只写固定 Agent军团 目录并按幂等键返回原文件', async (t) => {
  const root = await sandbox(t);
  const writer = new KnowledgeArchiveWriter({ contentRoot:root, now:() => new Date('2026-07-27T10:00:00.000Z') });
  const first = await writer.write({
    taskId:'knowledge-task-0001',
    idempotencyKey:'knowledge:key:0001',
    title:'内容拆解总结',
    markdown:'# 总结\n\napi_key: secret-value\n'
  });
  assert.equal(path.dirname(first.filePath), path.join(root, 'Agent军团'));
  assert.match(await fs.readFile(first.filePath, 'utf8'), /api_key: \[REDACTED\]/);
  const second = await writer.write({
    taskId:'knowledge-task-0001',
    idempotencyKey:'knowledge:key:0001',
    title:'内容拆解总结',
    markdown:'# 被忽略的新正文'
  });
  assert.equal(second.filePath, first.filePath);
  assert.equal(second.duplicate, true);
});

test('小办把明确引用的任务归档为可验证知识笔记', async (t) => {
  const root = await sandbox(t);
  const source = {
    taskId:'source-task-knowledge',
    status:'succeeded',
    input:{ title:'公开视频拆解' },
    assigneeAgentId:'video-content-analyst',
    artifactRefs:[{
      artifactId:'analysis-1', type:'video_content_analysis_report', title:'正式拆解报告', location:'runtime://analysis',
      validation:{ exists:true, readable:true, nonEmpty:true }
    }]
  };
  const store = { list:async () => [source] };
  const assistant = new LocalOfficeAssistant({
    store,
    artifactsDir:path.join(root, 'office'),
    knowledgeArchive:new KnowledgeArchiveWriter({ contentRoot:root })
  });
  const result = await assistant.execute({
    taskId:'knowledge-task-0002',
    taskType:'office.knowledge-summary',
    idempotencyKey:'knowledge:key:0002',
    input:{ title:'本次视频方法归档', context:{ sourceTaskIds:[source.taskId] } }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'knowledge_summary_note');
  assert.equal(result.artifactRefs[0].validation.pathRestricted, true);
  await assert.doesNotReject(() => fs.access(result.artifactRefs[0].location.replace('file://', '')));
});

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-archive-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}
