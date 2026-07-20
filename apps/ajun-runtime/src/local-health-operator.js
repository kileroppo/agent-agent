export class LocalHealthOperator {
  constructor({ governance, now = () => new Date() } = {}) { this.governance = governance; this.now = now; }

  async execute(task) {
    const checkedAt = this.now().toISOString();
    const governance = await this.governance.health();
    const components = [
      { id: 'ajun-runtime', name: 'A君运行台', status: 'healthy', detail: '当前任务已由本地运行台接收并执行。' },
      { id: 'paperclip', name: 'Paperclip 治理台', status: governance.status === 'ready' ? 'healthy' : 'degraded', detail: governance.status === 'ready' ? `本机连接正常（${governance.version || '版本未知'}）。` : '无法确认本机治理台健康；任务和结果仍保留在 A君运行台。' }
    ];
    const overall = components.every((item) => item.status === 'healthy') ? 'healthy' : 'degraded';
    const report = { checkedAt, overall, components, recommendedAction: overall === 'healthy' ? '无需恢复动作。' : '先检查 Paperclip 本机服务；不要尝试重置账号、凭据或外部连接。' };
    return {
      status: 'succeeded', currentStage: 'health_report_ready',
      execution: { executor: 'operator', mode: 'local_health_review', startedAt: task.execution?.startedAt || checkedAt, finishedAt: this.now().toISOString(), outcome: overall },
      artifactRefs: [{ artifactId: `health-report:${task.taskId}`, taskId: task.taskId, type: 'health_report', title: '本地运行健康报告', location: `runtime://${task.taskId}/health-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: checkedAt, data: report }]
    };
  }
}
