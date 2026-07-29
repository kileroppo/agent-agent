import { recordTaskUsage, summarizeTaskUsage } from './task-usage.js';
import { formatPublicReportReply } from './public-report-presentation.js';
import { formatOfficeBriefingReply } from './local-office-assistant.js';
import { canonicalizeBusinessAssignment, githubRepositoryQuery } from './business-task-routing.js';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { buildArchitectureGroundTruth, validateArchitectureEvidenceRefs } from './architecture-evidence.js';

const highRiskActions = ['外发', '发布', '删除', '付款', '付费', '扩权', '敏感'];
const organizationGovernanceWords = /创建.*(?:agent|智能体|岗位)|新建.*(?:agent|智能体|岗位)|扩权|账号|连接|公开发布|对外发布|付款|付费|预算|暂停|终止|跨\s*agent/i;

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
    contentGrowthWaitMs = 240_000
  }) {
    this.registry = registry;
    this.store = store;
    this.governance = governance;
    this.executors = executors;
    this.fallbackExecutor = fallbackExecutor;
    this.onTaskFailed = onTaskFailed;
    this.feishuChannelStatus = feishuChannelStatus;
    this.agentChannelStates = agentChannelStates;
    this.workerStatus = workerStatus;
    this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240_000, 240_000));
    this.contentGrowthRuns = new Map();
  }

  setFeishuChannelStatus(status) { this.feishuChannelStatus = status; }
  setAgentChannelStates(status) { this.agentChannelStates = status; }
  setWorkerStatus(status) { this.workerStatus = status; }

  async architectureGroundTruth() {
    return buildArchitectureGroundTruth({
      agents:await this.registry.list({ includeInactive:true }),
      tasks:await this.store.list()
    });
  }

  async create(input) {
    const rawRequested = {
      title:input?.title,
      description:input?.description,
      taskType:input?.taskType,
      agentId:input?.agentId,
      dependsOnPrevious:input?.context?.dependsOnPrevious === true
    };
    // 军团父任务是控制面信封，不能因标题中出现“老板汇报”而被改写成办公子任务。
    // 业务分工仍会在 mission plan、MCP 边界和每个子任务创建时分别规范化。
    const requested = String(rawRequested.taskType || '').startsWith('army.')
      ? {
          ...rawRequested,
          title:String(rawRequested.title || '').trim(),
          description:String(rawRequested.description || '').trim(),
          taskType:String(rawRequested.taskType || '').trim(),
          agentId:String(rawRequested.agentId || '').trim()
        }
      : canonicalizeBusinessAssignment(rawRequested);
    const title = requested.title; const taskType = requested.taskType;
    if (!title) throw new ValidationError('请说明要完成什么。');
    if (!taskType) throw new ValidationError('请选择任务类型。');
    const suppliedIdempotencyKey = String(input?.idempotencyKey || '').trim();
    if (suppliedIdempotencyKey) {
      const existing = (await this.store.list()).find((item) => item.idempotencyKey === suppliedIdempotencyKey);
      if (existing) return existing;
    }
    const requesterName = String(input?.requesterName || '').trim() || 'A君';
    const requestedAgentId = requested.agentId || null;
    let candidates = await this.registry.candidates(taskType);
    if (requestedAgentId) candidates = candidates.filter((agent) => agent.agentId === requestedAgentId);
    const agent = candidates.length === 1 ? candidates[0] : null;
    const description = requested.description;
    const sourceUrls = uniquePublicUrls([String(input?.sourceUrl || '').trim(), ...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), ...extractPublicUrls(`${title}\n${description}`)]);
    const sourceUrl = sourceUrls[0] || null;
    let task = await this.store.createTask({
      taskType, idempotencyKey: suppliedIdempotencyKey || `local:${cryptoSafe(title)}:${Date.now()}`, requester: input?.requester || { kind: requesterName === 'A君' ? 'local-owner' : 'lan-collaborator', ref: requesterName }, source: input?.source || { channel: 'ajun-runtime' },
      assigneeAgentId: agent?.agentId || null, parentTaskId: String(input?.parentTaskId || '').trim() || null, recovery: input?.recovery || undefined, input: {
        title,
        description,
        sourceUrl,
        sourceUrls,
        query:githubQueryInput(taskType, input?.query, `${title}\n${description}`),
        repo:optionalInput(input?.repo),
        path:optionalInput(input?.path),
        topic:optionalInput(input?.topic),
        reviewPolicy:input?.reviewPolicy === 'required' ? 'required' : 'optional',
        evidenceMode:input?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
        depth:input?.depth === 'full' ? 'full' : 'fast',
        visualMode:input?.visualMode === 'auto' || input?.visualMode === 'required'
          ? input.visualMode
          : input?.visualMode === 'off'
            ? 'off'
            : taskType === 'content.video-benchmark-analysis'
              ? 'auto'
              : 'off',
        focus:optionalInput(input?.focus),
        platforms:Array.isArray(input?.platforms) ? input.platforms.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10) : undefined,
        contentGoal:optionalInput(input?.contentGoal),
        durationSeconds:Number.isFinite(Number(input?.durationSeconds)) ? Number(input.durationSeconds) : undefined,
        researchMode:input?.researchMode === 'off' ? 'off' : 'auto',
        approvedForUse:input?.approvedForUse === true,
        sourceScriptTaskId:optionalInput(input?.sourceScriptTaskId),
        metrics:input?.metrics && typeof input.metrics === 'object' && !Array.isArray(input.metrics) ? input.metrics : undefined,
        context: input?.context || undefined
      },
      status: agent?.status === 'active' ? 'queued' : 'needs_input', currentStage: agent?.status === 'active' ? 'queued_for_execution' : agent ? 'waiting_for_agent_activation' : 'routing_needed',
      routing: { requestedAgentId, candidateAgentIds: candidates.map((item) => item.agentId), reason: agent?.status === 'active' ? '已路由到已启用的本地执行器。' : agent ? '岗位骨架已登记，等待启用真实执行器。' : candidates.length === 0 ? '没有岗位声明支持该任务类型。' : '多个岗位匹配，请明确选择承接岗位。' }
    });
    if (hasAffirmativeHighRiskIntent(`${title} ${description}`)
      && !['army.intake', 'governance.approval-review', 'office.knowledge-summary', 'content.platform-draft', 'content.video-script-package'].includes(taskType)) {
      await this.store.createApproval({ taskId: task.taskId, governanceMode: requiresOrganizationGovernance(title, description) ? 'paperclip' : 'local', decisionChannel: 'feishu_card', action: 'manual-risk-review', riskLevel: 'high', reason: '任务描述包含高风险动作，必须人工确认范围。', requestedBy: 'ajun', approverScope: 'A君', requestedScope: { taskType, title, assigneeAgentId: agent?.agentId || null }, validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
      task = (await this.store.list()).find((item) => item.taskId === task.taskId);
    }
    const approval = task.approvalRefs.length ? (await this.store.listApprovals()).find((item) => item.approvalId === task.approvalRefs[0]) : null;
    if (this.governance && (usesPaperclipHermesExecution(agent) || shouldProjectToPaperclip(task, approval))) {
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
    if (usesPaperclipHermesExecution(agent) && task.status !== 'waiting_approval') {
      const projected = Boolean(task.governance?.paperclipIssueId);
      return this.store.updateTask(task.taskId, {
        status:projected ? 'running' : 'needs_input',
        currentStage:projected ? 'waiting_paperclip_heartbeat' : 'waiting_governance',
        execution:{
          ...(task.execution || {}),
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipIssueId:task.governance?.paperclipIssueId || null,
          delegatedAt:new Date().toISOString()
        },
        ...(!projected ? {
          error:{
            code:'paperclip_projection_required',
            message:task.governance?.reason || 'Paperclip 任务投影尚未建立。',
            userMessage:'这名员工由 Paperclip 唤醒；治理总控恢复前不会改走本地重复执行器。',
            category:'governance',
            stage:'paperclip_projection',
            retryable:true,
            occurredAt:new Date().toISOString()
          }
        } : { error:undefined })
      });
    }
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
      const result = {
        status: 'failed',
        currentStage: 'execution_failed',
        execution:{ ...(updated.execution || {}), finishedAt:new Date().toISOString(), outcome:'failed' },
        error: {
          code:String(error?.code || 'executor_failed').slice(0, 120),
          message:String(error?.message || '执行器失败。').slice(0, 500),
          userMessage:'本地任务未能完成，请查看安全诊断。',
          category:String(error?.category || 'manual').slice(0, 80),
          stage:'execution',
          retryable:error?.retryable === true,
          occurredAt:new Date().toISOString()
        }
      };
      updated = await this.store.updateTask(updated.taskId, { ...result, usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }) });
    }
    if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    updated = await this.markFailureRecoveryPending(updated);
    this.startFailureRecovery(updated);
    return updated;
  }

  async getPaperclipAssignment(input = {}) {
    if (!this.governance?.verifyHermesAssignment) throw new ValidationError('Paperclip 任务校验能力不可用。');
    const identity = await this.governance.verifyHermesAssignment(input);
    const agent = await this.registry.get(identity.agentArmyId);
    if (!usesPaperclipHermesExecution(agent)) throw new ValidationError('当前岗位未启用 Paperclip Hermes 执行。');
    let task = (await this.store.list()).find((item) => item.governance?.paperclipIssueId === identity.issue.id);
    if (!task) {
      const acceptedTaskType = agent.acceptedTaskTypes[0];
      task = await this.store.createTask({
        taskType:acceptedTaskType,
        idempotencyKey:`paperclip:${identity.issue.id}`,
        requester:{ kind:'paperclip', ref:identity.issue.id },
        source:{ channel:'paperclip', paperclipIssueId:identity.issue.id, paperclipRunId:identity.run.id },
        assigneeAgentId:agent.agentId,
        parentTaskId:null,
        input:{
          title:String(identity.issue.title || 'Paperclip 指派任务').slice(0, 500),
          description:String(identity.issue.description || '').slice(0, 4000),
          sourceUrl:null,
          sourceUrls:[],
          context:{ paperclipIssueIdentifier:identity.issue.identifier || null }
        },
        status:'running',
        currentStage:'paperclip_hermes_running',
        routing:{ requestedAgentId:agent.agentId, candidateAgentIds:[agent.agentId], reason:'Paperclip 已把任务指派给该员工的 Hermes Profile。' },
        governance:{
          status:'synced',
          paperclipIssueId:identity.issue.id,
          paperclipIssueIdentifier:identity.issue.identifier || null,
          paperclipAssigneeAgentId:identity.paperclipAgent.id,
          paperclipAssigneeName:identity.paperclipAgent.name,
          syncedAt:new Date().toISOString()
        },
        execution:{
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipRunId:identity.run.id,
          paperclipAgentId:identity.paperclipAgent.id,
          startedAt:new Date().toISOString()
        }
      });
    } else if (!isTerminalTask(task)) {
      task = await this.store.updateTask(task.taskId, {
        status:'running',
        currentStage:'paperclip_hermes_running',
        execution:{
          ...(task.execution || {}),
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipRunId:identity.run.id,
          paperclipAgentId:identity.paperclipAgent.id,
          startedAt:task.execution?.startedAt || new Date().toISOString()
        }
      });
    }
    const groundTruth = agent.agentId === 'architect' ? await this.architectureGroundTruth() : null;
    return {
      task,
      assignment:{
        issueId:identity.issue.id,
        identifier:identity.issue.identifier || null,
        title:identity.issue.title,
        description:identity.issue.description || '',
        agentId:agent.agentId,
        runId:identity.run.id,
        ...(groundTruth ? { groundTruth } : {})
      }
    };
  }

  async completePaperclipAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (isTerminalTask(task)) return { task, assignment, duplicate:true };
    const requestedStatus = String(input.status || 'succeeded').trim();
    if (!['succeeded', 'failed', 'waiting_test'].includes(requestedStatus)) {
      throw new ValidationError('员工回报状态无效。');
    }
    const completedAt = new Date().toISOString();
    const summary = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!summary) throw new ValidationError('员工必须提供可核对的结果摘要。');
    let architectureEvidence = null;
    let architectureLayers = null;
    if (assignment.agentId === 'architect') {
      const groundTruth = await this.architectureGroundTruth();
      architectureLayers = normalizeArchitectureLayers(input);
      const factEvidence = validateArchitectureEvidenceRefs(
        architectureLayers.factClaims.flatMap((item) => item.evidenceRefs.map((ref) => ({ ref, claim:item.claim }))),
        groundTruth
      );
      const judgmentEvidence = validateArchitectureEvidenceRefs(
        architectureLayers.architectureJudgments.flatMap((item) => item.basisRefs.map((ref) => ({ ref, claim:item.judgment }))),
        groundTruth
      );
      const invalidRefs = [...new Set([...factEvidence.invalidRefs, ...judgmentEvidence.invalidRefs])];
      architectureEvidence = {
        valid:factEvidence.valid && invalidRefs.length === 0,
        refs:[...factEvidence.refs, ...judgmentEvidence.refs],
        invalidRefs,
        snapshotId:groundTruth.snapshotId
      };
      if (invalidRefs.length) {
        throw new ValidationError(`架构报告引用了快照中不存在的对象：${invalidRefs.join('、')}。当前事实和判断依据必须使用真实引用。`);
      }
      if (requestedStatus === 'succeeded' && !factEvidence.valid) {
        const reason = factEvidence.invalidRefs.length
          ? `当前事实引用了快照中不存在的对象：${factEvidence.invalidRefs.join('、')}`
          : '架构报告至少需要一条带真实引用的当前事实；推理和候选方案不能替代现状基线。';
        throw new ValidationError(`${reason} 未写入成功结论。`);
      }
    }
    const artifact = {
      taskId:task.taskId,
      type:'employee_role_report',
      data:{
        agentId:assignment.agentId,
        summary,
        evidence:String(input.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        remainingRisks:String(input.remainingRisks || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        ...(architectureEvidence ? {
          evidenceRefs:architectureEvidence.refs,
          evidenceValidation:{
            valid:architectureEvidence.valid,
            invalidRefs:architectureEvidence.invalidRefs,
            snapshotId:architectureEvidence.snapshotId
          },
          factClaims:architectureLayers.factClaims,
          architectureJudgments:architectureLayers.architectureJudgments,
          candidateProposals:architectureLayers.candidateProposals,
          currentStateUnknowns:architectureLayers.currentStateUnknowns,
          // 兼容旧读取方；新写入统一使用 currentStateUnknowns。
          unverifiedClaims:architectureLayers.currentStateUnknowns
        } : {}),
        paperclipIssueId:assignment.issueId,
        paperclipRunId:assignment.runId
      },
      validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:completedAt }
    };
    let updated = await this.store.updateTask(task.taskId, {
      status:requestedStatus,
      currentStage:requestedStatus === 'succeeded' ? 'paperclip_hermes_completed' : requestedStatus === 'waiting_test' ? 'paperclip_hermes_waiting_test' : 'paperclip_hermes_failed',
      artifactRefs:[...(task.artifactRefs || []), artifact],
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:completedAt,
        outcome:requestedStatus
      },
      ...(requestedStatus === 'failed' ? {
        error:{
          code:'paperclip_hermes_reported_failure',
          message:summary,
          userMessage:'员工已如实回报任务失败，请查看结果摘要和剩余风险。',
          category:'manual',
          stage:'paperclip_hermes',
          retryable:false,
          occurredAt:completedAt
        }
      } : { error:undefined })
    });
    await this.governance.completePaperclipIssue(assignment.issueId, {
      runId:assignment.runId,
      agentId:input.paperclipAgentId,
      apiKey:input.paperclipApiKey,
      result:updated
    });
    updated = await this.store.updateTask(updated.taskId, {
      governance:{ ...(updated.governance || {}), status:'synced', syncedAt:new Date().toISOString() }
    });
    return { task:updated, assignment, duplicate:false };
  }

  async executeTechnicalRepairAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'technical-expert' || task.taskType !== 'operations.technical-repair') {
      throw new ValidationError('当前指派不是技术专家受控修复任务。');
    }
    const existing = (task.artifactRefs || []).find((item) => item.type === 'technical_repair_case');
    if (existing) {
      return {
        assignment,
        result:existing.data,
        currentStage:task.currentStage,
        duplicate:true
      };
    }
    const executor = this.executors['technical-expert'];
    if (!executor?.execute) throw new ValidationError('技术专家隔离修复执行器不可用。');
    const result = await executor.execute(task);
    const verified = result.execution?.outcome === 'promoted'
      && result.execution?.verification?.testsPassed === true
      && result.execution?.verification?.recoveryVerified === true;
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result.currentStage || 'technical_repair_executed',
      artifactRefs:[...(task.artifactRefs || []), ...(result.artifactRefs || [])],
      execution:{
        ...(task.execution || {}),
        technicalRepair:result.execution || null
      }
    });
    return {
      assignment,
      result:{
        status:result.status,
        currentStage:result.currentStage,
        execution:result.execution,
        verified,
        recommendedCompletionStatus:verified ? 'succeeded' : 'waiting_test',
        artifacts:(result.artifactRefs || []).map((item) => ({
          type:item.type,
          validation:item.validation,
          data:item.data
        }))
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  }

  async executeContentGrowthAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    const allowed = {
      'video-content-analyst':new Set(['content.video-benchmark-analysis', 'content.performance-review']),
      'content-creator':new Set(['content.platform-draft', 'content.video-script-package'])
    };
    if (!allowed[assignment.agentId]?.has(task.taskType)) throw new ValidationError('当前指派不是受控内容增长任务。');
    const artifactTypes = {
      'content.video-benchmark-analysis':'video_content_analysis_report',
      'content.performance-review':'content_performance_report',
      'content.platform-draft':'platform_content_draft',
      'content.video-script-package':'video_script_package'
    };
    const expectedType = artifactTypes[task.taskType];
    const existing = (task.artifactRefs || []).find((item) => item.type === expectedType && item.validation?.exists === true && item.validation?.readable === true);
    if (existing) {
      const verified = contentGrowthArtifactVerified(task, existing);
      return {
        assignment,
        result:{
          status:verified ? 'succeeded' : 'waiting_test',
          currentStage:task.currentStage,
          verified,
          recommendedCompletionStatus:verified ? 'succeeded' : 'waiting_test',
          artifacts:[artifactExecutionView(existing)]
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        currentStage:task.currentStage,
        duplicate:true
      };
    }
    const settled = storedContentGrowthResult(task, expectedType);
    if (settled) {
      return {
        assignment,
        result:settled,
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.executors[assignment.agentId];
    if (!executor?.execute) throw new ValidationError('内容增长受控执行器不可用。');
    let run = this.contentGrowthRuns.get(task.taskId);
    const joined = Boolean(run);
    if (!run) {
      const promise = this.runContentGrowthAssignment({ task, assignment, expectedType, executor });
      run = { promise };
      this.contentGrowthRuns.set(task.taskId, run);
      void promise.finally(() => {
        if (this.contentGrowthRuns.get(task.taskId) === run) this.contentGrowthRuns.delete(task.taskId);
      }).catch(() => {});
    }
    const outcome = await settleWithin(run.promise, this.contentGrowthWaitMs);
    if (outcome.settled) return outcome.value;
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    return {
      assignment,
      result:{
        status:'running',
        currentStage:'content_growth_background_running',
        verified:false,
        recommendedCompletionStatus:'running',
        continuePolling:true,
        pollAfterSeconds:2,
        message:'同一项内容分析仍在 A君后台执行；请再次调用当前受控执行工具继续等待，不要回报任务完成。'
      },
      task:{ taskId:latest.taskId, status:latest.status, currentStage:latest.currentStage },
      duplicate:joined
    };
  }

  async runContentGrowthAssignment({ task, assignment, expectedType, executor }) {
    const executionStartedAt = new Date();
    const started = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:'content_growth_background_running',
      execution:{
        ...(task.execution || {}),
        contentGrowth:{
          state:'running',
          executor:assignment.agentId,
          startedAt:executionStartedAt.toISOString()
        }
      },
      error:undefined
    });
    let result;
    try {
      result = await executor.execute(started);
    } catch (error) {
      const completedAt = new Date().toISOString();
      result = {
        status:'waiting_test',
        currentStage:'content_growth_execution_failed',
        artifactRefs:[],
        execution:{
          executor:assignment.agentId,
          startedAt:executionStartedAt.toISOString(),
          finishedAt:completedAt,
          outcome:'failed'
        },
        error:{
          code:String(error?.code || 'content_growth_executor_failed').slice(0, 120),
          message:String(error?.message || '内容增长执行器失败。').slice(0, 500),
          userMessage:'内容分析未完成，已保留真实失败原因。',
          category:'manual',
          stage:'content_growth_execution',
          retryable:false,
          occurredAt:completedAt
        }
      };
    }
    const artifacts = Array.isArray(result.artifactRefs) ? result.artifactRefs : [];
    const verified = result.status === 'succeeded'
      && artifacts.some((item) => item.type === expectedType && contentGrowthArtifactVerified(task, item));
    const recommendedCompletionStatus = verified
      ? 'succeeded'
      : result.status === 'needs_input'
        ? 'failed'
        : 'waiting_test';
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    const preserveTerminal = isTerminalTask(latest);
    const updated = await this.store.updateTask(task.taskId, {
      status:preserveTerminal ? latest.status : 'running',
      currentStage:result.currentStage || 'content_growth_executed',
      artifactRefs:[...(latest.artifactRefs || []), ...artifacts],
      execution:{
        ...(latest.execution || {}),
        contentGrowth:{
          ...(result.execution || {}),
          state:'settled',
          status:result.status,
          verified,
          recommendedCompletionStatus,
          settledAt:new Date().toISOString()
        }
      },
      usage:recordTaskUsage({ task, result, startedAt:executionStartedAt }),
      ...(result.error ? { error:result.error } : preserveTerminal ? { error:latest.error } : {})
    });
    return {
      assignment,
      result:{
        status:result.status,
        currentStage:result.currentStage,
        verified,
        recommendedCompletionStatus,
        error:result.error || null,
        artifacts:artifacts.map(artifactExecutionView)
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
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
    const [agents, manager, tasks, approvals, governance] = await Promise.all([this.registry.list(), this.registry.get('ajun'), this.store.list(), this.store.listApprovals(), this.governance?.health() || { status: 'planned', version: null }]);
    const feishuChannel = channelCapability(this.feishuChannelStatus);
    const agentChannels = safeAgentChannelStates(this.agentChannelStates);
    const worker = safeWorkerStatus(this.workerStatus, tasks);
    const visibleAgents = agents.map((agent) => ({
      ...agent,
      ...(agent.interaction?.directFeishu !== 'disabled' && agentChannels[agent.agentId]
        ? { feishuChannel:withFeishuTaskEvidence(agentChannels[agent.agentId], agent.agentId, tasks) }
        : {})
    }));
    const onDemandAgents = visibleAgents.filter((agent) => agent.interaction?.directFeishu === 'disabled');
    const alwaysOnAgents = [
      ...(manager ? [manager] : []),
      ...visibleAgents.filter((agent) => agent.interaction?.directFeishu !== 'disabled')
    ];
    return { agents:visibleAgents, alwaysOnAgents, onDemandAgents, tasks, approvals, taskFocus: buildTaskFocus(tasks, approvals), usage:summarizeTaskUsage(tasks, { since:startOfToday() }), capabilities: [
      { id: 'task-coordination', name: '统一任务协调', status: 'ready', detail: '创建、路由和状态真相已就绪。' },
      { id: 'agent-registry', name: '岗位注册表', status: 'ready', detail: '岗位职责、任务类型和权限边界从 Manifest 读取。' },
      { id: 'approval-gate', name: '审批闸门', status: 'ready', detail: '高风险描述先进入待审批，不自动执行。' },
      { id: 'content-public-web-fetch', name: '公开网页内容获取', status: 'ready', detail: '仅读取公开 HTML/纯文本，拒绝内网、登录态和非网页内容。' },
      { id: 'governance', name: 'Paperclip 治理投影', status: governance.status, detail: governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）。` : 'Paperclip 未连接；任务仍可登记，后续可补同步。' },
      { id: 'feishu-channel', name: '飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail },
      { id: 'mac-worker', name: 'Mac工作间安全接力', status:worker.status, detail:worker.detail },
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
    if (current.taskType === 'army.cross-agent-mission') {
      return missionNotification(current, {
        chain,
        approvals:await this.store.listApprovals(),
        xiaod:this.executors.xiaod
      });
    }
    if (current.status === 'succeeded') {
      if (current.taskType === 'operations.health-review') {
        const report = current.artifactRefs?.find((item) => item.type === 'health_report')?.data;
        if (report?.overall && Array.isArray(report.components) && report.components.length) {
          return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatHealthReportReply(report) };
        }
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`运维官已经完成“${shortTaskTitle(root)}”，但结构化健康报告不可读；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'report.public-material') {
        const report = current.artifactRefs?.find((item) => item.type === 'public_web_report')?.data;
        if (report?.summary) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatPublicReportReply(report, { taskTitle:shortTaskTitle(root) }) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`公开资料报告员已经完成“${shortTaskTitle(root)}”，但摘要产物没有通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'research.github-search') {
        const report = current.artifactRefs?.find((item) => item.type === 'research_github_report')?.data;
        const read = current.artifactRefs?.find((item) => item.type === 'github_code_read')?.data;
        if (report?.results?.length) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatGithubSearchDelivery(report) };
        if (read?.summary) return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小R已读取 ${read.repo} 的 ${read.path}：${read.summary}\n来源：${read.source || `https://github.com/${read.repo}`}` };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小R已经完成“${shortTaskTitle(root)}”，但公开 GitHub 产物不可读；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'research.intel-report') {
        const report = current.artifactRefs?.find((item) => item.type === 'intel_research_report')?.data;
        if (report?.conclusion && Array.isArray(report?.sources) && report.sources.length) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatIntelResearchDelivery(report) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小R已经完成“${shortTaskTitle(root)}”，但结构化研究产物或来源未通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'office.briefing-package') {
        const report = current.artifactRefs?.find((item) => item.type === 'office_briefing_package')?.data;
        if (report?.summary && report?.markdown) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatOfficeBriefingReply(report) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`办公执行助理已经完成“${shortTaskTitle(root)}”，但汇报包没有通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'office.knowledge-summary') {
        const note = current.artifactRefs?.find((item) => item.type === 'knowledge_summary_note');
        if (note?.validation?.readable && note?.location) return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小办已完成知识归档“${note.title}”。\n受控文件：${note.location}\n校验值：${note.checksum || '未提供'}` };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小办已经完成“${shortTaskTitle(root)}”，但知识笔记没有通过可读性检查；系统不会把它当作完整归档。` };
      }
      if (current.taskType === 'content.video-benchmark-analysis') {
        const report = current.artifactRefs?.find((item) => item.type === 'video_content_analysis_report')?.data;
        if (report?.modules?.length) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatVideoAnalysisDelivery(report) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小拆已经完成“${shortTaskTitle(root)}”，但拆解报告没有通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'content.platform-draft') {
        const draft = current.artifactRefs?.find((item) => item.type === 'platform_content_draft')?.data;
        if (draft?.drafts?.length) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatPlatformDraftDelivery(draft) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小创已经完成“${shortTaskTitle(root)}”，但草稿产物没有通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'content.video-script-package') {
        const script = current.artifactRefs?.find((item) => item.type === 'video_script_package')?.data;
        if (script?.fullScript) return { terminal:true, status:'succeeded', taskId:root.taskId, message:formatVideoScriptDelivery(script) };
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`小创已经完成“${shortTaskTitle(root)}”，但可拍脚本没有通过读取确认；系统不会把它当作完整交付。` };
      }
      if (current.taskType === 'content.performance-review') {
        const report = current.artifactRefs?.find((item) => item.type === 'content_performance_report')?.data;
        if (report?.metrics) return { terminal:true, status:'succeeded', taskId:root.taskId, message:`【小拆内容表现复盘】\n${report.summary}\n${(report.observations || []).slice(0, 5).map((item) => `- ${item}`).join('\n')}` };
      }
      const roleReport = current.artifactRefs?.find((item) => item.type === 'employee_role_report')?.data;
      if (roleReport?.summary) {
        const worker = await taskWorkerName(this.registry, current);
        return { terminal:true, status:'succeeded', taskId:root.taskId, message:`${worker}已完成“${shortTaskTitle(root)}”。\n${roleReport.summary}` };
      }
      const delivery = current.artifactRefs?.find((item) => item.type === 'xiaod_media_delivery');
      const url = delivery?.data?.larkUrl;
      const verified = delivery?.data?.larkPermissionGranted === true;
      const prefix = retried ? '运维官自动恢复后，小D已经完成' : '小D已经完成';
      return { terminal: true, status: 'succeeded', taskId: root.taskId, message: url && verified ? `${prefix}“${shortTaskTitle(root)}”。\n交付文档：${url}` : `${prefix}“${shortTaskTitle(root)}”，但飞书文档权限尚未确认；系统不会把它冒充完整交付。` };
    }
    if (['queued', 'running'].includes(current.status)) {
      const worker = await taskWorkerName(this.registry, current);
      return { terminal: false, status: current.status, taskId: root.taskId, message: retried ? `“${shortTaskTitle(root)}”第一次处理失败，运维官已自动重试，当前仍在处理中。` : `“${shortTaskTitle(root)}”正在由${worker}处理。` };
    }
    if (current.status === 'waiting_worker') {
      return { terminal:false, status:'waiting_worker', taskId:root.taskId, message:`“${shortTaskTitle(root)}”需要老板的 Mac工作间处理。云端已安全排队；Mac 上线后会自动领取，不需要你重复提交。` };
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

export class ValidationError extends Error {}
function artifactExecutionView(item) {
  return {
    type:item.type,
    title:item.title,
    checksum:item.checksum || null,
    validation:item.validation,
    data:item.data
  };
}
function contentGrowthArtifactVerified(task, artifact) {
  const readable = artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty === true;
  if (!readable) return false;
  const formalFullAnalysis = task?.taskType === 'content.video-benchmark-analysis'
    && task?.input?.evidenceMode === 'formal'
    && task?.input?.depth === 'full';
  return !formalFullAnalysis || artifact.validation?.semanticValidationPassed === true;
}
function storedContentGrowthResult(task) {
  const execution = task?.execution?.contentGrowth;
  if (execution?.state !== 'settled') return null;
  const recommendedCompletionStatus = ['succeeded', 'failed', 'waiting_test'].includes(execution.recommendedCompletionStatus)
    ? execution.recommendedCompletionStatus
    : 'waiting_test';
  return {
    status:String(execution.status || recommendedCompletionStatus),
    currentStage:task.currentStage,
    verified:execution.verified === true,
    recommendedCompletionStatus,
    error:task.error || null,
    artifacts:[]
  };
}
async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled:false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled:true, value })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function optionalInput(value) { const text = String(value || '').trim(); return text || undefined; }
function githubQueryInput(taskType, suppliedQuery, requestText) {
  const explicit = optionalInput(suppliedQuery);
  if (explicit || taskType !== 'research.github-search') return explicit;
  return githubRepositoryQuery(requestText) || undefined;
}
async function taskWorkerName(registry, task) {
  const agentId = String(task?.assigneeAgentId || task?.execution?.executor || '').trim();
  const agent = agentId && typeof registry?.get === 'function' ? await registry.get(agentId) : null;
  return String(agent?.name || agentId || '承接员工').trim();
}
function formatGithubSearchDelivery(report) {
  const items = report.results.slice(0, 5).map((item, index) => `${index + 1}. ${item.fullName}（★ ${item.stars}，${item.language || '语言未提供'}）\n${item.suitability || item.assessment || ''}${item.suitability && item.assessment ? `\n元数据判断：${item.assessment}` : ''}\n${item.url}`);
  return ['【小R 公开 GitHub 检索】', `关键词：${report.query || '未提供'}`, '', ...items].join('\n');
}
function formatIntelResearchDelivery(report) {
  const list = (items) => (Array.isArray(items) && items.length ? items.map((item) => `- ${item}`).join('\n') : '- 暂无。');
  return ['【小R 研究报告】', `主题：${report.topic || '未提供'}`, `背景：${report.background || '仅根据已读取来源整理。'}`, `关键发现：\n${list(report.findings)}`, `结论：${report.conclusion}`, `行动建议：\n${list(report.recommendations)}`, `未决问题：\n${list(report.openQuestions)}`, `来源：\n${report.sources.slice(0, 5).map((source) => `- ${source.title || '公开来源'}\n  ${source.source}`).join('\n')}`].join('\n\n');
}
function formatHealthReportReply(report) {
  const overall = report.overall === 'healthy' ? '正常' : report.overall === 'degraded' ? '存在降级' : String(report.overall || '未知');
  const components = report.components.slice(0, 12).map((item) => {
    const status = item.status === 'healthy' ? '正常' : item.status === 'degraded' ? '降级' : String(item.status || '未知');
    return `- ${item.name || item.id || '未命名组件'}：${status}${item.detail ? `；${item.detail}` : ''}`;
  }).join('\n');
  return `【运维官健康检查】\n整体：${overall}\n${components}\n建议：${report.recommendedAction || '暂无。'}`;
}
function formatVideoAnalysisDelivery(report) {
  const modules = report.modules.slice(0, 13).map((item, index) => `${index + 1}. ${item.name}：${item.finding}\n   证据：${item.evidence?.timestamp ? `[${item.evidence.timestamp}] ` : ''}${item.evidence?.fragment || '证据缺失'}`).join('\n');
  const actions = Array.isArray(report.actionItems) && report.actionItems.length
    ? `\n\n行动清单：\n${report.actionItems.slice(0, 5).map((item) => `- ${item}`).join('\n')}`
    : '';
  const visual = Array.isArray(report.visualFindings) && report.visualFindings.length
    ? `\n\n画面观察：\n${report.visualFindings.slice(0, 5).map((item) => `- [${item.evidence?.timestamp || '时间点缺失'}｜${item.evidence?.frameRef || '帧缺失'}] ${item.finding}`).join('\n')}`
    : '';
  const completeness = report.completeness === 'complete'
    ? '图文分析完整'
    : '部分完成：字幕拆解已交付，画面分析未通过完整门禁';
  const source = report.sourceMetadata?.title
    ? `\n来源：${report.sourceMetadata.title}${report.sourceMetadata.author ? `｜${report.sourceMetadata.author}` : ''}${report.sourceMetadata.platform ? `｜${report.sourceMetadata.platform}` : ''}`
    : '';
  const generation = report.generationMode === 'hermes_advisor'
    ? 'Hermes 深度分析'
    : report.generationMode === 'hermes_advisor_evidence_repaired'
      ? 'Hermes 深度分析（证据结构已按确认稿修复）'
      : '本机证据化兜底（模型结果未通过结构校验）';
  return `【小拆视频内容拆解】\n模式：${generation}\n完整度：${completeness}\n证据：${report.evidenceLabel || report.evidenceMode}${source}\n${report.summary}\n\n${modules}${visual}${actions}`;
}
function formatPlatformDraftDelivery(report) {
  const drafts = report.drafts.slice(0, 3).map((item) => `- ${item.platform}：${item.titleCandidates?.[0] || '已生成草稿'}\n  开场：${item.opening || ''}`).join('\n');
  return `【小创平台草稿】\n仅生成草稿，未发布。\n${drafts}\n发布前仍需真人检查。`;
}
function formatVideoScriptDelivery(report) {
  if (report.templateLifecycle?.approvedForUse === true) {
    return '已采用这版。可拍脚本和制作包已经准备好；没有生成成片，也没有发布。';
  }
  const notes = Array.isArray(report.shootingNotes)
    ? report.shootingNotes.slice(0, 3).map((item) => `- ${item}`).join('\n')
    : '';
  return [
    '【可拍脚本】',
    `标题：${report.headline}`,
    `建议：${report.platform || 'douyin'}｜约 ${report.durationSeconds || 45} 秒`,
    '',
    `开场：${report.hook}`,
    '',
    report.fullScript,
    ...(notes ? ['', '拍摄提示：', notes] : []),
    '',
    '下一步：满意就回复“用这版”；要改直接说一句，例如“更像我说话”或“节奏快一点”。'
  ].join('\n');
}

async function missionNotification(task, { chain = [], approvals = [], xiaod = null } = {}) {
  const report = task.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary')?.data;
  const statuses = Array.isArray(report?.statuses) ? report.statuses.slice(0, 3) : [];
  const names = { xiaod:'小D', 'intel-researcher':'小R', 'office-assistant':'办公执行助理', 'video-content-analyst':'小拆', 'content-creator':'小创', operator:'运维官', architect:'架构师' };
  const lines = statuses.map((item) => `- ${names[item.employeeId] || item.employeeId || '待定员工'}：${missionStatusLabel(item.status)}｜${String(item.title || '未命名分工').replace(/\s+/g, ' ').slice(0, 120)}`);
  const terminal = ['succeeded', 'failed', 'cancelled', 'needs_input', 'waiting_test'].includes(task.status);
  if (!report || !statuses.length) {
    return {
      terminal,
      status:task.status,
      taskId:task.taskId,
      message:`总任务“${shortTaskTitle(task)}”${terminal ? '已经停止推进，但统一汇总不可读；系统不会把它当作完整交付。' : '正在建立和分派员工工作。'}`
    };
  }
  const briefing = report.decision?.briefing;
  const completed = statuses.filter((item) => item.status === 'succeeded').length;
  const progressStatus = !terminal && statuses.some((item) => item.status === 'waiting_approval')
    ? 'waiting_approval'
    : task.status;
  const summary = [
    `【A君总任务】${String(report.summary || shortTaskTitle(task)).replace(/\s+/g, ' ').slice(0, 300)}`,
    `进度：${completed}/${statuses.length} 项完成`,
    ...lines
  ];
  if (briefing?.summary) {
    summary.push(`统一汇报：${String(briefing.summary).replace(/\s+/g, ' ').slice(0, 800)}`);
    if (Array.isArray(briefing.openItems) && briefing.openItems.length) summary.push(`仍需处理：${briefing.openItems.slice(0, 3).join('；')}`);
    if (briefing.nextAction) summary.push(`下一步：${String(briefing.nextAction).replace(/\s+/g, ' ').slice(0, 500)}`);
  } else if (terminal && completed === statuses.length) {
    const analysisTaskId = statuses.find((item) => item.employeeId === 'video-content-analyst' && item.status === 'succeeded')?.taskId;
    const analysisTask = chain.find((item) => item.taskId === analysisTaskId);
    const analysis = analysisTask?.artifactRefs?.find((item) => item.type === 'video_content_analysis_report')?.data;
    if (analysis?.modules?.length) summary.push('', formatVideoAnalysisDelivery(analysis));
    else summary.push('所有分工已完成，但最终业务产物未通过读取确认；系统不会只用“完成”状态冒充交付。');
  } else if (terminal && completed < statuses.length) {
    summary.push('未完成部分已如实保留，没有被冒充为成功。');
  } else if (progressStatus === 'waiting_approval') {
    const reviewTask = chain.find((item) => item.status === 'waiting_approval'
      && item.execution?.executor === 'xiaod'
      && approvals.some((approval) => approval.taskId === item.taskId
        && approval.status === 'pending'
        && approval.action === 'confirm-transcript-after-complete-listen'));
    let reviewUrl = '';
    if (reviewTask?.execution?.xiaodJobId && typeof xiaod?.getJob === 'function') {
      try {
        const job = await xiaod.getJob(reviewTask.execution.xiaodJobId);
        if (job.output?.larkPermissionGranted === true && /^https:\/\//.test(String(job.output?.larkUrl || ''))) {
          reviewUrl = String(job.output.larkUrl);
        }
      } catch { /* 保留可操作的文字提醒，下一轮跟进可再次读取链接。 */ }
    }
    summary.push('机器稿已通过自动完整性检查；正式拆解仍未启动。');
    if (reviewUrl) summary.push(`机器稿：${reviewUrl}`);
    summary.push('请完整听完后在本会话回复“我已完整听审并确认”。A君会再弹出一次批准确认；未确认前不会启动小拆。');
  } else if (!terminal) {
    summary.push('A君会继续跟进这个总任务，不需要你分别追问每位员工。');
  }
  return { terminal, status:progressStatus, taskId:task.taskId, message:summary.join('\n') };
}

function missionStatusLabel(status) {
  return ({ succeeded:'已完成', failed:'失败', needs_input:'等待补充信息', cancelled:'已取消', waiting_test:'等待验证', waiting_approval:'等待批准', running:'处理中', queued:'排队中', planned:'待开始' })[status] || String(status || '未知');
}
function channelCapability(source) {
  const state = typeof source === 'function' ? source() : source;
  if (state?.status === 'external') return { status:'ready', detail:state.message || 'A君飞书入口已由 Hermes 原生 Gateway 承载；会话、上下文与 MCP 工具链已接通。' };
  if (state?.status === 'connected') return { status:'ready', detail:'官方飞书入口已连接；消息、审批卡会回到原聊天，现有 A君入口仍可保留。' };
  if (state?.status === 'connecting') return { status:'partial', detail:'官方飞书入口正在连接；现有 A君入口仍可用。' };
  if (state?.status === 'failed') return { status:'partial', detail:'官方飞书入口本次没有连上；现有 A君入口不受影响，问题已记录等待处理。' };
  return { status:'partial', detail:'A君私聊与审批卡已可用；官方收发入口已装好并默认关闭，待限定允许人员后接入官方通道并做真实飞书回归。' };
}
function cryptoSafe(value) { return Buffer.from(value).toString('base64url').slice(0, 24); }
function extractPublicUrls(value) {
  return [...String(value).matchAll(/https?:\/\/[^\s<>"'，。；：！？、【】（）《》“”‘’]+/gi)]
    .map((match) => match[0].replace(/[)\]},.;]+$/, ''));
}
function uniquePublicUrls(values) { return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]; }
function hasAffirmativeHighRiskIntent(value) {
  const text = String(value || '');
  return highRiskActions.some((action) => {
    let startAt = 0;
    while (startAt < text.length) {
      const index = text.indexOf(action, startAt);
      if (index < 0) return false;
      if (!isExplicitlyNegated(text.slice(0, index))) return true;
      startAt = index + action.length;
    }
    return false;
  });
}
function isExplicitlyNegated(prefix) {
  if (/(?:不|无|禁止|不得|不可|不能|无需|不用|不需要|不允许|不涉及)\s*$/.test(prefix)) return true;
  const clause = String(prefix || '').split(/[，,。；;：:！？!?\n]/).at(-1) || '';
  return /^\s*(?:请)?(?:不要|不得|禁止|不可|不能|无需|不用|不需要|不允许|不涉及)[^，,。；;：:！？!?\n]{0,80}(?:、|或|和|以及)\s*$/.test(clause);
}
function shouldProjectToPaperclip(task, approval = null) {
  return approval?.governanceMode === 'paperclip' || task.source?.channel === 'paperclip' || task.source?.channel === 'army-mission' || task.taskType.startsWith('governance.') || task.taskType === 'army.route-task' || task.taskType === 'army.cross-agent-mission' || task.taskType === 'operations.technical-repair';
}

function requiresOrganizationGovernance(title, description) { return organizationGovernanceWords.test(`${title} ${description}`); }
function shouldStartFailureRecovery(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task.taskType);
}
function normalizeArchitectureLayers(input = {}) {
  const explicitFacts = (Array.isArray(input.factClaims) ? input.factClaims : []).slice(0, 20).map((item) => ({
    claim:architectureText(item?.claim, 1000),
    evidenceRefs:architectureStrings(item?.evidenceRefs || item?.evidence_refs, 10, 500)
  })).filter((item) => item.claim && item.evidenceRefs.length);
  const legacyFacts = (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).slice(0, 30).map((item) => ({
    claim:architectureText(item?.claim, 1000),
    evidenceRefs:architectureStrings([item?.ref], 1, 500)
  })).filter((item) => item.claim && item.evidenceRefs.length);
  const architectureJudgments = (Array.isArray(input.architectureJudgments) ? input.architectureJudgments : []).slice(0, 20).map((item) => ({
    judgment:architectureText(item?.judgment, 1200),
    basisRefs:architectureStrings(item?.basisRefs || item?.basis_refs, 10, 500),
    assumptions:architectureStrings(item?.assumptions, 10, 600),
    confidence:['low', 'medium', 'high'].includes(item?.confidence) ? item.confidence : 'low'
  })).filter((item) => item.judgment && (item.basisRefs.length || item.assumptions.length));
  const candidateProposals = (Array.isArray(input.candidateProposals) ? input.candidateProposals : []).slice(0, 10).map((item) => ({
    proposal:architectureText(item?.proposal, 1200),
    problem:architectureText(item?.problem, 1000),
    validationPlan:architectureText(item?.validationPlan || item?.validation_plan, 1500),
    risks:architectureStrings(item?.risks, 10, 600),
    nonGoals:architectureStrings(item?.nonGoals || item?.non_goals, 10, 600)
  })).filter((item) => item.proposal && item.problem && item.validationPlan);
  return {
    factClaims:explicitFacts.length ? explicitFacts : legacyFacts,
    architectureJudgments,
    candidateProposals,
    currentStateUnknowns:architectureStrings([
      ...(Array.isArray(input.currentStateUnknowns) ? input.currentStateUnknowns : []),
      ...(Array.isArray(input.unverifiedClaims) ? input.unverifiedClaims : [])
    ], 20, 1000)
  };
}

function architectureText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function architectureStrings(values, maxItems, maxLength) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => architectureText(item, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function isTerminalTask(task) {
  return ['succeeded', 'failed', 'cancelled', 'waiting_test'].includes(task?.status);
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
  const counts = Object.fromEntries(['queued', 'running', 'waiting_worker', 'pausing', 'paused', 'waiting_approval', 'waiting_test', 'needs_input', 'succeeded', 'failed'].map((status) => [status, tasks.filter((task) => task.status === status).length]));
  const priority = ['waiting_approval', 'needs_input', 'pausing', 'running', 'waiting_worker', 'queued', 'paused', 'failed', 'waiting_test'];
  const pendingContinuation = tasks.find((task) =>
    task.status === 'succeeded'
    && intakeRecommendation(task)
    && !tasks.some((child) => child.parentTaskId === task.taskId)
    && !hasLaterUserOutcome(task, tasks)
  );
  const current = priority.flatMap((status) => tasks.filter((task) => task.status === status && isOwnerActionable(task, tasks)))[0] || pendingContinuation || null;
  const approval = current ? approvals.find((item) => current.approvalRefs?.includes(item.approvalId) && item.status === 'pending') : null;
  return {
    total: tasks.length,
    completed: counts.succeeded,
    inProgress: counts.queued + counts.running + counts.waiting_worker + counts.pausing,
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

function isOwnerActionable(task, tasks) {
  if (!['needs_input', 'failed', 'waiting_test'].includes(task.status)) return true;
  if (isSupersededBySuccess(task, tasks)) return false;
  const channel = String(task.source?.channel || '').trim();
  const originChannel = String(task.source?.originChannel || '').trim();
  if (!channel && !originChannel) return true;
  if (hasLaterUserOutcome(task, tasks)) return false;
  return channel === 'feishu' || originChannel === 'feishu' || channel === 'local-ui' || channel === 'hermes-native';
}

function isSupersededBySuccess(task, tasks) {
  const sourceUrl = String(task.input?.sourceUrl || '').trim();
  if (!sourceUrl) return false;
  const taskTime = Date.parse(task.updatedAt || task.createdAt || '') || 0;
  return tasks.some((candidate) =>
    candidate.taskId !== task.taskId
    && candidate.status === 'succeeded'
    && candidate.taskType === task.taskType
    && String(candidate.input?.sourceUrl || '').trim() === sourceUrl
    && (Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0) > taskTime
  );
}

function hasLaterUserOutcome(task, tasks) {
  const taskTime = Date.parse(task.updatedAt || task.createdAt || '') || 0;
  return tasks.some((candidate) => {
    if (!['succeeded', 'cancelled'].includes(candidate.status)) return false;
    const candidateChannel = String(candidate.source?.channel || '').trim();
    const candidateOrigin = String(candidate.source?.originChannel || '').trim();
    const userFacing = candidateChannel === 'feishu'
      || candidateOrigin === 'feishu'
      || candidateChannel === 'local-ui'
      || candidateChannel === 'hermes-native';
    return userFacing && (Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0) > taskTime;
  });
}

function nextActionFor(task, approval) {
  if (approval) return '请确认任务范围；在你确认前，系统不会继续执行。';
  if (intakeRecommendation(task)) return 'A君已经给出下一步建议；确认后可按建议创建后续任务。';
  if (task.status === 'needs_input') return task.error?.userMessage || '请补充目标、范围或必要素材后再继续。';
  if (task.status === 'waiting_test') return task.error?.userMessage || '自动检查没有在本轮完成；已保留为待测试，不影响其他任务继续。';
  if (task.status === 'pausing') return '正在暂停，会在当前步骤完成后的安全位置停下。';
  if (task.status === 'paused') return '这项任务已暂停，确认继续前不会开始新的处理步骤。';
  if (task.status === 'waiting_worker') return '这项工作需要老板的 Mac；已安全排队，Mac 上线后会自动领取。';
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
