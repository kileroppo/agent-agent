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

test('公开网页岗位会自动收紧为只读公开网页能力，方便后续真实试用', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({ requestedOutcome:'只读取公开网页，输出中文摘要报告', candidateName:'公开网页摘要员' });
  assert.deepEqual(proposal.requestedCapabilities, ['content.public.fetch']);
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
  const accepted = await service.recordAcceptance(passed.proposalId, { artifactTitle: '公开素材报告', artifactRef: 'runtime://test/report.json', passed: true });
  assert.equal(accepted.status, 'testing');
  assert.equal(accepted.acceptance.status, 'passed');
  const active = await service.activate(passed.proposalId);
  assert.equal(active.status, 'active');
});

test('新岗位试用通过后会立刻登记到 Paperclip，不需要重启 A君', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-roster-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roster = [{ agentId: '即时登记报告员', name: '即时登记报告员', status: 'active' }];
  const syncCalls = [];
  const governance = {
    async projectProposal() { return { status: 'synced', paperclipIssueId: 'issue-1', paperclipApprovalId: 'approval-1' }; },
    async approveProposal() { return { status: 'synced', paperclipIssueId: 'issue-1', paperclipApprovalId: 'approval-1', paperclipApprovalStatus: 'approved' }; },
    async updateProposal(proposal) { return { status: 'synced', paperclipIssueId: 'issue-1', proposalStatus: proposal.status }; },
    async syncRoster(manifests) { syncCalls.push(manifests); return { status: 'synced', agents: [{ agentArmyId: '即时登记报告员' }] }; }
  };
  const service = new AgentProposalService({ store: new TaskStore(path.join(root, 'runtime.json')), registry: { async list() { return roster; } }, governance });
  const proposal = await service.create({ requestedOutcome: '输出公开素材报告', candidateName: '即时登记报告员' });
  await service.submit(proposal.proposalId);
  await service.approveForTest(proposal.proposalId);
  await service.createTestInstance(proposal.proposalId);
  await service.recordAcceptance(proposal.proposalId, { artifactTitle: '公开素材报告', artifactRef: 'runtime://test/instant-roster.json', passed: true });
  const active = await service.activate(proposal.proposalId);
  assert.equal(active.status, 'active');
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0][0].agentId, '即时登记报告员');
  assert.equal(active.governance.rosterSync.status, 'synced');
});

test('第一批拒绝未审核的能力，阻止自动扩权', async (t) => {
  const service = await setup(t);
  await assert.rejects(() => service.create({ requestedOutcome: '自动发布内容', requestedCapabilities: ['content.private.publish'] }), /只能请求已审核/);
});

test('没有真实工作能力的岗位同意后转为待补能力，不能被标成已上岗', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({
    requestedOutcome: '整理公开网页标题',
    candidateName: '网页标题整理员',
    requestedCapabilities: ['content.public.fetch'],
    acceptedTaskTypes: ['media.transcribe-and-refine']
  });
  await service.submit(proposal.proposalId);
  const revised = await service.approveForTest(proposal.proposalId);
  assert.equal(revised.status, 'needs_revision');
  assert.match(revised.audit.at(-1).detail, /不会进入试用或上线/);
});

test('草案会提前说明当前能否真正进入试用，避免批准后才发现是空岗位', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({
    requestedOutcome: '剪辑公开视频并自动发布',
    candidateName: '视频剪辑发布员'
  });
  assert.equal(proposal.trialReadiness.status, 'needs_capability');
  assert.match(proposal.trialReadiness.message, /目前还没有对应的真实执行能力/);
  assert.equal(proposal.runtimePlan.profileMode, 'needs-capability-build');
});

test('测试产物可以回报审计，但不会把候选岗位提前激活', async (t) => {
  const service = await setup(t);
  const proposal = await service.create({ requestedOutcome: '输出公开资料报告' });
  await service.submit(proposal.proposalId); await service.approveForTest(proposal.proposalId); await service.createTestInstance(proposal.proposalId);
  const updated = await service.recordTestEvidence(proposal.proposalId, { artifactTitle: '受限报告', artifactRef: 'runtime://test/report.md' });
  assert.equal(updated.status, 'testing');
  assert.equal(updated.audit.at(-1).action, 'test_evidence_recorded');
});

