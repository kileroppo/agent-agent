import crypto from 'node:crypto';
import path from 'node:path';
import { recordTaskUsage, summarizeTaskUsage } from './task-usage.js';
import { formatPublicReportReply } from './public-report-presentation.js';
import { formatOfficeBriefingReply } from './local-office-assistant.js';
import { canonicalizeBusinessAssignment, githubRepositoryQuery } from './business-task-routing.js';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { buildArchitectureGroundTruth, validateArchitectureEvidenceRefs } from './architecture-evidence.js';
import { presentTask } from './task-presentation.js';
import {
  executeIntelResearchOpenTaskStep,
  inspectOpenTaskManifestCapabilities,
  routeOpenTaskForExecutor,
  supportsOpenTask
} from './open-task-routing.js';
import { WECHAT_CHAT_TASK_TYPE, normalizeWechatChatRequest, wechatApprovalScope } from './wechat-chat-defaults.js';
import {
  assertPaperclipEmployeeExecutorAssignment,
  resolvePaperclipAssignmentTaskType,
} from './paperclip-employee-assignment.js';
import { getM5RoutineExecutionContract } from './m5-routine-execution-contract.js';
import {
  getActiveM5PlanRevision,
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
  M5StageRecoveryController,
} from './m5-stage-recovery-controller.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from './m5-route-execution.js';
import { m5WorkProductArtifactHash } from './m5-work-product-integrity.js';
import {
  compileM5RoleToolGrant,
  createM5RoleToolExecutionContext,
  M5RoleToolGrantError,
} from './m5-role-tool-grant.js';

