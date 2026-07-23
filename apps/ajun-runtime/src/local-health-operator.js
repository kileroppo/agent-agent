import { LocalRuntimeProbe } from './local-runtime-probe.js';

export class LocalHealthOperator {
  constructor({ governance, runtimeProbe = new LocalRuntimeProbe(), now = () => new Date() } = {}) { this.governance = governance; this.runtimeProbe = runtimeProbe; this.now = now; }

  async execute(task) {
    if (task.taskType === 'operations.failure-recovery') return this.reviewFailure(task);
    const checkedAt = this.now().toISOString();
    const [governance, runtimeComponents] = await Promise.all([this.governance.health(), this.runtimeProbe.check()]);
    const components = [
      ...runtimeComponents,
      { id: 'paperclip', name: 'Paperclip 治理台', status: governance.status === 'ready' ? 'healthy' : 'degraded', detail: governance.status === 'ready' ? `本机连接正常（${governance.version || '版本未知'}）。` : '暂时无法确认本机治理台；任务和结果仍保留在 A君运行台。' }
    ];
    const overall = components.every((item) => item.status === 'healthy') ? 'healthy' : 'degraded';
    const report = { checkedAt, overall, components, recommendedAction: overall === 'healthy' ? '无需恢复动作。' : '先检查 Paperclip 本机服务；不要尝试重置账号、凭据或外部连接。' };
    return {
      status: 'succeeded', currentStage: 'health_report_ready',
      execution: { executor: 'operator', mode: 'local_health_review', startedAt: task.execution?.startedAt || checkedAt, finishedAt: this.now().toISOString(), outcome: overall },
      usage: { tools:[{ id:'local-runtime-probe', name:'本机运行检查', calls:2 }, { id:'paperclip-health', name:'治理台健康检查', calls:1 }] },
      artifactRefs: [{ artifactId: `health-report:${task.taskId}`, taskId: task.taskId, type: 'health_report', title: '本地运行健康报告', location: `runtime://${task.taskId}/health-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: checkedAt, data: report }]
    };
  }

  async reviewFailure(task) {
    const checkedAt = this.now().toISOString();
    const context = task.input?.context || {};
    const failure = context.failure || {};
    const canRetry = failure.retryable === true
      && Boolean(context.sourceUrl)
      && Number(context.attempt || 0) < Number(context.maxAutomaticRetries || 0);
    const decision = {
      failedTaskId: context.failedTaskId || task.parentTaskId || null,
      action: canRetry ? 'retry_once' : 'escalate_technical_expert',
      reason: canRetry ? '故障被标记为可重试，原始公开来源仍存在，且尚未超过自动重试上限。' : '故障不可安全自动恢复，或自动重试次数已经用尽。',
      automaticRetryLimit: Number(context.maxAutomaticRetries || 0),
      attempt: Number(context.attempt || 0),
      checkedAt
    };
    return {
      status: 'succeeded', currentStage: 'recovery_decision_ready',
      execution: { executor: 'operator', mode: 'failure_recovery_review', startedAt: task.execution?.startedAt || checkedAt, finishedAt: this.now().toISOString(), outcome: decision.action },
      artifactRefs: [{ artifactId: `recovery-decision:${task.taskId}`, taskId: task.taskId, type: 'recovery_decision', title: '运维官恢复决定', location: `runtime://${task.taskId}/recovery-decision`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: checkedAt, data: decision }]
    };
  }
}
