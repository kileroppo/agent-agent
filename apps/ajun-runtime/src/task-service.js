const highRiskWords = /外发|发布|删除|付款|付费|扩权|敏感/;

export class TaskService {
  constructor({ registry, store, governance = null, executors = {} }) { this.registry = registry; this.store = store; this.governance = governance; this.executors = executors; }

  async create(input) {
    const title = String(input?.title || '').trim(); const taskType = String(input?.taskType || '').trim();
    if (!title) throw new ValidationError('请说明要完成什么。');
    if (!taskType) throw new ValidationError('请选择任务类型。');
    const requesterName = String(input?.requesterName || '').trim() || 'A君';
    const requestedAgentId = String(input?.agentId || '').trim() || null;
    let candidates = await this.registry.candidates(taskType);
    if (requestedAgentId) candidates = candidates.filter((agent) => agent.agentId === requestedAgentId);
    const agent = candidates.length === 1 ? candidates[0] : null;
    const description = String(input?.description || '').trim(); const sourceUrl = String(input?.sourceUrl || '').trim() || extractPublicUrl(`${title}\n${description}`);
    let task = await this.store.createTask({
      taskType, idempotencyKey: `local:${cryptoSafe(title)}:${Date.now()}`, requester: { kind: requesterName === 'A君' ? 'local-owner' : 'lan-collaborator', ref: requesterName }, source: { channel: 'ajun-runtime' },
      assigneeAgentId: agent?.agentId || null, parentTaskId: String(input?.parentTaskId || '').trim() || null, input: { title, description, sourceUrl: sourceUrl || null },
      status: agent?.status === 'active' ? 'queued' : 'needs_input', currentStage: agent?.status === 'active' ? 'queued_for_execution' : agent ? 'waiting_for_agent_activation' : 'routing_needed',
      routing: { requestedAgentId, candidateAgentIds: candidates.map((item) => item.agentId), reason: agent?.status === 'active' ? '已路由到已启用的本地执行器。' : agent ? '岗位骨架已登记，等待启用真实执行器。' : candidates.length === 0 ? '没有岗位声明支持该任务类型。' : '多个岗位匹配，请明确选择承接岗位。' }
    });
    if (highRiskWords.test(`${title} ${description}`) && !['army.intake', 'governance.approval-review'].includes(taskType)) {
      await this.store.createApproval({ taskId: task.taskId, action: 'manual-risk-review', riskLevel: 'high', reason: '任务描述包含高风险动作，必须人工确认范围。', requestedBy: 'task-coordinator', approverScope: 'A君', requestedScope: { taskType, title }, validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
      task = (await this.store.list()).find((item) => item.taskId === task.taskId);
    }
    if (this.governance && shouldProjectToPaperclip(task)) {
      const approval = task.approvalRefs.length ? (await this.store.listApprovals()).find((item) => item.approvalId === task.approvalRefs[0]) : null;
      task = await this.store.updateTask(task.taskId, { governance: await this.governance.project(task, approval) });
    }
    const executor = agent?.status === 'active' ? this.executors[agent.agentId] : null;
    if (executor && task.status !== 'waiting_approval') {
      task = await this.store.updateTask(task.taskId, { status: 'running', currentStage: 'starting', execution: { executor: agent.agentId, startedAt: new Date().toISOString() } });
      if (this.governance && task.governance?.paperclipIssueId) task = await this.store.updateTask(task.taskId, { governance: await this.governance.update(task) });
      try {
        task = await this.store.updateTask(task.taskId, await executor.execute(task));
        if (task.status === 'running' && typeof executor.observe === 'function') executor.observe(task);
      } catch (error) {
        task = await this.store.updateTask(task.taskId, { status: 'failed', currentStage: 'execution_failed', error: { code: 'executor_failed', message: String(error?.message || '执行器失败。'), userMessage: '本地任务未能完成，请查看安全诊断。', category: 'manual', stage: 'execution', occurredAt: new Date().toISOString() } });
      }
      if (this.governance && task.governance?.paperclipIssueId) task = await this.store.updateTask(task.taskId, { governance: await this.governance.update(task) });
    }
    return task;
  }

  async continueFromRecommendation(taskId) {
    const parent = (await this.store.list()).find((task) => task.taskId === taskId);
    if (!parent) throw new ValidationError('找不到这条原始任务。');
    const intake = parent.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
    if (parent.status !== 'succeeded' || !intake?.recommendedTaskType || !intake?.recommendedAgentId) {
      throw new ValidationError('这条任务当前没有可继续执行的建议。');
    }
    if (intake.recommendedTaskType === 'media.transcribe-and-refine' && !parent.input?.sourceUrl) {
      throw new ValidationError('小D需要公开素材链接。请在“指定岗位或任务类型”中选择小D并补上链接后提交。');
    }
    return this.create({
      title: parent.input.title,
      description: parent.input.description,
      sourceUrl: parent.input.sourceUrl,
      requesterName: parent.requester?.ref,
      taskType: intake.recommendedTaskType,
      agentId: intake.recommendedAgentId,
      parentTaskId: parent.taskId
    });
  }

  async rejectApproval(approvalId) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval) throw new ValidationError('找不到这条审批。');
    if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
    await this.store.updateApproval(approvalId, { status:'rejected', decisionBy:'A君', decisionReason:'本机主人拒绝当前请求范围。', decidedAt:new Date().toISOString() });
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    let updated = await this.store.updateTask(task.taskId, { status:'cancelled', currentStage:'approval_rejected', error:{ code:'approval_rejected', message:'本机主人拒绝了当前审批范围。', userMessage:'这项高风险任务已被拒绝并关闭，未执行任何外部动作。', category:'manual', stage:'approval', occurredAt:new Date().toISOString() } });
    if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    return updated;
  }

