import { ValidationError } from './task-service-execution-support.js';

const XIAOD_TERMINAL_OR_REVIEW_STATUSES = new Set(['completed', 'failed', 'cancelled', 'awaiting_review', 'awaiting_delivery']);

export const taskApprovalCoordinatorMethods = {
  async approveApproval(approvalId, options = {}) {
    return this.runApprovalResolution(approvalId, 'local:approve', () => approveLocal.call(this, approvalId, options));
  },

  async rejectApproval(approvalId, options = {}) {
    return this.runApprovalResolution(approvalId, 'local:reject', () => rejectLocal.call(this, approvalId, options));
  },

  continueXiaodDelivery(taskId, options = {}) {
    const key = String(taskId || '').trim();
    const running = this.xiaodDeliveryRequestRuns.get(key);
    if (running) return running;
    const request = Promise.resolve().then(() => continueXiaodDeliveryOnce.call(this, taskId, options)).finally(() => {
      if (this.xiaodDeliveryRequestRuns.get(key) === request) this.xiaodDeliveryRequestRuns.delete(key);
    });
    this.xiaodDeliveryRequestRuns.set(key, request);
    return request;
  },

  requestTaskControl(taskId, action) {
    const key = `${String(taskId || '').trim()}:${String(action || '').trim()}`;
    const running = this.taskControlRuns.get(key);
    if (running) return running;
    const execution = Promise.resolve().then(() => requestTaskControlOnce.call(this, taskId, action)).finally(() => {
      if (this.taskControlRuns.get(key) === execution) this.taskControlRuns.delete(key);
    });
    this.taskControlRuns.set(key, execution);
    return execution;
  },

  async resolvePaperclipApproval(approvalId, decision, options = {}) {
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new ValidationError('组织级审批决定无效。');
    return this.runApprovalResolution(approvalId, `paperclip:${normalized}`, () => resolvePaperclipOnce.call(this, approvalId, normalized, options));
  },

  async reconcilePendingPaperclipApprovals() {
    const approvals = (await this.store.listApprovals()).filter((approval) => approval.status === 'pending'
      && approval.governanceMode === 'paperclip'
      && ['resolving', 'confirmed'].includes(approval.externalDecision?.state)
      && ['approve', 'reject'].includes(approval.externalDecision?.decision));
    const results = [];
    for (const approval of approvals) {
      try {
        const task = await this.resolvePaperclipApproval(approval.approvalId, approval.externalDecision.decision, {
          decisionBy:approval.externalDecision.decisionBy || 'A君审批恢复器',
          decisionReason:approval.externalDecision.decisionReason || '恢复已开始的 Paperclip 审批决定。',
          chatRef:approval.externalDecision.chatRef || '',
        });
        results.push({ approvalId:approval.approvalId, status:'reconciled', taskId:task.taskId });
      } catch (error) {
        results.push({ approvalId:approval.approvalId, status:'sync_pending', reason:String(error?.message || 'unknown').slice(0, 300) });
      }
    }
    return results;
  },

  runApprovalResolution(approvalId, intent, operation) {
    const key = String(approvalId || '').trim();
    const running = this.approvalResolutionRuns.get(key);
    if (running) {
      if (running.intent !== intent) throw conflictError();
      return running.execution;
    }
    const execution = Promise.resolve().then(operation).finally(() => {
      if (this.approvalResolutionRuns.get(key)?.execution === execution) this.approvalResolutionRuns.delete(key);
    });
    this.approvalResolutionRuns.set(key, { intent, execution });
    return execution;
  },
};

async function approveLocal(approvalId, { decisionBy = 'A君', decisionReason = '已确认本次范围。', chatRef = '' } = {}) {
  const approval = await approvalFor(this, approvalId);
  if (approval.governanceMode === 'paperclip') throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接放行。');
  if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
  const task = await taskForApproval(this, approval, chatRef);
  validateApprovalScope(task, approval);
  if (approval.action === 'confirm-transcript-after-complete-listen') {
    const xiaod = this.executors.xiaod;
    if (typeof xiaod?.confirmTranscript !== 'function') throw new ValidationError('小D确认稿能力当前不可用，未生成确认稿。');
    await xiaod.confirmTranscript(task, { reviewerRef:decisionBy });
    await this.store.updateApproval(approvalId, decisionPatch('approved', decisionBy, decisionReason));
    return this.store.updateTask(task.taskId, {
      status:'running', currentStage:'xiaod_review_confirmed', error:undefined,
      execution:{ ...(task.execution || {}), polling:{ state:'pending', consecutiveFailures:0, nextPollAt:new Date().toISOString() } },
    });
  }
  await this.store.updateApproval(approvalId, decisionPatch('approved', decisionBy, decisionReason));
  const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
  return this.executeTask(await this.store.updateTask(task.taskId, { status:'queued', currentStage:'approval_approved', error:undefined }), agent);
}

