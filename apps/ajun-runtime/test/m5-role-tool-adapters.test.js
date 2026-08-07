import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createM5RoleToolAdapters } from '../src/m5-role-tool-adapters.js';

test('任务读取适配器只返回当前信封明确引用或同父任务的条目', async () => {
  const tasks = [
    { taskId:'allowed-explicit', parentTaskId:null },
    { taskId:'allowed-sibling', parentTaskId:'mission-1' },
    { taskId:'current', parentTaskId:'mission-1' },
    { taskId:'other-project-task', parentTaskId:'mission-2' },
  ];
  const adapters = createM5RoleToolAdapters({
    store:{ async list() { return tasks; } },
  });
  const result = await adapters['ajun-task-store']({
    trustedScope:{ allowedTaskIds:['allowed-explicit', 'allowed-sibling'] },
    input:{ sourceTaskIds:['other-project-task'], parentTaskId:'mission-2' },
  });
  assert.deepEqual(result.map((item) => item.taskId), ['allowed-explicit', 'allowed-sibling']);
});

test('Markdown 写适配器把安全相对路径写进 execution workspace 并拒绝符号链接逃逸', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'm5-role-workspace-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'm5-role-outside-'));
  const adapters = createM5RoleToolAdapters();
  const written = await adapters['ajun-office-markdown']({
    access:{ relativePath:'work-products/report.md' },
    input:{ contents:'# 报告' },
    workspaceRoot:workspace,
  });
  assert.equal(await readFile(written.filePath, 'utf8'), '# 报告');

  await mkdir(path.join(workspace, 'escaped-parent'));
  await symlink(outside, path.join(workspace, 'escaped-parent', 'link'));
  await assert.rejects(
    adapters['ajun-office-markdown']({
      access:{ relativePath:'escaped-parent/link/report.md' },
      input:{ contents:'# 不应写出' },
      workspaceRoot:workspace,
    }),
    /符号链接/,
  );
  await assert.rejects(
    adapters['ajun-office-markdown']({
      access:{ relativePath:'escaped-parent/link/newdir/report.md' },
      input:{ contents:'# 不应先在外部创建目录' },
      workspaceRoot:workspace,
    }),
    /符号链接/,
  );
  await assert.rejects(
    () => access(path.join(outside, 'newdir')),
    { code:'ENOENT' },
  );
});

test('知识库适配器只接受独立声明的 Agent军团 逻辑目录scope', async () => {
  let writes = 0;
  const adapters = createM5RoleToolAdapters({
    knowledgeArchive:{
      async write() {
        writes += 1;
        return { bytes:1, readable:true, duplicate:false };
      },
    },
  });
  await assert.rejects(
    adapters['content-library']({
      access:{ scope:'paperclip-execution-workspace', relativePath:'knowledge/note.md' },
      input:{ taskId:'task-12345678', idempotencyKey:'key', markdown:'note' },
    }),
    /逻辑目录/,
  );
  assert.equal(writes, 0);
  await adapters['content-library']({
    access:{ scope:'agent-army-knowledge-archive', relativePath:'Agent军团' },
    input:{ taskId:'task-12345678', idempotencyKey:'key', markdown:'note' },
  });
  assert.equal(writes, 1);
});

test('只有真实可调用实现才注册动态网页、PDF和Office适配器', () => {
  const unavailable = createM5RoleToolAdapters({
    publicDynamicWebReader:{ read:true },
    publicPdfReader:{ read:true },
    officeDocuments:{ writeDocx:true, writeXlsx:true, writePdf:true },
    officePresentations:{ writePptd:true, exportPptx:true },
  });
  for (const name of [
    'hermes-public-browser',
    'hermes-pdf',
    'hermes-docx',
    'hermes-xlsx',
    'hermes-office-pdf',
    'open-kimi-pptd',
    'open-kimi-pptx',
  ]) {
    assert.equal(name in unavailable, false);
  }
  const available = createM5RoleToolAdapters({
    publicDynamicWebReader:{ async read() {} },
    publicPdfReader:{ async read() {} },
    officeDocuments:{
      async writeDocx() {},
      async writeXlsx() {},
      async writePdf() {},
    },
    officePresentations:{
      async writePptd() {},
      async exportPptx() {},
    },
  });
  for (const name of [
    'hermes-public-browser',
    'hermes-pdf',
    'hermes-docx',
    'hermes-xlsx',
    'hermes-office-pdf',
    'open-kimi-pptd',
    'open-kimi-pptx',
  ]) {
    assert.equal(typeof available[name], 'function');
  }
});

test('日报 Work Product 使用当前 Issue/Run、先写工作区并按幂等键复用', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'm5-office-report-'));
  const workProducts = [];
  const calls = [];
  const governance = {
    async getIssueWorkProducts(issueId) {
      assert.equal(issueId, 'issue-1');
      return workProducts;
    },
    async createIssueWorkProduct(issueId, product, options) {
      calls.push({ issueId, product, options });
      const created = { id:'wp-1', ...product };
      workProducts.push(created);
      return created;
    },
  };
  const adapters = createM5RoleToolAdapters({ governance });
  const context = {
    access:{
      toolId:'office.report.daily.write',
      relativePath:'work-products/task-1/daily-report.md',
    },
    input:{
      idempotencyKey:'paperclip:task-12345678',
      title:'日报',
      markdown:'# 日报\n\n今日完成。',
      sourceTaskIds:['task-a'],
    },
    workspaceRoot:workspace,
    trustedScope:{
      paperclipIssueId:'issue-1',
      paperclipRunId:'run-1',
      pipelineCaseId:'case-1',
      allowedTaskIds:['task-a'],
    },
  };
  const first = await adapters['paperclip-work-product'](context);
  const second = await adapters['paperclip-work-product'](context);
  assert.equal(first.workProductId, 'wp-1');
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.runId, 'run-1');
  assert.equal(calls[0].product.metadata.pipelineCaseId, 'case-1');
  assert.equal(await readFile(path.join(workspace, context.access.relativePath), 'utf8'), '# 日报\n\n今日完成。\n');

  await assert.rejects(
    () => adapters['paperclip-work-product']({
      ...context,
      input:{ ...context.input, idempotencyKey:'paperclip:task-87654321', sourceTaskIds:['task-outside'] },
    }),
    { code:'paperclip_scope_invalid' },
  );
});
