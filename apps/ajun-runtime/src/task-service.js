import { buildArchitectureGroundTruth } from './architecture-evidence.js';
import { WECHAT_CHAT_TASK_TYPE } from './wechat-chat-defaults.js';
import { SkillExecutionRegistry } from './skill-execution-registry.js';
import { TaskCapabilityCatalog } from './task-capability-catalog.js';
import { TaskExecutionCoordinator } from './task-execution-coordinator.js';
import { TaskIntake } from './task-intake.js';
import { TaskNotification } from './task-notification.js';
import { TaskRecordService } from './task-record-service.js';
import { TaskRecovery } from './task-recovery.js';
import { OfficePresentationExecution } from './office-presentation-execution.js';
import { taskServiceExecutionMethods } from './task-service-execution.js';
import { ValidationError } from './task-service-execution-support.js';
export { ValidationError } from './task-service-execution-support.js';
import { privateReadGrantStatus, revokePrivateReadGrant } from './private-read-grant.js';
import { taskApprovalCoordinatorMethods } from './task-approval-coordinator.js';
import { TaskOverview } from './task-overview.js';

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
    officePresentationWorkspaceRoot = null,
    usageLedger = null,
    missionChildPolicy = null,
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
    this.usageLedger = usageLedger;
    this.missionChildPolicy = missionChildPolicy;
    this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240_000, 240_000));
    this.contentGrowthRuns = new Map();
    this.employeeAssignmentRuns = new Map();
    this.approvalResolutionRuns = new Map();
    this.taskControlRuns = new Map();
    this.xiaodDeliveryRequestRuns = new Map();
    this.xiaodDeliveryRuns = new Map();
    this.paperclipAssignmentCompletionRuns = new Map();
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
    this.officePresentationExecution = new OfficePresentationExecution({
      workspaceRoot:officePresentationWorkspaceRoot,
      store,
      governance,
      capabilityCatalog,
      executorResolver:(agentId) => capabilityCatalog.executor(agentId, this.executors),
      roleToolAdapters,
    });
    this.intake = new TaskIntake({
      registry,
      store,
      governance,
      execute:(task, agent) => this.executeTask(task, agent),
    });
    this.notification = new TaskNotification({ store, registry, executors });
    this.taskRecovery = new TaskRecovery({
      store,
      recover:typeof onTaskFailed === 'function' ? (task, input) => this.onTaskFailed(task, input) : null,
      createTask:(input) => this.create(input),
    });
    this.taskRecords = new TaskRecordService({ store, taskDetailBaseUrl, taskRecovery:this.taskRecovery });
    this.taskOverview = new TaskOverview({
      registry,
      store,
      governance,
      executors,
      capabilityCatalog,
      skillExecutionRegistry,
      localAiCapabilityStatus:this.localAiCapabilityStatus,
      usageLedger,
      taskDetailBaseUrl,
      getFeishuChannelStatus:() => this.feishuChannelStatus,
      getAgentChannelStates:() => this.agentChannelStates,
      getWorkerStatus:() => this.workerStatus,
    });
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
      workflowId:parent.workflow?.workflowId,
      workflowType:parent.workflow?.workflowType,
      context: {
        ...(parent.input?.context || {}),
        ...(intake.advisor ? { intakeAdvisor:intake.advisor } : {}),
        ...(intake.autoContinue === true ? { autoCapabilityAssessment:true } : {})
      },
      idempotencyKey: `intake-continuation:${parent.taskId}:${intake.recommendedTaskType}:${intake.recommendedAgentId}`
    });
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
    ].includes(child.taskType) || this.missionChildPolicy?.allowsApprovalInheritance({ child, parent }) === true;
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
    if (this.officePresentationExecution.supports(task, agent)) {
      return this.officePresentationExecution.execute(task, agent);
    }
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
    const receivedAt = new Date().toISOString();
    const normalizedNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return this.store.updateTask(task.taskId, {
      feedback: {
        sentiment: normalizedSentiment,
        note:normalizedNote,
        receivedAt,
      },
      evaluation:{
        ...(task.evaluation || {}),
        humanAcceptance:{
          status:normalizedSentiment === 'useful' ? 'accepted' : 'revision_required',
          note:normalizedNote,
          source:'feishu_feedback',
          decidedAt:receivedAt,
        },
      },
    });
  }

  async overview({ includeTasks = true } = {}) {
    return this.taskOverview.read({ includeTasks });
  }

  async consoleOverview() { return this.overview({ includeTasks:false }); }

  async listTaskRecords(query = {}, { audience = 'lan' } = {}) { return this.taskRecords.list(query, { audience }); }

  async taskRecordDetail(taskId, { audience = 'lan' } = {}) { return this.taskRecords.detail(taskId, { audience }); }

  async recoveryView(taskOrId, options = {}) { return this.taskRecovery.view(taskOrId, options); }

  async requestRecovery(taskId, input, actor = {}) { return this.taskRecovery.request(taskId, input, actor); }

  async usageOverview() {
    return this.taskOverview.usage();
  }

  async notificationStatus(taskId, chatRef = '') {
    return this.notification.status(taskId, chatRef);
  }
}


Object.assign(TaskService.prototype, taskServiceExecutionMethods);
Object.assign(TaskService.prototype, taskApprovalCoordinatorMethods);

function shouldStartFailureRecovery(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair', WECHAT_CHAT_TASK_TYPE].includes(task.taskType);
}
function validateApprovalChat(task, chatRef) {
  const expected = String(task.source?.chatRef || '').trim(); const actual = String(chatRef || '').trim();
  if (actual && expected && actual !== expected) throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function isExpiredApproval(approval, now = Date.now()) {
  const validUntil = Date.parse(approval?.validUntil || '');
  return approval?.status === 'pending' && Number.isFinite(validUntil) && validUntil <= now;
}
