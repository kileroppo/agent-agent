import { ValidationError } from './task-validation-error.js';
import { XiaodTaskControl } from './xiaod-task-control.js';

export class PaperclipApprovalResolution {
  #service;

  constructor(service) {
    this.#service = service;
  }

  async resolve(approvalId, decision, options = {}) {
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new ValidationError('组织级审批决定无效。');
    return this.#runOnce(approvalId, normalized, () => this.#resolveOnce(approvalId, normalized, options));
  }

  async reconcile() {
    const { store } = this.#service;
    const approvals = (await store.listApprovals()).filter((approval) => approval.status === 'pending'
      && approval.governanceMode === 'paperclip'
      && ['resolving', 'confirmed'].includes(approval.externalDecision?.state)
      && ['approve', 'reject'].includes(approval.externalDecision?.decision));
    const results = [];
    for (const approval of approvals) {
      try {
        const task = await this.#service.resolvePaperclipApproval(approval.approvalId, approval.externalDecision.decision, {
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
  }

  #runOnce(approvalId, decision, operation) {
    const { approvalResolutionRuns } = this.#service;
    const key = String(approvalId || '').trim();
    const intent = `paperclip:${decision}`;
    const running = approvalResolutionRuns.get(key);
    if (running) {
      if (running.intent !== intent) throw conflictError();
      return running.execution;
    }
    const execution = Promise.resolve().then(operation).finally(() => {
      if (approvalResolutionRuns.get(key)?.execution === execution) approvalResolutionRuns.delete(key);
    });
    approvalResolutionRuns.set(key, { intent, execution });
    return execution;
  }

  async #resolveOnce(approvalId, requestedDecision, options) {
    const service = this.#service;
    const { decisionBy = 'A君', decisionReason = '由飞书组织级审批卡确认。', chatRef = '' } = options;
    let approval = await approvalFor(service, approvalId);
    if (approval.governanceMode !== 'paperclip') throw new ValidationError('这不是组织级审批。');
    const task = await taskForApproval(service, approval, chatRef);
    if (approval.requestedScope) validateApprovalScope(task, approval);
    const paperclipApprovalId = String(task.governance?.paperclipApprovalId || '').trim();
    if (approval.status !== 'pending') {
      if (approval.status === 'expired') throw new ValidationError('这条审批已经处理过了。');
      return resumeCommitted(service, task, approval, requestedDecision);
    }
    if (!paperclipApprovalId || !service.governance?.resolveApproval) throw new ValidationError('Paperclip 审批投影不存在，未执行任务。');
    const existing = approval.externalDecision?.decision;
    if (existing && existing !== requestedDecision) throw conflictError();
    approval = await service.store.updateApproval(approvalId, {
      externalDecision:{
        ...(approval.externalDecision || {}),
        decision:requestedDecision,
        state:approval.externalDecision?.state === 'confirmed' ? 'confirmed' : 'resolving',
        paperclipApprovalId,
        requestedAt:approval.externalDecision?.requestedAt || new Date().toISOString(),
        decisionBy,
        decisionReason,
        chatRef,
      },
    });
    const confirmed = await confirmPaperclipDecision(service, approval, requestedDecision, decisionReason, paperclipApprovalId);
    approval = confirmed.approval;
    const decision = confirmed.decision;
    if (['pause-task', 'resume-task'].includes(approval.action)) {
      return new XiaodTaskControl(service).resolve(task, approval, {
        decision,
        approvalPatch:paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval),
      });
    }
    const patch = paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval);
    if (decision === 'reject') return rejectTask(service, approvalId, patch, task);
    return approveTask(service, approvalId, patch, task);
  }
}

async function confirmPaperclipDecision(service, approval, decision, reason, paperclipApprovalId) {
  if (approval.externalDecision?.state === 'confirmed') return { approval, decision:approval.externalDecision.decision || decision };
  let snapshot = null;
  if (typeof service.governance?.getApproval === 'function') try { snapshot = await service.governance.getApproval(paperclipApprovalId); } catch {}
  if (!paperclipDecision(snapshot?.status)) {
    try { snapshot = await service.governance.resolveApproval(paperclipApprovalId, decision, reason); }
    catch (error) {
      if (typeof service.governance?.getApproval !== 'function') throw error;
      try { snapshot = await service.governance.getApproval(paperclipApprovalId); } catch { throw error; }
      if (!paperclipDecision(snapshot?.status)) throw error;
    }
  }
  const confirmed = paperclipDecision(snapshot?.status);
  if (!confirmed) throw new ValidationError(`Paperclip 审批未进入已决状态：${snapshot?.status || 'unknown'}。`);
  const updated = await service.store.updateApproval(approval.approvalId, {
    externalDecision:{
      ...(approval.externalDecision || {}),
      requestedDecision:decision,
      decision:confirmed,
      state:'confirmed',
      confirmedAt:new Date().toISOString(),
      paperclipStatus:snapshot.status,
    },
  });
  return { approval:updated, decision:confirmed };
}

