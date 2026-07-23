import test from 'node:test';
import assert from 'node:assert/strict';
import { TechnicalRepairEvidenceRelay } from '../src/technical-repair-evidence-relay.js';

const task = { governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'agent-1' } };
const validDraft = { type:'artifact', provider:'technical-expert', title:'修复证据', status:'approved', metadata:{ agentArmyRepairEvidence:{ changedFiles:['src/fix.js'], testsPassed:true, testSummary:'1 项通过', recoveryVerified:true, recoverySummary:'恢复检查通过', remainingTests:[] } } };

test('技术专家不能联网时，A君只代为转交工作区内的完整修复证据', async () => {
  const calls = [];
  const governance = {
    async getPaperclipAgent() { return { adapterConfig:{ cwd:'/workspace/project/fixture' } }; },
    async createIssueWorkProduct(issueId, product) { calls.push(['product', issueId, product]); return { id:'product-1', ...product }; },
    async completeTechnicalRepairIssue(issueId, title) { calls.push(['complete', issueId, title]); }
  };
  const relay = new TechnicalRepairEvidenceRelay({ governance, projectRoot:'/workspace/project', fsImpl:{ async readFile() { return JSON.stringify(validDraft); } } });
  const result = await relay.relay(task);
  assert.equal(result.status, 'relayed');
  assert.equal(calls[0][2].metadata.agentArmyRepairEvidence.testsPassed, true);
  assert.deepEqual(calls[1], ['complete', 'issue-1', '修复证据']);
});

test('技术专家只留下修复事实时，A君 自动补齐治理台需要的外层信息', async () => {
  const calls = [];
  const governance = {
    async getPaperclipAgent() { return { adapterConfig:{ cwd:'/workspace/project/fixture' } }; },
    async createIssueWorkProduct(issueId, product) { calls.push(['product', issueId, product]); return { id:'product-1', ...product }; },
    async completeTechnicalRepairIssue(issueId, title) { calls.push(['complete', issueId, title]); }
  };
  const factOnly = { metadata: validDraft.metadata };
  const relay = new TechnicalRepairEvidenceRelay({ governance, projectRoot:'/workspace/project', fsImpl:{ async readFile() { return JSON.stringify(factOnly); } } });
  const result = await relay.relay({ ...task, input:{ title:'修复加法' } });
  assert.equal(result.status, 'relayed');
  assert.equal(calls[0][2].status, 'approved');
  assert.equal(calls[0][2].provider, 'A君技术专家');
  assert.match(calls[0][2].title, /修复加法/);
});

test('回执不完整或工作区越界时，A君不替专家登记成功', async () => {
  const governance = { async getPaperclipAgent() { return { adapterConfig:{ cwd:'/outside/project' } }; } };
  const relay = new TechnicalRepairEvidenceRelay({ governance, projectRoot:'/workspace/project', fsImpl:{ async readFile() { return JSON.stringify(validDraft); } } });
  assert.equal((await relay.relay(task)).status, 'unavailable');
});

test('技术专家在独立副本工作时，A君只读取该任务实际使用的副本', async () => {
  const calls = [];
  const governance = {
    async getPaperclipAgent() { return { adapterConfig:{ cwd:'/workspace/project' } }; },
    async getPaperclipIssueRuns() { return [{ environmentLease:{ executionWorkspaceId:'workspace-1' } }]; },
    async getExecutionWorkspace() { return { cwd:'/workspace/worktrees/repair-task-1' }; },
    async createIssueWorkProduct(issueId, product) { calls.push(['product', issueId, product]); return { id:'product-1', ...product }; },
    async completeTechnicalRepairIssue(issueId, title) { calls.push(['complete', issueId, title]); }
  };
  let sourcePath = null;
  const relay = new TechnicalRepairEvidenceRelay({ governance, projectRoot:'/workspace/project', allowedWorkspaceRoots:['/workspace/worktrees'], fsImpl:{ async readFile(file) { sourcePath = file; return JSON.stringify(validDraft); } } });
  const result = await relay.relay(task);
  assert.equal(result.status, 'relayed');
  assert.match(sourcePath, /\/workspace\/worktrees\/repair-task-1\/paperclip-work-product\.json$/);
});
