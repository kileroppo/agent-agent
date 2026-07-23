import { recordTaskUsage, summarizeTaskUsage } from './task-usage.js';
import { formatPublicReportReply } from './public-report-presentation.js';

const highRiskWords = /外发|发布|删除|付款|付费|扩权|敏感/;
const organizationGovernanceWords = /创建.*(?:agent|智能体|岗位)|新建.*(?:agent|智能体|岗位)|扩权|账号|连接|公开发布|对外发布|付款|付费|预算|暂停|终止|跨\s*agent/i;

export class TaskService {
  constructor({ registry, store, governance = null, executors = {}, fallbackExecutor = null, onTaskFailed = null, feishuChannelStatus = null }) { this.registry = registry; this.store = store; this.governance = governance; this.executors = executors; this.fallbackExecutor = fallbackExecutor; this.onTaskFailed = onTaskFailed; this.feishuChannelStatus = feishuChannelStatus; }

  setFeishuChannelStatus(status) { this.feishuChannelStatus = status; }

  async create(input) {
    const title = String(input?.title || '').trim(); const taskType = String(input?.taskType || '').trim();
    if (!title) throw new ValidationError('请说明要完成什么。');
    if (!taskType) throw new ValidationError('请选择任务类型。');
    const suppliedIdempotencyKey = String(input?.idempotencyKey || '').trim();
    if (suppliedIdempotencyKey) {
      const existing = (await this.store.list()).find((item) => item.idempotencyKey === suppliedIdempotencyKey);
      if (existing) return existing;
    }
    const requesterName = String(input?.requesterName || '').trim() || 'A君';
    const requestedAgentId = String(input?.agentId || '').trim() || null;
    let candidates = await this.registry.candidates(taskType);
    if (requestedAgentId) candidates = candidates.filter((agent) => agent.agentId === requestedAgentId);
    const agent = candidates.length === 1 ? candidates[0] : null;
    const description = String(input?.description || '').trim();
    const sourceUrls = uniquePublicUrls([String(input?.sourceUrl || '').trim(), ...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), ...extractPublicUrls(`${title}\n${description}`)]);
    const sourceUrl = sourceUrls[0] || null;
    let task = await this.store.createTask({
      taskType, idempotencyKey: suppliedIdempotencyKey || `local:${cryptoSafe(title)}:${Date.now()}`, requester: input?.requester || { kind: requesterName === 'A君' ? 'local-owner' : 'lan-collaborator', ref: requesterName }, source: input?.source || { channel: 'ajun-runtime' },
      assigneeAgentId: agent?.agentId || null, parentTaskId: String(input?.parentTaskId || '').trim() || null, recovery: input?.recovery || undefined, input: { title, description, sourceUrl, sourceUrls, context: input?.context || undefined },
      status: agent?.status === 'active' ? 'queued' : 'needs_input', currentStage: agent?.status === 'active' ? 'queued_for_execution' : agent ? 'waiting_for_agent_activation' : 'routing_needed',
      routing: { requestedAgentId, candidateAgentIds: candidates.map((item) => item.agentId), reason: agent?.status === 'active' ? '已路由到已启用的本地执行器。' : agent ? '岗位骨架已登记，等待启用真实执行器。' : candidates.length === 0 ? '没有岗位声明支持该任务类型。' : '多个岗位匹配，请明确选择承接岗位。' }
    });
    if (highRiskWords.test(`${title} ${description}`) && !['army.intake', 'governance.approval-review'].includes(taskType)) {
      await this.store.createApproval({ taskId: task.taskId, governanceMode: requiresOrganizationGovernance(title, description) ? 'paperclip' : 'local', decisionChannel: 'feishu_card', action: 'manual-risk-review', riskLevel: 'high', reason: '任务描述包含高风险动作，必须人工确认范围。', requestedBy: 'task-coordinator', approverScope: 'A君', requestedScope: { taskType, title, assigneeAgentId: agent?.agentId || null }, validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
      task = (await this.store.list()).find((item) => item.taskId === task.taskId);
    }
    const approval = task.approvalRefs.length ? (await this.store.listApprovals()).find((item) => item.approvalId === task.approvalRefs[0]) : null;
    if (this.governance && shouldProjectToPaperclip(task, approval)) {
      const parentIssueId = String(task.input?.context?.parentPaperclipIssueId || '').trim();
      const projection = parentIssueId && this.governance.projectChild ? await this.governance.projectChild(task, parentIssueId) : await this.governance.project(task, approval);
      task = await this.store.updateTask(task.taskId, { governance: projection });
    }
    return this.executeTask(task, agent);
  }

  async continueFromRecommendation(taskId) {
    const parent = (await this.store.list()).find((task) => task.taskId === taskId);
    if (!parent) throw new ValidationError('找不到这条原始任务。');
    const intake = parent.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
    if (parent.status !== 'succeeded' || !intake?.recommendedTaskType || !intake?.recommendedAgentId) {
      throw new ValidationError('这条任务当前没有可继续执行的建议。');
    }
    const existing = (await this.store.list()).find((task) => task.parentTaskId === parent.taskId && task.taskType === intake.recommendedTaskType && task.assigneeAgentId === intake.recommendedAgentId);
    if (existing) return existing;
    if (intake.recommendedTaskType === 'media.transcribe-and-refine' && !parent.input?.sourceUrl) {
      throw new ValidationError('小D需要公开素材链接。请在“指定岗位或任务类型”中选择小D并补上链接后提交。');
    }
    return this.create({
      title: parent.input.title,
      description: parent.input.description,
      sourceUrl: parent.input.sourceUrl,
      sourceUrls: parent.input.sourceUrls,
      requesterName: parent.requester?.ref,
      taskType: intake.recommendedTaskType,
      agentId: intake.recommendedAgentId,
      parentTaskId: parent.taskId,
      context: {
        ...(parent.input?.context || {}),
        ...(intake.advisor ? { intakeAdvisor:intake.advisor } : {}),
        ...(intake.autoContinue === true ? { autoCapabilityAssessment:true } : {})
      },
      idempotencyKey: `intake-continuation:${parent.taskId}:${intake.recommendedTaskType}:${intake.recommendedAgentId}`
    });
  }

  async rejectApproval(approvalId, { decisionBy = 'A君', decisionReason = '本机主人拒绝当前请求范围。', chatRef = '' } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval) throw new ValidationError('找不到这条审批。');
    if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
    if (isExpiredApproval(approval)) {
      await this.expireApproval(approvalId);
      throw new ValidationError('这条审批已过期，任务已自动关闭，未执行任何动作。');
    }
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    if (approval.governanceMode === 'paperclip' && chatRef) throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接拒绝。');
    validateApprovalChat(task, chatRef);
    await this.store.updateApproval(approvalId, { status:'rejected', decisionBy:String(decisionBy).slice(0, 120), decisionReason:String(decisionReason).slice(0, 300), decidedAt:new Date().toISOString() });
    let updated = await this.store.updateTask(task.taskId, { status:'cancelled', currentStage:'approval_rejected', error:{ code:'approval_rejected', message:'本机主人拒绝了当前审批范围。', userMessage:'这项高风险任务已被拒绝并关闭，未执行任何外部动作。', category:'manual', stage:'approval', occurredAt:new Date().toISOString() } });
    if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    return updated;
  }

