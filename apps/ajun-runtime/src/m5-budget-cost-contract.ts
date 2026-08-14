const UUID: any = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const BILLING_TYPES: any = new Set([
    'metered_api',
    'subscription_included',
    'subscription_overage',
    'credits',
    'fixed',
]);
const PRODUCER_SOURCES: any = Object.freeze({
    'content-plugin': 'provider-usage',
    publisher: 'publisher-receipt',
});
export function assertM5BudgetCoverage({ overview, companyId, agentId, projectId, maximumCostCents, }: any = {}): any {
    for (const [name, value] of [
        ['companyId', companyId],
        ['agentId', agentId],
        ['projectId', projectId],
    ]) {
        if (!UUID.test(String(value || ''))) {
            throw new M5BudgetCostContractError(`${name} 不是可信 Paperclip UUID。`, 'budget_context_invalid');
        }
    }
    if (!Number.isInteger(maximumCostCents) || maximumCostCents <= 0) {
        throw new M5BudgetCostContractError('最大费用估算必须是正整数美分。', 'budget_estimate_invalid');
    }
    const policies: any = Array.isArray(overview?.policies) ? overview.policies : [];
    const requirements: any[] = [
        ['company', companyId],
        ['agent', agentId],
        ['project', projectId],
    ];
    const accepted: any = requirements.map(([scopeType, scopeId]: any): any => {
        const matches: any = policies.filter((item: any): any => item?.scopeType === scopeType
            && item?.scopeId === scopeId
            && item?.metric === 'billed_cents'
            && item?.isActive !== false);
        const policy: any = matches.length === 1 ? matches[0] : null;
        const remainingAmount: any = Number(policy?.remainingAmount);
        if (!policy
            || policy.hardStopEnabled !== true
            || policy.paused === true
            || !['ok', 'warning'].includes(policy.status)
            || !Number.isFinite(remainingAmount)
            || remainingAmount < maximumCostCents) {
            throw new M5BudgetCostContractError(`Paperclip ${scopeType} 预算未唯一覆盖本次最大估算 ${maximumCostCents} 美分。`, 'paperclip_budget_insufficient');
        }
        return Object.freeze({ scopeType, scopeId, remainingAmount });
    });
    return Object.freeze(accepted);
}
export function createM5CostEventDraft({ producer, actionId, source, runContext, cost, }: any = {}): any {
    const expectedSource: any = PRODUCER_SOURCES[producer];
    if (!expectedSource) {
        throw new M5BudgetCostContractError('费用生产方必须是内容插件或 Publisher。', 'cost_producer_invalid');
    }
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(actionId || ''))) {
        throw new M5BudgetCostContractError('费用 actionId 无效。', 'cost_action_invalid');
    }
    const sourceRecord: any = strictObject(source, ['kind', 'receiptChecksum', 'connectorMode']);
    if (sourceRecord.kind !== expectedSource
        || !/^sha256:[0-9a-f]{64}$/i.test(String(sourceRecord.receiptChecksum || ''))
        || (producer === 'publisher'
            && !String(sourceRecord.connectorMode || '').startsWith('real:'))) {
        throw new M5BudgetCostContractError('费用必须来自可核验的真实 Provider 用量或真实 Publisher 回执。', 'cost_source_unverified');
    }
    const context: any = strictObject(runContext, [
        'companyId',
        'agentId',
        'issueId',
        'projectId',
        'goalId',
        'runId',
    ]);
    for (const field of ['companyId', 'agentId', 'projectId', 'runId']) {
        if (!UUID.test(String(context[field] || ''))) {
            throw new M5BudgetCostContractError(`费用上下文 ${field} 无效。`, 'cost_context_invalid');
        }
    }
    for (const optional of ['issueId', 'goalId']) {
        if (context[optional] != null && !UUID.test(String(context[optional]))) {
            throw new M5BudgetCostContractError(`费用上下文 ${optional} 无效。`, 'cost_context_invalid');
        }
    }
    const charge: any = strictObject(cost, [
        'provider',
        'biller',
        'billingType',
        'billingCode',
        'model',
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'costCents',
        'occurredAt',
    ]);
    if (!String(charge.provider || '').trim()
        || !String(charge.biller || '').trim()
        || !BILLING_TYPES.has(charge.billingType)
        || !String(charge.billingCode || '').startsWith('m5:')
        || !String(charge.model || '').trim()
        || !Number.isInteger(charge.costCents)
        || charge.costCents <= 0
        || Number.isNaN(Date.parse(charge.occurredAt))) {
        throw new M5BudgetCostContractError('费用字段不满足 Paperclip cost_event 契约。', 'cost_event_invalid');
    }
    for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
        if (!Number.isInteger(charge[field]) || charge[field] < 0) {
            throw new M5BudgetCostContractError('费用 Token 用量无效。', 'cost_event_invalid');
        }
    }
    return Object.freeze({
        schemaVersion: 'agent.army/m5-cost-event-draft/v1',
        producer,
        actionId,
        companyId: context.companyId,
        source: Object.freeze({
            kind: sourceRecord.kind,
            receiptChecksum: sourceRecord.receiptChecksum,
            connectorMode: sourceRecord.connectorMode || null,
        }),
        event: Object.freeze({
            agentId: context.agentId,
            issueId: context.issueId || null,
            projectId: context.projectId,
            goalId: context.goalId || null,
            heartbeatRunId: context.runId,
            provider: charge.provider,
            biller: charge.biller,
            billingType: charge.billingType,
            billingCode: charge.billingCode,
            model: charge.model,
            inputTokens: charge.inputTokens,
            cachedInputTokens: charge.cachedInputTokens,
            outputTokens: charge.outputTokens,
            costCents: charge.costCents,
            occurredAt: new Date(charge.occurredAt).toISOString(),
        }),
    });
}
export class M5BudgetCostContractError extends Error {
    code: any;
    constructor(message: any, code: any) {
        super(message);
        this.code = code;
    }
}
function strictObject(value: any, allowedKeys: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new M5BudgetCostContractError('费用契约字段必须是对象。', 'cost_event_invalid');
    }
    const extra: any = Object.keys(value).find((key: any): any => !allowedKeys.includes(key));
    if (extra) {
        throw new M5BudgetCostContractError(`费用契约不接受自由字段 ${extra}；不得夹带凭据、Prompt、文件路径或平台正文。`, 'cost_event_extra_field');
    }
    return value;
}
