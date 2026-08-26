import { FeishuCardActionEngine } from './feishu-card-action-engine.ts';
import { FeishuIngressDeduplicator } from './feishu-ingress-deduplicator.ts';

const MAX_REMEMBERED_EVENTS: any = 1000;

export class FeishuChannelBridge {
    commander: any;
    replies: any;
    resolveApproval: any;
    deduplicator: FeishuIngressDeduplicator;
    cardEngine: FeishuCardActionEngine;

    constructor({ commander, resolveApproval, deduplicator, cardEngine }: any = {}) {
        if (!commander?.handle)
            throw new FeishuChannelBridgeError('飞书收发入口缺少总管处理器。');
        if (typeof resolveApproval !== 'function')
            throw new FeishuChannelBridgeError('飞书收发入口缺少审批处理器。');
        this.commander = commander;
        this.resolveApproval = resolveApproval;
        this.replies = new Map();
        this.deduplicator = deduplicator || new FeishuIngressDeduplicator();
        this.cardEngine = cardEngine || new FeishuCardActionEngine();
    }

    async handleMessage(input: any): Promise<any> {
        const event: any = messageEvent(input);
        if (event.chatType === 'group' && !event.mentioned) {
            return { handled: false, reason: '群内未提及机器人，不创建任务。' };
        }

        const existing: any = this.replies.get(event.eventRef);
        if (existing) {
            return { ...existing, deduplicated: true };
        }

        const lease = this.deduplicator.acquireLease(event.eventRef);
        if (!lease.allowed) {
            return { handled: true, deduplicated: true, eventRef: event.eventRef, result: { reply: '消息正在并发处理中。' } };
        }

        try {
            const result: any = await this.commander.handle({
                text: event.text,
                sourceEventRef: event.eventRef,
                requesterRef: event.requesterRef,
                chatRef: event.chatRef,
                targetAgentId: event.targetAgentId || undefined
            });
            const response: Record<string, any> = { handled: true, deduplicated: false, eventRef: event.eventRef, result };
            this.remember(event.eventRef, response);
            if (lease.leaseToken) {
                this.deduplicator.markProcessed(event.eventRef, { token: lease.leaseToken });
            }
            return response;
        } finally {
            if (lease.leaseToken) {
                this.deduplicator.releaseLease(event.eventRef, lease.leaseToken);
            }
        }
    }

    async handleCardAction(input: any): Promise<any> {
        const action: any = cardAction(input);
        const result: any = await this.resolveApproval(action);
        return { handled: true, action, result };
    }

    remember(eventRef: any, response: any): any {
        this.replies.set(eventRef, response);
        if (this.replies.size <= MAX_REMEMBERED_EVENTS)
            return;
        this.replies.delete(this.replies.keys().next().value);
    }
}

export class FeishuChannelBridgeError extends Error {
}

function messageEvent(input: any): any {
    const eventRef: any = required(input?.eventRef, '飞书消息缺少稳定事件编号，未创建任务。');
    const text: any = required(input?.text, '飞书消息正文不能为空。');
    const chatType: any = input?.chatType === 'group' ? 'group' : input?.chatType === 'p2p' ? 'p2p' : null;
    if (!chatType)
        throw new FeishuChannelBridgeError('飞书消息缺少可识别的聊天类型，未创建任务。');
    return {
        eventRef,
        text,
        chatType,
        mentioned: input?.mentioned === true,
        chatRef: optional(input?.chatRef),
        requesterRef: optional(input?.requesterRef),
        targetAgentId: optional(input?.targetAgentId)
    };
}

function cardAction(input: any): any {
    const action: any = required(input?.action, '飞书卡片缺少决定，未执行任何动作。');
    if (!['approve', 'reject'].includes(action))
        throw new FeishuChannelBridgeError('飞书卡片决定不受支持，未执行任何动作。');
    const governanceMode: any = required(input?.governanceMode, '飞书卡片缺少治理方式，未执行任何动作。');
    if (!['local', 'paperclip', 'proposal'].includes(governanceMode))
        throw new FeishuChannelBridgeError('飞书卡片治理方式不受支持，未执行任何动作。');
    return {
        action,
        governanceMode,
        approvalId: required(input?.approvalId, '飞书卡片缺少审批编号，未执行任何动作。'),
        chatRef: optional(input?.chatRef),
        requesterRef: optional(input?.requesterRef) || 'feishu-approver'
    };
}

function required(value: any, message: any): any {
    const text: any = optional(value);
    if (!text)
        throw new FeishuChannelBridgeError(message);
    return text;
}

function optional(value: any): any { return String(value || '').trim(); }