async function rejectLocal(approvalId, { decisionBy = 'A君', decisionReason = '本机主人拒绝当前请求范围。', chatRef = '' } = {}) {
  const approval = await approvalFor(this, approvalId);
  if (approval.status !== 'pending') throw new ValidationError('这条审批已经处理过了。');
  const task = await taskForApproval(this, approval, chatRef);
  if (approval.governanceMode === 'paperclip') throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接拒绝。');
  if (approval.action === 'confirm-transcript-after-complete-listen' && typeof this.executors.xiaod?.rejectTranscript === 'function') {
    await this.executors.xiaod.rejectTranscript(task, { reviewerRef:decisionBy });
  }
  await this.store.updateApproval(approvalId, decisionPatch('rejected', decisionBy, decisionReason));
  let updated = await this.store.updateTask(task.taskId, { status:'cancelled', currentStage:'approval_rejected', error:{ code:'approval_rejected', userMessage:'这项高风险任务已被拒绝并关闭，未执行任何外部动作。' } });
  if (this.governance && updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance:await this.governance.update(updated) });
  return updated;
}

async function continueXiaodDeliveryOnce(taskId, { chatRef = '' } = {}) {
  const task = (await this.store.list()).find((item) => item.taskId === taskId);
  if (!task) throw new ValidationError('找不到要继续交付的任务。');
  validateApprovalChat(task, chatRef);
  if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) throw new ValidationError('这条任务没有可继续交付的小D工作。');
  if (this.xiaodDeliveryRuns.has(task.taskId)) return task;
  if (task.currentStage !== 'xiaod_awaiting_delivery' || task.status !== 'needs_input') throw new ValidationError('这条任务当前不在等待飞书交付阶段。');
  if (task.error?.code === 'xiaod_delivery_uncertain') throw new ValidationError(task.error.userMessage || '飞书交付结果不确定，必须先人工核对。');
  const executor = this.executors.xiaod;
  if (typeof executor?.redeliver !== 'function') throw new ValidationError('小D飞书交付能力当前不可用。');
  const requested = await this.store.updateTask(task.taskId, {
    // needs_input cannot jump directly to running. Re-enter through the queued
    // state so both JSON and SQLite stores enforce the same lifecycle contract.
    status:'queued', currentStage:'xiaod_delivery_retry_requested', error:undefined,
    execution:{ ...(task.execution || {}), polling:{ state:'pending', consecutiveFailures:0, nextPollAt:new Date().toISOString() } },
  });
  const run = Promise.resolve().then(() => executor.redeliver(requested)).then(async (job) => {
    const pending = job.status === 'awaiting_delivery';
    const updated = await this.store.updateTask(task.taskId, {
      status:pending ? 'needs_input' : 'running', currentStage:`xiaod_${job.status || 'delivery_retrying'}`,
      error:pending ? deliveryError(job) : undefined,
      execution:{ ...(requested.execution || {}), xiaodStatus:job.status, xiaodProgress:job.progress, updatedAt:new Date().toISOString(), polling:{ state:pending ? 'settled' : 'pending', consecutiveFailures:0, nextPollAt:pending ? null : new Date().toISOString() } },
    });
    if (!pending && typeof executor.observe === 'function') executor.observe(updated);
    return updated;
  }).catch(async (error) => this.store.updateTask(task.taskId, {
    status:'needs_input', currentStage:'xiaod_awaiting_delivery',
    error:{ code:error?.code === 'lark_delivery_uncertain' ? 'xiaod_delivery_uncertain' : 'xiaod_delivery_retry_failed', userMessage:error?.code === 'lark_delivery_uncertain' ? '飞书交付结果不确定，请先在本机运行台核对并仲裁；确认前不要重试。' : '飞书交付仍未完成；本地确认稿已保留。请修复飞书配置或连接后再次回复“继续飞书交付”。' },
  })).finally(() => this.xiaodDeliveryRuns.get(task.taskId) === run && this.xiaodDeliveryRuns.delete(task.taskId));
  this.xiaodDeliveryRuns.set(task.taskId, run);
  void run.catch(() => undefined);
  return requested;
}