const highRiskActions = ['外发', '发布', '删除', '付款', '付费', '扩权', '敏感'];
const organizationGovernanceWords = /创建.*(?:agent|智能体|岗位)|新建.*(?:agent|智能体|岗位)|扩权|账号|连接|公开发布|对外发布|付款|付费|预算|暂停|终止|跨\s*agent/i;
const ROLE_TOOL_GRANT = Symbol('m5RoleToolGrant');
const OPEN_RESEARCH_EXECUTION_POLICY = Symbol('openResearchExecutionPolicy');

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
    this.taskDetailBaseUrl = taskDetailBaseUrl;
    this.roleToolAdapters = roleToolAdapters;
    this.m5ProviderVision = typeof m5ProviderVision === 'function'
      ? m5ProviderVision
      : null;
    this.m5WorkProductValidator = typeof m5WorkProductValidator === 'function'
      ? m5WorkProductValidator
      : null;
    this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240_000, 240_000));
    this.contentGrowthRuns = new Map();
    this.employeeAssignmentRuns = new Map();
    this.m5WorkProductObserver = null;
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
    const wechatChat = taskType === WECHAT_CHAT_TASK_TYPE ? normalizeWechatChatRequest({ ...input, title, description }) : null;
    const sourceUrls = uniquePublicUrls([String(input?.sourceUrl || '').trim(), ...(Array.isArray(input?.sourceUrls) ? input.sourceUrls : []), ...extractPublicUrls(`${title}\n${description}`)]);
    const sourceUrl = sourceUrls[0] || null;
    let task = await this.store.createTask({
      taskType, idempotencyKey: suppliedIdempotencyKey || `local:${cryptoSafe(title)}:${Date.now()}`, requester: input?.requester || { kind: requesterName === 'A君' ? 'local-owner' : 'lan-collaborator', ref: requesterName }, source: input?.source || { channel: 'ajun-runtime' },
      assigneeAgentId: agent?.agentId || null, parentTaskId: String(input?.parentTaskId || '').trim() || null, recovery: input?.recovery || undefined, input: {
        title,
        description,
        sourceUrl,
        sourceUrls,
        connectionId:optionalConnectionId(input?.connectionId),
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
        ...(wechatChat ? { wechatChat } : {}),
        goalSpec:input?.goalSpec && typeof input.goalSpec === 'object' && !Array.isArray(input.goalSpec)
          ? input.goalSpec
          : undefined,
        context: input?.context || undefined
      },
      status: wechatChat && !wechatChat.chatSelector ? 'needs_input' : agent?.status === 'active' ? 'queued' : 'needs_input',
      currentStage: wechatChat && !wechatChat.chatSelector ? 'wechat_chat_required' : agent?.status === 'active' ? 'queued_for_execution' : agent ? 'waiting_for_agent_activation' : 'routing_needed',
      routing: {
        requestedAgentId,
        candidateAgentIds: candidates.map((item) => item.agentId),
        reason:wechatChat && !wechatChat.chatSelector
          ? '只缺联系人或群名；其余范围使用安全默认值。'
          : agent?.status === 'active' ? '已路由到已启用的本地执行器。' : agent ? '岗位骨架已登记，等待启用真实执行器。' : candidates.length === 0 ? '没有岗位声明支持该任务类型。' : '多个岗位匹配，请明确选择承接岗位。'
      },
      ...(wechatChat && !wechatChat.chatSelector ? {
        error:{
          code:'wechat_chat_required',
          message:'微信聊天只读任务缺少联系人或群名。',
          userMessage:'请只告诉我联系人或群名；时间默认今天至现在，最多 200 条，其余不用配置。',
          category:'needs_input',
          stage:'scope',
          retryable:false,
          occurredAt:new Date().toISOString()
        }
      } : {})
    });
    if (supportsOpenTask(task, agent)) {
      let capabilityInspection;
      try {
        capabilityInspection = inspectOpenTaskManifestCapabilities(task, agent);
      } catch (error) {
        throw new ValidationError(error?.message || '开放任务的目标输入无效。');
      }
      if (!capabilityInspection.allowed) {
        return this.store.updateTask(task.taskId, {
          status:'needs_input',
          currentStage:'manifest_capability_required',
          error:{
            code:'manifest_capability_required',
            message:`能力不在岗位 Manifest 白名单：${capabilityInspection.missing.join('、')}`,
            userMessage:'任务请求了该岗位没有的能力；系统没有创建临时授权、安装未知工具或扩大权限。',
            category:'needs_input',
            stage:'manifest_capability_check',
            retryable:false,
            occurredAt:new Date().toISOString()
          }
        });
      }
      const routed = routeOpenTaskForExecutor(task, agent);
      task = await this.store.updateTask(task.taskId, {
        input:{
          ...(task.input || {}),
          context:routed.input.context
        }
      });
    }
    if (taskType === WECHAT_CHAT_TASK_TYPE && wechatChat?.chatSelector) {
      await this.store.createApproval({
        taskId:task.taskId,
        governanceMode:'local',
        decisionChannel:'feishu_card',
        action:'wechat-private-chat-read',
        riskLevel:'high',
        reason:`只读“${wechatChat.chatSelector}”今天至当前的聊天，最多 ${wechatChat.maxMessages} 条；同名时自动选最近活跃会话。原文不落盘、不发给模型、不外发。`,
        requestedBy:'ajun',
        approverScope:'A君',
        requestedScope:wechatApprovalScope(task),
        validUntil:new Date(Date.now() + 30 * 60 * 1000).toISOString()
      });
      task = (await this.store.list()).find((item) => item.taskId === task.taskId);
    }
    if (taskType !== WECHAT_CHAT_TASK_TYPE && hasAffirmativeHighRiskIntent(`${title} ${description}`)
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
      const result = await executor.execute(routeOpenTaskForExecutor(updated, agent));
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
    let assignmentTask;
    try {
      assignmentTask = resolvePaperclipAssignmentTaskType({ agent, issue:identity.issue });
    } catch (error) {
      throw new ValidationError(error?.message || '当前 Paperclip 指派任务类型无法安全映射。');
    }
    const storedTasks = await this.store.list();
    let task = storedTasks.find((item) => item.governance?.paperclipIssueId === identity.issue.id);
    if (task && assignmentTask.routineKey && task.taskType !== assignmentTask.taskType) {
      throw new ValidationError(`当前任务信封类型与 M5 Routine ${assignmentTask.routineKey} 不一致。`);
    }
    const pipelineCase = assignmentTask.pipelineCaseId && typeof this.governance.getPipelineCase === 'function'
      ? await this.governance.getPipelineCase(assignmentTask.pipelineCaseId)
      : null;
    const assignmentProjectId = String(
      identity?.issue?.projectId
      || pipelineCase?.case?.projectId
      || pipelineCase?.projectId
      || '',
    ).trim() || null;
    const m5Contract = getM5RoutineExecutionContract(assignmentTask.routineKey);
    const activePlanRevision = m5Contract?.executionMode === 'hermes'
      ? await getActiveM5PlanRevision({
          governance:this.governance,
          pipelineCaseId:assignmentTask.pipelineCaseId,
          stageKey:m5Contract.stageKey,
          pipelineCase,
        })
      : null;
    const baseRoleToolGrant = await this.compilePaperclipRoleToolGrant({
      agent,
      identity,
      pipelineCase,
    });
    const relatedCaseIds = await m5PipelineCaseChainIds({
      governance:this.governance,
      pipelineCaseId:assignmentTask.pipelineCaseId,
      pipelineCase,
    });
    const related = m5RelatedTaskContext(storedTasks, relatedCaseIds, pipelineCase);
    if (!task) {
      const acceptedTaskType = assignmentTask.taskType;
      if (!acceptedTaskType) throw new ValidationError('当前岗位没有可映射的任务类型。');
      const caseFields = paperclipCaseContextFields(
        pipelineCase?.case?.fields || pipelineCase?.fields || {},
      );
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
          topic:caseFields.theme || null,
          contentGoal:caseFields.theme || null,
          platforms:caseFields.platform ? [caseFields.platform] : [],
          sourceUrl:related.sourceUrls[0] || null,
          sourceUrls:related.sourceUrls,
          context:{
            paperclipIssueIdentifier:identity.issue.identifier || null,
            ...(assignmentTask.routineKey ? { paperclipRoutineKey:assignmentTask.routineKey } : {}),
            ...(assignmentTask.pipelineCaseId ? { pipelineCaseId:assignmentTask.pipelineCaseId } : {}),
            ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
            ...(activePlanRevision ? {
              m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision),
            } : {}),
            ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
            ...(pipelineCase ? {
              pipelineCase:{
                id:pipelineCase.case?.id || pipelineCase.id || assignmentTask.pipelineCaseId,
                caseKey:pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
                title:pipelineCase.case?.title || pipelineCase.title || null,
                stageKey:pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
                fields:caseFields,
              },
            } : {}),
          }
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
        currentStage:task.execution?.paperclipEmployee
          ? task.currentStage
          : 'paperclip_hermes_running',
        execution:{
          ...(task.execution || {}),
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipRunId:identity.run.id,
          paperclipAgentId:identity.paperclipAgent.id,
          startedAt:task.execution?.startedAt || new Date().toISOString()
        },
        input:{
          ...(task.input || {}),
          context:{
            ...(task.input?.context || {}),
            m5Recovery:activePlanRevision
              ? m5PlanRevisionExecutionContext(activePlanRevision)
              : null,
            ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
            ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
            ...(pipelineCase ? {
              pipelineCase:{
                id:pipelineCase.case?.id || pipelineCase.id || assignmentTask.pipelineCaseId,
                caseKey:pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
                title:pipelineCase.case?.title || pipelineCase.title || null,
                stageKey:pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
                fields:paperclipCaseContextFields(
                  pipelineCase.case?.fields || pipelineCase.fields || {},
                ),
              },
            } : {}),
          },
        },
      });
    }
    const groundTruth = agent.agentId === 'architect' ? await this.architectureGroundTruth() : null;
    const roleToolGrant = baseRoleToolGrant
      ? Object.freeze({
          ...baseRoleToolGrant,
          trustedScope:trustedRoleToolScope({
            tasks:storedTasks,
            task,
            relatedTaskIds:related.sourceTaskIds,
            paperclipIssueId:identity.issue.id,
            paperclipRunId:identity.run.id,
            pipelineCaseId:assignmentTask.pipelineCaseId,
          }),
        })
      : null;
    const verified = {
      task,
      assignment:{
        issueId:identity.issue.id,
        identifier:identity.issue.identifier || null,
        title:identity.issue.title,
        description:identity.issue.description || '',
        agentId:agent.agentId,
        runId:identity.run.id,
        routineKey:assignmentTask.routineKey || null,
        pipelineCaseId:assignmentTask.pipelineCaseId || null,
        projectId:assignmentProjectId,
        ...(activePlanRevision ? {
          m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision),
        } : {}),
        ...(groundTruth ? { groundTruth } : {})
      }
    };
    Object.defineProperty(verified, ROLE_TOOL_GRANT, {
      value:roleToolGrant,
      enumerable:false,
    });
    Object.defineProperty(verified, OPEN_RESEARCH_EXECUTION_POLICY, {
      value:canonicalOpenResearchExecutionPolicy(identity.issue),
      enumerable:false,
    });
    return verified;
  }

  async compilePaperclipRoleToolGrant({ agent, identity, pipelineCase } = {}) {
    if (!agent?.toolExecutionPolicy) return null;
    const profile = typeof this.registry?.runtimeProfile === 'function'
      ? await this.registry.runtimeProfile(agent)
      : agent.runtimeProfile || null;
    if (!profile) {
      throw new ValidationError('当前岗位缺少可核验的 Hermes Profile，工具执行已拒绝。');
    }
    const projectId = String(
      identity?.issue?.projectId
      || pipelineCase?.case?.projectId
      || pipelineCase?.projectId
      || '',
    ).trim();
    const executionWorkspaceId = String(
      identity?.run?.environmentLease?.executionWorkspaceId
      || identity?.run?.executionWorkspaceId
      || '',
    ).trim();
    try {
      const grant = compileM5RoleToolGrant({
        manifest:agent,
        profile,
        paperclipAgentId:identity?.paperclipAgent?.id,
        projectId,
        executionWorkspaceId,
        availableAdapters:this.roleToolAdapters,
      });
      if (typeof this.governance?.getExecutionWorkspace !== 'function') {
        throw new M5RoleToolGrantError(
          'Paperclip execution workspace 读取适配器不可用。',
          'workspace_adapter_unavailable',
        );
      }
      const executionWorkspace = await this.governance.getExecutionWorkspace(executionWorkspaceId);
      const workspaceRoot = String(executionWorkspace?.cwd || '').trim();
      if (!path.isAbsolute(workspaceRoot)) {
        throw new M5RoleToolGrantError(
          'Paperclip execution workspace 缺少可信绝对路径。',
          'workspace_scope_invalid',
        );
      }
      return Object.freeze({ grant, workspaceRoot });
    } catch (error) {
      if (error instanceof M5RoleToolGrantError) {
        throw new ValidationError(`岗位工具授权失败：${error.message}`);
      }
      throw error;
    }
  }

  async recordM5StageExecution(taskId, result = {}) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task || isTerminalTask(task)) throw new ValidationError('M5 阶段任务不存在或已经结束。');
    const routineKey = String(task.input?.context?.paperclipRoutineKey || '').trim();
    const contract = getM5RoutineExecutionContract(routineKey);
    if (
      !contract
      || contract.executionMode !== 'hermes'
      || contract.executionTool?.id !== 'm5_stage_execute'
      || (!contract.pluginEntryTool && !contract.deterministicEntry)
    ) {
      throw new ValidationError('当前任务不接受 M5 内容插件阶段结果。');
    }
    const expectedToolId = contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5:publish_receipt_verify'
      : `agent-army.content-autonomy:${contract.pluginEntryTool}`;
    const expectedProvider = contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5-deterministic'
      : 'agent-army.content-autonomy';
    if (
      result?.toolId !== expectedToolId
      || result?.pluginId !== expectedProvider
    ) {
      throw new ValidationError('M5 内容插件回执与当前阶段固定工具不一致。');
    }
    const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
    const data = validatedM5StagePluginData(
      contract.stageKey,
      contract.expectedWorkProduct.artifactKinds[0],
      result,
    );
    const routeExecution = assertM5ExecutorRouteReceipt({
      task,
      contract,
      result:result?.routeExecution,
    });
    const pipelineCaseId = String(task.input?.context?.pipelineCaseId || '').trim();
    const artifactId = `m5-stage:${pipelineCaseId}:${artifactKind}`;
    const existing = (task.artifactRefs || []).find((item) => item.artifactId === artifactId);
    if (existing) {
      const updated = await this.store.updateTask(task.taskId, {
        ...(routeExecution ? {
          execution:{
            ...(task.execution || {}),
            m5RouteExecution:routeExecution,
          },
        } : {}),
      });
      return { task:updated, artifact:existing, duplicate:true };
    }
    const createdAt = new Date().toISOString();
    const artifact = {
      artifactId,
      taskId:task.taskId,
      type:artifactKind,
      title:`M5 ${contract.stageKey} 阶段插件产物`,
      location:`runtime://${task.taskId}/${artifactKind}`,
      mimeType:'application/json',
      accessScope:'local-owner',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        pluginReceiptVerified:true,
      },
      createdAt,
      data,
    };
    const updated = await this.store.updateTask(task.taskId, {
      currentStage:`${contract.stageKey}_tool_completed`,
      artifactRefs:[...(task.artifactRefs || []), artifact],
      ...(routeExecution ? {
        execution:{
          ...(task.execution || {}),
          m5RouteExecution:routeExecution,
        },
      } : {}),
    });
    return { task:updated, artifact, duplicate:false };
  }

  async recordM5StageExecutionFailure(taskId, routeExecution, error) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task || isTerminalTask(task)) return null;
    const contract = getM5RoutineExecutionContract(
      task.input?.context?.paperclipRoutineKey,
    );
    if (!contract || contract.executionTool?.id !== 'm5_stage_execute') return null;
    const receipt = assertM5ExecutorRouteReceipt({
      task,
      contract,
      result:routeExecution,
      allowUnchanged:true,
    });
    return this.store.updateTask(task.taskId, {
      currentStage:'m5_stage_executor_failed',
      execution:{
        ...(task.execution || {}),
        m5RouteExecution:receipt,
      },
      error:{
        code:String(error?.code || 'm5_stage_executor_failed').slice(0, 120),
        message:String(error?.message || 'M5 阶段执行失败。').slice(0, 500),
        userMessage:'M5 阶段执行失败，已保存真实路线回执供恢复控制器判断。',
        category:'retryable',
        stage:contract.stageKey,
        retryable:true,
        occurredAt:new Date().toISOString(),
      },
    });
  }

  async completePaperclipAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (isTerminalTask(task)) {
      if (task.status === 'succeeded') {
        const sync = await this.syncM5StageWorkProducts({
          task,
          assignment,
          apiKey:input.paperclipApiKey,
        });
        if (sync.synced) {
          await this.governance.completePaperclipIssue(assignment.issueId, {
            runId:assignment.runId,
            agentId:input.paperclipAgentId,
            apiKey:input.paperclipApiKey,
            result:task,
          });
        }
      }
      return { task, assignment, duplicate:true };
    }
    const requestedStatus = String(input.status || 'succeeded').trim();
    if (!['succeeded', 'failed', 'waiting_test'].includes(requestedStatus)) {
      throw new ValidationError('员工回报状态无效。');
    }
    const completedAt = new Date().toISOString();
    const summary = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!summary) throw new ValidationError('员工必须提供可核对的结果摘要。');
    const m5Contract = getM5RoutineExecutionContract(assignment.routineKey);
    const m5PlanRevisionReceipt = m5Contract?.executionMode === 'hermes'
      ? assertM5PlanRevisionConsumed({
          expected:task.input?.context?.m5Recovery,
          actual:task.execution?.m5RouteExecution,
          runId:assignment.runId,
          allowUnchangedFailure:requestedStatus === 'failed',
          input,
        })
      : null;
    if (
      requestedStatus === 'succeeded'
      && m5Contract?.stageKey === 'visual_analysis'
    ) {
      const projectId = paperclipUuid(assignment.projectId);
      const verifiedVisual = projectId && (task.artifactRefs || []).some((artifact) =>
        artifact?.type === 'visual_analysis_package'
        && contentGrowthArtifactVerified(task, artifact, {
          expectedProjectId:projectId,
        })
      );
      if (!verifiedVisual) {
        throw new ValidationError(
          'M5 画面分析缺少与当前 Paperclip Project 一致的 confirmed 视觉回执，不能回报 succeeded。',
        );
      }
    }
    if (requestedStatus === 'failed' && m5Contract?.executionMode === 'hermes') {
      return this.handleM5ReportedFailure({
        task,
        assignment,
        contract:m5Contract,
        summary,
        completedAt,
        m5PlanRevisionReceipt,
      });
    }
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
        paperclipRunId:assignment.runId,
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:completedAt }
    };
    let updated = await this.store.updateTask(task.taskId, {
      status:requestedStatus,
      currentStage:requestedStatus === 'succeeded' ? 'paperclip_hermes_completed' : requestedStatus === 'waiting_test' ? 'paperclip_hermes_waiting_test' : 'paperclip_hermes_failed',
      artifactRefs:[
        ...(task.artifactRefs || []),
        artifact
      ],
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:completedAt,
        outcome:requestedStatus,
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
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
    if (requestedStatus === 'succeeded') {
      await this.syncM5StageWorkProducts({
        task:updated,
        assignment,
        apiKey:input.paperclipApiKey,
      });
    }
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

  async handleM5ReportedFailure({
    task,
    assignment,
    contract,
    summary,
    completedAt,
    m5PlanRevisionReceipt = null,
  } = {}) {
    const controller = new M5StageRecoveryController({
      governance:this.governance,
      workProductValidator:this.m5WorkProductValidator,
    });
    const recovery = await controller.handleFailure({
      assignment,
      contract,
      task,
      summary,
      routeExecution:task.execution?.m5RouteExecution,
    });
    const failureArtifactId = `m5-stage-failure:${assignment.pipelineCaseId}:${assignment.runId}`;
    const failureArtifact = {
      artifactId:failureArtifactId,
      taskId:task.taskId,
      type:'employee_role_report',
      data:{
        agentId:assignment.agentId,
        summary,
        paperclipIssueId:assignment.issueId,
        paperclipRunId:assignment.runId,
        m5Recovery:{
          action:recovery.action,
          stageAttempt:recovery.stageAttempt,
          replanCount:recovery.replanCount,
          recoveryAction:recovery.recoveryAction || null,
        },
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:completedAt },
    };
    const retainedArtifacts = (task.artifactRefs || []).filter((artifact) =>
      artifact.artifactId !== failureArtifactId
      && !contract.expectedWorkProduct.artifactKinds.includes(artifact.type),
    );
    const verifiedReplay = recovery.action === 'verified_work_product';
    const blocked = recovery.action === 'blocked';
    const status = verifiedReplay ? 'succeeded' : blocked ? 'failed' : 'running';
    const currentStage = verifiedReplay
      ? 'm5_stage_work_product_replayed'
      : blocked
        ? 'm5_stage_recovery_blocked'
        : recovery.action === 'replan'
          ? 'm5_content_replan_scheduled'
          : 'm5_stage_retry_scheduled';
    const updated = await this.store.updateTask(task.taskId, {
      status,
      currentStage,
      artifactRefs:[...retainedArtifacts, failureArtifact],
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:verifiedReplay || blocked ? completedAt : null,
        outcome:verifiedReplay
          ? 'verified_work_product_replayed'
          : blocked
            ? 'm5_stage_recovery_blocked'
            : recovery.action === 'replan'
              ? 'm5_content_replan_scheduled'
              : 'm5_stage_retry_scheduled',
        paperclipEmployee:null,
        m5Recovery:{
          action:recovery.action,
          stageAttempt:recovery.stageAttempt,
          replanCount:recovery.replanCount,
          runId:assignment.runId,
          replayed:recovery.replayed === true,
          recoveryAction:recovery.recoveryAction || null,
        },
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      governance:{
        ...(task.governance || {}),
        status:'synced',
        syncedAt:completedAt,
      },
      error:verifiedReplay ? undefined : {
        code:blocked ? 'm5_stage_recovery_limit_reached' : `m5_${recovery.action}_scheduled`,
        message:summary,
        userMessage:blocked
          ? recovery.recoveryAction?.instruction || 'M5 阶段恢复上限已达到，等待负责人恢复当前 Case。'
          : recovery.action === 'replan'
            ? `M5 ${contract.stageKey} 阶段重试已用尽，已安排受控内容重规划。`
            : `M5 ${contract.stageKey} 阶段已安排安全重试。`,
        category:blocked ? 'manual' : 'retryable',
        stage:contract.stageKey,
        retryable:!blocked,
        occurredAt:completedAt,
      },
    });
    return {
      task:updated,
      assignment,
      recovery,
      duplicate:recovery.replayed === true,
    };
  }

  async syncM5StageWorkProducts({ task, assignment, apiKey } = {}) {
    const contract = getM5RoutineExecutionContract(assignment?.routineKey);
    if (!contract || contract.executionMode !== 'hermes') return { synced:false, reason:'not_m5_hermes' };
    if (
      !assignment.pipelineCaseId
      || typeof this.governance?.getPipelineCaseOutputs !== 'function'
      || typeof this.governance?.createIssueWorkProduct !== 'function'
    ) {
      throw new ValidationError('M5 阶段缺少 Paperclip Case Work Product 写回能力。');
    }
    const expected = contract.expectedWorkProduct;
    const expectedVisualProjectId = contract.stageKey === 'visual_analysis'
      ? paperclipUuid(assignment.projectId)
      : null;
    if (contract.stageKey === 'visual_analysis' && !expectedVisualProjectId) {
      throw new ValidationError('M5 画面分析缺少可信 Paperclip Project，不能写入 Work Product。');
    }
    const currentOutputs = outputItems(await this.governance.getPipelineCaseOutputs(
      assignment.pipelineCaseId,
    ));
    let paperclipRunsPromise = null;
    const validatePersistedProduct = async (product) => {
      if (!this.m5WorkProductValidator) {
        throw new ValidationError(
          `M5 ${contract.stageKey} 已有 Work Product 但完整漂移校验器不可用，禁止重放或回读。`,
        );
      }
      try {
        if (!paperclipRunsPromise) {
          paperclipRunsPromise = typeof this.governance?.getPaperclipIssueRuns === 'function'
            ? this.governance.getPaperclipIssueRuns(assignment.issueId)
            : Promise.resolve([]);
        }
        await this.m5WorkProductValidator({
          contract,
          product,
          targetCaseId:assignment.pipelineCaseId,
          projectId:assignment.projectId,
          assignment,
          task,
          paperclipRuns:await paperclipRunsPromise,
        });
      } catch (error) {
        throw new ValidationError(
          `M5 ${contract.stageKey} Work Product 漂移：${error?.message || '完整校验失败'}。`,
        );
      }
      if (healthyM5StageWorkProducts([product], contract).length !== 1) {
        throw new ValidationError(
          `M5 ${contract.stageKey} Work Product 漂移：结构、Provider 或状态不符合阶段契约。`,
        );
      }
    };
    const existingStageCandidates = m5StageWorkProductCandidates(currentOutputs, contract);
    if (existingStageCandidates.length > 1) {
      throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product 或未解决漂移，必须先核对。`);
    }
    if (existingStageCandidates.length === 1) {
      const existingStageProduct = existingStageCandidates[0];
      if (
        contract.stageKey === 'visual_analysis'
        && !contentGrowthArtifactVerified(task, {
          type:'visual_analysis_package',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:existingStageProduct?.metadata?.artifact,
        }, {
          expectedProjectId:expectedVisualProjectId,
        })
      ) {
        throw new ValidationError(
          'M5 画面分析已有 Work Product 的视觉回执、哈希或 Project 发生漂移，禁止重放或覆盖。',
        );
      }
      await validatePersistedProduct(existingStageProduct);
      return {
        synced:true,
        replayed:true,
        count:1,
        schemaVersion:expected.schemaVersion,
      };
    }
    const artifacts = (task?.artifactRefs || []).filter((artifact) =>
      expected.artifactKinds.includes(artifact?.type)
      && verifiedAssignmentArtifact(artifact)
      && (
        artifact?.type !== 'visual_analysis_package'
        || contentGrowthArtifactVerified(task, artifact, {
          expectedProjectId:expectedVisualProjectId,
        })
      )
    );
    if (artifacts.length < expected.minCount) {
      throw new ValidationError(
        `M5 ${contract.stageKey} 阶段缺少 ${expected.artifactKinds.join('/')} 专用产物，不能只凭普通回报完成。`,
      );
    }

    for (const artifact of artifacts.slice(0, expected.minCount)) {
      const outputs = outputItems(await this.governance.getPipelineCaseOutputs(
        assignment.pipelineCaseId,
      ));
      const stageCandidates = m5StageWorkProductCandidates(outputs, contract);
      if (stageCandidates.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product 或未解决漂移，必须先核对。`);
      }
      const existing = outputs.filter((item) =>
        item.kind === 'work_product'
        && item.type === 'artifact'
        && item.metadata?.sourceTaskId === task.taskId
        && item.metadata?.sourceArtifactId === artifact.artifactId,
      );
      if (
        stageCandidates.length === 1
        && (
          existing.length !== 1
          || stageCandidates[0] !== existing[0]
        )
      ) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在来源不一致的 Work Product 候选，禁止覆盖。`);
      }
      if (existing.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product，必须先核对漂移。`);
      }
      if (existing.length === 1) {
        await validatePersistedProduct(existing[0]);
        continue;
      }

      const metadata = m5WorkProductMetadata({ contract, task, artifact, assignment });
      await this.governance.createIssueWorkProduct(assignment.issueId, {
        type:'artifact',
        provider:m5WorkProductProvider(expected.type),
        externalId:metadata.artifactHash,
        title:`M5 ${contract.stageKey} / ${artifact.title || expected.type}`,
        status:'active',
        reviewState:'none',
        isPrimary:true,
        healthStatus:'healthy',
        summary:`${contract.stageKey} 阶段专用产物已由当前 Paperclip Run 写回。`,
        metadata,
        createdByRunId:assignment.runId,
      }, {
        runId:assignment.runId,
        apiKey,
      });
    }

    const finalOutputs = outputItems(await this.governance.getPipelineCaseOutputs(
      assignment.pipelineCaseId,
    ));
    const finalStageCandidates = m5StageWorkProductCandidates(finalOutputs, contract);
    if (finalStageCandidates.length > expected.minCount) {
      throw new ValidationError(`M5 ${contract.stageKey} 阶段写回后存在重复 Work Product 或未解决漂移。`);
    }
    const persisted = [];
    for (const artifact of artifacts.slice(0, expected.minCount)) {
      const candidates = finalOutputs.filter((item) =>
        item.kind === 'work_product'
        && item.type === 'artifact'
        && item.metadata?.sourceTaskId === task.taskId
        && item.metadata?.sourceArtifactId === artifact.artifactId,
      );
      if (candidates.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product，必须先核对漂移。`);
      }
      if (candidates.length === 1) {
        await validatePersistedProduct(candidates[0]);
        persisted.push(candidates[0]);
      }
    }
    if (persisted.length < expected.minCount) {
      throw new ValidationError(`M5 ${contract.stageKey} Work Product 写回后无法从同一 Case 回读。`);
    }
    if (typeof this.m5WorkProductObserver === 'function') {
      await this.m5WorkProductObserver({
        pipelineCaseId:assignment.pipelineCaseId,
        stageKey:contract.stageKey,
        routineKey:contract.routineKey,
        workProductType:expected.type,
      });
    }
    return { synced:true, count:persisted.length, schemaVersion:expected.schemaVersion };
  }

  async executeAgentProposalAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'creator' || task.taskType !== 'governance.agent-proposal') {
      throw new ValidationError('当前指派不是创建官岗位草案任务。');
    }
    const existing = (task.artifactRefs || []).find((item) =>
      item.type === 'agent_proposal'
      && item.validation?.exists === true
      && item.validation?.readable === true
    );
    if (existing) {
      return {
        assignment,
        result:{
          status:'succeeded',
          verified:true,
          recommendedCompletionStatus:'succeeded',
          proposal:existing.data
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.executors.creator;
    if (!executor?.execute) throw new ValidationError('创建官草案执行器不可用。');
    const result = await executor.execute(task, {
      proposalInput:{
        requestedOutcome:String(input.requestedOutcome || assignment.title || '').trim(),
        candidateName:String(input.candidateName || '').trim(),
        agentId:String(input.agentId || '').trim(),
        department:String(input.department || '').trim(),
        responsibilities:input.responsibilities,
        nonResponsibilities:input.nonResponsibilities,
        acceptedTaskTypes:input.acceptedTaskTypes,
        desiredSkills:input.desiredSkills,
        requestedCapabilities:input.requestedCapabilities,
        acceptanceTitle:String(input.acceptanceTitle || '').trim()
      }
    });
    const artifact = (result.artifactRefs || []).find((item) =>
      item.type === 'agent_proposal'
      && item.validation?.exists === true
      && item.validation?.readable === true
    );
    if (!artifact) throw new ValidationError('创建官没有生成可读取的岗位草案。');
    const proposalStage = artifact.data?.reviewSubmission?.status === 'pending' || artifact.data?.status === 'draft'
      ? 'agent_proposal_drafted'
      : 'agent_proposal_submitted';
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:proposalStage,
      artifactRefs:[...(task.artifactRefs || []), artifact],
      execution:{
        ...(task.execution || {}),
        agentProposal:{
          executor:'creator',
          proposalId:artifact.data?.proposalId || null,
          status:artifact.data?.status || null,
          recordedAt:new Date().toISOString()
        }
      }
    });
    return {
      assignment,
      result:{
        status:'succeeded',
        verified:true,
        recommendedCompletionStatus:'succeeded',
        proposal:artifact.data
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
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

  async executeOperationsHealthAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'operator' || task.taskType !== 'operations.health-review') {
      throw new ValidationError('当前指派不是运维官确定性健康检查任务。');
    }
    const existing = (task.artifactRefs || []).find((item) =>
      item.type === 'health_report'
      && item.validation?.exists === true
      && item.validation?.readable === true
      && item.validation?.nonEmpty === true
    );
    if (existing) {
      return {
        assignment,
        result:{
          status:'succeeded',
          currentStage:task.currentStage,
          verified:true,
          healthStatus:existing.data?.overall || 'unknown',
          recommendedCompletionStatus:'succeeded',
          artifacts:[artifactExecutionView(existing)]
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.executors.operator;
    if (!executor?.execute) throw new ValidationError('运维官确定性健康检查执行器不可用。');
    const result = await executor.execute(task);
    const artifacts = (result.artifactRefs || []).filter((item) => item.type === 'health_report');
    const verified = artifacts.some((item) =>
      item.validation?.exists === true
      && item.validation?.readable === true
      && item.validation?.nonEmpty === true
    );
    if (!verified) throw new ValidationError('运维官没有生成可核验的健康报告。');
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result.currentStage || 'health_report_ready',
      artifactRefs:[...(task.artifactRefs || []), ...artifacts],
      execution:{
        ...(task.execution || {}),
        operationsHealth:result.execution || null
      },
      usage:result.usage || task.usage
    });
    return {
      assignment,
      result:{
        status:result.status || 'succeeded',
        currentStage:updated.currentStage,
        verified:true,
        healthStatus:artifacts[0]?.data?.overall || 'unknown',
        recommendedCompletionStatus:'succeeded',
        artifacts:artifacts.map(artifactExecutionView)
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  }

  async executeEmployeeAssignment(input = {}) {
    const verified = await this.getPaperclipAssignment(input);
    const { task, assignment } = verified;
    const roleToolGrant = verified[ROLE_TOOL_GRANT] || null;
    const openResearchExecutionPolicy = verified[OPEN_RESEARCH_EXECUTION_POLICY] || null;
    const agent = await this.registry.get(assignment.agentId);
    try {
      assertPaperclipEmployeeExecutorAssignment({ agent, task });
    } catch (error) {
      throw new ValidationError(error?.message || '当前员工指派不允许执行。');
    }
    const hasM5Recovery = Boolean(task.input?.context?.m5Recovery);
    const observationDrivenResearch = task.taskType === 'research.open-investigation';
    const observationDrivenResearchActive = observationDrivenResearch
      && task.execution?.paperclipEmployee?.state !== 'settled';
    const stored = hasM5Recovery || observationDrivenResearchActive
      ? null
      : storedPaperclipEmployeeResult(task);
    if (stored) return { assignment, result:stored, task:taskExecutionView(task), duplicate:true };

    let run = this.employeeAssignmentRuns.get(task.taskId);
    const joined = Boolean(run);
    if (!run) {
      const executor = this.executors[assignment.agentId];
      if (!observationDrivenResearch && !executor?.execute) {
        throw new ValidationError('当前岗位的受控本机执行器不可用。');
      }
      const promise = this.runEmployeeAssignment({
        task,
        assignment,
        agent,
        executor,
        roleToolGrant,
        openResearchExecutionPolicy,
      });
      run = { promise };
      this.employeeAssignmentRuns.set(task.taskId, run);
      void promise.finally(() => {
        if (this.employeeAssignmentRuns.get(task.taskId) === run) this.employeeAssignmentRuns.delete(task.taskId);
      }).catch(() => {});
    }
    const completed = await run.promise;
    return joined ? { ...completed, duplicate:true } : completed;
  }

  async runEmployeeAssignment({
    task,
    assignment,
    agent,
    executor,
    roleToolGrant = null,
    openResearchExecutionPolicy = null,
  }) {
    const executionStartedAt = new Date();
    const m5Contract = getM5RoutineExecutionContract(assignment?.routineKey);
    let result;
    let routeExecution = null;
    try {
      const roleToolContext = roleToolGrant
        ? createM5RoleToolExecutionContext(roleToolGrant.grant, {
            adapters:this.roleToolAdapters,
            workspaceRoot:roleToolGrant.workspaceRoot,
            trustedScope:roleToolGrant.trustedScope,
          })
        : null;
      const prepared = prepareM5ExecutorTask({
        task,
        assignment,
        contract:m5Contract,
      });
      routeExecution = prepared.routeExecution;
      if (prepared.recovery) {
        assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
      }
      const paperclipWorkProducts = task.taskType === 'research.open-investigation'
        ? await this.readOpenResearchWorkProducts(assignment)
        : null;
      result = task.taskType === 'research.open-investigation'
        ? await executeIntelResearchOpenTaskStep({
            task:prepared.task,
            agent,
            assignment,
            executionPolicy:openResearchExecutionPolicy,
            paperclipWorkProducts,
            roleToolContext,
            reportExecutor:executor,
            writeStepWorkProduct:async (product) => {
              if (typeof this.governance?.createIssueWorkProduct !== 'function') {
                throw new ValidationError(
                  '小R开放研究缺少 Paperclip Work Product 写回能力。',
                );
              }
              return this.governance.createIssueWorkProduct(
                assignment.issueId,
                product,
                { runId:assignment.runId },
              );
            },
            readWorkProducts:() => this.readOpenResearchWorkProducts(assignment),
          })
        : await executor.execute(
            prepared.task,
            roleToolContext
              ? { roleToolContext, m5Recovery:prepared.recovery }
              : prepared.recovery
                ? { m5Recovery:prepared.recovery }
                : undefined,
          );
      if (
        roleToolContext
        && roleToolContext.snapshot().length === 0
        && result?.openResearch?.reusedReport !== true
      ) {
        throw new M5RoleToolGrantError(
          '受控执行器没有经过岗位工具授权上下文。',
          'role_tool_not_enforced',
        );
      }
    } catch (error) {
      const occurredAt = new Date().toISOString();
      result = {
        status:m5Contract?.executionMode === 'hermes' ? 'failed' : 'waiting_test',
        currentStage:'paperclip_employee_execution_failed',
        artifactRefs:[],
        error:{
          code:String(error?.code || 'paperclip_employee_executor_failed').slice(0, 120),
          message:String(error?.message || '员工受控执行器失败。').slice(0, 500),
          userMessage:m5Contract?.executionMode === 'hermes'
            ? 'M5 阶段本次执行失败；请按 Paperclip 恢复策略回报 failed。'
            : '员工未完成当前指派，已保留真实失败原因。',
          category:m5Contract?.executionMode === 'hermes'
            ? 'retryable'
            : String(error?.category || 'manual').slice(0, 80),
          stage:'paperclip_employee_execution',
          retryable:m5Contract?.executionMode === 'hermes' || error?.retryable === true,
          occurredAt,
        },
      };
    }
    const artifacts = Array.isArray(result?.artifactRefs) ? result.artifactRefs : [];
    const verified = result?.status === 'succeeded' && artifacts.some(verifiedAssignmentArtifact);
    const recommendedCompletionStatus = result?.status === 'running'
      ? 'running'
      : verified
        ? 'succeeded'
        : result?.status === 'failed'
          ? 'failed'
          : 'waiting_test';
    const settled = recommendedCompletionStatus !== 'running';
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result?.currentStage || (settled ? 'paperclip_employee_executed' : 'paperclip_employee_running'),
      artifactRefs:[...(latest.artifactRefs || []), ...artifacts],
      execution:{
        ...(latest.execution || {}),
        ...(result?.execution || {}),
        owner:'paperclip-hermes',
        paperclipEmployee:{
          state:settled ? 'settled' : 'running',
          executor:assignment.agentId,
          status:String(result?.status || recommendedCompletionStatus),
          verified,
          recommendedCompletionStatus,
          startedAt:executionStartedAt.toISOString(),
          updatedAt:new Date().toISOString(),
        },
        ...(routeExecution ? { m5RouteExecution:routeExecution } : {}),
      },
      usage:recordTaskUsage({ task, result, startedAt:executionStartedAt }),
      ...(result?.error ? { error:result.error } : { error:undefined }),
    });
    if (!settled && typeof executor?.observe === 'function') executor.observe(updated);
    return {
      assignment,
      result:{
        status:String(result?.status || recommendedCompletionStatus),
        currentStage:updated.currentStage,
        verified,
        recommendedCompletionStatus,
        ...(recommendedCompletionStatus === 'running'
          ? {
              continuePolling:true,
              pollAfterSeconds:3,
              message:'当前岗位的本机工作仍在执行；请再次调用 employee_assignment_execute 获取真实状态。',
            }
          : {}),
        error:result?.error || null,
        artifacts:artifacts.map(artifactExecutionView),
        ...(result?.openResearch ? { openResearch:result.openResearch } : {}),
      },
      task:taskExecutionView(updated),
      duplicate:false,
    };
  }

  async readOpenResearchWorkProducts(assignment) {
    if (typeof this.governance?.getIssueWorkProducts !== 'function') {
      throw new ValidationError(
        '小R开放研究缺少 Paperclip Work Product 回读能力。',
      );
    }
    return this.governance.getIssueWorkProducts(
      assignment.issueId,
      { runId:assignment.runId },
    );
  }

  async executeContentGrowthAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    const allowed = {
      'video-content-analyst':new Set([
        'content.video-benchmark-analysis',
        'content.performance-review',
        'content.campaign-visual-analysis',
      ]),
      'content-creator':new Set(['content.platform-draft', 'content.video-script-package'])
    };
    if (!allowed[assignment.agentId]?.has(task.taskType)) throw new ValidationError('当前指派不是受控内容增长任务。');
    const artifactTypes = {
      'content.video-benchmark-analysis':'video_content_analysis_report',
      'content.performance-review':'content_performance_report',
      'content.campaign-visual-analysis':'visual_analysis_package',
      'content.platform-draft':'platform_content_draft',
      'content.video-script-package':'video_script_package'
    };
    const expectedType = artifactTypes[task.taskType];
    const hasM5Recovery = Boolean(task.input?.context?.m5Recovery);
    const existing = hasM5Recovery
      ? null
      : (task.artifactRefs || []).find((item) =>
          item.type === expectedType
          && item.validation?.exists === true
          && item.validation?.readable === true
        );
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
    const settled = hasM5Recovery ? null : storedContentGrowthResult(task, expectedType);
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
      const providerVision = task.taskType === 'content.campaign-visual-analysis'
        ? this.m5ProviderVisionCallback({
            assignment,
            paperclipApiKey:input.paperclipApiKey,
          })
        : null;
      const promise = this.runContentGrowthAssignment({
        task,
        assignment,
        expectedType,
        executor,
        providerVision,
      });
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

  async runContentGrowthAssignment({
    task,
    assignment,
    expectedType,
    executor,
    providerVision = null,
  }) {
    const executionStartedAt = new Date();
    const m5Contract = getM5RoutineExecutionContract(assignment?.routineKey);
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
    let routeExecution = null;
    try {
      const prepared = prepareM5ExecutorTask({
        task:started,
        assignment,
        contract:m5Contract,
      });
      routeExecution = prepared.routeExecution;
      if (prepared.recovery) {
        assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
      }
      result = await executor.execute(
        prepared.task,
        {
          ...(prepared.recovery ? { m5Recovery:prepared.recovery } : {}),
          ...(providerVision ? { providerVision } : {}),
        },
      );
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
        },
        ...(routeExecution ? { m5RouteExecution:routeExecution } : {}),
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

  m5ProviderVisionCallback({ assignment, paperclipApiKey }) {
    if (
      typeof this.m5ProviderVision !== 'function'
      || !assignment?.pipelineCaseId
      || !String(paperclipApiKey || '').trim()
    ) return null;
    const caseId = String(assignment.pipelineCaseId);
    const apiKey = String(paperclipApiKey);
    let used = false;
    return (parameters) => {
      if (used) {
        throw new ValidationError('当前 heartbeat 的 M5 视觉 Provider callback 已使用，禁止第二次付费调用。');
      }
      used = true;
      const keys = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? Object.keys(parameters).sort()
        : [];
      if (keys.join(',') !== 'actionId,prompt,relativePath') {
        throw new ValidationError('M5 视觉 Provider callback 只接受 actionId、relativePath、prompt。');
      }
      const actionId = String(parameters.actionId || '');
      const relativePath = String(parameters.relativePath || '').replaceAll('\\', '/');
      const prompt = parameters.prompt;
      const actionPrefix = `${caseId}:vision:`;
      if (
        !actionId.startsWith(actionPrefix)
        || !/^[0-9a-f]{16}$/i.test(actionId.slice(actionPrefix.length))
        || !safeM5VisionRelativePath(relativePath)
        || typeof prompt !== 'string'
        || !prompt.trim()
        || prompt.length > 1_000
      ) {
        throw new ValidationError('M5 视觉 Provider callback 参数不在当前 Case 的受控范围内。');
      }
      return this.m5ProviderVision({
        caseId,
        parameters:{ actionId, relativePath, prompt },
        authentication:{
          requireRunAuthentication:true,
          paperclipApiKey:apiKey,
        },
      });
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
    const presentedTasks = tasks.map((task) => ({
      ...task,
      presentation:presentTask(task, { approvals, detailBaseUrl:this.taskDetailBaseUrl })
    }));
    return { agents:visibleAgents, alwaysOnAgents, onDemandAgents, tasks:presentedTasks, approvals, taskFocus: buildTaskFocus(tasks, approvals), usage:summarizeTaskUsage(tasks, { since:startOfToday() }), capabilities: [
      { id: 'task-coordination', name: '统一任务协调', status: 'ready', detail: '创建、路由和状态真相已就绪。' },
      { id: 'agent-registry', name: '岗位注册表', status: 'ready', detail: '岗位职责、任务类型和权限边界从 Manifest 读取。' },
      { id: 'approval-gate', name: '审批闸门', status: 'ready', detail: '高风险描述先进入待审批，不自动执行。' },
      { id: 'content-public-web-fetch', name: '公开资料读取', status: 'ready', detail: '可读取公开网页、动态页面和 PDF；拒绝内网、登录态与越权内容。' },
      { id: 'authorized-content-read', name: '登录平台只读采集', status: 'partial', detail: '小D已接入受控账号和平台专用通道；当前是否可读以“连接”页和具体任务验证为准。' },
      { id: 'governance', name: 'Paperclip 治理投影', status: governance.status, detail: governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）。` : 'Paperclip 未连接；任务仍可登记，后续可补同步。' },
      { id: 'feishu-channel', name: '飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail },
      { id: 'mac-worker', name: 'Mac工作间安全接力', status:worker.status, detail:worker.detail },
      { id: 'external-execution', name: '外部发布与写入', status: 'planned', detail: '外部发布和其他写入动作尚未接入；登录型只读采集不等于已经开放写入。' }
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

function validatedM5StagePluginData(stageKey, expectedArtifactKind, result) {
  const declared = declaredM5StageArtifact(result, expectedArtifactKind);
  const data = structuredClone(declared?.data || result);
  delete data.toolId;
  delete data.pluginId;
  delete data.artifact;
  delete data.artifactRefs;
  const unsafe = findUnsafeM5PluginValue(data);
  if (unsafe) throw new ValidationError(`M5 内容插件回执包含不允许持久化的字段或路径：${unsafe}。`);
  if (stageKey === 'parallel_image_generation') {
    if (
      !safeRelativeArtifactPath(data.relativePath, '.png')
      || !sha256Value(data.checksum)
      || !Number.isInteger(Number(data.bytes))
      || Number(data.bytes) <= 0
      || data.model !== 'step-image-edit-2'
      || !Number.isInteger(Number(data.seed))
      || !validConfirmedM5ProviderReceipt(data.providerReceipt, 'image_generate')
    ) {
      throw new ValidationError('M5 并行生图回执缺少真实 PNG、模型、种子或 confirmed Provider action/cost 血缘。');
    }
  } else if (stageKey === 'voice') {
    if (
      !safeRelativeArtifactPath(data.relativePath, '.mp3')
      || !sha256Value(data.checksum)
      || !Number.isInteger(Number(data.bytes))
      || Number(data.bytes) <= 0
      || data.model !== 'stepaudio-2.5-tts'
      || !String(data.voice || '').trim()
      || !validConfirmedM5ProviderReceipt(data.providerReceipt || data, 'tts')
    ) {
      throw new ValidationError('M5 配音回执缺少真实 MP3、模型、官方音色或 confirmed Provider action/cost 血缘。');
    }
  } else if (stageKey === 'render') {
    if (declared && data.outputs) {
      const expected = {
        master:['M5Master', 'master.mp4'],
        douyin:['M5Douyin', 'douyin.mp4'],
        xiaohongshu:['M5Xiaohongshu', 'xiaohongshu.mp4'],
      };
      if (
        typeof data.outputs !== 'object'
        || Array.isArray(data.outputs)
        || Object.keys(expected).some((platform) =>
          !validM5RenderOutput(data.outputs[platform], ...expected[platform]),
        )
      ) {
        throw new ValidationError('M5 RenderPackage 必须包含 master、douyin、xiaohongshu 三份固定成片及真实回执。');
      }
      const master = data.outputs.master;
      Object.assign(data, {
        composition:master.composition,
        propsPath:master.propsPath,
        outputPath:master.outputPath,
        relativePath:master.outputPath,
        checksum:master.checksum,
        bytes:Number(master.bytes),
      });
    } else {
      if (
        !safeRelativeArtifactPath(data.outputPath, '.mp4')
        || !sha256Value(data.checksum)
        || !Number.isInteger(Number(data.bytes))
        || Number(data.bytes) <= 0
        || !['M5Master', 'M5Douyin', 'M5Xiaohongshu'].includes(data.composition)
      ) {
        throw new ValidationError('M5 渲染回执缺少真实 MP4 相对路径、文件哈希、字节数或固定 Composition。');
      }
      data.relativePath = data.outputPath;
    }
  } else if (stageKey === 'machine_review') {
    if (!declared) {
      throw new ValidationError('M5 机器审核必须返回显式专用 artifact，单一 media-validate 回执不能冒充完整审核。');
    }
    const review = data.reviewReport && typeof data.reviewReport === 'object'
      ? data.reviewReport
      : data;
    const checks = review.checks;
    const requiredChecks = ['facts', 'privacy', 'rights', 'media', 'claims', 'grantScope', 'duplicate'];
    if (
      !['passed', 'failed'].includes(review.status)
      || !checks
      || typeof checks !== 'object'
      || requiredChecks.some((key) => typeof checks[key] !== 'boolean')
    ) {
      throw new ValidationError('M5 机器审核专用产物缺少七项门禁的确定性结论。');
    }
    if (review.status === 'passed' && !validM5ArtifactPackage(review.evidence?.artifactPackage)) {
      throw new ValidationError('M5 机器审核通过回执缺少已校验的固定产物包、manifest 哈希或完整产物清单。');
    }
    return { reviewReport:structuredClone(review) };
  } else if (stageKey === 'publish_approval') {
    if (
      typeof data.passed !== 'boolean'
      || !Array.isArray(data.errors)
      || !String(data.idempotencyKey || '').trim()
    ) {
      throw new ValidationError('M5 发布审批回执缺少确定性门禁结论或幂等键。');
    }
    data.status = data.passed ? 'passed' : 'failed';
  } else if (stageKey === 'verify') {
    if (
      !declared
      || data.status !== 'passed'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(data.receiptId || ''))
      || !['douyin', 'xiaohongshu'].includes(data.platform)
      || !String(data.externalContentId || '').trim()
      || !String(data.evidence || '').trim()
      || !sha256Value(data.contentChecksum)
    ) {
      throw new ValidationError('M5 发布核验专用产物缺少可信 PublishReceipt、平台内容ID、成功证据或内容哈希。');
    }
  } else {
    throw new ValidationError(`M5 阶段 ${stageKey} 没有插件回执校验器。`);
  }
  return data;
}

function declaredM5StageArtifact(result, expectedArtifactKind) {
  const candidates = [
    result?.artifact,
    ...(Array.isArray(result?.artifactRefs) ? result.artifactRefs : []),
  ].filter(Boolean);
  if (!candidates.length) return null;
  const matches = candidates.filter((item) => item?.type === expectedArtifactKind);
  if (matches.length !== 1) {
    throw new ValidationError(`M5 阶段必须且只能返回一个 ${expectedArtifactKind} 专用产物。`);
  }
  const artifact = matches[0];
  if (
    !artifact.data
    || typeof artifact.data !== 'object'
    || Array.isArray(artifact.data)
    || artifact.validation?.exists !== true
    || artifact.validation?.readable !== true
    || artifact.validation?.nonEmpty !== true
  ) {
    throw new ValidationError(`M5 ${expectedArtifactKind} 专用产物没有通过 exists/readable/nonEmpty 门禁。`);
  }
  return artifact;
}

function validM5RenderOutput(value, composition, fileName) {
  return value
    && value.composition === composition
    && safeRelativeArtifactPath(value.propsPath, '.props.json')
    && safeRelativeArtifactPath(value.outputPath, '.mp4')
    && String(value.outputPath).replaceAll('\\', '/').endsWith(`/${fileName}`)
    && sha256Value(value.checksum)
    && Number.isInteger(Number(value.bytes))
    && Number(value.bytes) > 0;
}

function findUnsafeM5PluginValue(value, path = 'result', seen = new Set()) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (/^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])/.test(value.trim())) return path;
    return null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return `${path}.__cycle__`;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|token|cookie|authorization|credential|api[_-]?key)/i.test(key)) {
      return `${path}.${key}`;
    }
    const unsafe = findUnsafeM5PluginValue(nested, `${path}.${key}`, seen);
    if (unsafe) return unsafe;
  }
  return null;
}