  startFailureRecovery(task) {
    if (!shouldStartFailureRecovery(task) || typeof this.onTaskFailed !== 'function') return;
    // 恢复链路可能需要受控诊断；原工作已经如实记为失败，不能因此卡住其他工作的返回。
    void Promise.resolve().then(() => this.onTaskFailed(task)).catch(() => undefined);
  }

  async markFailureRecoveryPending(task) {
    if (!shouldStartFailureRecovery(task) || typeof this.onTaskFailed !== 'function') return task;
    return this.store.updateTask(task.taskId, {
      recovery: {
        ...(task.recovery || {}),
        coordination: { status:'pending', requestedAt:new Date().toISOString(), reason:'任务执行出错，正在交给运维官判断安全恢复办法。' }
      }
    });
  }

  async approveApproval(approvalId, { decisionBy = 'A君', decisionReason = '已确认本次范围。', chatRef = '' } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval) throw new ValidationError('找不到这条审批。');
    if (approval.governanceMode === 'paperclip') throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接放行。');
    if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
    if (isExpiredApproval(approval)) {
      await this.expireApproval(approvalId);
      throw new ValidationError('这条审批已过期，任务已自动关闭，未执行任何动作。');
    }
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    validateApprovalChat(task, chatRef);
    validateApprovalScope(task, approval);
    await this.store.updateApproval(approvalId, { status:'approved', decisionBy:String(decisionBy).slice(0, 120), decisionReason:String(decisionReason).slice(0, 300), decidedAt:new Date().toISOString() });
    const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
    const queued = await this.store.updateTask(task.taskId, { status:'queued', currentStage:'approval_approved', error: undefined });
    return this.executeTask(queued, agent);
  }

  async requestPause(taskId) { return this.requestTaskControl(taskId, 'pause-task'); }
  async requestResume(taskId) { return this.requestTaskControl(taskId, 'resume-task'); }

  async requestTaskControl(taskId, action) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task) throw new ValidationError('找不到要控制的任务。');
    const isPause = action === 'pause-task';
    if (!['pause-task', 'resume-task'].includes(action)) throw new ValidationError('不支持这项任务控制。');
    if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) throw new ValidationError('目前只能控制正在由小D处理的任务。');
    if (isPause ? !['queued', 'running', 'pausing'].includes(task.status) : task.status !== 'paused') {
      throw new ValidationError(isPause ? '这条任务当前不能暂停。' : '只有已经暂停的任务可以继续。');
    }
    const existing = (await this.store.listApprovals()).find((approval) => approval.taskId === task.taskId && approval.action === action && approval.status === 'pending');
    if (existing) return { task, approval:existing, duplicate:true };
    const approval = await this.store.createApproval({
      taskId:task.taskId, holdTask:false, governanceMode:'paperclip', decisionChannel:'feishu_card', action, riskLevel:'high',
      reason:isPause ? '暂停会改变一项正在执行的工作。确认后，小D只会在当前步骤完成后的安全位置停下。' : '继续会恢复一项已暂停的工作。确认后，小D会从已保存的安全位置重新检查并继续处理。',
      requestedBy:'A君', approverScope:'A君', requestedScope:{ taskType:task.taskType, title:task.input?.title || '', assigneeAgentId:task.assigneeAgentId || null },
      validUntil:new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    let updated = task;
    if (!this.governance?.project) throw new ValidationError('Paperclip 暂不可用，不能绕过组织级确认。');
    const projection = await this.governance.project(task, approval);
    updated = await this.store.updateTask(task.taskId, { governance:projection, execution:{ ...(task.execution || {}), control:{ action, status:'waiting_approval', approvalId:approval.approvalId, requestedAt:new Date().toISOString() } } });
    return { task:updated, approval, duplicate:false };
  }

  async resolvePaperclipApproval(approvalId, decision, { decisionBy = 'A君', decisionReason = '由飞书组织级审批卡确认。', chatRef = '' } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval) throw new ValidationError('找不到这条审批。');
    if (approval.governanceMode !== 'paperclip') throw new ValidationError('这不是组织级审批。');
    if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
    if (isExpiredApproval(approval)) {
      await this.expireApproval(approvalId);
      throw new ValidationError('这条审批已过期，任务已自动关闭，未执行任何动作。');
    }
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    validateApprovalChat(task, chatRef); validateApprovalScope(task, approval);
    const paperclipApprovalId = String(task.governance?.paperclipApprovalId || '').trim();
    if (!paperclipApprovalId || !this.governance?.resolveApproval) throw new ValidationError('Paperclip 审批投影不存在，未执行任务。');
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new ValidationError('组织级审批决定无效。');
    await this.governance.resolveApproval(paperclipApprovalId, normalized, decisionReason);
    if (['pause-task', 'resume-task'].includes(approval.action)) return this.resolveTaskControlApproval(task, approval, normalized, decisionBy, decisionReason, paperclipApprovalId);
    if (normalized === 'reject') {
      await this.store.updateApproval(approvalId, { status:'rejected', decisionBy:String(decisionBy).slice(0,120), decisionReason:String(decisionReason).slice(0,300), decidedAt:new Date().toISOString(), paperclipApprovalId });
      let closed = await this.store.updateTask(task.taskId, { status:'cancelled', currentStage:'governance_rejected', error:{ code:'governance_rejected', message:'Paperclip 组织级审批已拒绝。', userMessage:'该组织级请求已被拒绝，未执行任何外部动作。', category:'manual', stage:'governance_approval', occurredAt:new Date().toISOString() } });
      if (closed.governance?.paperclipIssueId) closed = await this.store.updateTask(closed.taskId, { governance: await this.governance.update(closed) });
      return closed;
    }
    await this.store.updateApproval(approvalId, { status:'approved', decisionBy:String(decisionBy).slice(0,120), decisionReason:String(decisionReason).slice(0,300), decidedAt:new Date().toISOString(), paperclipApprovalId });
    const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
    const queued = await this.store.updateTask(task.taskId, { status:'queued', currentStage:'governance_approved', error: undefined });
    return this.executeTask(queued, agent);
  }

  async expirePendingApprovals({ now = Date.now() } = {}) {
    const approvals = await this.store.listApprovals();
    const expired = [];
    for (const approval of approvals) {
      if (!isExpiredApproval(approval, now)) continue;
      const result = await this.expireApproval(approval.approvalId, { now });
      if (result.expired) expired.push(result);
    }
    return expired;
  }

  async expireApproval(approvalId, { now = Date.now() } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval || !isExpiredApproval(approval, now)) return { approval, task:null, expired:false };
    const decidedAt = new Date(now).toISOString();
    const expiredApproval = await this.store.updateApproval(approvalId, {
      status:'expired', decisionBy:'A君', decisionReason:'审批已过期，未执行任务。', decidedAt
    });
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) return { approval:expiredApproval, task:null, expired:true };
    if (approval.holdTask === false) {
      const updated = await this.store.updateTask(task.taskId, {
        execution:{ ...(task.execution || {}), control:{ ...(task.execution?.control || {}), action:approval.action, status:'expired', approvalId, decidedAt } }
      });
      return { approval:expiredApproval, task:updated, expired:true };
    }
    if (task.status !== 'waiting_approval') return { approval:expiredApproval, task, expired:true };
    let closed = await this.store.updateTask(task.taskId, {
      status:'cancelled', currentStage:'approval_expired',
      error:{ code:'approval_expired', message:'审批已过期，任务已关闭且未执行。', userMessage:'这项确认已过期，任务没有执行，已自动关闭。', category:'manual', stage:'approval', occurredAt:decidedAt }
    });
    if (this.governance && closed.governance?.paperclipIssueId) {
      try { closed = await this.store.updateTask(closed.taskId, { governance:await this.governance.update(closed) }); }
      catch { /* 本机已如实关闭，Paperclip 恢复后会由既有补同步链路继续处理。 */ }
    }
    return { approval:expiredApproval, task:closed, expired:true };
  }

  async resolveTaskControlApproval(task, approval, decision, decisionBy, decisionReason, paperclipApprovalId) {
    const approved = decision === 'approve';
    await this.store.updateApproval(approval.approvalId, { status:approved ? 'approved' : 'rejected', decisionBy:String(decisionBy).slice(0,120), decisionReason:String(decisionReason).slice(0,300), decidedAt:new Date().toISOString(), paperclipApprovalId });
    if (!approved) {
      let unchanged = await this.store.updateTask(task.taskId, { execution:{ ...(task.execution || {}), control:{ ...(task.execution?.control || {}), action:approval.action, status:'rejected', decidedAt:new Date().toISOString() } } });
      if (unchanged.governance?.paperclipIssueId) unchanged = await this.store.updateTask(unchanged.taskId, { governance:await this.governance.update(unchanged) });
      return unchanged;
    }
    const executor = this.executors.xiaod;
    if (!executor || typeof executor[approval.action === 'pause-task' ? 'pause' : 'resume'] !== 'function') throw new ValidationError('小D当前不支持这项控制，未改变任务状态。');
    const method = approval.action === 'pause-task' ? 'pause' : 'resume';
    const job = await executor[method](task);
    const status = approval.action === 'pause-task' ? (job.status === 'paused' ? 'paused' : 'pausing') : 'running';
    let updated = await this.store.updateTask(task.taskId, {
      status, currentStage:approval.action === 'pause-task' ? `xiaod_${job.status || 'pausing'}` : 'xiaod_resumed', error:undefined,
      execution:{ ...(task.execution || {}), xiaodStatus:job.status, xiaodProgress:job.progress, updatedAt:new Date().toISOString(), control:{ action:approval.action, status:approved ? 'accepted' : 'rejected', approvalId:approval.approvalId, decidedAt:new Date().toISOString() }, polling:{ state:status === 'paused' ? 'settled' : 'pending', consecutiveFailures:0, nextPollAt:status === 'paused' ? null : new Date().toISOString() } }
    });
    if (updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance:await this.governance.update(updated) });
    if (approval.action === 'resume-task' && typeof executor.observe === 'function') executor.observe(updated);
    return updated;
  }

  async resumeApprovedMissionChild(taskId) {
    const child = (await this.store.list()).find((task) => task.taskId === taskId);
    if (!child) throw new ValidationError('找不到多人协作中的子工作。');
    if (child.status !== 'waiting_approval') return child;
    const context = child.input?.context || {};
    const parent = (await this.store.list()).find((task) => task.taskId === child.parentTaskId);
    const approvals = await this.store.listApprovals();
    const parentApproved = parent?.approvalRefs?.some((approvalId) => approvals.some((approval) => approval.approvalId === approvalId && approval.status === 'approved' && approval.governanceMode === 'paperclip'));
    const safeChildType = ['operations.health-review', 'governance.architecture-review'].includes(child.taskType);
    const trustedParent = parent?.taskType === 'army.cross-agent-mission' && ['running', 'succeeded'].includes(parent.status) && context.missionSafeOnly === true && context.missionTaskId === parent.taskId && context.parentPaperclipIssueId === parent.governance?.paperclipIssueId;
    if (!parentApproved || !safeChildType || !trustedParent) throw new ValidationError('这项子工作没有可继承的组织级批准，未继续执行。');
    for (const approvalId of child.approvalRefs || []) {
      const approval = approvals.find((item) => item.approvalId === approvalId);
      if (approval?.status === 'pending') await this.store.updateApproval(approvalId, { status:'superseded', decisionBy:'A君', decisionReason:'父级多人任务已完成组织级确认；这项安全子工作不重复要求确认。', decidedAt:new Date().toISOString() });
    }
    const agent = (await this.registry.list()).find((item) => item.agentId === child.assigneeAgentId) || null;
    const queued = await this.store.updateTask(child.taskId, { status:'queued', currentStage:'parent_scope_approved', error:undefined });
    return this.executeTask(queued, agent);
  }

  async executeTask(task, agent) {
    const executor = agent?.status === 'active' ? this.executors[agent.agentId] || (this.fallbackExecutor?.supports(agent) ? this.fallbackExecutor : null) : null;
    if (!executor || task.status === 'waiting_approval') return task;
    const executionStartedAt = new Date();
    let updated = await this.store.updateTask(task.taskId, { status: 'running', currentStage: 'starting', execution: { executor: agent.agentId, startedAt: executionStartedAt.toISOString() } });
    if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    try {
      const result = await executor.execute(updated);
      updated = await this.store.updateTask(updated.taskId, { ...result, usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }) });
      if (updated.status === 'running' && typeof executor.observe === 'function') executor.observe(updated);
    } catch (error) {
      const result = { status: 'failed', currentStage: 'execution_failed', execution:{ ...(updated.execution || {}), finishedAt:new Date().toISOString(), outcome:'failed' }, error: { code: 'executor_failed', message: String(error?.message || '执行器失败。'), userMessage: '本地任务未能完成，请查看安全诊断。', category: 'manual', stage: 'execution', occurredAt: new Date().toISOString() } };
      updated = await this.store.updateTask(updated.taskId, { ...result, usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }) });
    }
    if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    updated = await this.markFailureRecoveryPending(updated);
    this.startFailureRecovery(updated);
    return updated;
  }

  async recordFeedback(taskId, { sentiment, note = '' } = {}) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task) throw new ValidationError('找不到要评价的工作。');
    if (!['succeeded', 'failed', 'waiting_test', 'cancelled'].includes(task.status)) {
      throw new ValidationError('这件工作还没有结束，暂时不能作为结果评价记录。');
    }
    const normalizedSentiment = sentiment === 'useful' || sentiment === 'needs_improvement' ? sentiment : null;
    if (!normalizedSentiment) throw new ValidationError('评价类型无效。');
    return this.store.updateTask(task.taskId, {
      feedback: {
        sentiment: normalizedSentiment,
        note: String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        receivedAt: new Date().toISOString()
      }
    });
  }

  async overview() {
    const [agents, tasks, approvals, governance] = await Promise.all([this.registry.list(), this.store.list(), this.store.listApprovals(), this.governance?.health() || { status: 'planned', version: null }]);
    const feishuChannel = channelCapability(this.feishuChannelStatus);
    return { agents, tasks, approvals, taskFocus: buildTaskFocus(tasks, approvals), usage:summarizeTaskUsage(tasks, { since:startOfToday() }), capabilities: [
      { id: 'task-coordination', name: '统一任务协调', status: 'ready', detail: '创建、路由和状态真相已就绪。' },
      { id: 'agent-registry', name: '岗位注册表', status: 'ready', detail: '岗位职责、任务类型和权限边界从 Manifest 读取。' },
      { id: 'approval-gate', name: '审批闸门', status: 'ready', detail: '高风险描述先进入待审批，不自动执行。' },
      { id: 'content-public-web-fetch', name: '公开网页内容获取', status: 'ready', detail: '仅读取公开 HTML/纯文本，拒绝内网、登录态和非网页内容。' },
      { id: 'governance', name: 'Paperclip 治理投影', status: governance.status, detail: governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）。` : 'Paperclip 未连接；任务仍可登记，后续可补同步。' },
      { id: 'feishu-channel', name: '飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail },
      { id: 'external-execution', name: '外部账号与写入动作', status: 'planned', detail: '登录型账号连接、外部发布和其他写入动作尚未接入；这类动作仍需要审批。' }
    ] };
  }

  async usageOverview() { return summarizeTaskUsage(await this.store.list(), { since:startOfToday() }); }

  async notificationStatus(taskId, chatRef = '') {
    const tasks = await this.store.list();
    const root = tasks.find((task) => task.taskId === taskId);
    if (!root) throw new ValidationError('找不到要跟进的任务。');
    const expectedChat = String(root.source?.chatRef || '').trim();
    const actualChat = String(chatRef || '').trim();
    if (expectedChat && actualChat !== expectedChat) throw new ValidationError('当前会话不能读取这条任务。');
    const chain = taskChain(tasks, root.taskId);
    if (root.status === 'paused') return { terminal:true, status:'paused', taskId:root.taskId, message:`“${shortTaskTitle(root)}”已经暂停。你确认继续前，小D不会开始新的处理步骤。` };
    if (root.status === 'pausing') return { terminal:false, status:'pausing', taskId:root.taskId, message:`“${shortTaskTitle(root)}”正在暂停。小D会先完成当前一步，再在安全位置停下；不会再开始新的步骤。` };
    const technical = latestTask(chain.filter((task) => task.taskType === 'operations.technical-repair'));
    if (technical?.status === 'waiting_test') {
      const evidence = technical.artifactRefs?.find((item) => item.type === 'technical_repair_evidence')?.data;
      const nextAction = evidence?.nextAction || technical.error?.userMessage || '本轮自动检查没有完成，已保留为待测试。';
      return { terminal:true, status:'waiting_test', taskId:root.taskId, message:`“${shortTaskTitle(root)}”本轮暂时无法完成自动验证，已标为待测试。技术专家已保留当前结果：${nextAction} 其他工作会继续推进，不需要你重复提交。` };
    }
    if (technical?.status === 'succeeded') {
      const evidence = technical.artifactRefs?.find((item) => item.type === 'technical_repair_evidence');
      if (evidence?.validation?.testsPassed === true && evidence?.validation?.recoveryVerified === true) return { terminal:true, status:'repair_verified', taskId:root.taskId, message:`“${shortTaskTitle(root)}”遇到的故障已由技术专家修复，相关测试和恢复检查已经通过；仍待人工验收的项目已保留在记录中。` };
      return { terminal:true, status:'technical_repair', taskId:root.taskId, message:`“${shortTaskTitle(root)}”仍未完成。技术专家已经建立修复记录，但目前没有完整的修改、测试和恢复证据，A君不会把它当作已经修好。` };
    }
    if (technical?.status === 'failed') return { terminal:true, status:'technical_repair_failed', taskId:root.taskId, message:`“${shortTaskTitle(root)}”仍未完成。技术专家本轮也没有修复成功，故障记录已经保留，将继续进入下一轮处理。` };
    if (technical) {
      const stillWorking = ['queued', 'running'].includes(technical.status);
      return {
        terminal: !stillWorking,
        status: 'technical_repair',
        taskId: root.taskId,
        message: `“${shortTaskTitle(root)}”仍未完成。运维官已经尝试安全恢复，现在已升级给技术专家并建立修复任务；暂时不需要你重复提交。`
      };
    }
    const attempts = chain.filter((task) => task.taskType === root.taskType && (task.taskId === root.taskId || task.recovery?.rootTaskId === root.taskId));
    const current = latestTask(attempts) || root;
    const retried = current.taskId !== root.taskId;
    if (current.status === 'succeeded') {
      if (current.taskType === 'report.public-material') {
        const report = current.artifactRefs?.find((item) => item.type === 'public_web_report')?.data;
        if (report?.summary) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatPublicReportReply(report, { taskTitle:shortTaskTitle(root) }) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`公开资料报告员已经完成“${shortTaskTitle(root)}”，但摘要产物没有通过读取确认；系统不会把它当作完整交付。` };
      }
      const delivery = current.artifactRefs?.find((item) => item.type === 'xiaod_media_delivery');
      const url = delivery?.data?.larkUrl;
      const verified = delivery?.data?.larkPermissionGranted === true;
      const prefix = retried ? '运维官自动恢复后，小D已经完成' : '小D已经完成';
      return { terminal: true, status: 'succeeded', taskId: root.taskId, message: url && verified ? `${prefix}“${shortTaskTitle(root)}”。\n交付文档：${url}` : `${prefix}“${shortTaskTitle(root)}”，但飞书文档权限尚未确认；系统不会把它冒充完整交付。` };
    }
    if (['queued', 'running'].includes(current.status)) {
      return { terminal: false, status: current.status, taskId: root.taskId, message: retried ? `“${shortTaskTitle(root)}”第一次处理失败，运维官已自动重试，当前仍在处理中。` : `“${shortTaskTitle(root)}”正在由小D处理。` };
    }
    if (current.status === 'failed' && current.recovery?.coordination?.status === 'pending') {
      return { terminal: false, status: 'recovery_pending', taskId: root.taskId, message: `“${shortTaskTitle(root)}”遇到故障，正在交给运维官判断恢复办法。` };
    }
    if (current.status === 'failed' && current.recovery?.coordination?.status === 'retrying') {
      return { terminal: false, status: 'recovery_pending', taskId: root.taskId, message: `“${shortTaskTitle(root)}”遇到故障，运维官已接手并正在从安全断点恢复；不需要你重复提交。` };
    }
    if (current.status === 'failed' && current.taskType === 'media.transcribe-and-refine' && !current.recovery?.coordination) {
      return { terminal: false, status: 'recovery_pending', taskId: root.taskId, message: `“${shortTaskTitle(root)}”遇到故障，正在交给运维官判断恢复办法。` };
    }
    if (current.recovery?.coordination?.status === 'pending') return { terminal: false, status: 'recovery_pending', taskId: root.taskId, message: `“${shortTaskTitle(root)}”遇到故障，正在等待运维官接手。` };
    if (current.status === 'waiting_test') return { terminal:true, status:'waiting_test', taskId:root.taskId, message:`“${shortTaskTitle(root)}”本轮自动检查没有完成，已标为待测试。其他工作会继续推进；这项检查恢复后会按记录继续。` };
    if (current.status === 'needs_input') return { terminal: true, status: 'needs_input', taskId: root.taskId, message: current.error?.userMessage || `“${shortTaskTitle(root)}”缺少必要信息，暂时不能继续。` };
    if (current.status === 'failed') return { terminal: true, status: 'failed', taskId: root.taskId, message: `“${shortTaskTitle(root)}”没有完成：${current.error?.userMessage || '处理时遇到问题。'}` };
    return { terminal: false, status: current.status || 'unknown', taskId: root.taskId, message: `“${shortTaskTitle(root)}”已经登记，等待新的进度。` };
  }
}

export class ValidationError extends Error {}
function channelCapability(source) {
  const state = typeof source === 'function' ? source() : source;
  if (state?.status === 'connected') return { status:'ready', detail:'官方飞书入口已连接；消息、审批卡会回到原聊天，现有 A君入口仍可保留。' };
  if (state?.status === 'connecting') return { status:'partial', detail:'官方飞书入口正在连接；现有 A君入口仍可用。' };
  if (state?.status === 'failed') return { status:'partial', detail:'官方飞书入口本次没有连上；现有 A君入口不受影响，问题已记录等待处理。' };
  return { status:'partial', detail:'A君私聊与审批卡已可用；官方收发入口已装好并默认关闭，待限定允许人员后接入官方通道并做真实飞书回归。' };
}
function cryptoSafe(value) { return Buffer.from(value).toString('base64url').slice(0, 24); }
function extractPublicUrls(value) { return [...String(value).matchAll(/https?:\/\/[^\s<>"]+/gi)].map((match) => match[0].replace(/[),.;，。；]+$/, '')); }
function uniquePublicUrls(values) { return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]; }
function shouldProjectToPaperclip(task, approval = null) {
  return approval?.governanceMode === 'paperclip' || task.source?.channel === 'paperclip' || task.source?.channel === 'army-mission' || task.taskType.startsWith('governance.') || task.taskType === 'army.route-task' || task.taskType === 'army.cross-agent-mission' || task.taskType === 'operations.technical-repair';
}

function requiresOrganizationGovernance(title, description) { return organizationGovernanceWords.test(`${title} ${description}`); }
function shouldStartFailureRecovery(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task.taskType);
}
function validateApprovalScope(task, approval) {
  const scope = approval.requestedScope || {};
  if (scope.taskType !== task.taskType || scope.title !== task.input?.title || scope.assigneeAgentId !== (task.assigneeAgentId || null)) {
    throw new ValidationError('审批范围与当前任务不一致，未执行任务。');
  }
}
function validateApprovalChat(task, chatRef) {
  const expected = String(task.source?.chatRef || '').trim(); const actual = String(chatRef || '').trim();
  if (actual && expected && actual !== expected) throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function isExpiredApproval(approval, now = Date.now()) {
  const validUntil = Date.parse(approval?.validUntil || '');
  return approval?.status === 'pending' && Number.isFinite(validUntil) && validUntil <= now;
}

function buildTaskFocus(tasks, approvals) {
  const counts = Object.fromEntries(['queued', 'running', 'pausing', 'paused', 'waiting_approval', 'waiting_test', 'needs_input', 'succeeded', 'failed'].map((status) => [status, tasks.filter((task) => task.status === status).length]));
  const priority = ['waiting_approval', 'needs_input', 'pausing', 'running', 'queued', 'paused', 'failed', 'waiting_test'];
  const pendingContinuation = tasks.find((task) => task.status === 'succeeded' && intakeRecommendation(task) && !tasks.some((child) => child.parentTaskId === task.taskId));
  const current = priority.flatMap((status) => tasks.filter((task) => task.status === status))[0] || pendingContinuation || null;
  const approval = current ? approvals.find((item) => current.approvalRefs?.includes(item.approvalId) && item.status === 'pending') : null;
  return {
    total: tasks.length,
    completed: counts.succeeded,
    inProgress: counts.queued + counts.running + counts.pausing,
    paused: counts.paused,
    needsInput: counts.needs_input,
    waitingApproval: counts.waiting_approval,
    waitingTest: counts.waiting_test,
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
  if (task.status === 'waiting_test') return task.error?.userMessage || '自动检查没有在本轮完成；已保留为待测试，不影响其他任务继续。';
  if (task.status === 'pausing') return '正在暂停，会在当前步骤完成后的安全位置停下。';
  if (task.status === 'paused') return '这项任务已暂停，确认继续前不会开始新的处理步骤。';
  if (task.status === 'failed') return task.error?.userMessage || '这项任务未完成，请根据错误信息决定是否重试或补充信息。';
  if (task.status === 'running') return '任务正在处理，等待新的进度或结果。';
  return '任务已排队，等待本地执行器开始处理。';
}

function intakeRecommendation(task) {
  const intake = task.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
  return intake?.recommendedTaskType && intake?.recommendedAgentId ? intake : null;
}

function taskChain(tasks, rootTaskId) {
  const included = new Set([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskId && included.has(task.parentTaskId) && !included.has(task.taskId)) { included.add(task.taskId); changed = true; }
    }
  }
  return tasks.filter((task) => included.has(task.taskId));
}

function latestTask(tasks) {
  return [...tasks].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null;
}

function shortTaskTitle(task) { return String(task.input?.title || '未命名任务').replace(/\s+/g, ' ').slice(0, 48); }
function startOfToday() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
