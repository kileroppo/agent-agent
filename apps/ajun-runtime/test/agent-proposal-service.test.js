import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentProposalService, ProposalValidationError } from '../src/agent-proposal-service.js';
import { TaskStore } from '../src/task-store.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new AgentProposalService({ store: new TaskStore(path.join(root, 'runtime.json')), registry: { async list() { return []; } } });
}

test('飞书事件重复投递只生成一条草案，草案默认不激活', async (t) => {
  const service = await setup(t);
  const input = { sourceEventRef: 'feishu:om_1', requestedOutcome: '整理公开资料并输出周报', candidateName: '公开资料报告员', requestedCapabilities: ['content.public.fetch'] };
  const [first, second] = await Promise.all([service.create(input, { source: 'feishu' }), service.create(input, { source: 'feishu' })]);
  assert.equal(first.proposalId, second.proposalId);
  assert.equal(first.status, 'draft');
  assert.equal(first.candidateManifest.status, 'draft');
  assert.deepEqual(first.requestedCapabilities, ['content.public.fetch']);
  assert.match(first.promptDraft, /不得读取凭据/);
});

test('没有负责人批准不能创建测试实例，批准后测试仍是隔离配置', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({ requestedOutcome: '输出公开素材报告', candidateName: '报告员' });
  await assert.rejects(() => service.createTestInstance(proposal.proposalId), ProposalValidationError);
  await service.submit(proposal.proposalId);
  await service.approveForTest(proposal.proposalId);
  const instance = await service.createTestInstance(proposal.proposalId, { hermesProfileName: 'publicreport' });
  assert.equal(instance.status, 'ready');
  assert.equal(instance.hermesProfile.isolated, true);
  assert.equal(instance.hermesProfile.productionCredentials, false);
  assert.equal(instance.hermesProfile.profileName, 'publicreport');
  assert.equal(instance.budgetPolicy.maxRuns, 1);
});

test('失败验收只能回到修订，成功验收必须带可验证产物才可激活', async (t) => {
  const service = await setup(t);
  const failed = await service.create({ requestedOutcome: '输出公开素材报告', candidateName: '失败报告员' });
  await service.submit(failed.proposalId); await service.approveForTest(failed.proposalId); await service.createTestInstance(failed.proposalId);
  const revised = await service.recordAcceptance(failed.proposalId, { artifactTitle: '失败报告', artifactRef: 'runtime://test/failed', passed: false });
  assert.equal(revised.status, 'needs_revision');
  const passed = await service.create({ requestedOutcome: '输出公开素材报告', candidateName: '通过报告员' });
  await service.submit(passed.proposalId); await service.approveForTest(passed.proposalId); await service.createTestInstance(passed.proposalId);
  await assert.rejects(() => service.recordAcceptance(passed.proposalId, { passed: true }), ProposalValidationError);
  const active = await service.recordAcceptance(passed.proposalId, { artifactTitle: '公开素材报告', artifactRef: 'runtime://test/report.json', passed: true });
  assert.equal(active.status, 'active');
});

test('第一批拒绝未审核的能力，阻止自动扩权', async (t) => {
  const service = await setup(t);
  await assert.rejects(() => service.create({ requestedOutcome: '自动发布内容', requestedCapabilities: ['content.private.publish'] }), /只能请求已审核/);
});

test('测试产物可以回报审计，但不会把候选岗位提前激活', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({ requestedOutcome: '输出公开资料报告' });
  await service.submit(proposal.proposalId); await service.approveForTest(proposal.proposalId); await service.createTestInstance(proposal.proposalId);
  const updated = await service.recordTestEvidence(proposal.proposalId, { artifactTitle: '受限报告', artifactRef: 'runtime://test/report.md' });
  assert.equal(updated.status, 'testing');
  assert.equal(updated.audit.at(-1).action, 'test_evidence_recorded');
});

test('有 Paperclip 投影时，必须先成功批准组织级审核才进入测试', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-governance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let approvals = 0;
  const governance = { async projectProposal() { return { status:'synced', paperclipApprovalId:'approval-1' }; }, async approveProposal() { approvals += 1; return { status:'synced', paperclipApprovalId:'approval-1', paperclipApprovalStatus:'approved' }; } };
  const service = new AgentProposalService({ store: new TaskStore(path.join(root, 'runtime.json')), registry: { async list() { return []; } }, governance });
  const proposal = await service.create({ requestedOutcome:'输出公开资料报告' });
  await service.submit(proposal.proposalId);
  const testing = await service.approveForTest(proposal.proposalId);
  assert.equal(approvals, 1); assert.equal(testing.status, 'testing');
});