function safeRelativeArtifactPath(value, extension) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && relative.toLowerCase().endsWith(extension)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
  );
}

function safeRelativeImageArtifactPath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && /\.(?:jpe?g|png|webp)$/i.test(relative)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function safeM5VisionRelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(
    relative
    && /\.png$/i.test(relative)
    && !relative.startsWith('/')
    && relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function sha256Value(value) {
  return /^(?:sha256:)?[0-9a-f]{64}$/i.test(String(value || '').trim());
}

function paperclipUuid(value) {
  const id = String(value || '').trim();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function validConfirmedM5ProviderReceipt(value, operation) {
  const actionId = String(value?.actionId || '').trim();
  const record = value?.callRecord;
  const commit = value?.costCommit;
  return /^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
    && value?.operation === operation
    && record?.actionId === actionId
    && record?.operation === operation
    && record?.model === value?.model
    && sha256Value(record?.promptChecksum)
    && commit?.status === 'confirmed'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(commit?.costEventId || ''))
    && commit?.costEvent?.provider === 'stepfun'
    && Number.isInteger(Number(commit?.costEvent?.costCents))
    && Number(commit.costEvent.costCents) >= 0;
}

function taskExecutionView(task) {
  return {
    taskId:task.taskId,
    taskType:task.taskType,
    status:task.status,
    currentStage:task.currentStage,
  };
}

function paperclipCaseContextFields(fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const allowed = [
    'campaignId',
    'scheduledDate',
    'theme',
    'platform',
    'contentVersion',
    'contentVersionId',
    'assetRightsBasis',
  ];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return [[key, value.trim().slice(0, 500)]];
    if (Number.isInteger(value)) return [[key, value]];
    return [];
  }));
}

