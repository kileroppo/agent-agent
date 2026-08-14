import crypto from 'node:crypto';
import { coded, sha256 } from './policy.ts';
const TICKET_VERSION = 'agent.army/m5-budget-ticket/v1';
const MAX_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 10;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function createSignedBudgetTicket({ privateKey, run, actionId, operation, maximumCostCents, parameters, scopes, now = new Date(), ttlSeconds = 90, }: any = {}) {
    const issuedAt = Math.floor(new Date(now).getTime() / 1000);
    if (!Number.isInteger(issuedAt))
        throw new Error('预算票据签发时间无效。');
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
        throw new Error(`预算票据有效期必须为 1-${MAX_TTL_SECONDS} 秒。`);
    }
    const cost = positiveInteger(maximumCostCents, '预算票据最大费用无效。');
    const payload = {
        v: TICKET_VERSION,
        reservationId: crypto.randomUUID(),
        companyId: uuid(run?.companyId, '预算票据公司无效。'),
        agentId: uuid(run?.agentId, '预算票据岗位无效。'),
        projectId: uuid(run?.projectId, '预算票据项目无效。'),
        runId: uuid(run?.runId, '预算票据 Run 无效。'),
        actionId: validActionId(actionId),
        operation: String(operation || '').trim(),
        maximumCostCents: cost,
        parametersChecksum: budgetTicketParametersChecksum(parameters),
        scopes: canonicalScopes(scopes, cost),
        iat: issuedAt,
        exp: issuedAt + ttl,
    };
    if (!payload.operation)
        throw new Error('预算票据 operation 无效。');
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url');
    return `${encoded}.${signature}`;
}
export function verifySignedBudgetTicket({ ticket, publicKey, run, actionId, operation, maximumCostCents, parameters, now = new Date(), }: any = {}) {
    const [encoded, signature, extra] = String(ticket || '').split('.');
    if (!encoded || !signature || extra)
        denied('预算票据格式无效。');
    let payload;
    try {
        if (!crypto.verify(null, Buffer.from(encoded), publicKey, Buffer.from(signature, 'base64url')))
            denied('预算票据签名无效。');
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    catch (error: any) {
        if (error?.code === 'paid_budget_ticket_invalid')
            throw error;
        denied('预算票据无法验证。');
    }
    const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
    if (payload?.v !== TICKET_VERSION
        || !Number.isInteger(payload?.iat)
        || !Number.isInteger(payload?.exp)
        || payload.exp <= payload.iat
        || payload.exp - payload.iat > MAX_TTL_SECONDS
        || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS
        || payload.exp < nowSeconds - CLOCK_SKEW_SECONDS)
        denied('预算票据已过期或时间范围无效。');
    const expected = {
        companyId: uuid(run?.companyId, '当前公司上下文无效。'),
        agentId: uuid(run?.agentId, '当前岗位上下文无效。'),
        projectId: uuid(run?.projectId, '当前项目上下文无效。'),
        runId: uuid(run?.runId, '当前 Run 上下文无效。'),
        actionId: validActionId(actionId),
        operation: String(operation || '').trim(),
        maximumCostCents: positiveInteger(maximumCostCents, '当前最大费用无效。'),
        parametersChecksum: budgetTicketParametersChecksum(parameters),
    };
    for (const [key, value] of Object.entries(expected)) {
        if (payload[key] !== value)
            denied(`预算票据与当前 ${key} 不匹配。`);
    }
    const reservationId = uuid(payload.reservationId, '预算票据预留标识无效。');
    const scopes = canonicalScopes(payload.scopes, expected.maximumCostCents);
    return Object.freeze({
        reservationId,
        companyId: expected.companyId,
        agentId: expected.agentId,
        projectId: expected.projectId,
        runId: expected.runId,
        allowed: true,
        reservedCents: expected.maximumCostCents,
        maximumCostCents: expected.maximumCostCents,
        scopes: Object.freeze(Object.fromEntries(scopes.map((item: any) => [
            item.scopeType,
            Object.freeze({
                scopeId: item.scopeId,
                allowed: true,
                remainingCents: item.remainingCents,
            }),
        ]))),
    });
}
export function budgetTicketParametersChecksum(parameters: any) {
    return sha256(Buffer.from(stableJson(withoutTicket(parameters))));
}
function withoutTicket(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const { budgetTicket: _ignored, ...rest } = value;
    return rest;
}
function stableJson(value: any): string {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function canonicalScopes(value: any, reservedCents: any) {
    const source = Array.isArray(value)
        ? Object.fromEntries(value.map((item: any) => [item?.scopeType, item]))
        : value;
    const definitions = [
        ['company', 'companyId'],
        ['agent', 'agentId'],
        ['project', 'projectId'],
    ];
    return definitions.map(([scopeType]: any) => {
        const scope = source?.[scopeType];
        const remainingCents = Number(scope?.remainingCents ?? scope?.remainingAmount);
        if (scope?.scopeType != null && scope.scopeType !== scopeType
            || !UUID.test(String(scope?.scopeId || ''))
            || !Number.isInteger(remainingCents)
            || remainingCents < reservedCents)
            throw new Error(`预算票据缺少有效的 ${scopeType} 范围。`);
        return { scopeType, scopeId: scope.scopeId, remainingCents };
    });
}
function validActionId(value: any) {
    const actionId = String(value || '');
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(actionId))
        throw new Error('预算票据 actionId 无效。');
    return actionId;
}
function positiveInteger(value: any, message: any) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0)
        throw new Error(message);
    return amount;
}
function uuid(value: any, message: any) {
    const id = String(value || '').trim();
    if (!UUID.test(id))
        throw new Error(message);
    return id;
}
function denied(message: any) {
    throw coded('paid_budget_ticket_invalid', `${message} Provider 未调用。`);
}
