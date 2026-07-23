export class CrossAgentMissionService {
  constructor({ tasks, store, governance } = {}) { this.tasks = tasks; this.store = store; this.governance = governance; }

  async create({ title, requester, source, idempotencyKey }) {
    let mission = await this.tasks.create({ title, taskType:'army.cross-agent-mission', agentId:'task-coordinator', requester, source, idempotencyKey });
    if (mission.status === 'waiting_approval') {
      const approvalId = mission.approvalRefs?.[0];
      const approval = approvalId ? (await this.store.listApprovals()).find((item) => item.approvalId === approvalId && item.status === 'pending') : null;
      return {
        mission, children:[],
        reply:'这项多人工作包含费用或其他组织级范围。我已经把它交给 Paperclip 等待你确认；在你同意前，不会安排员工开始，也不会产生费用。',
        ...(approval ? { approval:{ approvalId:approval.approvalId, governanceMode:approval.governanceMode, action:approval.action, riskLevel:approval.riskLevel, reason:approval.reason, requestedScope:approval.requestedScope, validUntil:approval.validUntil } } : {})
      };
    }
    return this.dispatch(mission);
  }

  async dispatch(missionOrId) {
    let mission = typeof missionOrId === 'string' ? (await this.store.list()).find((item) => item.taskId === missionOrId) : missionOrId;
    if (!mission) throw new Error('找不到要继续的多人协作任务。');
    const existing = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary');
    if (mission.status === 'succeeded' || existing?.data?.completed === true) return { mission, children:[], reply:'这项多人工作已经完成汇总，不会重复安排员工。' };
    const plan = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_plan')?.data;
    if (!plan) throw new Error('多人协作计划未生成，未创建分工。');
    const parentIssueId = mission.governance?.paperclipIssueId || null;
    const existingChildren = this.store?.list ? (await this.store.list()).filter((task) => task.parentTaskId === mission.taskId) : [];
    const children = [];
    for (const subtask of plan.subtasks) {
      const idempotencyKey = `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`;
      let child = existingChildren.find((task) => task.idempotencyKey === idempotencyKey) || null;
      if (!child) child = await this.tasks.create({
        title:subtask.title, description:`来自已经完成确认的多人协作分工。验收：${subtask.acceptance}`,
        taskType:subtask.taskType, agentId:subtask.agentId, requester:mission.requester, source:{ ...(mission.source || {}), channel:'army-mission', missionTaskId:mission.taskId }, parentTaskId:mission.taskId,
        idempotencyKey,
        context:{ missionTaskId:mission.taskId, parentPaperclipIssueId:parentIssueId, missionSafeOnly:true }
      });
      if (child.status === 'waiting_approval' && typeof this.tasks.resumeApprovedMissionChild === 'function') child = await this.tasks.resumeApprovedMissionChild(child.taskId);
      children.push(child);
    }
    const allDone = children.every((item) => item.status === 'succeeded');
    const artifact = missionSummary(mission, children, allDone);
    mission = await this.store.updateTask(mission.taskId, { status:allDone ? 'succeeded' : 'running', currentStage:allDone ? 'mission_delivered' : 'mission_in_progress', artifactRefs:[...(mission.artifactRefs || []).filter((item) => item.type !== 'cross_agent_mission_summary'), artifact] });
    if (mission.governance?.paperclipIssueId) mission = await this.store.updateTask(mission.taskId, { governance:await this.governance.update(mission) });
    return { mission, children, reply:replyFor(mission, children, allDone) };
  }
}

function missionSummary(mission, children, allDone) {
  const at = new Date().toISOString();
  return { artifactId:`mission-summary:${mission.taskId}`, taskId:mission.taskId, type:'cross_agent_mission_summary', title:'多人协作汇总', location:`runtime://${mission.taskId}/mission-summary`, mimeType:'application/json', accessScope:'local-owner', validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:allDone }, createdAt:at, data:{ childTaskIds:children.map((item) => item.taskId), completed:allDone, employeeIds:children.map((item) => item.assigneeAgentId), statuses:children.map((item) => ({ taskId:item.taskId, status:item.status })), decision:decisionFor(children, allDone) } };
}

function replyFor(mission, children, allDone) {
  const names = { operator:'运维官', architect:'架构师' };
  const work = children.map((item) => names[item.assigneeAgentId] || item.assigneeAgentId).join('、');
  if (!allDone) return `已安排${work}协同处理这次军团盘点。我会在结论出来后直接告诉你现在的情况和下一步。`;
  const decision = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary')?.data?.decision;
  if (!decision) return `已安排${work}完成这次军团盘点。结论已保存；没有触发登录、外发、付费或扩权。`;
  const owner = decision.ownerAction ? `现在需要你处理的是：${decision.ownerAction}` : '现在没有必须由你决定的事情。';
  return `盘点完成：${decision.health}。下一步建议：${decision.nextAction}。${owner}`;
}

function decisionFor(children, allDone) {
  const health = children.find((item) => item.taskType === 'operations.health-review')?.artifactRefs?.find((item) => item.type === 'health_report')?.data;
  const architecture = children.find((item) => item.taskType === 'governance.architecture-review')?.artifactRefs?.find((item) => item.type === 'architecture_review')?.data;
  const unhealthy = (health?.components || []).filter((item) => item.status !== 'healthy').map((item) => item.name || '一项本机组件');
  const healthText = !health ? '本机检查结果还在整理' : health.overall === 'healthy' ? '本机运行正常' : `发现需要检查的部分：${unhealthy.length ? unhealthy.join('、') : '本机组件'}`;
  const nextAction = String(architecture?.nextAction || (allDone ? '继续按真实工作积累记录；有新的卡点我会主动说明。' : '等待员工完成当前分工。')).replace(/。$/, '');
  const ownerAction = health?.overall === 'healthy' ? null : '请在方便时查看本机运行状态；我不会自行重置、登录或扩大权限';
  return { health:healthText, nextAction, ownerAction };
}