function m5PlanRevisionExecutionContext(revision) {
  return {
    schemaVersion:revision.schemaVersion,
    revisionId:revision.revisionId,
    revision:revision.revision,
    failedCaseId:revision.failedCaseId,
    failureObservation:{
      issueId:revision.failureObservation?.issueId || null,
      runId:revision.failureObservation?.runId || null,
      stageKey:revision.failureObservation?.stageKey || null,
      summary:revision.failureObservation?.summary || '',
      summaryHash:revision.failureObservation?.summaryHash || null,
    },
    rejectedRoute:{
      kind:revision.rejectedRoute?.kind || null,
      reason:revision.rejectedRoute?.reason || '',
      routeFingerprint:revision.rejectedRoute?.routeFingerprint || null,
      execution:revision.rejectedRoute?.execution || null,
    },
    nextRoute:{
      kind:revision.nextRoute?.kind,
      stageKey:revision.nextRoute?.stageKey,
      preserveVerifiedWorkProducts:revision.nextRoute?.preserveVerifiedWorkProducts === true,
      instruction:revision.nextRoute?.instruction || '',
    },
  };
}

function assertM5PlanRevisionConsumed({
  expected,
  actual,
  runId,
  allowUnchangedFailure = false,
  input,
} = {}) {
  if (!expected) return null;
  const revisionId = String(expected.revisionId || '').trim();
  const consumedRevisionId = String(input?.consumedRevisionId || '').trim();
  if (!revisionId || consumedRevisionId !== revisionId) {
    throw new ValidationError('当前 M5 Run 必须精确回报已消费的 PlanRevision ID。');
  }
  if (
    !validM5RouteExecution(actual)
    || actual.runId !== runId
    || actual.consumedRevisionId !== revisionId
    || actual.stageKey !== expected.nextRoute?.stageKey
  ) {
    throw new ValidationError('当前 M5 Run 没有执行器生成的 PlanRevision 消费回执。');
  }
  if (
    !allowUnchangedFailure
    && (actual.routeChanged !== true || actual.changedDimensions.length === 0)
  ) {
    throw new ValidationError(
      '执行器确认本次输入、工具和策略均未变化；拒绝把同一路线写成已恢复。',
    );
  }
  return {
    schemaVersion:'agent.army/m5-plan-revision-receipt/v1',
    consumedRevisionId,
    routeChanged:actual.routeChanged === true,
    changedDimensions:[...actual.changedDimensions],
    routeFingerprint:actual.routeFingerprint,
    routeSummary:actual.routeSummary,
    stageKey:expected.nextRoute?.stageKey || null,
    recordedAt:new Date().toISOString(),
  };
}

