export class LocalTaskCoordinator {
  constructor({ now = () => new Date() } = {}) { this.now = now; }

  async execute(task) {
    const completedAt = this.now().toISOString();
    const recommendation = recommend(task.input);
    const record = {
      receivedAt: task.createdAt,
      completedAt,
      normalizedRequest: task.input.title,
      contextProvided: Boolean(task.input.description),
      recommendedTaskType: recommendation.taskType,
      recommendedAgentId: recommendation.agentId,
      nextAction: recommendation.nextAction,
      externalActionStarted: false
    };
    return {
      status: 'succeeded', currentStage: 'intake_record_ready',
      execution: { executor: 'task-coordinator', mode: 'local_intake_review', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'recorded' },
      artifactRefs: [{ artifactId: `intake-record:${task.taskId}`, taskId: task.taskId, type: 'task_intake_record', title: '任务接收与下一步建议', location: `runtime://${task.taskId}/intake-record`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: record }]
    };
  }
}

function recommend(input) {
  const text = `${input.title || ''} ${input.description || ''}`.toLowerCase();
  const hasMediaLink = Boolean(input.sourceUrl);
  if (/审核|审查|发布|外发|删除|付款|付费|扩权|敏感|权限/.test(text)) return { taskType: 'governance.approval-review', agentId: 'reviewer', nextAction: '创建“范围与风险审查”任务；审核官只给出风险与补充信息结论，最终决定仍由 A君完成。' };
  if (/架构|能力|边界|规划|演进|岗位/.test(text)) return { taskType: 'governance.architecture-review', agentId: 'architect', nextAction: '创建“架构师能力评估”任务，盘点现有岗位、缺口与下一条可验证的推进建议。' };
  if (hasMediaLink || /视频|音频|youtube|转录|字幕|transcri/.test(text)) return { taskType: 'media.transcribe-and-refine', agentId: 'xiaod', nextAction: '创建“小D转录整理”任务，并附上公开素材链接。' };
  if (/健康|状态|服务|运行|paperclip/.test(text)) return { taskType: 'operations.health-review', agentId: 'operator', nextAction: '创建“本机健康检查”任务，获取 A君与 Paperclip 的当前状态。' };
  return { taskType: null, agentId: null, nextAction: '当前没有唯一可执行岗位。请补充目标、交付物或选择具体任务类型；不会自动触发外部动作。' };
}
