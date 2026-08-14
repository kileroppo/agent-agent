/**
 * The only place that knows Feishu's official Channel SDK.
 *
 * A君's task, approval, and audit records remain in the existing runtime.
 * This runner only receives a normalised Feishu event, passes it to that
 * truth, then sends the already-decided reply or approval card back.
 */
export class OfficialFeishuChannelRunner {
    bridge: any;
    channel: any;
    channelOptions: any;
    completionWatchStore: any;
    completionWatcher: any;
    completionWatcherFactory: any;
    createChannel: any;
    environment: any;
    logger: any;
    state: any;
    targetAgentId: any;
    taskStatus: any;
    constructor({ bridge, createChannel, taskStatus = null, completionWatchStore = null, environment = process.env, logger = console, completionWatcherFactory = null, channelOptions = null, targetAgentId = null }: any = {}) {
        if (!bridge?.handleMessage || !bridge?.handleCardAction)
            throw new OfficialFeishuChannelRunnerError('官方飞书入口缺少 A君收发桥。');
        if (typeof createChannel !== 'function')
            throw new OfficialFeishuChannelRunnerError('官方飞书入口缺少飞书通道创建方法。');
        this.bridge = bridge;
        this.createChannel = createChannel;
        this.environment = environment;
        this.logger = logger;
        this.taskStatus = taskStatus;
        this.completionWatchStore = completionWatchStore;
        this.completionWatcherFactory = completionWatcherFactory;
        this.channelOptions = channelOptions;
        this.targetAgentId = safeAgentId(targetAgentId);
        this.channel = null;
        this.completionWatcher = null;
        this.state = channelState('disabled', '官方飞书入口尚未启用；现有 A君入口保持不变。');
    }
    enabled(): any {
        // Employee apps carry explicit, local-only credentials. They must not
        // inherit the legacy A君 environment switch, otherwise every independent
        // bot stays disabled even though its own app is fully provisioned.
        if (this.channelOptions)
            return true;
        return String(this.environment.AJUN_FEISHU_CHANNEL_ENABLED || '').trim().toLowerCase() === 'true';
    }
    async start(): Promise<any> {
        if (!this.enabled())
            return this.setState('disabled', '官方飞书入口尚未启用；现有 A君入口保持不变。');
        this.setState('connecting', '官方飞书入口正在连接；现有 A君入口仍可用。');
        try {
            const options: any = this.channelOptions || officialChannelOptions(this.environment);
            const channel: any = await this.createChannel(options);
            if (!channel?.on || !channel?.connect || !channel?.reply)
                throw new OfficialFeishuChannelRunnerError('官方飞书通道返回的能力不完整，未启用。');
            channel.on({
                message: async (message: any): Promise<any> => this.replyToMessage(channel, message),
                cardAction: async (event: any): Promise<any> => this.handleCardAction(event),
                error: (error: any): any => this.logger.warn?.(`官方飞书入口出现错误：${safeError(error)}`)
            });
            await channel.connect();
            this.channel = channel;
            this.completionWatcher = this.createCompletionWatcher(channel);
            await this.completionWatcher?.start();
            this.logger.info?.('官方飞书收发入口已连接。');
            return this.setState('connected', '官方飞书入口已连接；消息、审批卡会回到原聊天。');
        }
        catch (error: any) {
            this.setState('failed', `官方飞书入口没有连上：${safeError(error)}。现有 A君入口不受影响。`);
            throw error;
        }
    }
    async stop(): Promise<any> {
        if (!this.channel?.disconnect)
            return;
        await this.channel.disconnect();
        this.channel = null;
        this.completionWatcher?.stop();
        this.completionWatcher = null;
        this.setState('disabled', '官方飞书入口已关闭；现有 A君入口保持不变。');
    }
    snapshot(): any {
        const delivery: any = this.completionWatcher?.snapshot?.();
        return delivery?.status === 'delivery_uncertain'
            ? { status: 'delivery_uncertain', message: delivery.message, uncertainDeliveries: delivery.uncertainDeliveries }
            : { ...this.state };
    }
    setState(status: any, message: any): any {
        this.state = channelState(status, message);
        return this.snapshot();
    }
    async replyToMessage(channel: any, message: any): Promise<any> {
        try {
            const response: any = await this.bridge.handleMessage({
                eventRef: `feishu:${message.messageId}`,
                text: message.content,
                chatType: message.chatType,
                mentioned: message.mentionedBot === true,
                chatRef: message.chatId,
                requesterRef: message.senderId,
                targetAgentId: this.targetAgentId || undefined
            });
            if (!response.handled || response.deduplicated)
                return;
            const result: any = response.result || {};
            if (result.reply)
                await channel.reply(message, { markdown: result.reply });
            if (result.approval)
                await channel.reply(message, { card: approvalCard(result.approval) });
            if (result.completionWatch)
                await this.completionWatcher?.watch({ taskId: result.completionWatch.taskId, chatId: message.chatId });
        }
        catch (error: any) {
            this.logger.warn?.(`官方飞书消息未能处理：${safeError(error)}`);
            await channel.reply(message, { markdown: '这条请求暂时没有处理成功；我已保留问题，不会假装已经完成。' });
        }
    }
    async handleCardAction(event: any): Promise<any> {
        const value: any = event?.action?.value || {};
        try {
            const response: any = await this.bridge.handleCardAction({
                approvalId: value.approvalId,
                action: value.action,
                governanceMode: value.governanceMode,
                chatRef: event.chatId,
                requesterRef: event.operator?.openId
            });
            const toast: any = approvalToast(response.action.action, response.result, value.taskControlAction);
            return {
                toast: { type: 'success', content: toast },
                // A toast alone leaves the original buttons live and visually selected.
                // Replace the source card synchronously so a decision is final in both
                // the task truth and the chat UI.
                card: { type: 'raw', data: approvalResultCard(value, toast) }
            };
        }
        catch (error: any) {
            this.logger.warn?.(`官方飞书审批未能处理：${safeError(error)}`);
            return { toast: { type: 'error', content: '这次确认没有生效；原任务保持不变。' } };
        }
    }
    createCompletionWatcher(channel: any): any {
        if (!this.taskStatus || !this.completionWatchStore || typeof channel.send !== 'function')
            return null;
        const input: Record<string, any> = { taskStatus: this.taskStatus, send: (chatId: any, content: any): any => channel.send(chatId, content), store: this.completionWatchStore, logger: this.logger };
        return this.completionWatcherFactory ? this.completionWatcherFactory(input) : null;
    }
}
export class OfficialFeishuChannelRunnerError extends Error {
}
export function officialChannelOptions(environment: any = process.env): any {
    const appId: any = requiredEnv(environment, 'AJUN_FEISHU_CHANNEL_APP_ID', '官方飞书入口缺少应用编号，未启用。');
    const appSecret: any = requiredEnv(environment, 'AJUN_FEISHU_CHANNEL_APP_SECRET', '官方飞书入口缺少应用密钥，未启用。');
    const dmAllowlist: any = listEnv(environment.AJUN_FEISHU_CHANNEL_ALLOWED_USER_IDS);
    if (!dmAllowlist.length)
        throw new OfficialFeishuChannelRunnerError('官方飞书入口必须先指定允许私聊的人员，未启用。');
    return {
        appId,
        appSecret,
        transport: 'websocket',
        source: 'agent-army-ajun',
        policy: {
            requireMention: true,
            dmMode: 'allowlist',
            dmAllowlist,
            groupAllowlist: listEnv(environment.AJUN_FEISHU_CHANNEL_ALLOWED_GROUP_IDS),
            respondToMentionAll: false,
            botLoopGuard: true
        },
        safety: {
            dedup: { ttl: 10 * 60 * 1000, maxEntries: 2000 },
            chatQueue: { enabled: true, mergeWhileBusy: false },
            staleMessageWindowMs: 5 * 60 * 1000
        }
    };
}
export function approvalCard(approval: any): any {
    const title: any = approval.governanceMode === 'proposal' ? 'A君 · 新员工审核' : 'A君 · 请你确认';
    const scope: any = approval.requestedScope?.title || approval.reason || '本次工作范围';
    const labels: any = approvalLabels(approval.action);
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title }, template: 'orange' },
        elements: [
            { tag: 'markdown', content: `**事项**：${safeCardText(scope)}\n\n${safeCardText(approval.reason || '请确认本次范围。')}` },
            { tag: 'action', actions: [
                    { tag: 'button', text: { tag: 'plain_text', content: labels.approve }, type: 'primary', value: approvalValue(approval, 'approve') },
                    { tag: 'button', text: { tag: 'plain_text', content: labels.reject }, type: 'danger', value: approvalValue(approval, 'reject') }
                ] }
        ]
    };
}
function approvalValue(approval: any, action: any): any { return { approvalId: approval.approvalId, governanceMode: approval.governanceMode, action, taskControlAction: approval.action || null }; }
function approvalLabels(action: any): any {
    if (action === 'pause-task')
        return { approve: '同意暂停', reject: '保持继续处理' };
    if (action === 'resume-task')
        return { approve: '同意继续', reject: '保持暂停' };
    return { approve: '批准本次范围', reject: '拒绝并关闭' };
}
function approvalResultCard(value: any, message: any): any {
    const approved: any = value.action === 'approve';
    const action: any = value.taskControlAction === 'pause-task' ? (approved ? '已同意暂停' : '已保持继续处理')
        : value.taskControlAction === 'resume-task' ? (approved ? '已同意继续' : '已保持暂停')
            : approved ? '已批准' : '已拒绝并关闭';
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'A君 · 审批已处理' }, template: approved ? 'green' : 'grey' },
        elements: [{ tag: 'markdown', content: `**${action}**\n\n${safeCardText(message)}` }]
    };
}
function listEnv(value: any): any { return [...new Set(String(value || '').split(',').map((item: any): any => item.trim()).filter(Boolean))]; }
function requiredEnv(environment: any, key: any, message: any): any {
    const value: any = String(environment?.[key] || '').trim();
    if (!value)
        throw new OfficialFeishuChannelRunnerError(message);
    return value;
}
function safeCardText(value: any): any { return String(value || '').replace(/[<>]/g, '').slice(0, 1500); }
function safeError(error: any): any { return String(error?.message || '未知问题').replace(/[\r\n]/g, ' ').slice(0, 180); }
function approvalToast(action: any, result: any, taskControlAction: any): any {
    if (taskControlAction === 'pause-task')
        return action === 'approve' ? '已同意暂停；小D会在安全位置停下。' : '已保持继续处理。';
    if (taskControlAction === 'resume-task')
        return action === 'approve' ? '已同意继续；小D会从安全位置恢复。' : '已保持暂停。';
    if (action === 'reject')
        return '已拒绝，草案或任务已关闭。';
    return result?.task ? '已批准，任务会按确认范围继续。' : '已批准，后续会按确认范围继续。';
}
function channelState(status: any, message: any): any { return { status, message, updatedAt: new Date().toISOString() }; }
function safeAgentId(value: any): any { const id: any = String(value || '').trim(); return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : null; }
