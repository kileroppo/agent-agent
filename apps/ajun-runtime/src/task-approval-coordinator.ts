import { ValidationError } from './task-service-execution-support.ts';
import { PaperclipApprovalResolution } from './paperclip-approval-resolution.ts';
import { XiaodDeliveryResume } from './xiaod-delivery-resume.ts';
import { XiaodTaskControl } from './xiaod-task-control.ts';
export const taskApprovalCoordinatorMethods: Record<string, any> = {
    async approveApproval(approvalId: any, options: any = {}): Promise<any> {
        return this.runApprovalResolution(approvalId, 'local:approve', (): any => approveLocal.call(this, approvalId, options));
    },
    async rejectApproval(approvalId: any, options: any = {}): Promise<any> {
        return this.runApprovalResolution(approvalId, 'local:reject', (): any => rejectLocal.call(this, approvalId, options));
    },
    continueXiaodDelivery(taskId: any, options: any = {}): any {
        return new XiaodDeliveryResume(this).request(taskId, options);
    },
    requestTaskControl(taskId: any, action: any): any {
        return new XiaodTaskControl(this).request(taskId, action);
    },
    async resolvePaperclipApproval(approvalId: any, decision: any, options: any = {}): Promise<any> {
        return new PaperclipApprovalResolution(this).resolve(approvalId, decision, options);
    },
    async reconcilePendingPaperclipApprovals(): Promise<any> {
        return new PaperclipApprovalResolution(this).reconcile();
    },
    runApprovalResolution(approvalId: any, intent: any, operation: any): any {
        const key: any = String(approvalId || '').trim();
        const running: any = this.approvalResolutionRuns.get(key);
        if (running) {
            if (running.intent !== intent)
                throw conflictError();
            return running.execution;
        }
        const execution: any = Promise.resolve().then(operation).finally((): any => {
            if (this.approvalResolutionRuns.get(key)?.execution === execution)
                this.approvalResolutionRuns.delete(key);
        });
        this.approvalResolutionRuns.set(key, { intent, execution });
        return execution;
    },
};
async function approveLocal(this: any, approvalId: any, { decisionBy = 'A君', decisionReason = '已确认本次范围。', chatRef = '' }: any = {}): Promise<any> {
    const approval: any = await approvalFor(this, approvalId);
    if (approval.governanceMode === 'paperclip')
        throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接放行。');
    if (approval.status !== 'pending')
        throw new ValidationError('这条审批已经处理过了。');
    const task: any = await taskForApproval(this, approval, chatRef);
    validateApprovalScope(task, approval);
    if (approval.action === 'confirm-transcript-after-complete-listen') {
        const xiaod: any = this.executors.xiaod;
        if (typeof xiaod?.confirmTranscript !== 'function')
            throw new ValidationError('小D确认稿能力当前不可用，未生成确认稿。');
        await xiaod.confirmTranscript(task, { reviewerRef: decisionBy });
        await this.store.updateApproval(approvalId, decisionPatch('approved', decisionBy, decisionReason));
        return this.store.updateTask(task.taskId, {
            status: 'running', currentStage: 'xiaod_review_confirmed', error: undefined,
            execution: { ...(task.execution || {}), polling: { state: 'pending', consecutiveFailures: 0, nextPollAt: new Date().toISOString() } },
        });
    }
    await this.store.updateApproval(approvalId, decisionPatch('approved', decisionBy, decisionReason));
    const agent: any = (await this.registry.list()).find((item: any): any => item.agentId === task.assigneeAgentId) || null;
    return this.executeTask(await this.store.updateTask(task.taskId, { status: 'queued', currentStage: 'approval_approved', error: undefined }), agent);
}
async function rejectLocal(this: any, approvalId: any, { decisionBy = 'A君', decisionReason = '本机主人拒绝当前请求范围。', chatRef = '' }: any = {}): Promise<any> {
    const approval: any = await approvalFor(this, approvalId);
    if (approval.status !== 'pending')
        throw new ValidationError('这条审批已经处理过了。');
    const task: any = await taskForApproval(this, approval, chatRef);
    if (approval.governanceMode === 'paperclip')
        throw new ValidationError('这条组织级审批必须在 Paperclip 完成决定，不能由本机直接拒绝。');
    if (approval.action === 'confirm-transcript-after-complete-listen' && typeof this.executors.xiaod?.rejectTranscript === 'function') {
        await this.executors.xiaod.rejectTranscript(task, { reviewerRef: decisionBy });
    }
    await this.store.updateApproval(approvalId, decisionPatch('rejected', decisionBy, decisionReason));
    let updated: any = await this.store.updateTask(task.taskId, { status: 'cancelled', currentStage: 'approval_rejected', error: { code: 'approval_rejected', userMessage: '这项高风险任务已被拒绝并关闭，未执行任何外部动作。' } });
    if (this.governance && updated.governance?.paperclipIssueId)
        updated = await this.store.updateTask(updated.taskId, { governance: await this.governance.update(updated) });
    return updated;
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
    if (scope.taskType !== task.taskType || scope.title !== task.input?.title || scope.assigneeAgentId !== (task.assigneeAgentId || null))
        throw new ValidationError('审批范围与当前任务不一致，未执行任务。');
}
function validateApprovalChat(task: any, chatRef: any): any {
    const expected: any = String(task.source?.chatRef || '').trim();
    const actual: any = String(chatRef || '').trim();
    if (actual && expected && actual !== expected)
        throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function decisionPatch(status: any, by: any, reason: any): any { return { status, decisionBy: String(by).slice(0, 120), decisionReason: String(reason).slice(0, 300), decidedAt: new Date().toISOString() }; }
function conflictError(): any { const error: any = new ValidationError('同一条审批正在处理另一个决定；已拒绝并发覆盖。'); error.code = 'approval_resolution_conflict'; return error; }