function prepareM5ExecutorTask({ task, assignment, contract } = {}) {
  if (!contract || contract.executionMode !== 'hermes') {
    return { task, recovery:null, routeExecution:null };
  }
  const recovery = task?.input?.context?.m5Recovery || null;
  const strategy = recovery?.nextRoute?.kind
    || `default:${contract.executionTool?.id || 'hermes_executor'}`;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const routeExecution = createM5RouteExecution({
    runId:assignment.runId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds:[contract.executionTool?.id || 'hermes_executor'],
    inputs:m5BusinessExecutionInput(task?.input),
  });
  if (!recovery) return { task, recovery:null, routeExecution };
  return {
    recovery,
    routeExecution,
    task:{
      ...task,
      input:{
        ...(task.input || {}),
        context:{
          ...(task.input?.context || {}),
          m5AlternativeRoute:{
            revisionId:recovery.revisionId,
            strategy,
            instruction:recovery.nextRoute?.instruction || '',
            preserveVerifiedWorkProducts:
              recovery.nextRoute?.preserveVerifiedWorkProducts === true,
          },
        },
      },
    },
  };
}

function assertM5ExecutorRouteReceipt({
  task,
  contract,
  result,
  allowUnchanged = false,
} = {}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  if (!recovery && !validM5RouteExecution(result)) return null;
  if (
    !validM5RouteExecution(result)
    || result.runId !== task?.execution?.paperclipRunId
    || result.stageKey !== contract?.stageKey
  ) {
    throw new ValidationError('M5 阶段执行器缺少与当前 Run、阶段一致的真实路线回执。');
  }
  if (recovery) {
    if (result.consumedRevisionId !== recovery.revisionId) {
      throw new ValidationError('M5 阶段执行器消费的 PlanRevision 与当前指派不一致。');
    }
    if (!allowUnchanged && (result.routeChanged !== true || result.changedDimensions.length === 0)) {
      throw new ValidationError('M5 阶段执行器没有真实改变输入、工具或策略。');
    }
  }
  return result;
}