async function requestTaskControlOnce(taskId, action) {
  const task = (await this.store.list()).find((item) => item.taskId === taskId);
  if (!task) throw new ValidationError('找不到要控制的任务。');
  const isPause = action === 'pause-task';
  if (!['pause-task', 'resume-task'].includes(action)) throw new ValidationError('不支持这项任务控制。');
  if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) throw new ValidationError('目前只能控制正在由小D处理的任务。');
  if (isPause ? !['queued', 'running', 'pausing'].includes(task.status) : task.status !== 'paused') throw new ValidationError(isPause ? '这条任务当前不能暂停。' : '只有已经暂停的任务可以继续。');
  const existing = (await this.store.listApprovals()).find((item) => item.taskId === task.taskId && item.action === action && item.status === 'pending');
  if (existing) return { task, approval:existing, duplicate:true };
  const approval = await this.store.createApproval({
    taskId:task.taskId, holdTask:false, governanceMode:'paperclip', decisionChannel:'feishu_card', action, riskLevel:'high',
    reason:isPause ? '暂停会改变一项正在执行的工作。' : '继续会恢复一项已暂停的工作。', requestedBy:'A君', approverScope:'A君',
    requestedScope:{ taskType:task.taskType, title:task.input?.title || '', assigneeAgentId:task.assigneeAgentId || null }, validUntil:new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (!this.governance?.project) throw new ValidationError('Paperclip 暂不可用，不能绕过组织级确认。');
  const projection = await this.governance.project(task, approval);
  const updated = await this.store.updateTask(task.taskId, { governance:projection, execution:{ ...(task.execution || {}), control:{ action, status:'waiting_approval', approvalId:approval.approvalId, requestedAt:new Date().toISOString() } } });
  return { task:updated, approval, duplicate:false };
}

async function resolvePaperclipOnce(approvalId, requestedDecision, options = {}) {
  const { decisionBy = 'A君', decisionReason = '由飞书组织级审批卡确认。', chatRef = '' } = options;
  let approval = await approvalFor(this, approvalId);
  if (approval.governanceMode !== 'paperclip') throw new ValidationError('这不是组织级审批。');
  const task = await taskForApproval(this, approval, chatRef);
  if (approval.requestedScope) validateApprovalScope(task, approval);
  const paperclipApprovalId = String(task.governance?.paperclipApprovalId || '').trim();
  if (approval.status !== 'pending') {
    if (approval.status === 'expired') throw new ValidationError('这条审批已经处理过了。');
    return resumeCommitted.call(this, task, approval, requestedDecision, options);
  }
  if (!paperclipApprovalId || !this.governance?.resolveApproval) throw new ValidationError('Paperclip 审批投影不存在，未执行任务。');
  const existing = approval.externalDecision?.decision;
  if (existing && existing !== requestedDecision) throw conflictError();
  approval = await this.store.updateApproval(approvalId, { externalDecision:{ ...(approval.externalDecision || {}), decision:requestedDecision, state:approval.externalDecision?.state === 'confirmed' ? 'confirmed' : 'resolving', paperclipApprovalId, requestedAt:approval.externalDecision?.requestedAt || new Date().toISOString(), decisionBy, decisionReason, chatRef } });
  const confirmed = await confirmPaperclipDecision.call(this, approval, requestedDecision, decisionReason, paperclipApprovalId);
  approval = confirmed.approval;
  const decision = confirmed.decision;
  if (['pause-task', 'resume-task'].includes(approval.action)) return resolveTaskControl.call(this, task, approval, decision, decisionBy, decisionReason, paperclipApprovalId);
  const patch = paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval);
  if (decision === 'reject') {
    const committed = await this.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, { status:'cancelled', currentStage:'governance_rejected', error:governanceRejectedError() });
    let closed = committed.task;
    if (closed.governance?.paperclipIssueId) closed = await this.store.updateTask(closed.taskId, { governance:await this.governance.update(closed) });
    return closed;
  }
  const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
  const committed = await this.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, { status:'queued', currentStage:'governance_approved', error:undefined });
  return this.executeTask(committed.task, agent);
}

