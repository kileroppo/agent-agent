const RISK_CATEGORIES = [
  ['外发', 'external_send'], ['发布', 'publish'], ['删除', 'delete'], ['付款', 'payment'], ['付费', 'paid_action'], ['扩权', 'permission_expansion'], ['敏感', 'sensitive_data']
];
const HIGH_RISK_SIDE_EFFECTS = new Set(['external_send', 'publish', 'delete', 'payment', 'paid_action', 'permission_expansion', 'sensitive_data']);

export class LocalReviewer {
  now: () => Date;
  constructor({ now = () => new Date() }: any = {}) { this.now = now; }

  async execute(task: any) {
    const completedAt = this.now().toISOString();
    const text = `${task.input.title || ''} ${task.input.description || ''}`;
    const context = task.input?.context || {};
    const subject = reviewSubject(context);
    const structuredReview = hasStructuredReviewSubject(context);
    const declaredSideEffects = strings(subject.externalSideEffects);
    const riskCategories = [...new Set([
      ...RISK_CATEGORIES.filter(([word]) => text.includes(word)).map(([, category]) => category),
      ...declaredSideEffects.map(normalizeSideEffect)
    ].filter(Boolean))];
    const scopeStated = Boolean(String(task.input.description || '').trim());
    const findings = structuredReview
      ? structuredFindings({ subject, riskCategories, now:this.now() })
      : [finding('scope.declared', 'scope', scopeStated ? 'pass' : 'fail', scopeStated ? '已声明审查范围。' : '缺少明确审查范围。', 'task.input.description')];
    const blockingFindings = findings.filter((item) => item.status !== 'pass');
    const recommendation = !scopeStated
      ? 'needs_scope_before_owner_decision'
      : blockingFindings.length
        ? 'needs_revision_before_owner_decision'
        : 'human_owner_decision_required';
    const report = {
      schemaVersion: 'agent.army/governance-review/v1',
      reviewedAt: completedAt,
      scopeStated,
      riskCategories,
      structuredReview,
      findings,
      summary: {
        passed: findings.filter((item) => item.status === 'pass').length,
        failed: findings.filter((item) => item.status === 'fail').length,
        needsEvidence: findings.filter((item) => item.status === 'needs_evidence').length,
        blockingFindingIds: blockingFindings.map((item) => item.findingId)
      },
      recommendation,
      nextAction: recommendation === 'human_owner_decision_required'
        ? '机器交叉核验未发现阻断项；仍由负责人决定是否批准，审核官不执行也不代替最终授权。'
        : recommendation === 'needs_scope_before_owner_decision'
          ? '补充目标、影响范围、有效期与交付条件后，再由负责人决定。'
          : `先修订或补证：${blockingFindings.map((item) => item.message).join('；')}。完成后再交负责人决定。`,
      finalDecisionMade: false,
      externalActionStarted: false
    };
    return {
      status: 'succeeded', currentStage: 'review_report_ready',
      execution: { executor: 'reviewer', mode: 'local_scope_review', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: report.recommendation },
      artifactRefs: [{ artifactId: `review-report:${task.taskId}`, taskId: task.taskId, type: 'review_report', title: '范围与风险审查结果', location: `runtime://${task.taskId}/review-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: report }]
    };
  }
}

function structuredFindings({ subject, riskCategories, now }: any) {
  const findings: any[] = [];
  const scope = subject.scope;
  const dataScopes = array(subject.dataScopes);
  const toolAllowlist = strings(subject.toolAllowlist);
  const budget = object(subject.budget);
  const sideEffects = strings(subject.externalSideEffects).map(normalizeSideEffect).filter(Boolean);
  const capabilityAudits = array(subject.capabilityAudit);
  const approvalPolicies = array(subject.approvalPolicies);

  findings.push(finding('scope.structured', 'scope', hasDeclaredScope(scope) ? 'pass' : 'fail',
    hasDeclaredScope(scope) ? '结构化范围已声明。' : '结构化范围缺少目标、边界或交付条件。', 'task.input.context.scope'));
  findings.push(finding('data_scopes.declared', 'data_scope', dataScopes.length ? 'pass' : 'fail',
    dataScopes.length ? `已声明 ${dataScopes.length} 项数据范围。` : '缺少 dataScopes，无法确认可读取的数据边界。', 'task.input.context.dataScopes'));
  if (dataScopes.length) {
    const incomplete = dataScopes.filter((item) => !item?.scope || !array(item?.access).length || !String(item?.boundary || '').trim());
    findings.push(finding('data_scopes.bounded', 'data_scope', incomplete.length ? 'fail' : 'pass',
      incomplete.length ? `${incomplete.length} 项数据范围缺少 scope、access 或 boundary。` : '每项数据范围都有访问方式和边界。', 'task.input.context.dataScopes'));
  }
  findings.push(finding('tools.declared', 'tool_allowlist', toolAllowlist.length ? 'pass' : 'fail',
    toolAllowlist.length ? `已声明 ${toolAllowlist.length} 项工具能力。` : '缺少 toolAllowlist，无法确认实际能力边界。', 'task.input.context.toolAllowlist'));

  const auditedCapabilities = new Set(capabilityAudits.filter(auditPassed).map((item) => String(item.capabilityId || item.capability || item.toolId || '').trim()).filter(Boolean));
  const unaudited = toolAllowlist.filter((tool) => !auditedCapabilities.has(tool));
  findings.push(finding('capabilities.audited', 'capability_audit',
    !toolAllowlist.length ? 'needs_evidence' : unaudited.length ? 'needs_evidence' : 'pass',
    !toolAllowlist.length ? '等待工具清单后才能核验能力审计。' : unaudited.length ? `以下工具缺少通过的能力审计：${unaudited.join('、')}。` : '工具白名单均有通过的能力审计记录。',
    'task.input.context.capabilityAudit'));

  const hasBudgetLimits = positiveNumber(budget.maxRuns) || positiveNumber(budget.maxTokens) || positiveNumber(budget.maxWallClockSeconds);
  findings.push(finding('budget.bounded', 'budget', hasBudgetLimits ? 'pass' : 'fail',
    hasBudgetLimits ? '预算包含至少一项正数硬上限。' : '预算缺少 maxRuns、maxTokens 或 maxWallClockSeconds 的正数硬上限。', 'task.input.context.budget'));
  const spendRequested = riskCategories.includes('payment') || riskCategories.includes('paid_action');
  findings.push(finding('budget.external_spend', 'budget',
    spendRequested && budget.externalSpendAllowed !== true ? 'fail' : 'pass',
    spendRequested && budget.externalSpendAllowed !== true ? '任务包含付款或付费动作，但预算未明确允许外部支出。' : '外部支出声明与预算一致。',
    'task.input.context.budget.externalSpendAllowed'));

  const validUntil = String(subject.validUntil || '').trim();
  const expiry = Date.parse(validUntil);
  findings.push(finding('validity.not_expired', 'validity',
    !validUntil || !Number.isFinite(expiry) ? 'fail' : expiry <= now.getTime() ? 'fail' : 'pass',
    !validUntil ? '缺少 validUntil。' : !Number.isFinite(expiry) ? 'validUntil 不是有效时间。' : expiry <= now.getTime() ? 'validUntil 已过期。' : '有效期尚未过期。',
    'task.input.context.validUntil'));

  const undeclaredRisks = riskCategories.filter((item: string) => HIGH_RISK_SIDE_EFFECTS.has(item) && !sideEffects.includes(item));
  findings.push(finding('side_effects.declared', 'external_side_effect',
    undeclaredRisks.length ? 'fail' : 'pass',
    undeclaredRisks.length ? `文本出现高风险动作但 externalSideEffects 未声明：${undeclaredRisks.join('、')}。` : '高风险外部副作用已显式声明或未发现。',
    'task.input.context.externalSideEffects'));
  const sideEffectsWithoutApproval = sideEffects.filter((effect: string | null) => effect && HIGH_RISK_SIDE_EFFECTS.has(effect) && !hasApprovalFor(effect, approvalPolicies));
  findings.push(finding('side_effects.approval_gate', 'approval',
    sideEffectsWithoutApproval.length ? 'fail' : 'pass',
    sideEffectsWithoutApproval.length ? `以下外部副作用缺少人工审批门禁：${sideEffectsWithoutApproval.join('、')}。` : '已声明的高风险副作用均有人工审批门禁或不存在高风险副作用。',
    'task.input.context.approvalPolicies'));
  return findings;
}

function reviewSubject(context: any) {
  const nested = object(context.reviewSubject || context.proposal || context.candidate);
  const manifest = object(nested.candidateManifest || context.candidateManifest);
  return {
    scope: nested.scope ?? context.scope,
    dataScopes: nested.dataScopes ?? manifest.dataScopes ?? context.dataScopes,
    toolAllowlist: nested.toolAllowlist ?? manifest.toolAllowlist ?? context.toolAllowlist,
    budget: nested.budget ?? nested.budgetPolicy ?? manifest.budgetPolicy ?? context.budget ?? context.budgetPolicy,
    validUntil: nested.validUntil ?? context.validUntil,
    externalSideEffects: nested.externalSideEffects ?? context.externalSideEffects,
    capabilityAudit: nested.capabilityAudit ?? nested.capabilityAudits ?? context.capabilityAudit ?? context.capabilityAudits,
    approvalPolicies: nested.approvalPolicies ?? manifest.approvalPolicies ?? context.approvalPolicies
  };
}

function hasStructuredReviewSubject(context: any) {
  return ['reviewSubject', 'proposal', 'candidateManifest', 'scope', 'dataScopes', 'toolAllowlist', 'budget', 'budgetPolicy', 'validUntil', 'externalSideEffects', 'capabilityAudit', 'capabilityAudits']
    .some((key) => Object.prototype.hasOwnProperty.call(context || {}, key));
}

function finding(findingId: string, category: string, status: string, message: string, field: string) {
  return { findingId, category, severity: status === 'pass' ? 'info' : status === 'fail' ? 'blocker' : 'warning', status, field, message };
}
function auditPassed(item: any) { return ['passed', 'approved', 'verified', 'safe'].includes(String(item?.status || item?.result || '').toLowerCase()); }
function hasApprovalFor(effect: string, policies: any[]) {
  return policies.some((item: any) => {
    const action = String(item?.action || item?.sideEffect || '').trim();
    const decision = String(item?.decision || item?.result || '').toLowerCase();
    return (action === effect || action === 'external-or-sensitive-action' || action === '*')
      && (decision.includes('approval') || decision.includes('owner') || decision.includes('human'));
  });
}
function hasDeclaredScope(value: any) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  return Boolean(String(value.goal || value.outcome || value.description || '').trim())
    && Boolean(String(value.boundary || value.constraints || value.deliverable || '').trim() || array(value.constraints).length);
}
function normalizeSideEffect(value: any): string | null {
  const text = String(value || '').trim();
  const match = RISK_CATEGORIES.find(([word, category]) => text === category || text.includes(word));
  return match?.[1] || text || null;
}
function positiveNumber(value: any) { return Number.isFinite(Number(value)) && Number(value) > 0; }
function strings(value: any): string[] { return [...new Set(array(value).map((item: any) => typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim()).filter(Boolean))] as string[]; }
function array(value: any): any[] { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function object(value: any): any { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