function m5BusinessExecutionInput(input) {
  if (!input || typeof input !== 'object') return {};
  const context = input.context && typeof input.context === 'object'
    ? Object.fromEntries(
        Object.entries(input.context)
          .filter(([key]) => !['m5Recovery', 'm5AlternativeRoute'].includes(key)),
      )
    : {};
  return {
    ...input,
    context,
  };
}

function trustedRoleToolScope({
  tasks,
  task,
  relatedTaskIds,
  paperclipIssueId = null,
  paperclipRunId = null,
  pipelineCaseId = null,
} = {}) {
  const relatedIds = new Set(
    (Array.isArray(relatedTaskIds) ? relatedTaskIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  const parentTaskId = String(task?.parentTaskId || '').trim();
  const currentTaskId = String(task?.taskId || '').trim();
  const allowedTaskIds = (Array.isArray(tasks) ? tasks : []).filter((candidate) =>
    candidate?.taskId !== currentTaskId
    && (
      relatedIds.has(String(candidate?.taskId || ''))
      || (parentTaskId && candidate?.parentTaskId === parentTaskId)
    ),
  ).map((candidate) => candidate.taskId);
  return Object.freeze({
    allowedTaskIds:Object.freeze(allowedTaskIds),
    paperclipIssueId:String(paperclipIssueId || '').trim() || null,
    paperclipRunId:String(paperclipRunId || '').trim() || null,
    pipelineCaseId:String(pipelineCaseId || '').trim() || null,
  });
}

async function m5PipelineCaseChainIds({ governance, pipelineCaseId, pipelineCase }) {
  const firstId = String(pipelineCaseId || '').trim();
  if (!firstId) return [];
  const caseIds = [];
  const visited = new Set();
  let current = pipelineCase?.case || pipelineCase || { id:firstId };
  for (let depth = 0; depth < 32; depth += 1) {
    const currentId = String(current?.id || (depth === 0 ? firstId : '')).trim();
    if (!currentId || visited.has(currentId)) {
      throw new ValidationError('M5 Pipeline Case 父子链无效或存在循环。');
    }
    caseIds.push(currentId);
    visited.add(currentId);
    const parentCaseId = String(current?.parentCaseId || '').trim();
    if (!parentCaseId) return caseIds;
    if (typeof governance?.getPipelineCase !== 'function') {
      throw new ValidationError('M5 Pipeline Case 缺少父级读取能力，无法绑定前置产物。');
    }
    const parent = await governance.getPipelineCase(parentCaseId);
    current = parent?.case || parent;
    if (!current) throw new ValidationError('M5 Pipeline Case 父级不存在，无法绑定前置产物。');
  }
  throw new ValidationError('M5 Pipeline Case 父子链超过安全深度。');
}

function m5RelatedTaskContext(tasks, pipelineCaseIds, pipelineCase = null) {
  const allowedCaseIds = new Set(
    (Array.isArray(pipelineCaseIds) ? pipelineCaseIds : [pipelineCaseIds])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (!allowedCaseIds.size) return { sourceTaskIds:[], sourceUrls:[] };
  const currentFields = paperclipCaseContextFields(
    pipelineCase?.case?.fields || pipelineCase?.fields || {},
  );
  const sameContentDay = (candidate) => {
    const fields = candidate?.input?.context?.pipelineCase?.fields || {};
    return Boolean(
      currentFields.campaignId
      && currentFields.scheduledDate
      && fields.campaignId === currentFields.campaignId
      && fields.scheduledDate === currentFields.scheduledDate
      && String(fields.contentVersion || 'v1') === String(currentFields.contentVersion || 'v1'),
    );
  };
  const related = (Array.isArray(tasks) ? tasks : [])
    .filter((item) =>
      (
        allowedCaseIds.has(String(item?.input?.context?.pipelineCaseId || '').trim())
        || sameContentDay(item)
      )
      && item?.governance?.paperclipIssueId
      && !['failed', 'cancelled'].includes(item.status),
    )
    .sort((left, right) =>
      Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0),
    );
  const sourceUrls = related.flatMap((item) => (item.artifactRefs || []).flatMap((artifact) => {
    if (artifact?.validation?.publicReadOnly !== true) return [];
    const sources = Array.isArray(artifact.data?.sources) ? artifact.data.sources : [];
    return sources.map((source) => String(source.source || source.url || '').trim())
      .filter((value) => /^https?:\/\//i.test(value));
  }));
  return {
    sourceTaskIds:[...new Set(related.map((item) => item.taskId).filter(Boolean))].slice(-20),
    sourceUrls:[...new Set(sourceUrls)].slice(0, 5),
  };
}

function m5WorkProductMetadata({ contract, task, artifact, assignment }) {
  const expected = contract.expectedWorkProduct;
  const safeData = sanitizeM5ArtifactData(artifact.data);
  const metadata = {
    schemaVersion:expected.schemaVersion,
    kind:expected.type,
    stageKey:contract.stageKey,
    routineKey:contract.routineKey,
    sourceTaskId:task.taskId,
    sourceArtifactId:String(artifact.artifactId || `${artifact.type}:${task.taskId}`).slice(0, 240),
    sourceIssueId:String(assignment?.issueId || task.governance?.paperclipIssueId || '').trim(),
    pipelineCaseId:String(assignment?.pipelineCaseId || task.input?.context?.pipelineCaseId || '').trim(),
    projectId:String(assignment?.projectId || task.input?.context?.paperclipProjectId || '').trim(),
    sourceRunId:String(assignment?.runId || task.execution?.paperclipRunId || '').trim(),
    artifactKind:artifact.type,
    artifact:safeData,
  };
  metadata.artifactHash = m5WorkProductArtifactHash(metadata);
  if (expected.type === 'ContentVersion') {
    const contentVersion = safeData?.contentVersion;
    if (!validM5ContentVersion(contentVersion)) {
      throw new ValidationError(
        '平台适配产物缺少可发布 ContentVersion（平台、版本、sha256、相对媒体路径、标题、正文和标签）。',
      );
    }
    metadata.contentVersion = contentVersion;
  }
  if (expected.type === 'MachineReview') {
    const reviewReport = safeData?.reviewReport;
    if (!validM5MachineReview(reviewReport)) {
      throw new ValidationError('机器审核产物没有完整通过七项发布门禁，不能写成可信 MachineReview。');
    }
    metadata.reviewReport = reviewReport;
  }
  return metadata;
}

function m5WorkProductProvider(kind) {
  return ['ContentVersion', 'MachineReview'].includes(kind)
    ? 'agent-army.content-autonomy'
    : 'agent-army.ajun-runtime';
}

function sanitizeM5ArtifactData(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.slice(0, 20_000);
    if (/^file:\/\//i.test(text) || /^(?:\/|[A-Za-z]:[\\/])/.test(text)) {
      return '[redacted-local-path]';
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeM5ArtifactData(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, 2_000);
  const denied = /(?:^|_)(?:authorization|cookie|credentials?|password|secrets?|session|token|api[_-]?key|file[_-]?path|local[_-]?path)(?:$|_)/i;
  return Object.fromEntries(Object.entries(value).slice(0, 300).flatMap(([key, child]) =>
    denied.test(key) ? [] : [[key, sanitizeM5ArtifactData(child, depth + 1)]],
  ));
}

function validM5ContentVersion(value) {
  return value
    && ['douyin', 'xiaohongshu'].includes(value.platform)
    && /^[a-z0-9][a-z0-9_.:-]{2,127}$/i.test(String(value.contentVersionId || ''))
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.checksum || ''))
    && validM5RelativePath(value.mediaPath)
    && Boolean(String(value.title || '').trim())
    && Boolean(String(value.body || '').trim())
    && Array.isArray(value.tags);
}

function validM5MachineReview(value) {
  const checks = [
    'facts',
    'privacy',
    'rights',
    'media',
    'claims',
    'grantScope',
    'duplicate',
  ];
  return value?.status === 'passed'
    && checks.every((key) => value?.checks?.[key] === true)
    && validM5ArtifactPackage(value?.evidence?.artifactPackage);
}

const M5_REQUIRED_ARTIFACTS = Object.freeze([
  'master.mp4',
  'douyin.mp4',
  'xiaohongshu.mp4',
  'douyin.copy.json',
  'xiaohongshu.copy.json',
  'cover.png',
  'sources.json',
  'review.json',
  'lineage.json',
]);

function validM5ArtifactPackage(value) {
  const artifacts = Array.isArray(value?.requiredArtifacts)
    ? value.requiredArtifacts.map((item) => String(item || '').trim())
    : [];
  return validM5RelativePath(value?.manifestPath)
    && String(value.manifestPath).endsWith('/artifact-manifest.json')
    && sha256Value(value?.manifestChecksum)
    && artifacts.length === M5_REQUIRED_ARTIFACTS.length
    && new Set(artifacts).size === M5_REQUIRED_ARTIFACTS.length
    && M5_REQUIRED_ARTIFACTS.every((name) => artifacts.includes(name));
}

function validM5RelativePath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(text)
    && !text.startsWith('/')
    && text.split('/').every((part) => part && part !== '.' && part !== '..');
}

function outputItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function canonicalOpenResearchExecutionPolicy(issue) {
  const value = issue?.executionPolicy?.openResearch;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({
    remainingUnits:value.remainingUnits,
    estimatedNextStepUnits:value.estimatedNextStepUnits,
  });
}

function verifiedAssignmentArtifact(item) {
  return item?.validation?.exists === true
    && item?.validation?.readable === true
    && item?.validation?.nonEmpty === true;
}
function storedPaperclipEmployeeResult(task) {
  const execution = task?.execution?.paperclipEmployee;
  if (execution?.state === 'running' && task.status === 'running') {
    return {
      status:'running',
      currentStage:task.currentStage,
      verified:false,
      recommendedCompletionStatus:'running',
      continuePolling:true,
      pollAfterSeconds:3,
      message:'当前岗位的本机工作仍在执行；请再次调用 employee_assignment_execute 获取真实状态。',
      artifacts:[],
    };
  }
  if (execution?.state === 'settled') {
    return {
      status:String(execution.status || execution.recommendedCompletionStatus || 'waiting_test'),
      currentStage:task.currentStage,
      verified:execution.verified === true,
      recommendedCompletionStatus:['succeeded', 'failed', 'waiting_test'].includes(execution.recommendedCompletionStatus)
        ? execution.recommendedCompletionStatus
        : 'waiting_test',
      error:task.error || null,
      artifacts:(task.artifactRefs || []).filter(verifiedAssignmentArtifact).map(artifactExecutionView),
    };
  }
  if (isTerminalTask(task)) {
    const verified = task.status === 'succeeded' && (task.artifactRefs || []).some(verifiedAssignmentArtifact);
    return {
      status:task.status,
      currentStage:task.currentStage,
      verified,
      recommendedCompletionStatus:verified
        ? 'succeeded'
        : task.status === 'failed'
          ? 'failed'
          : 'waiting_test',
      error:task.error || null,
      artifacts:(task.artifactRefs || []).filter(verifiedAssignmentArtifact).map(artifactExecutionView),
    };
  }
  return null;
}
function artifactExecutionView(item) {
  return {
    type:item.type,
    title:item.title,
    checksum:item.checksum || null,
    validation:item.validation,
    data:item.data
  };
}
function contentGrowthArtifactVerified(task, artifact, { expectedProjectId = null } = {}) {
  const readable = artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty === true;
  if (!readable) return false;
  if (task?.taskType === 'content.campaign-visual-analysis') {
    const insights = artifact?.data?.insights;
    const receipt = artifact?.data?.providerReceipt;
    return Array.isArray(insights)
      && insights.length > 0
      && insights.every((item) =>
        String(item?.finding || '').trim()
        && String(item?.frameRef || '').trim()
        && String(item?.timestamp || '').trim()
        && String(item?.evidenceKind || '').trim(),
      )
      && validConfirmedM5ProviderReceipt(receipt, 'vision')
      && safeRelativeImageArtifactPath(receipt?.sourcePath)
      && sha256Value(receipt?.sourceChecksum)
      && sha256Value(receipt?.observationChecksum)
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(
        receipt?.costCommit?.costEvent?.projectId || '',
      ))
      && (
        expectedProjectId == null
        || receipt?.costCommit?.costEvent?.projectId === expectedProjectId
      );
  }
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
function optionalConnectionId(value) {
  const id = optionalInput(value);
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError('账号连接标识格式不正确。');
  }
  return id;
}
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
    && !['operations.failure-recovery', 'operations.technical-repair', WECHAT_CHAT_TASK_TYPE].includes(task.taskType);
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
  const ownerPriority = ['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test'];
  const systemPriority = ['pausing', 'running', 'waiting_worker', 'queued'];
  const ownerDecisionStatuses = new Set(['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test']);
  const ownerActionableTasks = tasks.filter((task) =>
    ownerDecisionStatuses.has(task.status) && isOwnerActionable(task, tasks)
  );
  const pendingContinuation = tasks.find((task) =>
    task.status === 'succeeded'
    && intakeRecommendation(task)
    && !tasks.some((child) => child.parentTaskId === task.taskId)
    && !hasLaterUserOutcome(task, tasks)
  );
  const ownerCurrent = ownerPriority.flatMap((status) =>
    tasks.filter((task) => task.status === status && isOwnerActionable(task, tasks))
  )[0];
  const systemCurrent = systemPriority.flatMap((status) =>
    tasks.filter((task) => task.status === status && isOwnerActionable(task, tasks))
  )[0];
  const current = ownerCurrent || pendingContinuation || systemCurrent || null;
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
    ownerActionable: ownerActionableTasks.length + (pendingContinuation ? 1 : 0),
    reviewBacklog: counts.failed + counts.waiting_test,
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
