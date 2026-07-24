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
  constructor({ store, registry, governance = null, taskService = null, restrictedAcceptanceRunner = null, now = () => new Date() } = {}) {
    this.store = store; this.registry = registry; this.governance = governance; this.taskService = taskService; this.restrictedAcceptanceRunner = restrictedAcceptanceRunner; this.now = now;
  }

  async create(input, { source = 'ajun-runtime' } = {}) {
    const requestedOutcome = text(input?.requestedOutcome || input?.title, '请说明新岗位要交付什么。');
    const sourceEventRef = optional(input?.sourceEventRef);
    if (sourceEventRef) {
      const existing = (await this.store.listProposals()).find((item) => item.sourceEventRef === sourceEventRef);
      if (existing) return existing;
    }
    const candidateManifest = candidate(input, requestedOutcome);
    const requestedCapabilities = capabilities(input?.requestedCapabilities, requestedOutcome);
    const trialReadiness = currentTrialReadiness(candidateManifest, requestedCapabilities);
    const now = this.now().toISOString();
    let proposal = await this.store.createProposal({
      source, sourceEventRef, sourceChatRef: optional(input?.sourceChatRef), requestedOutcome, candidateManifest,
      promptRef: `runtime://agent-proposals/${candidateManifest.agentId}/system-prompt`,
      promptDraft: promptFor(candidateManifest, requestedOutcome),
      desiredSkills: strings(input?.desiredSkills), requestedCapabilities,
      trialReadiness,
      runtimePlan: { profileMode: trialReadiness.status === 'ready' ? 'isolated-test-only' : 'needs-capability-build', profileRef: `runtime://agent-proposals/${candidateManifest.agentId}/hermes-test-profile`, productionProfileCreated: false },
      budgetPolicy: { maxRuns: 1, externalSpendAllowed: false, maxTokens: Number(input?.maxTokens || 12000) },
      acceptanceTask: acceptanceTask(input, candidateManifest),
      status: 'draft',
      reviewRefs: [architectReview(candidateManifest, requestedCapabilities, now)],
      audit: [{ at: now, actor: 'creator', action: 'draft_created', detail: '只创建岗位草案；未创建生产 Agent、外部连接或账号权限。' }]
    });
    return proposal;
  }

  async reviewRegisteredDrafts(text) {
    const manifests = (await this.registry.list()).filter((manifest) => manifest?.status === 'draft' && mentionsDraft(text, manifest));
    const reviewed = [];
    for (const manifest of manifests) {
      let proposal = (await this.store.listProposals()).find((item) => item.manifestAgentId === manifest.agentId) || null;
      if (!proposal) proposal = await this.store.createProposal(manifestProposal(manifest, this.now()));
      if (proposal.status === 'draft') proposal = await this.submit(proposal.proposalId);
      const trialReadiness = currentTrialReadiness(proposal.candidateManifest, proposal.requestedCapabilities);
      if (proposal.trialReadiness?.status !== trialReadiness.status || proposal.trialReadiness?.message !== trialReadiness.message) {
        proposal = await this.store.updateProposal(proposal.proposalId, { trialReadiness, runtimePlan:{ ...(proposal.runtimePlan || {}), profileMode:trialReadiness.status === 'ready' ? 'isolated-test-only' : 'needs-capability-build' } });
      }
      reviewed.push(proposal);
    }
    return reviewed;
  }

  async submit(proposalId) {
    const draft = await this.get(proposalId);
    if (draft.status !== 'draft') throw new ProposalValidationError(`草案状态“${draft.status}”不能提交审核。`);
    const reviewer = await this.runReviewerTask(draft);
    await this.store.updateProposal(proposalId, { reviewRefs: [...(draft.reviewRefs || []).filter((item) => item.role !== 'reviewer'), reviewer] });
    let proposal = await this.transition(proposalId, 'pending_approval', 'creator', '已提交组织级审核；未启动测试实例。');
    if (this.governance) proposal = await this.store.updateProposal(proposalId, { governance: await this.governance.projectProposal(proposal) });
    return proposal;
  }

  async runReviewerTask(proposal) {
    const at = this.now().toISOString();
    if (!this.taskService) return reviewerReview(proposal.candidateManifest, proposal.requestedCapabilities, at);
    const reviewTask = await this.taskService.create({
      title: `审查新岗位草案：${proposal.candidateManifest.name}`,
      description: [
        `岗位目标：${proposal.requestedOutcome}`,
        `申请能力：${proposal.requestedCapabilities.join('、') || '无外部能力'}`,
        `测试范围：仅公开素材、一次受限测试、不登录、不外发、不付费、不扩权。`,
        `有效期：本次岗位草案。交付条件：给出风险、缺失信息和是否可进入负责人决定。`
      ].join('\n'),
      taskType: 'governance.approval-review', agentId: 'reviewer',
      idempotencyKey: `agent-proposal-review:${proposal.proposalId}`,
      requester: { kind:'local-system', ref:'creator' },
      source: { channel:'agent-proposal', eventRef:`agent-proposal:${proposal.proposalId}` },
      context: { proposalId:proposal.proposalId, candidateAgentId:proposal.candidateManifest.agentId }
    });
    const report = reviewTask.artifactRefs?.find((item) => item.type === 'review_report');
    if (reviewTask.status !== 'succeeded' || !report?.validation?.exists || !report?.validation?.nonEmpty) {
      throw new ProposalValidationError('审核官尚未形成可验证结论，岗位草案仍保留为草稿。');
    }
    return {
      reviewId: `reviewer-task:${reviewTask.taskId}`, role:'reviewer', result:report.data?.recommendation || 'human_owner_required',
      summary:report.data?.nextAction || '审核官已完成范围与风险审查，等待负责人决定。', at:report.createdAt || at,
      taskId:reviewTask.taskId, artifactRef:report.location
    };
  }

  async approveForTest(proposalId, decisionBy = 'A君') {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending_approval') throw new ProposalValidationError(`草案状态“${proposal.status}”不能进入受限测试。`);
    const trialReadiness = currentTrialReadiness(proposal.candidateManifest, proposal.requestedCapabilities);
    if (this.governance) {
      const governance = await this.governance.approveProposal(proposal);
      await this.store.updateProposal(proposalId, { governance });
    }
    if (trialReadiness.status !== 'ready') {
      let revised = await this.transition(proposalId, 'needs_revision', decisionBy, '负责人已确认岗位方向；当前没有对应的真实执行能力，草案转为待补能力，不会进入试用或上线。');
      if (this.governance) revised = await this.store.updateProposal(proposalId, { governance: await this.governance.updateProposal(revised) });
      return revised;
    }
    return this.transition(proposalId, 'testing', decisionBy, '负责人批准受限测试；仅允许白名单能力与验收任务。');
  }

  async createTestInstance(proposalId, { hermesProfileName = null } = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('草案未获批准，不能创建受限测试实例。');
    assertRunnableCandidate(proposal);
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
    if (passed) assertRunnableCandidate(proposal);
    const instance = (await this.store.listTestInstances()).find((item) => item.proposalId === proposalId && item.status === 'ready');
    if (!instance) throw new ProposalValidationError('请先准备受限测试实例。');
    await this.store.updateTestInstance(instance.testInstanceId, { status: passed ? 'passed' : 'failed', artifact: { title: String(artifactTitle).slice(0, 160), ref: String(artifactRef).slice(0, 500), passed: Boolean(passed), recordedAt: this.now().toISOString() } });
    if (!passed) return this.transition(proposalId, 'needs_revision', 'operator', '验收未通过；未创建正式 Agent 或飞书路由。');
    const audit = [...(proposal.audit || []), { at:this.now().toISOString(), actor:'operator', action:'restricted_acceptance_passed', detail:'受限测试通过，等待负责人单独决定是否激活；当前仍不允许派活。' }];
    let updated = await this.store.updateProposal(proposalId, { audit, acceptance:{ status:'passed', artifactTitle:String(artifactTitle).slice(0, 160), artifactRef:String(artifactRef).slice(0, 500), passedAt:this.now().toISOString() } });
    if (this.governance) updated = await this.store.updateProposal(proposalId, { governance: await this.governance.updateProposal(updated) });
    return updated;
  }

  async activate(proposalId, decisionBy = 'A君') {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('只有完成受限测试且仍在测试中的草案可以激活。');
    if (proposal.acceptance?.status !== 'passed') throw new ProposalValidationError('受限测试尚未通过，不能激活岗位。');
    assertRunnableCandidate(proposal);
    let updated = await this.transition(proposalId, 'active', decisionBy, '负责人确认受限测试产物后激活岗位。');
    if (this.governance) updated = await this.store.updateProposal(proposalId, { governance: await this.governance.updateProposal(updated) });
    const rosterSync = await this.syncActivatedRoster();
    if (rosterSync) updated = await this.store.updateProposal(proposalId, { governance: { ...(updated.governance || {}), rosterSync } });
    return updated;
  }

  async runRestrictedAcceptance(proposalId, input = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('只有测试中的草案可以运行受限试用。');
    const instance = (await this.store.listTestInstances()).find((item) => item.proposalId === proposalId && item.status === 'ready');
    if (!instance) throw new ProposalValidationError('请先准备受限测试实例。');
    if (!this.restrictedAcceptanceRunner) throw new ProposalValidationError('当前没有可用的受限试用执行器。');
    let result;
    try {
      result = await this.restrictedAcceptanceRunner.run({ proposal, testInstance: instance, sourceUrl: String(input.sourceUrl || '').trim(), sourceUrls:strings(input.sourceUrls), query:optional(input.query), topic:optional(input.topic) });
    } catch (error) {
      return this.recordAcceptance(proposalId, { artifactTitle:'受限试用失败记录', artifactRef:`runtime://agent-proposals/${proposalId}/acceptance-failed`, passed:false });
    }
    const artifact = result?.artifactRefs?.find((item) => item.validation?.exists && item.validation?.readable && item.validation?.nonEmpty);
    if (result?.status !== 'succeeded' || !artifact?.title || !artifact?.location) {
      return this.recordAcceptance(proposalId, { artifactTitle:'受限试用失败记录', artifactRef:`runtime://agent-proposals/${proposalId}/acceptance-failed`, passed:false });
    }
    return this.recordAcceptance(proposalId, { artifactTitle:artifact.title, artifactRef:artifact.location, passed:true });
  }

  async recordTestEvidence(proposalId, { artifactTitle, artifactRef } = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'testing') throw new ProposalValidationError('只有测试中的草案可以登记测试产物。');
    if (!artifactTitle || !artifactRef) throw new ProposalValidationError('测试产物必须提供标题与引用。');
    const instance = (await this.store.listTestInstances()).find((item) => item.proposalId === proposalId && item.status === 'ready');
    if (!instance) throw new ProposalValidationError('请先准备受限测试实例。');
    const evidence = [...(instance.evidence || []), { title: String(artifactTitle).slice(0, 160), ref: String(artifactRef).slice(0, 500), recordedAt: this.now().toISOString() }];
    await this.store.updateTestInstance(instance.testInstanceId, { evidence });
    const audit = [...(proposal.audit || []), { at: this.now().toISOString(), actor: 'operator', action: 'test_evidence_recorded', detail: `已登记测试产物：${evidence.at(-1).title}；尚未激活。` }];
    let updated = await this.store.updateProposal(proposalId, { audit });
    if (this.governance) updated = await this.store.updateProposal(proposalId, { governance: await this.governance.updateProposal(updated) });
    return updated;
  }

  async reject(proposalId, decisionBy = 'A君') {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending_approval') throw new ProposalValidationError(`草案状态“${proposal.status}”不能拒绝。`);
    if (this.governance) {
      const governance = await this.governance.rejectProposal(proposal);
      await this.store.updateProposal(proposalId, { governance });
    }
    return this.transition(proposalId, 'rejected', decisionBy, '负责人拒绝草案；未启动任何运行实例。');
  }
  async get(proposalId) { const proposal = (await this.store.listProposals()).find((item) => item.proposalId === proposalId); if (!proposal) throw new ProposalValidationError('找不到 Agent 草案。'); return proposal; }

  async syncActivatedRoster() {
    if (!this.governance?.syncRoster || !this.registry?.list) return null;
    try {
      return await this.governance.syncRoster(await this.registry.list());
    } catch {
      return { status: 'sync_pending', reason: '新岗位已在本机上岗，管理台登记待下次同步补上。', syncedAt: this.now().toISOString() };
    }
  }

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
function capabilities(value, outcome = '') {
  const inferred = /公开.*(?:网页|页面|文章|资料|素材)|(?:网页|页面|文章|资料|素材).*?(?:摘要|报告|整理)|公开.*(?:摘要|报告|整理)/.test(String(outcome)) ? ['content.public.fetch'] : [];
  const selected = strings(value, inferred);
  if (selected.some((item) => !SAFE_CAPABILITIES.has(item))) throw new ProposalValidationError('第一批测试实例只能请求已审核的公开内容获取能力。');
  return selected;
}
function assertRunnableCandidate(proposal) {
  if (currentTrialReadiness(proposal?.candidateManifest, proposal?.requestedCapabilities).status !== 'ready') {
    throw new ProposalValidationError('当前草案没有可受限验证的公开只读执行范围；请修改岗位范围后再试。');
  }
}
function currentTrialReadiness(manifest, requestedCapabilities) {
  const taskTypes = manifest?.acceptedTaskTypes || [];
  const supportsPublicReport = taskTypes.length === 1
    && taskTypes[0] === 'report.public-material'
    && requestedCapabilities?.includes('content.public.fetch');
  const supportsGithubScout = manifest?.agentId === 'github-scout'
    && taskTypes.length === 1 && taskTypes[0] === 'research.github-search'
    && sameItems(requestedCapabilities, ['github.public.search', 'github.public.read']);
  const supportsIntelResearch = manifest?.agentId === 'intel-researcher'
    && taskTypes.length === 1 && taskTypes[0] === 'research.intel-report'
    && sameItems(requestedCapabilities, ['content.public.fetch', 'github.public.search', 'github.public.read']);
  if (supportsGithubScout || supportsIntelResearch) return { status:'ready', message:'可进入一次受限公开只读测试；负责人批准前不会启用，测试必须交出可验证产物。' };
  return supportsPublicReport
    ? { status:'ready', message:'当前可进入只读公开网页的受限试用；通过真实产物验收后才会上岗。' }
    : { status:'needs_capability', message:'这个岗位的草案可以先审核，但军团目前还没有对应的真实执行能力；不会进入试用，更不会上线。' };
}
function manifestProposal(manifest, now) {
  const requestedCapabilities = strings(manifest.toolAllowlist);
  const trialReadiness = currentTrialReadiness(manifest, requestedCapabilities);
  return {
    source:'registered-manifest', sourceEventRef:`registered-manifest:${manifest.agentId}`, manifestAgentId:manifest.agentId,
    requestedOutcome:manifest.role, candidateManifest:manifest, promptRef:manifest.promptRef,
    promptDraft:null, desiredSkills:[], requestedCapabilities,
    trialReadiness,
    runtimePlan:{ profileMode:trialReadiness.status === 'ready' ? 'isolated-test-only' : 'needs-capability-build', profileRef:manifest.runtimeProfileRef, productionProfileCreated:false },
    budgetPolicy:{ maxRuns:1, externalSpendAllowed:false, maxTokens:12000 },
    acceptanceTask:{ taskType:manifest.acceptedTaskTypes?.[0] || '', title:`验证 ${manifest.name} 的受限公开资料任务`, constraints:[...(manifest.nonResponsibilities || []), '仅执行一次白名单验收任务', '必须返回可验证产物引用'] },
    status:'draft', reviewRefs:[architectReview(manifest, requestedCapabilities, now.toISOString())],
    audit:[{ at:now.toISOString(), actor:'reviewer', action:'manifest_draft_projected', detail:'已将仓库中登记的草案岗位投影为可追溯审核草案；未启用岗位、未创建外部连接。' }]
  };
}
function sameItems(items, expected) { return Array.isArray(items) && items.length === expected.length && expected.every((item) => items.includes(item)); }
function mentionsDraft(text, manifest) {
  const value = String(text || '').toLowerCase().replace(/\s+/g, '');
  const agentId = String(manifest?.agentId || '').toLowerCase();
  const name = String(manifest?.name || '').toLowerCase().replace(/\s+/g, '');
  return Boolean(value && (value.includes(agentId) || value.includes(name)));
}
function strings(value, fallback = []) { const items = Array.isArray(value) ? value : value ? [value] : fallback; return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]; }
function optional(value) { return String(value || '').trim() || null; }
function text(value, message) { const result = optional(value); if (!result) throw new ProposalValidationError(message); return result.slice(0, 500); }
function slug(value) { const ascii = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return ascii || `candidate-${Math.random().toString(36).slice(2, 8)}`; }