async function rejectTask(service, approvalId, patch, task) {
  const committed = await service.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, {
    status:'cancelled', currentStage:'governance_rejected', error:governanceRejectedError(),
  });
  let closed = committed.task;
  if (closed.governance?.paperclipIssueId) {
    closed = await service.store.updateTask(closed.taskId, { governance:await service.governance.update(closed) });
  }
  return closed;
}

async function approveTask(service, approvalId, patch, task) {
  const agent = (await service.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
  const committed = await service.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, {
    status:'queued', currentStage:'governance_approved', error:undefined,
  });
  return service.executeTask(committed.task, agent);
}

async function resumeCommitted(service, task, approval, decision) {
  const expected = decision === 'approve' ? 'approved' : 'rejected';
  if (approval.status !== expected) throw conflictError();
  if (['pause-task', 'resume-task'].includes(approval.action)) {
    return new XiaodTaskControl(service).resolve(task, approval, { decision, alreadyCommitted:true });
  }
  if (decision === 'reject') {
    return task.status === 'cancelled'
      ? task
      : service.store.updateTask(task.taskId, { status:'cancelled', currentStage:'governance_rejected', error:governanceRejectedError() });
  }
  if (!['waiting_approval', 'queued'].includes(task.status)) return task;
  const agent = (await service.registry.list()).find((item) => item.agentId === task.assigneeAgentId) || null;
  const queued = task.status === 'queued'
    ? task
    : await service.store.updateTask(task.taskId, { status:'queued', currentStage:'governance_approved', error:undefined });
  return service.executeTask(queued, agent);
}

async function approvalFor(service, approvalId) {
  const value = (await service.store.listApprovals()).find((item) => item.approvalId === approvalId);
  if (!value) throw new ValidationError('找不到这条审批。');
  return value;
}

async function taskForApproval(service, approval, chatRef) {
  const task = (await service.store.list()).find((item) => item.taskId === approval.taskId);
  if (!task) throw new ValidationError('找不到关联任务。');
  validateApprovalChat(task, chatRef);
  return task;
}

function validateApprovalScope(task, approval) {
  const scope = approval.requestedScope || {};
  if (scope.taskType !== task.taskType || scope.title !== task.input?.title || scope.assigneeAgentId !== (task.assigneeAgentId || null)) {
    throw new ValidationError('审批范围与当前任务不一致，未执行任务。');
  }
}

function validateApprovalChat(task, chatRef) {
  const expected = String(task.source?.chatRef || '').trim();
  const actual = String(chatRef || '').trim();
  if (actual && expected && actual !== expected) throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}

function decisionPatch(status, by, reason) {
  return { status, decisionBy:String(by).slice(0, 120), decisionReason:String(reason).slice(0, 300), decidedAt:new Date().toISOString() };
}

function paperclipDecision(status) {
  return status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : null;
}

function paperclipDecisionPatch(decision, by, reason, id, approval) {
  const override = approval.externalDecision?.requestedDecision && approval.externalDecision.requestedDecision !== decision;
  return {
    ...decisionPatch(
      decision === 'approve' ? 'approved' : 'rejected',
      override ? 'Paperclip 已决事实' : by,
      override ? `Paperclip 只读回查确认该审批已经${decision === 'approve' ? '批准' : '拒绝'}；旧入口的相反决定未覆盖权威状态。` : reason,
    ),
    paperclipApprovalId:id,
    externalDecision:{
      ...(approval.externalDecision || {}),
      decision,
      state:'confirmed',
      paperclipApprovalId:id,
      confirmedAt:approval.externalDecision?.confirmedAt || new Date().toISOString(),
    },
  };
}

function governanceRejectedError() {
  return { code:'governance_rejected', userMessage:'该组织级请求已被拒绝，未执行任何外部动作。', occurredAt:new Date().toISOString() };
}

function conflictError() {
  const error = new ValidationError('同一条审批正在处理另一个决定；已拒绝并发覆盖。');
  error.code = 'approval_resolution_conflict';
  return error;
}