test('受限试用必须由真实执行结果决定是否上岗，不能只填一句通过', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-acceptance-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const runner = { async run({ sourceUrl }) { return sourceUrl === 'https://example.com/readme' ? { status:'succeeded', artifactRefs:[{ title:'公开网页中文摘要', location:'runtime://trial/report', validation:{ exists:true, readable:true, nonEmpty:true } }] } : { status:'needs_input', artifactRefs:[] }; } };
  const service = new AgentProposalService({ store:new TaskStore(path.join(root, 'runtime.json')), registry:{ async list() { return []; } }, restrictedAcceptanceRunner:runner });
  const proposal = await service.create({ requestedOutcome:'只读取公开网页，输出中文摘要报告' });
  await service.submit(proposal.proposalId); await service.approveForTest(proposal.proposalId); await service.createTestInstance(proposal.proposalId);
  const accepted = await service.runRestrictedAcceptance(proposal.proposalId, { sourceUrl:'https://example.com/readme' });
  assert.equal(accepted.status, 'testing');
  const active = await service.activate(proposal.proposalId);
  assert.equal(active.status, 'active');
  const failing = await service.create({ requestedOutcome:'只读取公开网页，输出中文摘要报告' });
  await service.submit(failing.proposalId); await service.approveForTest(failing.proposalId); await service.createTestInstance(failing.proposalId);
  const revised = await service.runRestrictedAcceptance(failing.proposalId, { sourceUrl:'' });
  assert.equal(revised.status, 'needs_revision');
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

test('提交新岗位前由审核官创建独立任务并把产物关联回草案', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-review-task-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const calls = [];
  const taskService = { async create(input) {
    calls.push(input);
    return { taskId:'review-task-1', status:'succeeded', artifactRefs:[{ type:'review_report', location:'runtime://review-task-1/review-report', createdAt:'2026-07-21T12:00:00.000Z', validation:{ exists:true, nonEmpty:true }, data:{ recommendation:'human_owner_decision_required', nextAction:'风险范围已写清，交给负责人决定。' } }] };
  } };
  const service = new AgentProposalService({ store:new TaskStore(path.join(root, 'runtime.json')), registry:{ async list(){ return []; } }, taskService });
  const draft = await service.create({ requestedOutcome:'整理公开网页标题', candidateName:'网页标题整理员' });
  assert.equal(draft.reviewRefs.some((item) => item.role === 'reviewer'), false);
  const submitted = await service.submit(draft.proposalId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskType, 'governance.approval-review');
  assert.equal(calls[0].agentId, 'reviewer');
  assert.equal(calls[0].context.proposalId, draft.proposalId);
  assert.equal(submitted.reviewRefs.find((item) => item.role === 'reviewer').taskId, 'review-task-1');
  assert.equal(submitted.status, 'pending_approval');
});

test('审核官没有可验证结论时草案停在草稿，不冒充已审核', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-review-failed-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const service = new AgentProposalService({
    store:new TaskStore(path.join(root, 'runtime.json')), registry:{ async list(){ return []; } },
    taskService:{ async create(){ return { taskId:'review-task-failed', status:'failed', artifactRefs:[] }; } }
  });
  const draft = await service.create({ requestedOutcome:'整理公开网页标题' });
  await assert.rejects(() => service.submit(draft.proposalId), /尚未形成可验证结论/);
  assert.equal((await service.get(draft.proposalId)).status, 'draft');
});

