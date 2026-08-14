import { coded } from './policy.ts';
import { verifySignedBudgetTicket } from './signed-budget-ticket.ts';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REQUIRED_SCOPES = Object.freeze([
    ['company', 'companyId'],
    ['agent', 'agentId'],
    ['project', 'projectId'],
]);
/**
 * Paperclip 2026.722.0 does not expose a budget client in the public plugin
 * SDK. A newer host may inject this narrow, trusted extension into the worker
 * context. Until then paid tools deliberately fail closed.
 */
export function paidBudgetCheckerFromContext(ctx: any) {
    const checker = ctx?.paperclipBudgets?.reservePaidToolBudget;
    if (typeof checker === 'function')
        return checker.bind(ctx.paperclipBudgets);
    return async (request: any) => {
        const config = await ctx.config.get();
        return verifySignedBudgetTicket({
            ticket: request.budgetTicket,
            publicKey: config.budgetTicketPublicKey,
            run: request,
            actionId: request.actionId,
            operation: request.operation,
            maximumCostCents: request.maximumCostCents,
            parameters: request.parameters,
        });
    };
}
export async function reservePaidToolBudget({ checker, run, actionId, operation, maximumCostCents, budgetTicket, parameters, }: any) {
    const context = trustedRunContext(run);
    const requestedCents = positiveInteger(maximumCostCents, 'paid_budget_estimate_invalid', '付费工具缺少有效的最大费用估算，Provider 未调用。');
    if (typeof checker !== 'function') {
        throw coded('paid_budget_checker_unavailable', 'Paperclip 未向插件注入可信预算检查器，Provider 未调用。');
    }
    let decision;
    try {
        decision = await checker({
            ...context,
            actionId: String(actionId),
            operation: String(operation),
            maximumCostCents: requestedCents,
            budgetTicket,
            parameters,
        });
    }
    catch {
        throw coded('paid_budget_check_failed', 'Paperclip 预算检查失败，Provider 未调用。');
    }
    assertDecisionContext(decision, context);
    if (decision.allowed !== true) {
        throw coded('paid_budget_insufficient', '公司、岗位或 Project 预算不足，Provider 未调用。');
    }
    const reservationId = validUuid(decision.reservationId, 'paid_budget_reservation_invalid', 'Paperclip 未返回有效的原子预算预留，Provider 未调用。');
    const reservedCents = positiveInteger(decision.reservedCents, 'paid_budget_reservation_invalid', 'Paperclip 预算预留金额无效，Provider 未调用。');
    if (reservedCents < requestedCents) {
        throw coded('paid_budget_insufficient', 'Paperclip 预算预留不足以覆盖本次最大费用，Provider 未调用。');
    }
    for (const [scopeType, idField] of REQUIRED_SCOPES) {
        const scope = decision.scopes?.[scopeType];
        if (scope?.scopeId !== (context as Record<string, any>)[idField]
            || scope?.allowed !== true
            || !Number.isInteger(scope?.remainingCents)
            || scope.remainingCents < reservedCents) {
            throw coded('paid_budget_scope_invalid', `Paperclip ${scopeType} 预算回执缺失、不匹配或余额不足，Provider 未调用。`);
        }
    }
    return Object.freeze({
        reservationId,
        reservedCents,
        maximumCostCents: requestedCents,
    });
}
function trustedRunContext(run: any) {
    return {
        companyId: validUuid(run?.companyId, 'paid_budget_context_invalid', '付费工具缺少可信公司上下文，Provider 未调用。'),
        agentId: validUuid(run?.agentId, 'paid_budget_context_invalid', '付费工具缺少可信岗位上下文，Provider 未调用。'),
        projectId: validUuid(run?.projectId, 'paid_budget_context_invalid', '付费工具缺少可信 Project 上下文，Provider 未调用。'),
        runId: validUuid(run?.runId, 'paid_budget_context_invalid', '付费工具缺少可信 Run 上下文，Provider 未调用。'),
    };
}
function assertDecisionContext(decision: any, context: any) {
    if (!decision
        || decision.companyId !== context.companyId
        || decision.agentId !== context.agentId
        || decision.projectId !== context.projectId
        || decision.runId !== context.runId) {
        throw coded('paid_budget_context_mismatch', 'Paperclip 预算回执与当前公司、岗位、Project 或 Run 不匹配，Provider 未调用。');
    }
}
function positiveInteger(value: any, code: any, message: any) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0)
        throw coded(code, message);
    return amount;
}
function validUuid(value: any, code: any, message: any) {
    const id = String(value || '').trim();
    if (!UUID.test(id))
        throw coded(code, message);
    return id;
}
