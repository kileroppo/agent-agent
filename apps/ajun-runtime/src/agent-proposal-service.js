import crypto from 'node:crypto';

const SAFE_CAPABILITIES = new Set(['content.public.fetch', 'content.public.media', 'content.public.subtitles']);
const TRANSITIONS = {
  draft: new Set(['pending_approval', 'needs_revision', 'rejected', 'archived']),
  pending_approval: new Set(['testing', 'needs_revision', 'rejected', 'archived']),
  testing: new Set(['active', 'needs_revision', 'archived']),
  needs_revision: new Set(['draft', 'rejected', 'archived']),
  active: new Set(['archived']),
  rejected: new Set(['archived']),
  archived: new Set([])
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
    const manifests = (await this.registry.list({ includeInactive:true })).filter((manifest) => ['draft', 'active'].includes(manifest?.status) && mentionsDraft(text, manifest));
    const reviewed = [];
    for (const manifest of manifests) {
      let proposal = (await this.store.listProposals()).find((item) => item.manifestAgentId === manifest.agentId) || null;
      if (manifest.status === 'active') {
        proposal ||= {
          ...manifestProposal(manifest, this.now()),
          proposalId:`registered:${manifest.agentId}`,
          status:'active',
          reviewRefs:[reviewerReview(manifest, strings(manifest.toolAllowlist), this.now().toISOString())]
        };
        reviewed.push({ ...proposal, registryStatus:'active', candidateManifest:manifest });
        continue;
      }
      if (!proposal) proposal = await this.store.createProposal(manifestProposal(manifest, this.now()));
      else {
        const projected = manifestProposal(manifest, this.now());
        if (registeredProjectionChanged(proposal, projected)) {
          if (['pending_approval', 'testing'].includes(proposal.status)) {
            proposal = await this.transition(proposal.proposalId, 'needs_revision', 'reviewer', '正式 Manifest 或岗位 Skill 投影发生变化，原审核失效并退回重新审核。');
            proposal = await this.transition(proposal.proposalId, 'draft', 'reviewer', '已同步最新正式 Manifest，等待重新提交审核。');
          }
          if (proposal.status === 'draft') {
            proposal = await this.store.updateProposal(proposal.proposalId, {
              candidateManifest:projected.candidateManifest,
              promptRef:projected.promptRef,
              desiredSkills:projected.desiredSkills,
              requestedCapabilities:projected.requestedCapabilities,
              trialReadiness:projected.trialReadiness,
              runtimePlan:{ ...(proposal.runtimePlan || {}), ...projected.runtimePlan },
              budgetPolicy:projected.budgetPolicy,
              acceptanceTask:projected.acceptanceTask,
              reviewRefs:projected.reviewRefs
            });
          }
        }
      }
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
        `职责：${strings(proposal.candidateManifest.responsibilities).join('；') || '未声明'}`,
        `禁止事项：${strings(proposal.candidateManifest.nonResponsibilities).join('；') || '未声明'}`,
        `任务类型：${strings(proposal.candidateManifest.acceptedTaskTypes).join('、') || '未声明'}`,
        `申请能力：${proposal.requestedCapabilities.join('、') || '无外部能力'}`,
        `能力边界：${proposal.requestedCapabilities.map(capabilityBoundary).join('；') || '无工具调用'}`,
        `数据范围：${JSON.stringify(proposal.candidateManifest.dataScopes || [])}`,
        `Skill：${proposal.desiredSkills.join('、') || '无额外 Skill'}`,
        `Skill审核：${JSON.stringify(proposal.candidateManifest.runtimeCapabilities?.skillReviews || [])}`,
        `预算：${JSON.stringify(proposal.candidateManifest.budgetPolicy || proposal.budgetPolicy)}`,
        `试用预算：${JSON.stringify(proposal.budgetPolicy)}；与岗位单任务预算分开，只允许一次验收运行。`,
        `质量门禁：${JSON.stringify(proposal.candidateManifest.qualityGates || [])}`,
        `正式证据审批：${JSON.stringify(proposal.candidateManifest.evidencePolicy || {})}`,
        `失败去向：${proposal.candidateManifest.budgetPolicy?.onLimit || '停止并如实报告，不扩大权限或外部动作'}`,
        '产物定位：只通过当前任务明确列出的 sourceTaskIds 查找已验证 ArtifactContract；只读取允许根目录内的 file:// 文件，不接受任务正文中的任意路径。',
        '引用定义：sourceTaskIds 是 A君本机任务存储中的稳定任务 ID；执行器只从这些任务的 artifactRefs 选择 type/validation 合格的产物，路径必须位于 A君 dataDir 或小D artifact root，Paperclip 不接收本机绝对路径。',
        '确认稿触发：小D先生成机器稿和质量报告；默认在质量门禁通过后自动生成带 confirmationMode=automatic、completeListen=false、版本和 SHA-256 的 confirmed_transcript。转录异常或用户明确要求时才进入 confirm-transcript-after-complete-listen 审批，并生成 confirmationMode=human 的确认稿。正式分析只认 confirmed_transcript；否则只能初步分析。',
        '来源脱敏：ArtifactContract 和 ContentPackage 不包含 Cookie、token、登录态或浏览器会话；发现此类字段必须拒绝，不传给候选岗位。',
        '复盘写回：只新建当前复盘任务的 content_performance_report，并用 sourceRefs 关联原拆解和草稿；不修改原任务、原产物或平台数据。',
        `预算优先级：试用最多 ${proposal.budgetPolicy?.maxTokens || 12000} tokens、一次运行；生产任务同时受 Manifest 的时间/尝试上限约束，任一先到即停止。若提供方不返回可靠 token 用量，不虚构数字，只按时间和尝试上限停止。`,
        '有效期：负责人决定后 7 天内仅运行一次受限试用；逾期重新审核。岗位正式激活后持续到 Manifest 被 paused 或 retired。',
        `测试范围：仅公开素材、一次受限测试、不登录、不外发、不付费、不扩权。`,
        `验收任务：${JSON.stringify(proposal.acceptanceTask)}`,
        `有效期：本次岗位草案。交付条件：逐项核对后给出风险、缺失信息和是否可进入负责人决定；信息足够时用 succeeded 回报，信息不足时用 waiting_test。`
      ].join('\n'),
      taskType: 'governance.approval-review', agentId: 'reviewer',
      idempotencyKey: `agent-proposal-review:${proposal.proposalId}:${reviewContractKey(proposal)}`,
      requester: { kind:'local-system', ref:'creator' },
      source: { channel:'agent-proposal', eventRef:`agent-proposal:${proposal.proposalId}` },
      context: { proposalId:proposal.proposalId, candidateAgentId:proposal.candidateManifest.agentId }
    });
    const report = reviewTask.artifactRefs?.find((item) => ['review_report', 'employee_role_report'].includes(item.type));
    if (reviewTask.status !== 'succeeded' || !report?.validation?.exists || !report?.validation?.nonEmpty) {
      throw new ProposalValidationError('审核官尚未形成可验证结论，岗位草案仍保留为草稿。');
    }
    return {
      reviewId: `reviewer-task:${reviewTask.taskId}`, role:'reviewer', result:report.data?.recommendation || 'human_owner_required',
      summary:report.data?.nextAction || report.data?.summary || '审核官已完成范围与风险审查，等待负责人决定。', at:report.createdAt || at,
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
    const formal = typeof this.registry?.formal === 'function'
      ? await this.registry.formal(proposal.candidateManifest.agentId)
      : (await this.registry.list({ includeInactive:true })).find((item) => item.agentId === proposal.candidateManifest.agentId);
    if (!formal || formal.status !== 'active') {
      throw new ProposalValidationError('受限测试通过后仍需落盘并启用正式 Manifest，不能只靠运行时提案生成活动员工。');
    }
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
      result = await this.restrictedAcceptanceRunner.run({
        proposal,
        testInstance:instance,
        sourceUrl:String(input.sourceUrl || '').trim(),
        sourceUrls:strings(input.sourceUrls),
        query:optional(input.query),
        topic:optional(input.topic),
        title:optional(input.title),
        sourceTaskIds:strings(input.sourceTaskIds || input.context?.sourceTaskIds),
        depth:input.depth === 'full' ? 'full' : 'fast',
        evidenceMode:input.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
        focus:optional(input.focus),
        platforms:strings(input.platforms),
        contentGoal:optional(input.contentGoal),
        metrics:input.metrics && typeof input.metrics === 'object' ? input.metrics : null,
        acceptanceTranscript:optional(input.acceptanceTranscript)
      });
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

  async archive(proposalId, { archivedBy = 'A君', reason = '岗位或测试实例已结束，保留历史审计但不再进入活动名单。' } = {}) {
    const proposal = await this.get(proposalId);
    if (proposal.status === 'archived') return proposal;
    const archivedAt = this.now().toISOString();
    const updated = await this.transition(proposalId, 'archived', String(archivedBy).slice(0, 120), String(reason).slice(0, 500));
    return this.store.updateProposal(proposalId, {
      archivedAt,
      archivedBy:String(archivedBy).slice(0, 120),
      archiveReason:String(reason).slice(0, 500),
      governance:{ ...(updated.governance || {}), rosterSync:{ status:'archived', syncedAt:archivedAt } }
    });
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
  const supportsIntelResearch = manifest?.agentId === 'intel-researcher'
    && taskTypes.includes('research.intel-report')
    && taskTypes.includes('research.github-search')
    && sameItems(requestedCapabilities, ['content.public.fetch', 'github.public.search', 'github.public.read']);
  const supportsVideoContentAnalyst = manifest?.agentId === 'video-content-analyst'
    && taskTypes.includes('content.video-benchmark-analysis')
    && taskTypes.includes('content.performance-review')
    && sameItems(requestedCapabilities, ['army.task.status.read', 'content.artifact.read', 'content.analysis.write']);
  const supportsContentCreator = manifest?.agentId === 'content-creator'
    && taskTypes.length === 1
    && taskTypes[0] === 'content.platform-draft'
    && sameItems(requestedCapabilities, ['army.task.status.read', 'content.artifact.read', 'content.draft.write']);
  if (supportsIntelResearch) return { status:'ready', message:'可进入一次受限公开只读测试；负责人批准前不会启用，测试必须交出可验证产物。' };
  if (supportsVideoContentAnalyst) return { status:'ready', message:'可引用一份受控确认稿进入一次证据化拆解试用；测试不能抓取、登录、发布或绕过人工确认。' };
  if (supportsContentCreator) return { status:'ready', message:'可引用确认稿和正式拆解进入一次草稿试用；只允许生成最多三个平台版本，不能发布。' };
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
    promptDraft:null, desiredSkills:strings(manifest.runtimeCapabilities?.skills), requestedCapabilities,
    trialReadiness,
    runtimePlan:{ profileMode:trialReadiness.status === 'ready' ? 'isolated-test-only' : 'needs-capability-build', profileRef:manifest.runtimeProfileRef, productionProfileCreated:false },
    budgetPolicy:{ maxRuns:1, externalSpendAllowed:false, maxTokens:12000 },
    acceptanceTask:{ taskType:manifest.acceptedTaskTypes?.[0] || '', title:`验证 ${manifest.name} 的受限公开资料任务`, constraints:[...(manifest.nonResponsibilities || []), '仅执行一次白名单验收任务', '必须返回可验证产物引用'] },
    status:'draft', reviewRefs:[architectReview(manifest, requestedCapabilities, now.toISOString())],
    audit:[{ at:now.toISOString(), actor:'reviewer', action:'manifest_draft_projected', detail:'已将仓库中登记的草案岗位投影为可追溯审核草案；未启用岗位、未创建外部连接。' }]
  };
}
function sameItems(items, expected) { return Array.isArray(items) && items.length === expected.length && expected.every((item) => items.includes(item)); }
function registeredProjectionChanged(proposal, projected) {
  const current = {
    candidateManifest:proposal?.candidateManifest,
    desiredSkills:proposal?.desiredSkills || [],
    requestedCapabilities:proposal?.requestedCapabilities || [],
    acceptanceTask:proposal?.acceptanceTask
  };
  const next = {
    candidateManifest:projected?.candidateManifest,
    desiredSkills:projected?.desiredSkills || [],
    requestedCapabilities:projected?.requestedCapabilities || [],
    acceptanceTask:projected?.acceptanceTask
  };
  return JSON.stringify(current) !== JSON.stringify(next);
}
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
function capabilityBoundary(value) {
  return ({
    'army.task.status.read':'只读当前任务和明确引用任务的脱敏状态，不读取聊天全文或凭据',
    'content.artifact.read':'只读当前任务明确引用、已验证且位于受控目录的产物',
    'content.analysis.write':'只在当前任务本机产物目录写拆解/复盘文件，不外发',
    'content.draft.write':'只在当前任务本机产物目录写待审草稿，外部副作用固定为 0',
    'knowledge.archive.write':'只通过统一内容库边界写 Agent军团 目录，不接受任意路径且不读取私人笔记'
  })[value] || `${value}：仅按 Manifest 数据范围使用，未知副作用默认拒绝`;
}
function reviewContractKey(proposal) {
  const value = JSON.stringify({
    candidateManifest:proposal?.candidateManifest,
    requestedCapabilities:proposal?.requestedCapabilities,
    desiredSkills:proposal?.desiredSkills,
    budgetPolicy:proposal?.budgetPolicy,
    acceptanceTask:proposal?.acceptanceTask
  });
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
