const SAFE_CAPABILITIES = new Set(['content.public.fetch', 'content.public.media', 'content.public.subtitles']);
const TRANSITIONS = {
  draft: new Set(['pending_approval', 'needs_revision', 'rejected']),
  pending_approval: new Set(['testing', 'needs_revision', 'rejected']),
  testing: new Set(['active', 'needs_revision']),
  needs_revision: new Set(['draft', 'rejected']),
  active: new Set([]),
  rejected: new Set([])
};

export class AgentProposalService {
  constructor({ store, registry, governance = null, now = () => new Date() } = {}) {
    this.store = store; this.registry = registry; this.governance = governance; this.now = now;
  }

  async create(input, { source = 'ajun-runtime' } = {}) {
    const requestedOutcome = text(input?.requestedOutcome || input?.title, '请说明新岗位要交付什么。');
    const sourceEventRef = optional(input?.sourceEventRef);
    if (sourceEventRef) {
      const existing = (await this.store.listProposals()).find((item) => item.sourceEventRef === sourceEventRef);
      if (existing) return existing;
    }
    const candidateManifest = candidate(input, requestedOutcome);
    const requestedCapabilities = capabilities(input?.requestedCapabilities);
    const now = this.now().toISOString();
    let proposal = await this.store.createProposal({
      source, sourceEventRef, requestedOutcome, candidateManifest,
      promptRef: `runtime://agent-proposals/${candidateManifest.agentId}/system-prompt`,
      promptDraft: promptFor(candidateManifest, requestedOutcome),
      desiredSkills: strings(input?.desiredSkills), requestedCapabilities,
      runtimePlan: { profileMode: 'isolated-test-only', profileRef: `runtime://agent-proposals/${candidateManifest.agentId}/hermes-test-profile`, productionProfileCreated: false },
      budgetPolicy: { maxRuns: 1, externalSpendAllowed: false, maxTokens: Number(input?.maxTokens || 12000) },
      acceptanceTask: acceptanceTask(input, candidateManifest),
      status: 'draft',
      reviewRefs: [architectReview(candidateManifest, requestedCapabilities, now), reviewerReview(candidateManifest, requestedCapabilities, now)],
      audit: [{ at: now, actor: 'creator', action: 'draft_created', detail: '只创建岗位草案；未创建生产 Agent、外部连接或账号权限。' }]
    });
    return proposal;
  }

  async submit(proposalId) {
    let proposal = await this.transition(proposalId, 'pending_approval', 'creator', '已提交组织级审核；未启动测试实例。');
    if (this.governance) proposal = await this.store.updateProposal(proposalId, { governance: await this.governance.projectProposal(proposal) });
    return proposal;
  }

  async approveForTest(proposalId, decisionBy = 'A君') {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending_approval') throw new ProposalValidationError(`草案状态“${proposal.status}”不能进入受限测试。`);
    if (this.governance) {
      const governance = await this.governance.approveProposal(proposal);
      await this.store.updateProposal(proposalId, { governance });
    }
    return this.transition(proposalId, 'testing', decisionBy, '负责人批准受限测试；仅允许白名单能力与验收任务。');
  }

  async createTestInstance(proposalId, { hermesProfileName = null } = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('草案未获批准，不能创建受限测试实例。');
    const existing = (await this.store.listTestInstances()).find((item) => item.proposalId === proposalId && item.status !== 'stopped');
    if (existing) return existing;
    const active = (await this.store.listTestInstances()).find((item) => item.status === 'ready' || item.status === 'running');
    if (active) throw new ProposalValidationError('当前已有受限测试实例，请先结束后再创建下一条。');
    return this.store.createTestInstance({
      proposalId, agentId: proposal.candidateManifest.agentId, status: 'ready',
      hermesProfile: { mode: hermesProfileName ? 'isolated-existing-profile' : 'contract-only', profileName: hermesProfileName || null, isolated: true, productionCredentials: false, profileRef: proposal.runtimePlan.profileRef },
      capabilityAllowlist: proposal.requestedCapabilities, desiredSkills: proposal.desiredSkills,
      budgetPolicy: proposal.budgetPolicy, acceptanceTask: proposal.acceptanceTask,
      audit: [{ at: this.now().toISOString(), actor: 'ajun-runtime', action: 'isolated_test_prepared', detail: '仅写入本机受限测试配置；没有读取或写入 Hermes 凭据。' }]
    });
  }