async function confirmPaperclipDecision(approval, decision, reason, paperclipApprovalId) {
  if (approval.externalDecision?.state === 'confirmed') return { approval, decision:approval.externalDecision.decision || decision };
  let snapshot = null;
  if (typeof this.governance?.getApproval === 'function') try { snapshot = await this.governance.getApproval(paperclipApprovalId); } catch {}
  if (!paperclipDecision(snapshot?.status)) {
    try { snapshot = await this.governance.resolveApproval(paperclipApprovalId, decision, reason); }
    catch (error) {
      if (typeof this.governance?.getApproval !== 'function') throw error;
      try { snapshot = await this.governance.getApproval(paperclipApprovalId); } catch { throw error; }
      if (!paperclipDecision(snapshot?.status)) throw error;
    }
  }
  const confirmed = paperclipDecision(snapshot?.status);
  if (!confirmed) throw new ValidationError(`Paperclip 审批未进入已决状态：${snapshot?.status || 'unknown'}。`);
  const updated = await this.store.updateApproval(approval.approvalId, { externalDecision:{ ...(approval.externalDecision || {}), requestedDecision:decision, decision:confirmed, state:'confirmed', confirmedAt:new Date().toISOString(), paperclipStatus:snapshot.status } });
  return { approval:updated, decision:confirmed };
}

async function resumeCommitted(task, approval, decision, options) {
  const expected = decision === 'approve' ? 'approved' : 'rejected';
  if (approval.status !== expected) throw conflictError();
  if (['pause-task', 'resume-task'].includes(approval.action)) return resolveTaskControl.call(this, task, approval, decision, options.decisionBy, options.decisionReason, task.governance?.paperclipApprovalId, { alreadyCommitted:true });
  if (decision === 'reject') return task.status === 'cancelled' ? task : this.store.updateTask(task.taskId, { status:'cancelled', currentStage:'governance_rejected', error:governanceRejectedError() });
  if (!['waiting_approval', 'queued'].includes(task.status)) return task;
  const agent = (await this.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
  const queued = task.status === 'queued' ? task : await this.store.updateTask(task.taskId, { status:'queued', currentStage:'governance_approved', error:undefined });
  return this.executeTask(queued, agent);
}

async function resolveTaskControl(task, approval, decision, decisionBy, decisionReason, paperclipApprovalId, { alreadyCommitted = false } = {}) {
  const patch = paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval);
  if (decision !== 'approve') {
    const taskPatch = (current) => ({ execution:{ ...(current.execution || {}), control:{ ...(current.execution?.control || {}), action:approval.action, status:'rejected', approvalId:approval.approvalId, decidedAt:new Date().toISOString() } } });
    return alreadyCommitted ? this.store.updateTask(task.taskId, taskPatch(task)) : (await this.store.resolveApprovalAndUpdateTask(approval.approvalId, patch, task.taskId, taskPatch)).task;
  }
  const executor = this.executors.xiaod;
  const method = approval.action === 'pause-task' ? 'pause' : 'resume';
  if (typeof executor?.[method] !== 'function') throw new ValidationError('小D当前不支持这项控制，未改变任务状态。');
  if (!alreadyCommitted) approval = await this.store.updateApproval(approval.approvalId, { localEffect:{ ...(approval.localEffect || {}), action:approval.action, state:'resolving', requestedAt:approval.localEffect?.requestedAt || new Date().toISOString() } });
  const { job, outcome } = await ensureControlEffect.call(this, task, approval, executor, method);
  const decidedAt = new Date().toISOString();
  const status = approval.action === 'pause-task' ? (job.status === 'paused' ? 'paused' : 'pausing') : 'running';
  const taskPatch = (current) => ({ status, currentStage:approval.action === 'pause-task' ? `xiaod_${job.status || 'pausing'}` : 'xiaod_resumed', error:undefined, execution:{ ...(current.execution || {}), xiaodStatus:job.status, xiaodProgress:job.progress, control:{ action:approval.action, status:outcome === 'obsolete' ? 'superseded' : 'accepted', approvalId:approval.approvalId, decidedAt }, polling:{ state:status === 'paused' ? 'settled' : 'pending', consecutiveFailures:0, nextPollAt:status === 'paused' ? null : decidedAt } } });
  let updated;
  if (alreadyCommitted) updated = await this.store.updateTask(task.taskId, taskPatch(task));
  else updated = (await this.store.resolveApprovalAndUpdateTask(approval.approvalId, { ...patch, localEffect:{ ...(approval.localEffect || {}), state:'confirmed', confirmedAt:decidedAt, xiaodStatus:job.status, outcome } }, task.taskId, taskPatch)).task;
  if (updated.governance?.paperclipIssueId) updated = await this.store.updateTask(updated.taskId, { governance:await this.governance.update(updated) });
  if (approval.action === 'resume-task' && outcome !== 'obsolete' && typeof executor.observe === 'function') executor.observe(updated);
  return updated;
}

