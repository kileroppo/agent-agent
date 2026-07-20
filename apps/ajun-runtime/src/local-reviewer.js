const RISK_CATEGORIES = [
  ['外发', 'external_send'], ['发布', 'publish'], ['删除', 'delete'], ['付款', 'payment'], ['付费', 'paid_action'], ['扩权', 'permission_expansion'], ['敏感', 'sensitive_data']
];

export class LocalReviewer {
  constructor({ now = () => new Date() } = {}) { this.now = now; }

  async execute(task) {
    const completedAt = this.now().toISOString();
    const text = `${task.input.title || ''} ${task.input.description || ''}`;
    const riskCategories = RISK_CATEGORIES.filter(([word]) => text.includes(word)).map(([, category]) => category);
    const scopeStated = Boolean(String(task.input.description || '').trim());
    const report = {
      reviewedAt: completedAt,
      scopeStated,
      riskCategories,
      recommendation: scopeStated ? 'human_owner_decision_required' : 'needs_scope_before_owner_decision',
      nextAction: scopeStated ? '由 A君基于明确范围决定是否批准；审核官不执行也不代替最终授权。' : '补充目标、影响范围、有效期与交付条件后，再由 A君决定。',
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
