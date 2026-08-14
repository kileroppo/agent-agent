export const WECHAT_CHAT_AGENT_ID: any = 'wechat-chat-retriever';
export const WECHAT_CHAT_TASK_TYPE: any = 'wechat.chat.retrieval';
export const WECHAT_CHAT_CAPABILITY: any = 'wechat.local-vault.chat.read';
export const WECHAT_CHAT_MAX_MESSAGES: any = 200;
export function normalizeWechatChatRequest(input: any = {}, { now = new Date() }: any = {}): any {
    const current: any = validDate(now) || new Date();
    const nested: any = input?.wechatChat && typeof input.wechatChat === 'object' ? input.wechatChat : {};
    const combined: any = `${input?.title || ''}\n${input?.description || ''}`;
    const chatSelector: any = clean(nested.chatSelector
        || input?.chatSelector
        || input?.chat
        || inferChatSelector(combined)).slice(0, 160);
    const startTime: any = parseDate(nested.startTime || input?.startTime) || startOfLocalDay(current);
    const requestedEnd: any = parseDate(nested.endTime || input?.endTime);
    const endTime: any = requestedEnd && requestedEnd.getTime() <= current.getTime() ? requestedEnd : current;
    const boundedStart: any = startTime.getTime() <= endTime.getTime() ? startTime : startOfLocalDay(endTime);
    return {
        chatSelector: chatSelector || null,
        startTime: boundedStart.toISOString(),
        endTime: endTime.toISOString(),
        maxMessages: Math.min(Math.max(Number(nested.maxMessages || input?.maxMessages) || WECHAT_CHAT_MAX_MESSAGES, 1), WECHAT_CHAT_MAX_MESSAGES),
        outputMode: nested.outputMode === 'metadata-summary' ? 'metadata-summary' : 'local-summary',
        refreshMode: 'incremental',
        sameNameStrategy: 'latest-active-session',
        privateContentModelAccess: 'local-only',
        requestedFutureEndClampedToNow: Boolean(requestedEnd && requestedEnd.getTime() > current.getTime())
    };
}
export function inferChatSelector(value: any): any {
    const text: any = clean(value);
    const patterns: any[] = [
        /群名\s*[：:]\s*([^\s，。；;：:]{1,80})/i,
        /(?:获取|读取|查看|导出|整理|分析)\s*(?:微信)?\s*([^\s，。；;：:]{1,80})\s*(?:群聊|群|聊天)/i,
        /([a-zA-Z0-9_\-\u4e00-\u9fff]{1,80})\s*(?:群聊|群)(?:的)?(?:微信)?聊天/i
    ];
    for (const pattern of patterns) {
        const matched: any = text.match(pattern)?.[1];
        if (matched && !['微信', '聊天', '群聊'].includes(matched))
            return matched;
    }
    return '';
}
export function wechatApprovalScope(task: any): any {
    const request: any = task?.input?.wechatChat || {};
    return {
        taskType: task.taskType,
        title: task.input?.title || '',
        assigneeAgentId: task.assigneeAgentId || null,
        chatSelector: request.chatSelector,
        startTime: request.startTime,
        endTime: request.endTime,
        maxMessages: request.maxMessages,
        outputMode: request.outputMode,
        sameNameStrategy: request.sameNameStrategy
    };
}
function parseDate(value: any): any {
    if (!value)
        return null;
    const parsed: any = new Date(value);
    return validDate(parsed);
}
function validDate(value: any): any {
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}
function startOfLocalDay(value: any): any {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
function clean(value: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim();
}