test('审核官可将已登记的小G、小R草案投影为可追溯审核，而不启用岗位', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-registered-drafts-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const roster = [
    { agentId:'github-scout', name:'小G', status:'draft', role:'检索公开 GitHub 项目', promptRef:'agents/github-scout/prompts/system.md', runtimeProfileRef:'integrations/hermes/profiles/github-scout.profile.json', acceptedTaskTypes:['research.github-search'], toolAllowlist:['github.public.search', 'github.public.read'], dataScopes:[{ scope:'public-github-metadata', access:['read'] }], nonResponsibilities:['不登录'], qualityGates:[{ gate:'sources-have-public-url-and-fetched-at', required:true }] },
    { agentId:'intel-researcher', name:'小R', status:'draft', role:'综合公开来源', promptRef:'agents/intel-researcher/prompts/system.md', runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json', acceptedTaskTypes:['research.intel-report'], toolAllowlist:['content.public.fetch', 'github.public.search', 'github.public.read'], dataScopes:[{ scope:'public-research-sources', access:['read'] }], nonResponsibilities:['不外发'], qualityGates:[{ gate:'research-report-has-required-structure', required:true }] }
  ];
  const calls = [];
  const service = new AgentProposalService({
    store:new TaskStore(path.join(root, 'runtime.json')), registry:{ async list() { return roster; } },
    taskService:{ async create(input) {
      calls.push(input);
      return { taskId:`review-${calls.length}`, status:'succeeded', artifactRefs:[{ type:'review_report', location:`runtime://review-${calls.length}/report`, createdAt:'2026-07-23T12:00:00.000Z', validation:{ exists:true, nonEmpty:true }, data:{ recommendation:'human_owner_decision_required', nextAction:'范围已核对，等待负责人决定。' } }] };
    } }
  });
  const reviewed = await service.reviewRegisteredDrafts('审核一下小G和小R这两个新员工草案');
  assert.equal(reviewed.length, 2);
  assert.deepEqual(reviewed.map((item) => item.candidateManifest.agentId).sort(), ['github-scout', 'intel-researcher']);
  assert.ok(reviewed.every((item) => item.status === 'pending_approval'));
  assert.ok(reviewed.every((item) => item.trialReadiness.status === 'ready'));
  assert.deepEqual(reviewed.find((item) => item.manifestAgentId === 'github-scout').requestedCapabilities, ['github.public.search', 'github.public.read']);
  assert.equal(calls.length, 2);
  const repeated = await service.reviewRegisteredDrafts('审查 小G 和 小R');
  assert.deepEqual(repeated.map((item) => item.proposalId).sort(), reviewed.map((item) => item.proposalId).sort());
  assert.equal(calls.length, 2);
});

test('审核官可只读复核已经上岗的小G边界，不重复创建草案或审批', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-active-review-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const manifest = { agentId:'github-scout', name:'小G', status:'active', role:'检索公开 GitHub 项目', acceptedTaskTypes:['research.github-search'], toolAllowlist:['github.public.search', 'github.public.read'], dataScopes:[{ scope:'public-github-metadata', access:['read'] }], nonResponsibilities:['不登录'], qualityGates:[{ gate:'sources-have-public-url-and-fetched-at', required:true }] };
  const store = new TaskStore(path.join(root, 'runtime.json'));
  const service = new AgentProposalService({
    store,
    registry:{ async list() { return [manifest]; } },
    taskService:{ async create() { throw new Error('在岗只读复核不应创建审批任务'); } }
  });
  const [reviewed] = await service.reviewRegisteredDrafts('审查小G岗位');
  assert.equal(reviewed.registryStatus, 'active');
  assert.equal(reviewed.status, 'active');
  assert.equal(reviewed.proposalId, 'registered:github-scout');
  assert.equal((await store.listProposals()).length, 0);
});

test('小G、小R经负责人批准后可准备一次受限公开只读测试，但不会直接激活', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proposal-research-trial-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const manifest = { agentId:'github-scout', name:'小G', status:'draft', role:'检索公开 GitHub 项目', promptRef:'agents/github-scout/prompts/system.md', runtimeProfileRef:'integrations/hermes/profiles/github-scout.profile.json', acceptedTaskTypes:['research.github-search'], toolAllowlist:['github.public.search', 'github.public.read'], dataScopes:[{ scope:'public-github-metadata', access:'read' }], nonResponsibilities:['不登录'], qualityGates:[{ gate:'sources-have-public-url-and-fetched-at', required:true }] };
  const service = new AgentProposalService({
    store:new TaskStore(path.join(root, 'runtime.json')), registry:{ async list() { return [manifest]; } },
    taskService:{ async create() { return { taskId:'review-g', status:'succeeded', artifactRefs:[{ type:'review_report', location:'runtime://review-g/report', createdAt:'2026-07-23T12:00:00.000Z', validation:{ exists:true, nonEmpty:true }, data:{ recommendation:'human_owner_decision_required', nextAction:'等待负责人决定。' } }] }; } }
  });
  const [draft] = await service.reviewRegisteredDrafts('审核小G草案');
  const testing = await service.approveForTest(draft.proposalId);
  assert.equal(testing.status, 'testing');
  const instance = await service.createTestInstance(draft.proposalId);
  assert.equal(instance.status, 'ready');
  assert.deepEqual(instance.capabilityAllowlist, ['github.public.search', 'github.public.read']);
});
