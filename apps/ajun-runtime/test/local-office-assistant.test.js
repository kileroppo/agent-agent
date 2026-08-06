import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalOfficeAssistant, formatOfficeBriefingReply } from '../src/local-office-assistant.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

test('办公执行助理把已完成与未完成员工任务整理成真实 Markdown 汇报包', async (t) => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-assistant-'));
  t.after(() => fs.rm(artifactsDir, { recursive:true, force:true }));
  const tasks = [
    {
      taskId:'research-1', parentTaskId:'mission-1', assigneeAgentId:'intel-researcher', status:'succeeded', currentStage:'intel_research_ready',
      createdAt:'2026-07-26T11:00:00.000Z', input:{ title:'调查公开资料' },
      artifactRefs:[{ type:'intel_research_report', title:'公开资料研究报告', location:'runtime://research-1/report', validation:{ exists:true, nonEmpty:true } }]
    },
    {
      taskId:'media-1', parentTaskId:'mission-1', assigneeAgentId:'xiaod', status:'needs_input', currentStage:'source_required',
      createdAt:'2026-07-26T11:01:00.000Z', input:{ title:'整理视频' }, error:{ userMessage:'还缺少公开视频链接。' }, artifactRefs:[]
    }
  ];
  const worker = new LocalOfficeAssistant({ now, artifactsDir, store:{ async list(){ return tasks; } } });
  const result = await worker.execute({
    taskId:'office-1', parentTaskId:'mission-1', assigneeAgentId:'office-assistant',
    input:{ title:'整理本次三员工工作结果', description:'给老板一份完成情况、产物和未决事项汇报。' }
  });

  assert.equal(result.status, 'succeeded');
  const artifact = result.artifactRefs[0];
  assert.equal(artifact.type, 'office_briefing_package');
  assert.equal(artifact.validation.sourceTaskCount, 2);
  assert.equal(artifact.validation.nonEmpty, true);
  const filePath = new URL(artifact.location);
  const markdown = await fs.readFile(filePath, 'utf8');
  assert.match(markdown, /调查公开资料/);
  assert.match(markdown, /还缺少公开视频链接/);
  assert.match(markdown, /## 未决事项/);
  assert.match(markdown, /## 下一步/);
  assert.match(formatOfficeBriefingReply(artifact.data), /已核对 2 项关联工作/);
});

test('办公执行助理没有足够材料时明确等待输入，不生成空报告', async () => {
  const worker = new LocalOfficeAssistant({ now, artifactsDir:'/tmp/unused-office-artifacts', store:{ async list(){ return []; } } });
  const result = await worker.execute({ taskId:'office-empty', input:{ title:'整理' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'office_material_required');
  assert.match(result.error.userMessage, /不会用空内容生成假汇报/);
});

test('办公执行助理不会把未验证产物列入产物索引', async (t) => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-assistant-'));
  t.after(() => fs.rm(artifactsDir, { recursive:true, force:true }));
  const tasks = [{
    taskId:'source-1', assigneeAgentId:'intel-researcher', status:'succeeded', input:{ title:'一项研究' },
    artifactRefs:[{ type:'intel_research_report', title:'未验证报告', location:'runtime://source-1/report', validation:{ exists:false, nonEmpty:true } }]
  }];
  const worker = new LocalOfficeAssistant({ now, artifactsDir, store:{ async list(){ return tasks; } } });
  const result = await worker.execute({ taskId:'office-safe', input:{ title:'整理真实任务结果', context:{ sourceTaskIds:['source-1'] } } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].data.sourceTasks[0].artifacts.length, 0);
  assert.match(result.artifactRefs[0].data.markdown, /当前没有经过验证的关联产物/);
});

test('知识归档会写入草稿核心结论和人工发布待办，不只罗列产物名', async () => {
  let captured = null;
  const tasks = [{
    taskId:'draft-1',
    assigneeAgentId:'content-creator',
    status:'succeeded',
    input:{ title:'生成真实草稿' },
    artifactRefs:[{
      type:'platform_content_draft',
      title:'抖音待审草稿',
      location:'file:///tmp/draft.md',
      validation:{ exists:true, nonEmpty:true },
      data:{
        platforms:['douyin'],
        publishingStatus:'draft_only',
        drafts:[{ titleCandidates:['先核对事实，再表达情绪'] }]
      }
    }]
  }];
  const worker = new LocalOfficeAssistant({
    now,
    artifactsDir:'/tmp/unused-office-artifacts',
    store:{ async list() { return tasks; } },
    knowledgeArchive:{
      async write(input) {
        captured = input;
        return { filePath:'/tmp/knowledge.md', checksum:'abc', readable:true, bytes:input.markdown.length, duplicate:false };
      }
    }
  });
  const result = await worker.execute({
    taskId:'archive-1',
    idempotencyKey:'archive-key-1',
    taskType:'office.knowledge-summary',
    input:{ title:'归档草稿闭环', context:{ sourceTaskIds:['draft-1'] } }
  });
  assert.equal(result.status, 'succeeded');
  assert.match(captured.markdown, /已生成 douyin 待审草稿/);
  assert.match(captured.markdown, /先核对事实，再表达情绪/);
  assert.match(captured.markdown, /人工审阅平台草稿/);
  assert.match(captured.markdown, /再单独决定是否发布/);
});

test('小办交付计划通过岗位上下文生成 DOCX/XLSX/PDF，不旁路本机目录', async () => {
  const calls = [];
  const roleToolContext = {
    async execute(input) {
      calls.push(input);
      if (input.toolId === 'army.task.read') return [];
      if (input.toolId === 'office.artifact.write') {
        return { filePath:'/trusted/workspace/work-products/briefing.md', bytes:120 };
      }
      return {
        relativePath:input.relativePath,
        mimeType:{
          'office.docx.write':'application/docx',
          'office.xlsx.write':'application/xlsx',
          'office.pdf.write':'application/pdf',
        }[input.toolId],
        bytes:240,
        checksum:'b'.repeat(64),
        validation:{ exists:true, readable:true, nonEmpty:true, workspaceRestricted:true },
      };
    },
  };
  const worker = new LocalOfficeAssistant({ now, store:{ async list() { return []; } } });
  const result = await worker.execute({
    taskId:'office-program-1',
    taskType:'office.deliverable-program',
    input:{
      title:'生成完整办公交付计划',
      description:'根据当前材料生成可审阅的三种办公格式。',
    },
  }, { roleToolContext });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map((call) => call.toolId), [
    'army.task.read',
    'office.artifact.write',
    'office.docx.write',
    'office.xlsx.write',
    'office.pdf.write',
  ]);
  assert.deepEqual(result.artifactRefs.slice(1).map((artifact) => artifact.type), [
    'office_docx_document',
    'office_xlsx_document',
    'office_pdf_document',
  ]);
});

test('小办日报只把受控写回返回的 Paperclip Work Product 登记为成功产物', async () => {
  const calls = [];
  const roleToolContext = {
    async execute(input) {
      calls.push(input);
      if (input.toolId === 'army.task.read') return [];
      if (input.toolId === 'office.artifact.write') {
        return { filePath:'/trusted/workspace/daily.md', bytes:120 };
      }
      if (input.toolId === 'office.report.daily.write') {
        return {
          workProductId:'wp-daily-1',
          contentHash:'c'.repeat(64),
          relativePath:input.relativePath,
          duplicate:false,
        };
      }
      throw new Error(`unexpected ${input.toolId}`);
    },
  };
  const worker = new LocalOfficeAssistant({ now, store:{ async list() { return []; } } });
  const result = await worker.execute({
    taskId:'office-daily-1',
    idempotencyKey:'paperclip:office-daily-1',
    taskType:'content.campaign-metrics',
    input:{
      title:'整理今日活动指标',
      description:'整理当前活动今天已经验证的指标和待办。',
    },
  }, { roleToolContext });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map((call) => call.toolId), [
    'army.task.read',
    'office.artifact.write',
    'office.report.daily.write',
  ]);
  const product = result.artifactRefs.find((artifact) => artifact.type === 'office_daily_report_work_product');
  assert.equal(product.data.workProductId, 'wp-daily-1');
  assert.equal(product.validation.paperclipWorkProduct, true);
});
