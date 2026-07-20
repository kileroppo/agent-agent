export class LocalArchitect {
  constructor({ registry, now = () => new Date() } = {}) { this.registry = registry; this.now = now; }

  async execute(task) {
    const completedAt = this.now().toISOString();
    const agents = await this.registry.list();
    const active = agents.filter((agent) => agent.status === 'active');
    const draft = agents.filter((agent) => agent.status !== 'active');
    const report = {
      reviewedAt: completedAt,
      request: { title: task.input.title, scopeStated: Boolean(task.input.description) },
      currentCapabilities: active.map((agent) => ({ agentId: agent.agentId, name: agent.name, taskTypes: agent.acceptedTaskTypes })),
      capabilityGaps: draft.map((agent) => ({ agentId: agent.agentId, name: agent.name, reason: '岗位尚未启用本地执行器。' })),
      boundary: '本次只读评估岗位注册表；没有创建连接、修改权限、调用外部账号或改变系统边界。',
      nextAction: draft.length ? `先为“${draft[0].name}”补一条可验证的本地执行路径，再评估是否需要扩展外部能力。` : '现有岗位均有本地执行路径；下一步按真实任务验证各岗位的交接与恢复。',
      externalActionStarted: false,
      architectureChanged: false
    };
    return {
      status: 'succeeded', currentStage: 'architecture_review_ready',
      execution: { executor: 'architect', mode: 'local_capability_review', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'reviewed' },
      artifactRefs: [{ artifactId: `architecture-review:${task.taskId}`, taskId: task.taskId, type: 'architecture_review', title: '岗位能力与边界评估', location: `runtime://${task.taskId}/architecture-review`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: report }]
    };
  }
}