  async recordAcceptance(proposalId, { artifactTitle, artifactRef, passed = false } = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('只有测试中的草案可以登记验收。');
    if (!artifactTitle || !artifactRef) throw new ProposalValidationError('验收必须提供可验证产物标题与引用。');
    const instance = (await this.store.listTestInstances()).find((item) => item.proposalId === proposalId && item.status === 'ready');
    if (!instance) throw new ProposalValidationError('请先准备受限测试实例。');
    await this.store.updateTestInstance(instance.testInstanceId, { status: passed ? 'passed' : 'failed', artifact: { title: String(artifactTitle).slice(0, 160), ref: String(artifactRef).slice(0, 500), passed: Boolean(passed), recordedAt: this.now().toISOString() } });
    if (!passed) return this.transition(proposalId, 'needs_revision', 'operator', '验收未通过；未创建正式 Agent 或飞书路由。');
    let updated = await this.transition(proposalId, 'active', 'A君', '受限测试验收通过，允许建立正式运行投影。');
    if (this.governance) updated = await this.store.updateProposal(proposalId, { governance: await this.governance.updateProposal(updated) });
    return updated;
  }

  async reject(proposalId, decisionBy = 'A君') { return this.transition(proposalId, 'rejected', decisionBy, '负责人拒绝草案；未启动任何运行实例。'); }
  async get(proposalId) { const proposal = (await this.store.listProposals()).find((item) => item.proposalId === proposalId); if (!proposal) throw new ProposalValidationError('找不到 Agent 草案。'); return proposal; }

  async transition(proposalId, target, actor, detail) {
    const proposal = await this.get(proposalId);
    if (!TRANSITIONS[proposal.status]?.has(target)) throw new ProposalValidationError(`草案状态“${proposal.status}”不能转换为“${target}”。`);
    const audit = [...(proposal.audit || []), { at: this.now().toISOString(), actor, action: `status_${target}`, detail }];
    return this.store.updateProposal(proposalId, { status: target, audit });
  }
}

export class ProposalValidationError extends Error {}

function candidate(input, outcome) {
  const agentId = slug(input?.agentId || input?.candidateName || outcome);
  return {
    schemaVersion: 'agent.army/v1', manifestVersion: '0.1.0', agentId,
    name: text(input?.candidateName || `${outcome.slice(0, 18)}专员`, '请提供岗位名称。'), department: optional(input?.department) || '待审核岗位',
    role: outcome, responsibilities: strings(input?.responsibilities, [outcome]),
    nonResponsibilities: strings(input?.nonResponsibilities, ['不得读取凭据、Cookie、浏览器会话或私密内容。', '不得执行外发、发布、付费、扩权或其他外部副作用。']),
    acceptedTaskTypes: strings(input?.acceptedTaskTypes, ['report.public-material']), toolAllowlist: ['ajun.capability.request'],
    dataScopes: [{ scope: 'public-material-only', access: ['read'], boundary: '仅公开素材；无账号、无私密数据、无写入。' }],
    approvalPolicies: [{ action: 'external-or-sensitive-action', riskLevel: 'high', decision: 'require-approval' }],
    qualityGates: [{ gate: 'acceptance-artifact-verified', required: true }],
    budgetPolicy: { maxRuns: 1, externalSpendAllowed: false }, promptRef: `runtime://agent-proposals/${agentId}/system-prompt`, runtimeProfileRef: `runtime://agent-proposals/${agentId}/hermes-test-profile`, appRef: 'apps/ajun-runtime', owner: 'A君', status: 'draft'
  };
}
function acceptanceTask(input, manifest) { return { taskType: manifest.acceptedTaskTypes[0], title: optional(input?.acceptanceTitle) || `验证 ${manifest.name} 的公开资料报告`, constraints: ['仅公开素材', '不登录账号', '不外发或发布', '必须返回可验证产物引用'] }; }
function architectReview(manifest, capabilities, at) { return { reviewId: `architect:${at}`, role: 'architect', result: 'recommend_pending_approval', summary: `复用 A君能力边界；候选岗位仅请求：${capabilities.join('、') || '无外部能力'}。`, at }; }
function reviewerReview(manifest, capabilities, at) { return { reviewId: `reviewer:${at}`, role: 'reviewer', result: 'human_owner_required', summary: `默认拒绝账号、发布、付费与扩权；测试预算仅一次。`, at }; }
function promptFor(manifest, outcome) { return `你是${manifest.name}。目标：${outcome}\n只处理公开素材并输出可验证报告；不得读取凭据、登录账号、外发、发布、付费或扩权。缺少必要材料时停止并说明。`; }
function capabilities(value) { const selected = strings(value); if (selected.some((item) => !SAFE_CAPABILITIES.has(item))) throw new ProposalValidationError('第一批测试实例只能请求已审核的公开内容获取能力。'); return selected; }
function strings(value, fallback = []) { const items = Array.isArray(value) ? value : value ? [value] : fallback; return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]; }
function optional(value) { return String(value || '').trim() || null; }
function text(value, message) { const result = optional(value); if (!result) throw new ProposalValidationError(message); return result.slice(0, 500); }
function slug(value) { const ascii = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return ascii || `candidate-${Math.random().toString(36).slice(2, 8)}`; }
