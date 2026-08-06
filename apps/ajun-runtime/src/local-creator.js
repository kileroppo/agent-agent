export class LocalCreator {
  constructor({ proposals, now = () => new Date() } = {}) { this.proposals = proposals; this.now = now; }

  async execute(task, { proposalInput = null } = {}) {
    const structured = proposalInput && typeof proposalInput === 'object' ? proposalInput : {};
    const capabilityDesign = designCapabilities(structured);
    const proposal = await this.proposals.create({
      requestedOutcome: structured.requestedOutcome || task.input.title,
      candidateName: structured.candidateName || undefined,
      agentId: structured.agentId || undefined,
      department: structured.department || undefined,
      responsibilities: structured.responsibilities,
      nonResponsibilities: structured.nonResponsibilities,
      acceptedTaskTypes: structured.acceptedTaskTypes,
      desiredSkills: structured.desiredSkills,
      requestedCapabilities: structured.requestedCapabilities,
      acceptanceTitle: structured.acceptanceTitle,
      sourceEventRef: task.source?.eventRef || `paperclip:${task.governance?.paperclipIssueId || task.taskId}:agent-proposal`
    }, { source: task.source?.channel || 'ajun-runtime' });
    let submitted = proposal;
    let reviewSubmission = { status: proposal.status === 'draft' ? 'pending' : 'submitted' };
    if (proposal.status === 'draft') {
      try {
        submitted = await this.proposals.submit(proposal.proposalId);
        reviewSubmission = { status: 'submitted' };
      } catch (error) {
        reviewSubmission = {
          status: 'pending',
          reason: error instanceof Error ? error.message.slice(0, 300) : '审核提交暂未完成'
        };
      }
    }
    const completedAt = this.now().toISOString();
    const revisedCapabilityDesign = reviseCapabilityDesign(capabilityDesign, submitted);
    return {
      status: 'succeeded',
      currentStage: reviewSubmission.status === 'submitted' ? 'agent_proposal_submitted' : 'agent_proposal_drafted',
      execution: { executor: 'creator', mode: 'proposal_only', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: submitted.status },
      artifactRefs: [{ artifactId: `agent-proposal:${submitted.proposalId}`, taskId: task.taskId, type: 'agent_proposal', title: `岗位草案：${submitted.candidateManifest.name}`, location: `runtime://agent-proposals/${submitted.proposalId}`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: { proposalId: submitted.proposalId, status: submitted.status, reviewSubmission, capabilityDesign:revisedCapabilityDesign, nextAction: submitted.trialReadiness?.message || '等待负责人审核；未通过受限测试前不会创建或路由正式 Agent。' } }]
    };
  }
}

function designCapabilities(input) {
  const requested = strings(input.requestedCapabilities);
  const catalog = Array.isArray(input.capabilityCatalog) ? input.capabilityCatalog : Array.isArray(input.availableCapabilities) ? input.availableCapabilities : [];
  const reuseEvidence = [];
  const gaps = [];
  for (const capabilityId of requested) {
    const candidate = catalog.find((item) => String(item?.capabilityId || item?.id || '') === capabilityId);
    if (!candidate) {
      gaps.push({ capabilityId, reason:'仓库和已登记能力目录中没有匹配项。', status:'unresolved' });
      continue;
    }
    const auditStatus = String(candidate.audit?.status || candidate.auditStatus || 'not_verified');
    const evidenceRefs = strings(candidate.evidenceRefs || candidate.audit?.evidenceRefs);
    const reusable = ['passed', 'approved', 'verified', 'safe'].includes(auditStatus) && evidenceRefs.length > 0;
    reuseEvidence.push({
      capabilityId,
      candidateId:String(candidate.capabilityId || candidate.id),
      source:String(candidate.source || 'registered-capability-catalog'),
      version:String(candidate.version || 'unknown'),
      auditStatus,
      evidenceRefs,
      recommendation:reusable ? 'reuse_existing' : 'verify_before_reuse'
    });
    if (!reusable) gaps.push({ capabilityId, reason:'已有候选能力，但缺少通过的审计状态或可检查证据。', status:'needs_verification' });
  }
  const unresolvedIds = new Set(gaps.map((item) => item.capabilityId));
  return {
    schemaVersion:'agent.army/capability-design/v1',
    requestedCapabilities:requested,
    reuseEvidence,
    gaps,
    reuseCoverage:{ requested:requested.length, reusable:reuseEvidence.filter((item) => item.recommendation === 'reuse_existing').length },
    sandboxExperiment:minimalSandboxExperiment({ input, requested, unresolvedIds }),
    revisionAdvice:revisionAdvice({ requested, gaps, input })
  };
}

function minimalSandboxExperiment({ input, requested, unresolvedIds }) {
  const targetCapabilities = requested.filter((item) => unresolvedIds.has(item));
  return {
    experimentId:'candidate-capability-minimum-sandbox',
    status:targetCapabilities.length ? 'proposed' : requested.length ? 'not_required_existing_capability_reusable' : 'not_applicable_no_capability_requested',
    targetCapabilities,
    environment:'isolated-test-profile',
    fixture:String(input.acceptanceTitle || '使用一条脱敏或合成输入完成一次最小交付。'),
    steps:targetCapabilities.length ? [
      '固定候选能力来源、版本和哈希。',
      '在无真实凭据、无外部写入的隔离 Profile 中加载能力。',
      '仅运行一次合成输入，并验证预期产物。',
      '确认越权、外发、付费和未知副作用均被拒绝。',
      '卸载候选能力并确认隔离状态可回滚。'
    ] : [],
    acceptance:{
      artifactValidation:['exists', 'readable', 'nonEmpty'],
      externalSideEffects:false,
      permissionExpansion:false,
      rollbackRequired:true
    },
    productionActivationAuthorized:false
  };
}

function revisionAdvice({ requested, gaps, input }) {
  const advice = [];
  if (!String(input.requestedOutcome || '').trim()) advice.push('补充岗位要稳定交付的业务结果。');
  if (!requested.length) advice.push('明确最小工具能力清单；未知能力不得通过岗位草案自动扩权。');
  if (gaps.length) advice.push(`先验证能力缺口：${gaps.map((item) => item.capabilityId).join('、')}；验证通过前岗位只能保持草案。`);
  if (!strings(input.acceptedTaskTypes).length) advice.push('补充可路由且可验收的任务类型。');
  return advice;
}

function reviseCapabilityDesign(design, proposal) {
  const readiness = proposal?.trialReadiness || {};
  const revisionAdvice = [...design.revisionAdvice];
  if (readiness.status && readiness.status !== 'ready') revisionAdvice.push(readiness.message || 'proposal service 判定当前能力尚不能进入受限试用。');
  return {
    ...design,
    proposalServiceReadiness:{ status:String(readiness.status || 'unknown'), message:String(readiness.message || '') },
    revisionAdvice:[...new Set(revisionAdvice)]
  };
}
function strings(value) { return [...new Set((Array.isArray(value) ? value : value ? [value] : []).map((item) => String(item).trim()).filter(Boolean))]; }
