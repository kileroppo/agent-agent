import { privateReadGrantStatus, revokePrivateReadGrant } from './private-read-grant.ts';
import { ValidationError } from './task-validation-error.ts';
export class TaskApprovalLifecycle {
    governance: any;
    store: any;
    constructor({ store, governance = null }: any = {}) {
        this.store = store;
        this.governance = governance;
    }
    async revokePrivateReadGrant(approvalId: any, { revokedBy = 'A君', chatRef = '' }: any = {}): Promise<any> {
        const approval: any = (await this.store.listApprovals()).find((item: any): any => item.approvalId === approvalId);
        if (!approval || approval.action !== 'wechat-private-chat-read')
            throw new ValidationError('找不到这条微信临时授权。');
        if (!approval.privateReadGrant)
            throw new ValidationError('这条审批尚未生成可撤销的微信临时授权。');
        const task: any = (await this.store.list()).find((item: any): any => item.taskId === approval.taskId);
        if (!task)
            throw new ValidationError('找不到关联任务。');
        validateApprovalChat(task, chatRef);
        if (approval.privateReadGrant.revokedAt)
            return withGrantStatus(approval);
        const updated: any = await this.store.updateApproval(approvalId, {
            privateReadGrant: {
                ...revokePrivateReadGrant(approval.privateReadGrant),
                revokedBy: String(revokedBy || 'A君').slice(0, 120),
            },
        });
        return withGrantStatus(updated);
    }
    async expirePending({ now = Date.now() }: any = {}): Promise<any> {
        const approvals: any = await this.store.listApprovals();
        const expired: any[] = [];
        for (const approval of approvals) {
            if (!isExpiredApproval(approval, now))
                continue;
            const result: any = await this.expire(approval.approvalId, { now });
            if (result.expired)
                expired.push(result);
        }
        return expired;
    }
    async expire(approvalId: any, { now = Date.now() }: any = {}): Promise<any> {
        const approval: any = (await this.store.listApprovals()).find((item: any): any => item.approvalId === approvalId);
        if (!approval || !isExpiredApproval(approval, now))
            return { approval, task: null, expired: false };
        const decidedAt: any = new Date(now).toISOString();
        const expiredApproval: any = await this.store.updateApproval(approvalId, {
            status: 'expired', decisionBy: 'A君', decisionReason: '审批已过期，未执行任务。', decidedAt,
        });
        const task: any = (await this.store.list()).find((item: any): any => item.taskId === approval.taskId);
        if (!task)
            return { approval: expiredApproval, task: null, expired: true };
        if (approval.holdTask === false) {
            const updated: any = await this.store.updateTask(task.taskId, {
                execution: {
                    ...(task.execution || {}),
                    control: { ...(task.execution?.control || {}), action: approval.action, status: 'expired', approvalId, decidedAt },
                },
            });
            return { approval: expiredApproval, task: updated, expired: true };
        }
        if (task.status !== 'waiting_approval')
            return { approval: expiredApproval, task, expired: true };
        let closed: any = await this.store.updateTask(task.taskId, {
            status: 'cancelled',
            currentStage: 'approval_expired',
            error: {
                code: 'approval_expired',
                message: '审批已过期，任务已关闭且未执行。',
                userMessage: '这项确认已过期，任务没有执行，已自动关闭。',
                category: 'manual',
                stage: 'approval',
                occurredAt: decidedAt,
            },
        });
        if (this.governance && closed.governance?.paperclipIssueId) {
            try {
                closed = await this.store.updateTask(closed.taskId, { governance: await this.governance.update(closed) });
            }
            catch {
                // 本机已如实关闭，Paperclip 恢复后会由既有补同步链路继续处理。
            }
        }
        return { approval: expiredApproval, task: closed, expired: true };
    }
}
function withGrantStatus(approval: any): any {
    return { ...approval, privateReadGrantStatus: privateReadGrantStatus(approval.privateReadGrant) };
}
function validateApprovalChat(task: any, chatRef: any): any {
    const expected: any = String(task.source?.chatRef || '').trim();
    const actual: any = String(chatRef || '').trim();
    if (actual && expected && actual !== expected)
        throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function isExpiredApproval(approval: any, now: any = Date.now()): any {
    const validUntil: any = Date.parse(approval?.validUntil || '');
    return approval?.status === 'pending' && Number.isFinite(validUntil) && validUntil <= now;
}
