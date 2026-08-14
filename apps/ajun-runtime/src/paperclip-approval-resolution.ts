import { ValidationError } from './task-validation-error.ts';
import { XiaodTaskControl } from './xiaod-task-control.ts';
export class PaperclipApprovalResolution {
    #service;
    constructor(service: any) {
        this.#service = service;
    }
    async resolve(approvalId: any, decision: any, options: any = {}): Promise<any> {
        const normalized: any = String(decision || '').trim().toLowerCase();
        if (!['approve', 'reject'].includes(normalized))
            throw new ValidationError('组织级审批决定无效。');
        return this.#runOnce(approvalId, normalized, (): any => this.#resolveOnce(approvalId, normalized, options));
    }
    async reconcile(): Promise<any> {
        const { store } = this.#service;
        const approvals: any = (await store.listApprovals()).filter((approval: any): any => approval.status === 'pending'
            && approval.governanceMode === 'paperclip'
            && ['resolving', 'confirmed'].includes(approval.externalDecision?.state)
            && ['approve', 'reject'].includes(approval.externalDecision?.decision));
        const results: any[] = [];
        for (const approval of approvals) {
            try {
                const task: any = await this.#service.resolvePaperclipApproval(approval.approvalId, approval.externalDecision.decision, {
                    decisionBy: approval.externalDecision.decisionBy || 'A君审批恢复器',
                    decisionReason: approval.externalDecision.decisionReason || '恢复已开始的 Paperclip 审批决定。',
                    chatRef: approval.externalDecision.chatRef || '',
                });
                results.push({ approvalId: approval.approvalId, status: 'reconciled', taskId: task.taskId });
            }
            catch (error: any) {
                results.push({ approvalId: approval.approvalId, status: 'sync_pending', reason: String(error?.message || 'unknown').slice(0, 300) });
            }
        }
        return results;
    }
    #runOnce(approvalId: any, decision: any, operation: any): any {
        const { approvalResolutionRuns } = this.#service;
        const key: any = String(approvalId || '').trim();
        const intent: any = `paperclip:${decision}`;
        const running: any = approvalResolutionRuns.get(key);
        if (running) {
            if (running.intent !== intent)
                throw conflictError();
            return running.execution;
        }
        const execution: any = Promise.resolve().then(operation).finally((): any => {
            if (approvalResolutionRuns.get(key)?.execution === execution)
                approvalResolutionRuns.delete(key);
        });
        approvalResolutionRuns.set(key, { intent, execution });
        return execution;
    }
    async #resolveOnce(approvalId: any, requestedDecision: any, options: any): Promise<any> {
        const service: any = this.#service;
        const { decisionBy = 'A君', decisionReason = '由飞书组织级审批卡确认。', chatRef = '' } = options;
        let approval: any = await approvalFor(service, approvalId);
        if (approval.governanceMode !== 'paperclip')
            throw new ValidationError('这不是组织级审批。');
        const task: any = await taskForApproval(service, approval, chatRef);
        if (approval.requestedScope)
            validateApprovalScope(task, approval);
        const paperclipApprovalId: any = String(task.governance?.paperclipApprovalId || '').trim();
        if (approval.status !== 'pending') {
            if (approval.status === 'expired')
                throw new ValidationError('这条审批已经处理过了。');
            return resumeCommitted(service, task, approval, requestedDecision);
        }
        if (!paperclipApprovalId || !service.governance?.resolveApproval)
            throw new ValidationError('Paperclip 审批投影不存在，未执行任务。');
        const existing: any = approval.externalDecision?.decision;
        if (existing && existing !== requestedDecision)
            throw conflictError();
        approval = await service.store.updateApproval(approvalId, {
            externalDecision: {
                ...(approval.externalDecision || {}),
                decision: requestedDecision,
                state: approval.externalDecision?.state === 'confirmed' ? 'confirmed' : 'resolving',
                paperclipApprovalId,
                requestedAt: approval.externalDecision?.requestedAt || new Date().toISOString(),
                decisionBy,
                decisionReason,
                chatRef,
            },
        });
        const confirmed: any = await confirmPaperclipDecision(service, approval, requestedDecision, decisionReason, paperclipApprovalId);
        approval = confirmed.approval;
        const decision: any = confirmed.decision;
        if (['pause-task', 'resume-task'].includes(approval.action)) {
            return new XiaodTaskControl(service).resolve(task, approval, {
                decision,
                approvalPatch: paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval),
            });
        }
        const patch: any = paperclipDecisionPatch(decision, decisionBy, decisionReason, paperclipApprovalId, approval);
        if (decision === 'reject')
            return rejectTask(service, approvalId, patch, task);
        return approveTask(service, approvalId, patch, task);
    }
}
async function confirmPaperclipDecision(service: any, approval: any, decision: any, reason: any, paperclipApprovalId: any): Promise<any> {
    if (approval.externalDecision?.state === 'confirmed')
        return { approval, decision: approval.externalDecision.decision || decision };
    let snapshot: any = null;
    if (typeof service.governance?.getApproval === 'function')
        try {
            snapshot = await service.governance.getApproval(paperclipApprovalId);
        }
        catch { }
    if (!paperclipDecision(snapshot?.status)) {
        try {
            snapshot = await service.governance.resolveApproval(paperclipApprovalId, decision, reason);
        }
        catch (error: any) {
            if (typeof service.governance?.getApproval !== 'function')
                throw error;
            try {
                snapshot = await service.governance.getApproval(paperclipApprovalId);
            }
            catch {
                throw error;
            }
            if (!paperclipDecision(snapshot?.status))
                throw error;
        }
    }
    const confirmed: any = paperclipDecision(snapshot?.status);
    if (!confirmed)
        throw new ValidationError(`Paperclip 审批未进入已决状态：${snapshot?.status || 'unknown'}。`);
    const updated: any = await service.store.updateApproval(approval.approvalId, {
        externalDecision: {
            ...(approval.externalDecision || {}),
            requestedDecision: decision,
            decision: confirmed,
            state: 'confirmed',
            confirmedAt: new Date().toISOString(),
            paperclipStatus: snapshot.status,
        },
    });
    return { approval: updated, decision: confirmed };
}
async function rejectTask(service: any, approvalId: any, patch: any, task: any): Promise<any> {
    const committed: any = await service.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, {
        status: 'cancelled', currentStage: 'governance_rejected', error: governanceRejectedError(),
    });
    let closed: any = committed.task;
    if (closed.governance?.paperclipIssueId) {
        closed = await service.store.updateTask(closed.taskId, { governance: await service.governance.update(closed) });
    }
    return closed;
}
async function approveTask(service: any, approvalId: any, patch: any, task: any): Promise<any> {
    const agent: any = (await service.registry.list()).find((item: any): any => item.agentId === task.assigneeAgentId) || null;
    const committed: any = await service.store.resolveApprovalAndUpdateTask(approvalId, patch, task.taskId, {
        status: 'queued', currentStage: 'governance_approved', error: undefined,
    });
    return service.executeTask(committed.task, agent);
}
async function resumeCommitted(service: any, task: any, approval: any, decision: any): Promise<any> {
    const expected: any = decision === 'approve' ? 'approved' : 'rejected';
    if (approval.status !== expected)
        throw conflictError();
    if (['pause-task', 'resume-task'].includes(approval.action)) {
        return new XiaodTaskControl(service).resolve(task, approval, { decision, alreadyCommitted: true });
    }
    if (decision === 'reject') {
        return task.status === 'cancelled'
            ? task
            : service.store.updateTask(task.taskId, { status: 'cancelled', currentStage: 'governance_rejected', error: governanceRejectedError() });
    }
    if (!['waiting_approval', 'queued'].includes(task.status))
        return task;
    const agent: any = (await service.registry.list()).find((item: any): any => item.agentId === task.assigneeAgentId) || null;
    const queued: any = task.status === 'queued'
        ? task
        : await service.store.updateTask(task.taskId, { status: 'queued', currentStage: 'governance_approved', error: undefined });
    return service.executeTask(queued, agent);
}
async function approvalFor(service: any, approvalId: any): Promise<any> {
    const value: any = (await service.store.listApprovals()).find((item: any): any => item.approvalId === approvalId);
    if (!value)
        throw new ValidationError('找不到这条审批。');
    return value;
}
async function taskForApproval(service: any, approval: any, chatRef: any): Promise<any> {
    const task: any = (await service.store.list()).find((item: any): any => item.taskId === approval.taskId);
    if (!task)
        throw new ValidationError('找不到关联任务。');
    validateApprovalChat(task, chatRef);
    return task;
}
function validateApprovalScope(task: any, approval: any): any {
    const scope: any = approval.requestedScope || {};
    if (scope.taskType !== task.taskType || scope.title !== task.input?.title || scope.assigneeAgentId !== (task.assigneeAgentId || null)) {
        throw new ValidationError('审批范围与当前任务不一致，未执行任务。');
    }
}
function validateApprovalChat(task: any, chatRef: any): any {
    const expected: any = String(task.source?.chatRef || '').trim();
    const actual: any = String(chatRef || '').trim();
    if (actual && expected && actual !== expected)
        throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function decisionPatch(status: any, by: any, reason: any): any {
    return { status, decisionBy: String(by).slice(0, 120), decisionReason: String(reason).slice(0, 300), decidedAt: new Date().toISOString() };
}
function paperclipDecision(status: any): any {
    return status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : null;
}
function paperclipDecisionPatch(decision: any, by: any, reason: any, id: any, approval: any): any {
    const override: any = approval.externalDecision?.requestedDecision && approval.externalDecision.requestedDecision !== decision;
    return {
        ...decisionPatch(decision === 'approve' ? 'approved' : 'rejected', override ? 'Paperclip 已决事实' : by, override ? `Paperclip 只读回查确认该审批已经${decision === 'approve' ? '批准' : '拒绝'}；旧入口的相反决定未覆盖权威状态。` : reason),
        paperclipApprovalId: id,
        externalDecision: {
            ...(approval.externalDecision || {}),
            decision,
            state: 'confirmed',
            paperclipApprovalId: id,
            confirmedAt: approval.externalDecision?.confirmedAt || new Date().toISOString(),
        },
    };
}
function governanceRejectedError(): any {
    return { code: 'governance_rejected', userMessage: '该组织级请求已被拒绝，未执行任何外部动作。', occurredAt: new Date().toISOString() };
}
function conflictError(): any {
    const error: any = new ValidationError('同一条审批正在处理另一个决定；已拒绝并发覆盖。');
    error.code = 'approval_resolution_conflict';
    return error;
}