async function ensureControlEffect(task, approval, executor, method) {
  if (typeof executor.getJob === 'function') {
    const observed = await executor.getJob(task.execution?.xiaodJobId);
    const recovered = xiaodControlOutcome(approval.action, observed);
    if (recovered) return { job:observed, outcome:recovered };
  }
  try {
    const job = await executor[method](task);
    const outcome = xiaodControlOutcome(approval.action, job);
    if (!outcome) throw new ValidationError('小D未确认任务控制结果。');
    return { job, outcome };
  } catch (error) {
    if (typeof executor.getJob !== 'function') throw error;
    const recovered = await executor.getJob(task.execution?.xiaodJobId);
    const outcome = xiaodControlOutcome(approval.action, recovered);
    if (!outcome) throw error;
    return { job:recovered, outcome };
  }
}

async function approvalFor(service, approvalId) { const value = (await service.store.listApprovals()).find((item) => item.approvalId === approvalId); if (!value) throw new ValidationError('找不到这条审批。'); return value; }
async function taskForApproval(service, approval, chatRef) { const task = (await service.store.list()).find((item) => item.taskId === approval.taskId); if (!task) throw new ValidationError('找不到关联任务。'); validateApprovalChat(task, chatRef); return task; }
function validateApprovalScope(task, approval) { const scope = approval.requestedScope || {}; if (scope.taskType !== task.taskType || scope.title !== task.input?.title || scope.assigneeAgentId !== (task.assigneeAgentId || null)) throw new ValidationError('审批范围与当前任务不一致，未执行任务。'); }
function validateApprovalChat(task, chatRef) { const expected = String(task.source?.chatRef || '').trim(); const actual = String(chatRef || '').trim(); if (actual && expected && actual !== expected) throw new ValidationError('审批卡会话与原任务不一致，未执行任务。'); }
function decisionPatch(status, by, reason) { return { status, decisionBy:String(by).slice(0, 120), decisionReason:String(reason).slice(0, 300), decidedAt:new Date().toISOString() }; }
function paperclipDecision(status) { return status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : null; }
function paperclipDecisionPatch(decision, by, reason, id, approval) { const override = approval.externalDecision?.requestedDecision && approval.externalDecision.requestedDecision !== decision; return { ...decisionPatch(decision === 'approve' ? 'approved' : 'rejected', override ? 'Paperclip 已决事实' : by, override ? `Paperclip 只读回查确认该审批已经${decision === 'approve' ? '批准' : '拒绝'}；旧入口的相反决定未覆盖权威状态。` : reason), paperclipApprovalId:id, externalDecision:{ ...(approval.externalDecision || {}), decision, state:'confirmed', paperclipApprovalId:id, confirmedAt:approval.externalDecision?.confirmedAt || new Date().toISOString() } }; }
function governanceRejectedError() { return { code:'governance_rejected', userMessage:'该组织级请求已被拒绝，未执行任何外部动作。', occurredAt:new Date().toISOString() }; }
function xiaodControlOutcome(action, job) { const status = String(job?.status || ''); if (!status) return null; if (XIAOD_TERMINAL_OR_REVIEW_STATUSES.has(status)) return 'obsolete'; return action === 'pause-task' ? (['pausing', 'paused'].includes(status) ? 'applied' : null) : (status === 'paused' ? null : 'applied'); }
function deliveryError(job) { return { code:'xiaod_delivery_pending', userMessage:job?.output?.larkDelivery?.state === 'uncertain' ? '飞书交付结果不确定，请先在本机运行台核对并仲裁；确认前不要重试。' : '本地确认稿已保留，但飞书交付尚未完成。' }; }
function conflictError() { const error = new ValidationError('同一条审批正在处理另一个决定；已拒绝并发覆盖。'); error.code = 'approval_resolution_conflict'; return error; }