  async overview() {
    const [agents, tasks, approvals, governance] = await Promise.all([this.registry.list(), this.store.list(), this.store.listApprovals(), this.governance?.health() || { status: 'planned', version: null }]);
    return { agents, tasks, approvals, taskFocus: buildTaskFocus(tasks, approvals), capabilities: [
      { id: 'task-coordination', name: '统一任务协调', status: 'ready', detail: '创建、路由和状态真相已就绪。' },
      { id: 'agent-registry', name: '岗位注册表', status: 'ready', detail: '岗位职责、任务类型和权限边界从 Manifest 读取。' },
      { id: 'approval-gate', name: '审批闸门', status: 'ready', detail: '高风险描述先进入待审批，不自动执行。' },
      { id: 'content-public-web-fetch', name: '公开网页内容获取', status: 'ready', detail: '仅读取公开 HTML/纯文本，拒绝内网、登录态和非网页内容。' },
      { id: 'governance', name: 'Paperclip 治理投影', status: governance.status, detail: governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）。` : 'Paperclip 未连接；任务仍可登记，后续可补同步。' },
      { id: 'external-execution', name: '外部执行', status: 'planned', detail: 'Hermes、授权连接和外部动作尚未接入。' }
    ] };
  }
}

export class ValidationError extends Error {}
function cryptoSafe(value) { return Buffer.from(value).toString('base64url').slice(0, 24); }
function extractPublicUrl(value) { return String(value).match(/https?:\/\/[^\s<>"]+/i)?.[0]?.replace(/[),.;，。；]+$/, '') || ''; }
function shouldProjectToPaperclip(task) {
  return Boolean(task.approvalRefs?.length) || task.source?.channel === 'paperclip' || task.taskType.startsWith('governance.') || task.taskType.startsWith('army.');
}

function buildTaskFocus(tasks, approvals) {
  const counts = Object.fromEntries(['queued', 'running', 'waiting_approval', 'needs_input', 'succeeded', 'failed'].map((status) => [status, tasks.filter((task) => task.status === status).length]));
  const priority = ['waiting_approval', 'needs_input', 'running', 'queued', 'failed'];
  const pendingContinuation = tasks.find((task) => task.status === 'succeeded' && intakeRecommendation(task) && !tasks.some((child) => child.parentTaskId === task.taskId));
  const current = priority.flatMap((status) => tasks.filter((task) => task.status === status))[0] || pendingContinuation || null;
  const approval = current ? approvals.find((item) => current.approvalRefs?.includes(item.approvalId) && item.status === 'pending') : null;
  return {
    total: tasks.length,
    completed: counts.succeeded,
    inProgress: counts.queued + counts.running,
    needsInput: counts.needs_input,
    waitingApproval: counts.waiting_approval,
    failed: counts.failed,
    next: current ? {
      taskId: current.taskId,
      title: current.input?.title || '未命名任务',
      status: current.status,
      action: nextActionFor(current, approval)
    } : null
  };
}

function nextActionFor(task, approval) {
  if (approval) return '请确认任务范围；在你确认前，系统不会继续执行。';
  if (intakeRecommendation(task)) return 'A君已经给出下一步建议；确认后可按建议创建后续任务。';
  if (task.status === 'needs_input') return task.error?.userMessage || '请补充目标、范围或必要素材后再继续。';
  if (task.status === 'failed') return task.error?.userMessage || '这项任务未完成，请根据错误信息决定是否重试或补充信息。';
  if (task.status === 'running') return '任务正在处理，等待新的进度或结果。';
  return '任务已排队，等待本地执行器开始处理。';
}

function intakeRecommendation(task) {
  const intake = task.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
  return intake?.recommendedTaskType && intake?.recommendedAgentId ? intake : null;
}
