import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TechnicalRepairEvidenceRelay } from '../src/technical-repair-evidence-relay.ts';

const task = {
  governance:{
    paperclipIssueId:'issue-1',
    paperclipAssigneeAgentId:'agent-1',
  },
};
const validDraft = {
  type:'artifact',
  provider:'technical-expert',
  title:'修复证据',
  status:'approved',
  metadata:{
    agentArmyRepairEvidence:{
      changedFiles:['src/fix.js'],
      testsPassed:true,
      testSummary:'1 项通过',
      recoveryVerified:true,
      recoverySummary:'恢复检查通过',
      remainingTests:[],
    },
  },
};

async function fixture(t, draft = validDraft) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repair-relay-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const project = path.join(root, 'project');
  const worktrees = path.join(root, 'worktrees');
  const workspace = path.join(worktrees, 'repair-task-1');
  await fs.mkdir(project);
  await fs.mkdir(workspace, { recursive:true });
  await fs.writeFile(
    path.join(workspace, 'paperclip-work-product.json'),
    JSON.stringify(draft),
  );
  const calls = [];
  const governance = {
    async getPaperclipAgent() { return { adapterConfig:{ cwd:workspace } }; },
    async createIssueWorkProduct(issueId, product) {
      calls.push(['product', issueId, product]);
      return { id:'product-1', ...product };
    },
    async completeTechnicalRepairIssue(issueId, title) {
      calls.push(['complete', issueId, title]);
    },
  };
  return { root, project, worktrees, workspace, calls, governance };
}

test('技术专家不能联网时，A君只代为转交真实工作区内的完整修复证据', async (t) => {
  const item = await fixture(t);
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
  });
  const result = await relay.relay(task);
  assert.equal(result.status, 'relayed');
  assert.equal(item.calls[0][2].metadata.agentArmyRepairEvidence.testsPassed, true);
  assert.deepEqual(item.calls[1], ['complete', 'issue-1', '修复证据']);
});

test('技术专家只留下修复事实时，A君自动补齐治理台需要的外层信息', async (t) => {
  const item = await fixture(t, { metadata:validDraft.metadata });
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
  });
  const result = await relay.relay({ ...task, input:{ title:'修复加法' } });
  assert.equal(result.status, 'relayed');
  assert.equal(item.calls[0][2].status, 'approved');
  assert.equal(item.calls[0][2].provider, 'A君技术专家');
  assert.match(item.calls[0][2].title, /修复加法/);
});

test('回执不完整或工作区越界时，A君不替专家登记成功', async (t) => {
  const item = await fixture(t);
  const outside = path.join(item.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, 'paperclip-work-product.json'),
    JSON.stringify(validDraft),
  );
  item.governance.getPaperclipAgent = async () => ({ adapterConfig:{ cwd:outside } });
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
  });
  assert.equal((await relay.relay(task)).status, 'unavailable');
});

test('技术专家在独立副本工作时，A君只读取该任务实际使用的副本', async (t) => {
  const item = await fixture(t);
  item.governance.getPaperclipAgent = async () => ({ adapterConfig:{ cwd:item.project } });
  item.governance.getPaperclipIssueRuns = async () => [
    { environmentLease:{ executionWorkspaceId:'workspace-1' } },
  ];
  item.governance.getExecutionWorkspace = async () => ({ cwd:item.workspace });
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
  });
  const result = await relay.relay(task);
  assert.equal(result.status, 'relayed');
  assert.equal(result.sourcePath, path.join(item.workspace, 'paperclip-work-product.json'));
});

test('allowed root 内的 workspace symlink 不能读取或登记根外回执', async (t) => {
  const item = await fixture(t);
  const outside = path.join(item.root, 'outside');
  const linked = path.join(item.worktrees, 'linked-workspace');
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, 'paperclip-work-product.json'),
    JSON.stringify(validDraft),
  );
  await fs.symlink(outside, linked);
  item.governance.getPaperclipAgent = async () => ({ adapterConfig:{ cwd:linked } });
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
  });
  const result = await relay.relay(task);
  assert.equal(result.status, 'unavailable');
  assert.equal(item.calls.length, 0);
});

test('源码根身份复验失败时，A君不转交回执', async (t) => {
  const item = await fixture(t);
  const relay = new TechnicalRepairEvidenceRelay({
    governance:item.governance,
    projectRoot:item.project,
    allowedWorkspaceRoots:[item.worktrees],
    verifySourceRoot:async () => { throw new Error('changed'); },
  });
  const result = await relay.relay(task);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /源码根已变化/);
  assert.equal(item.calls.length, 0);
});
