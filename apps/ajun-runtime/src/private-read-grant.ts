import crypto from 'node:crypto';
const MAX_USES: any = 10;
const DEFAULT_TTL_MS: any = 30 * 60 * 1000;
export function resolvePrivateReadGrant({ approvals, task, expectedScope, now = new Date() }: any = {}): any {
    const timestamp: any = validDate(now);
    const candidates: any = (Array.isArray(approvals) ? approvals : [])
        .filter((approval: any): any => approval?.action === 'wechat-private-chat-read' && approval?.status === 'approved')
        .sort((left: any, right: any): any => String(right.decidedAt || right.createdAt || '').localeCompare(String(left.decidedAt || left.createdAt || '')));
    for (const approval of candidates) {
        const grant: any = approval.privateReadGrant;
        if (grant && grantMatches(grant, task, expectedScope) && grantUsable(grant, timestamp)) {
            return { approval, grant, created: false };
        }
    }
    const sourceApproval: any = candidates.find((approval: any): any => approval.taskId === task?.taskId
        && scopesEqual(approval.requestedScope, expectedScope)
        && !approval.revokedAt
        && validUntil(approval.validUntil, timestamp));
    if (!sourceApproval)
        return null;
    const expiresAt: any = new Date(Math.min(timestamp.getTime() + DEFAULT_TTL_MS, Date.parse(sourceApproval.validUntil || '') || Number.POSITIVE_INFINITY)).toISOString();
    return {
        approval: sourceApproval,
        created: true,
        grant: {
            schemaVersion: 'agent.army/private-read-grant/v1',
            grantId: crypto.randomUUID(),
            ownerId: String(sourceApproval.decisionBy || 'owner'),
            sourceApprovalId: sourceApproval.approvalId,
            feishuChatRef: feishuChatRef(task),
            requestingAgentId: String(task?.assigneeAgentId || ''),
            scope: expectedScope,
            maxUses: MAX_USES,
            uses: [],
            createdAt: timestamp.toISOString(),
            expiresAt,
            revokedAt: null,
        },
    };
}
export function consumePrivateReadGrant(grant: any, { taskId, now = new Date() }: any = {}): any {
    const timestamp: any = validDate(now);
    if (!grantUsable(grant, timestamp)) {
        throw grantError('private_read_grant_unavailable', '本次微信临时授权已过期、撤销或用尽，请重新确认。');
    }
    const stableTaskId: any = String(taskId || '').trim();
    if (!stableTaskId)
        throw grantError('private_read_grant_invalid', '微信临时授权缺少任务标识。');
    if (grant.uses.some((use: any): any => use.taskId === stableTaskId))
        return grant;
    return {
        ...grant,
        uses: [...grant.uses, { taskId: stableTaskId, readStartedAt: timestamp.toISOString() }],
    };
}
export function revokePrivateReadGrant(grant: any, { now = new Date() }: any = {}): any {
    return { ...grant, revokedAt: validDate(now).toISOString() };
}
export function privateReadGrantStatus(grant: any, { now = new Date() }: any = {}): any {
    const timestamp: any = validDate(now);
    const used: any = Array.isArray(grant?.uses) ? grant.uses.length : 0;
    const maxUses: any = Number(grant?.maxUses) || 0;
    return {
        status: grantUsable(grant, timestamp) ? 'active' : grant?.revokedAt ? 'revoked' : 'expired_or_exhausted',
        remainingUses: Math.max(0, maxUses - used),
        expiresAt: grant?.expiresAt || null,
    };
}
function grantMatches(grant: any, task: any, scope: any): any {
    return grant?.requestingAgentId === task?.assigneeAgentId
        && grant?.feishuChatRef === feishuChatRef(task)
        && scopesEqual(reusableScope(grant?.scope), reusableScope(scope));
}
function grantUsable(grant: any, now: any): any {
    return Boolean(grant)
        && !grant.revokedAt
        && validUntil(grant.expiresAt, now)
        && Array.isArray(grant.uses)
        && grant.uses.length < Number(grant.maxUses || 0);
}
function feishuChatRef(task: any): any {
    return String(task?.input?.context?.feishuChatRef
        || task?.input?.context?.chatRef
        || task?.source?.chatRef
        || 'local-console').trim();
}
function reusableScope(scope: any): any {
    return {
        chatSelector: scope?.chatSelector,
        startTime: scope?.startTime,
        endTime: scope?.endTime,
        maxMessages: scope?.maxMessages,
        outputMode: scope?.outputMode,
        sameNameStrategy: scope?.sameNameStrategy,
    };
}
function scopesEqual(left: any, right: any): any {
    return JSON.stringify(left || {}) === JSON.stringify(right || {});
}
function validUntil(value: any, now: any): any {
    const parsed: any = Date.parse(value || '');
    return Number.isFinite(parsed) && parsed > now.getTime();
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw grantError('private_read_grant_invalid', '微信临时授权时间无效。');
    return date;
}
function grantError(code: any, message: any): any {
    return Object.assign(new Error(message), { code, category: 'manual', retryable: false });
}
