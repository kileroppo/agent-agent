import { summarizeTaskUsage } from './task-usage.js';
import { buildArchitectureGroundTruth } from './architecture-evidence.js';
import { presentTask } from './task-presentation.js';
import { WECHAT_CHAT_TASK_TYPE } from './wechat-chat-defaults.js';
import { SkillExecutionRegistry } from './skill-execution-registry.js';
import { TaskCapabilityCatalog } from './task-capability-catalog.js';
import { TaskExecutionCoordinator } from './task-execution-coordinator.js';
import { TaskIntake } from './task-intake.js';
import { TaskNotification } from './task-notification.js';
import { taskServiceExecutionMethods } from './task-service-execution.js';
import { ValidationError } from './task-service-execution-support.js';
export { ValidationError } from './task-service-execution-support.js';
import { buildTaskFocus } from './task-overview-focus.js';
import { privateReadGrantStatus, revokePrivateReadGrant } from './private-read-grant.js';

export class TaskService {
  constructor({
    registry,
    store,
    governance = null,
    executors = {},
    fallbackExecutor = null,
    onTaskFailed = null,
    feishuChannelStatus = null,
    agentChannelStates = null,
    workerStatus = null,
    contentGrowthWaitMs = 240_000,
    taskDetailBaseUrl = '',
    roleToolAdapters = {},
    m5ProviderVision = null,
    m5WorkProductValidator = null,
    skillExecutionRegistry = new SkillExecutionRegistry(),
    capabilityCatalog = new TaskCapabilityCatalog({ executors }),
    localAiCapabilityStatus = null,
  }) {
    this.registry = registry;
    this.store = store;
    this.governance = governance;
    this.executors = executors;
    this.capabilityCatalog = capabilityCatalog;
    this.fallbackExecutor = fallbackExecutor;
    this.onTaskFailed = onTaskFailed;
    this.feishuChannelStatus = feishuChannelStatus;
    this.agentChannelStates = agentChannelStates;
    this.workerStatus = workerStatus;
    this.taskDetailBaseUrl = taskDetailBaseUrl;
    this.roleToolAdapters = roleToolAdapters;
    this.m5ProviderVision = typeof m5ProviderVision === 'function'
      ? m5ProviderVision
      : null;
    this.m5WorkProductValidator = typeof m5WorkProductValidator === 'function'
      ? m5WorkProductValidator
      : null;
    this.skillExecutionRegistry = skillExecutionRegistry;
    this.localAiCapabilityStatus = typeof localAiCapabilityStatus === 'function' ? localAiCapabilityStatus : null;
    this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240_000, 240_000));
    this.contentGrowthRuns = new Map();
    this.employeeAssignmentRuns = new Map();
    this.m5WorkProductObserver = null;
    this.executionCoordinator = new TaskExecutionCoordinator({
      store,
      governance,
      capabilityCatalog,
      executorResolver:(agentId) => capabilityCatalog.executor(agentId, this.executors),
      fallbackExecutor,
      fallbackExecutorResolver:() => this.fallbackExecutor,
      markFailureRecoveryPending:(task) => this.markFailureRecoveryPending(task),
      startFailureRecovery:(task) => this.startFailureRecovery(task),
    });
    this.intake = new TaskIntake({
      registry,
      store,
      governance,
      execute:(task, agent) => this.executeTask(task, agent),
    });
    this.notification = new TaskNotification({ store, registry, executors });
  }

  setFeishuChannelStatus(status) { this.feishuChannelStatus = status; }
  setAgentChannelStates(status) { this.agentChannelStates = status; }
  setWorkerStatus(status) { this.workerStatus = status; }
  setM5WorkProductObserver(observer) { this.m5WorkProductObserver = observer; }

  async architectureGroundTruth() {
    return buildArchitectureGroundTruth({
      agents:await this.registry.list({ includeInactive:true }),
      tasks:await this.store.list()
    });
  }

  async create(input) {
    return this.intake.create(input);
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
    if (approval.action === 'confirm-transcript-after-complete-listen' && typeof this.executors.xiaod?.rejectTranscript === 'function') {
      await this.executors.xiaod.rejectTranscript(task, { reviewerRef:decisionBy });
    }
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
    if (approval.action === 'confirm-transcript-after-complete-listen') {
      const xiaod = this.executors.xiaod;
      if (typeof xiaod?.confirmTranscript !== 'function') throw new ValidationError('小D确认稿能力当前不可用，未生成确认稿。');
      await xiaod.confirmTranscript(task, { reviewerRef:decisionBy });
      return this.store.updateTask(task.taskId, {
        status:'running',
        currentStage:'xiaod_review_confirmed',
        error:undefined,
        execution:{ ...(task.execution || {}), polling:{ state:'pending', consecutiveFailures:0, nextPollAt:new Date().toISOString() } }
      });
    }
    const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
    const queued = await this.store.updateTask(task.taskId, { status:'queued', currentStage:'approval_approved', error: undefined });
    return this.executeTask(queued, agent);
  }

  async revokePrivateReadGrant(approvalId, { revokedBy = 'A君', chatRef = '' } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval || approval.action !== 'wechat-private-chat-read') throw new ValidationError('找不到这条微信临时授权。');
    if (!approval.privateReadGrant) throw new ValidationError('这条审批尚未生成可撤销的微信临时授权。');
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    validateApprovalChat(task, chatRef);
    if (approval.privateReadGrant.revokedAt) return {
      ...approval,
      privateReadGrantStatus:privateReadGrantStatus(approval.privateReadGrant),
    };
    const updated = await this.store.updateApproval(approvalId, {
      privateReadGrant:{
        ...revokePrivateReadGrant(approval.privateReadGrant),
        revokedBy:String(revokedBy || 'A君').slice(0, 120),
      },
    });
    return {
      ...updated,
      privateReadGrantStatus:privateReadGrantStatus(updated.privateReadGrant),
    };
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
    const safeChildType = [
      'operations.health-review',
      'governance.architecture-review',
      'media.transcribe-and-refine',
      'research.intel-report',
      'office.briefing-package'
    ].includes(child.taskType);
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
    return this.executionCoordinator.execute(task, agent);
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
    const [agents, manager, tasks, approvals, governance, skillReadiness, localAi] = await Promise.all([this.registry.list(), this.registry.get('ajun'), this.store.list(), this.store.listApprovals(), this.governance?.health() || { status: 'planned', version: null }, this.skillExecutionRegistry.overview(), this.localAiCapabilityStatus?.() || null]);
    const runtimeHealth = await executorRuntimeHealth(this.executors);
    const feishuChannel = channelCapability(this.feishuChannelStatus);
    const agentChannels = safeAgentChannelStates(this.agentChannelStates);
    const worker = safeWorkerStatus(this.workerStatus, tasks);
    const visibleAgents = agents.map((agent) => ({
      ...agent,
      ...(runtimeHealth[agent.agentId] ? { runtimeHealth:runtimeHealth[agent.agentId] } : {}),
      ...(agent.interaction?.directFeishu !== 'disabled' && agentChannels[agent.agentId]
        ? { feishuChannel:withFeishuTaskEvidence(agentChannels[agent.agentId], agent.agentId, tasks) }
        : {})
    }));
    const onDemandAgents = visibleAgents.filter((agent) => agent.interaction?.directFeishu === 'disabled');
    const alwaysOnAgents = [
      ...(manager ? [manager] : []),
      ...visibleAgents.filter((agent) => agent.interaction?.directFeishu !== 'disabled')
    ];
    const presentedTasks = tasks.map((task) => ({
      ...task,
      presentation:presentTask(task, { approvals, detailBaseUrl:this.taskDetailBaseUrl })
    }));
    const presentedApprovals = approvals.map((approval) => ({
      ...approval,
      ...(approval.privateReadGrant ? { privateReadGrantStatus:privateReadGrantStatus(approval.privateReadGrant) } : {}),
    }));
    const capabilities = [
      { id: 'task-coordination', name: '统一任务协调', status: 'ready', detail: '创建、路由和状态真相已就绪。' },
      { id: 'agent-registry', name: '岗位注册表', status: 'ready', detail: '岗位职责、任务类型和权限边界从 Manifest 读取。' },
      { id: 'approval-gate', name: '审批闸门', status: 'ready', detail: '高风险描述先进入待审批，不自动执行。' },
      { id: 'content-public-web-fetch', name: '公开资料读取', status: 'ready', detail: '可读取公开网页、动态页面和 PDF；拒绝内网、登录态与越权内容。' },
      { id: 'authorized-content-read', name: '登录平台只读采集', status: 'partial', detail: '小D已接入受控账号和平台专用通道；当前是否可读以“连接”页和具体任务验证为准。' },
      { id: 'governance', name: 'Paperclip 治理投影', status: governance.status, detail: governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）。` : 'Paperclip 未连接；任务仍可登记，后续可补同步。' },
      { id: 'feishu-channel', name: '飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail },
      { id: 'mac-worker', name: 'Mac工作间安全接力', status:worker.status, detail:worker.detail },
      ...(localAi ? [{
        id:'local-ai',
        name:'本机 AI 全能力网关',
        status:localAi.status === 'healthy' ? 'ready' : localAi.status === 'degraded' ? 'partial' : 'unavailable',
        detail:String(localAi.safeMessage || '本机 AI 网关状态未知。').slice(0, 300),
      }] : []),
      { id: 'external-execution', name: '外部发布与写入', status: 'planned', detail: '外部发布和其他写入动作尚未接入；登录型只读采集不等于已经开放写入。' }
    ];
    const presentationSkill = skillReadiness.find((item) => item.slug === 'open-kimi-ppt');
    if (presentationSkill) {
      const composeStatus = presentationSkill.modes?.compose?.status || presentationSkill.status;
      const exportStatus = presentationSkill.modes?.export?.status || presentationSkill.status;
      capabilities.push({
        id:'office-presentation',
        name:'小办演示文稿',
        status:composeStatus === 'ready' && exportStatus === 'ready'
          ? 'ready'
          : composeStatus === 'ready' ? 'partial' : 'unavailable',
        detail:[
          `PPTD ${composeStatus === 'ready' ? '可用' : `不可用（${composeStatus}）`}`,
          `PPTX ${exportStatus === 'ready' ? '可用' : `暂不可用（${exportStatus}）`}`,
          presentationSkill.recovery,
        ].filter(Boolean).join('；').slice(0, 500),
      });
    }
    const wechatHealth = runtimeHealth['wechat-chat-retriever'];
    if (wechatHealth) capabilities.push({
      id:'wechat-private-read',
      name:'微信本机只读',
      status:wechatHealth.status === 'healthy' ? 'ready' : wechatHealth.status === 'degraded' ? 'partial' : 'unavailable',
      detail:wechatHealth.safeMessage
    });
    return { agents:visibleAgents, alwaysOnAgents, onDemandAgents, tasks:presentedTasks, approvals:presentedApprovals, skillReadiness, taskFocus: buildTaskFocus(tasks, approvals), usage:summarizeTaskUsage(tasks, { since:startOfToday() }), capabilities };
  }

  async usageOverview() { return summarizeTaskUsage(await this.store.list(), { since:startOfToday() }); }

  async notificationStatus(taskId, chatRef = '') {
    return this.notification.status(taskId, chatRef);
  }
}


Object.assign(TaskService.prototype, taskServiceExecutionMethods);

function safeAgentChannelStates(source) {
  try {
    const states = typeof source === 'function' ? source() : source;
    return Object.fromEntries(Object.entries(states || {}).flatMap(([agentId, state]) => {
      const status = String(state?.status || '').trim();
      const message = String(state?.message || '').trim();
      return status && message ? [[agentId, { status, message }]] : [];
    }));
  } catch { return {}; }
}

function safeWorkerStatus(source, tasks) {
  try {
    const value = typeof source === 'function' ? source(tasks) : source;
    const status = String(value?.status || '').trim();
    const detail = String(value?.detail || '').trim();
    return status && detail ? { status, detail } : { status:'local', detail:'当前由本机直接承接需要 Mac 的工作。' };
  } catch {
    return { status:'degraded', detail:'暂时无法读取 Mac工作间连接状态；任务事实不受影响。' };
  }
}

function withFeishuTaskEvidence(channel, agentId, tasks) {
  const verified = ['connected', 'external'].includes(channel.status) && (tasks || []).some((task) => task.source?.channel === 'feishu'
    && task.source?.targetAgentId === agentId
    && ['succeeded', 'failed', 'waiting_test', 'cancelled'].includes(task.status));
  return verified ? { ...channel, verified:true } : channel;
}

function channelCapability(source) {
  const state = typeof source === 'function' ? source() : source;
  if (state?.status === 'external') return { status:'ready', detail:state.message || 'A君飞书入口已由 Hermes 原生 Gateway 承载；会话、上下文与 MCP 工具链已接通。' };
  if (state?.status === 'connected') return { status:'ready', detail:'官方飞书入口已连接；消息、审批卡会回到原聊天，现有 A君入口仍可保留。' };
  if (state?.status === 'connecting') return { status:'partial', detail:'官方飞书入口正在连接；现有 A君入口仍可用。' };
  if (state?.status === 'failed') return { status:'partial', detail:'官方飞书入口本次没有连上；现有 A君入口不受影响，问题已记录等待处理。' };
  return { status:'partial', detail:'A君私聊与审批卡已可用；官方收发入口已装好并默认关闭，待限定允许人员后接入官方通道并做真实飞书回归。' };
}
function shouldStartFailureRecovery(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair', WECHAT_CHAT_TASK_TYPE].includes(task.taskType);
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

async function executorRuntimeHealth(executors) {
  const entries = await Promise.all(Object.entries(executors || {}).map(async ([agentId, executor]) => {
    if (typeof executor?.health !== 'function') return null;
    try {
      const value = await executor.health();
      const status = ['healthy', 'degraded', 'unavailable'].includes(value?.status)
        ? value.status
        : 'unavailable';
      return [agentId, {
        status,
        checkedAt:String(value?.checkedAt || ''),
        requiredDatabases:{
          contact:value?.requiredDatabases?.contact === true,
          session:value?.requiredDatabases?.session === true,
          message:value?.requiredDatabases?.message === true
        },
        safeMessage:String(value?.safeMessage || '本机执行器健康状态未知。').replace(/\s+/g, ' ').trim().slice(0, 300)
      }];
    } catch {
      return [agentId, {
        status:'unavailable',
        checkedAt:'',
        requiredDatabases:{ contact:false, session:false, message:false },
        safeMessage:'本机执行器健康检查失败，请由运维官检查。'
      }];
    }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

function startOfToday() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
