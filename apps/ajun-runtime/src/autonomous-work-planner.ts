import { assertNoSensitiveData } from './goal-spec.ts';
const WORK_PLAN_SCHEMA_VERSION: any = 'agent.army/work-plan/v1';
const STEP_STATUSES: any = new Set(['pending', 'running', 'completed', 'failed', 'blocked', 'superseded']);
const HARD_LIMITS: any = Object.freeze({
    maxDurationMs: 60 * 60 * 1000,
    maxModelCalls: 20,
    maxConcurrency: 4,
    maxDelegationDepth: 2
});
const APPROVAL_THRESHOLD_USD: any = 5;
const MAX_REPLANS: any = 3;
export class AutonomousWorkPlanError extends Error {
    code: any;
    name: any;
    constructor(code: any, message: any) {
        super(message);
        this.name = 'AutonomousWorkPlanError';
        this.code = code;
    }
}
export function createWorkPlan({ goalSpec, steps, budget = undefined, now = new Date() }: any = {}): any {
    try {
        assertNoSensitiveData({ goalSpec, steps }, 'workPlan');
    }
    catch {
        throw new AutonomousWorkPlanError('sensitive_data_rejected', '工作计划包含敏感字段或凭据，已拒绝。');
    }
    validateGoalSpec(goalSpec);
    const timestamp: any = asIso(now);
    const normalizedSteps: any = normalizeSteps(steps);
    validateDag(normalizedSteps);
    const budgetPolicy: any = normalizeBudgetPolicy(budget);
    return {
        schemaVersion: WORK_PLAN_SCHEMA_VERSION,
        planId: `work-plan:${goalSpec.goalId}`,
        goalSpec: clone(goalSpec),
        version: 1,
        status: 'ready',
        steps: normalizedSteps,
        budget: {
            hardLimits: budgetPolicy.hardLimits,
            approvalThresholdUsd: budgetPolicy.approvalThresholdUsd,
            usage: {
                startedAt: timestamp,
                modelCalls: 0,
                activeChildren: 0,
                delegationDepth: 0,
                actualCostUsd: 0,
                estimatedCostUsd: 0
            }
        },
        replanCount: 0,
        replanEvents: [],
        createdAt: timestamp,
        updatedAt: timestamp
    };
}
export function recordWorkPlanCheckpoint(plan: any, { stepId, status, checkpoint = undefined, artifactRefs = undefined, now = new Date() }: any = {}): any {
    validatePlan(plan);
    if (['waiting_approval', 'budget_exhausted'].includes(plan.status)) {
        throw new AutonomousWorkPlanError('execution_gated', `工作计划处于 ${plan.status}，不能继续执行步骤。`);
    }
    if (!STEP_STATUSES.has(status) || ['pending', 'superseded'].includes(status)) {
        throw new AutonomousWorkPlanError('invalid_step_status', `不能将 checkpoint 写入状态 ${String(status)}。`);
    }
    const next: any = clone(plan);
    const step: any = next.steps.find((item: any): any => item.stepId === stepId);
    if (!step)
        throw new AutonomousWorkPlanError('step_not_found', `未找到步骤 ${String(stepId)}。`);
    assertTransition(step.status, status);
    if (['running', 'completed'].includes(status))
        assertDependenciesSatisfied(next, step);
    if (checkpoint !== undefined) {
        try {
            assertNoSensitiveData(checkpoint, `checkpoint.${step.stepId}`);
        }
        catch {
            throw new AutonomousWorkPlanError('sensitive_data_rejected', 'checkpoint 包含敏感凭据，已拒绝。');
        }
        step.checkpoint = clone(checkpoint);
    }
    if (artifactRefs !== undefined) {
        step.artifactRefs = textList(artifactRefs, 'artifactRefs', 100, 500);
    }
    if (status === 'running' && step.status !== 'running')
        step.attempt += 1;
    step.status = status;
    step.updatedAt = asIso(now);
    next.updatedAt = step.updatedAt;
    next.status = derivePlanStatus(next.steps);
    return next;
}
export function recordAutonomyUsage(plan: any, delta: any = {}, { now = new Date() }: any = {}): any {
    validatePlan(plan);
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
        throw new AutonomousWorkPlanError('invalid_usage', '自主执行用量必须是对象。');
    }
    const next: any = clone(plan);
    const usage: any = next.budget?.usage;
    if (!usage)
        throw new AutonomousWorkPlanError('invalid_work_plan', '工作计划缺少预算用量。');
    usage.modelCalls += nonNegativeNumber(delta.modelCalls, 'modelCalls', { integer: true, fallback: 0 });
    usage.actualCostUsd += nonNegativeNumber(delta.actualCostUsd, 'actualCostUsd', { fallback: 0 });
    if (delta.estimatedCostUsd !== undefined) {
        usage.estimatedCostUsd = nonNegativeNumber(delta.estimatedCostUsd, 'estimatedCostUsd');
    }
    if (delta.activeChildren !== undefined) {
        usage.activeChildren = nonNegativeNumber(delta.activeChildren, 'activeChildren', { integer: true });
    }
    if (delta.delegationDepth !== undefined) {
        usage.delegationDepth = nonNegativeNumber(delta.delegationDepth, 'delegationDepth', { integer: true });
    }
    const timestamp: any = asIso(now);
    const elapsedMs: any = Math.max(0, Date.parse(timestamp) - Date.parse(usage.startedAt));
    const reasons: any[] = [];
    const limits: any = next.budget?.hardLimits || HARD_LIMITS;
    const approvalThresholdUsd: any = Number.isFinite(Number(next.budget?.approvalThresholdUsd))
        ? Number(next.budget.approvalThresholdUsd)
        : APPROVAL_THRESHOLD_USD;
    if (elapsedMs > limits.maxDurationMs)
        reasons.push('max_duration');
    if (usage.modelCalls > limits.maxModelCalls)
        reasons.push('max_model_calls');
    if (usage.activeChildren > limits.maxConcurrency)
        reasons.push('max_concurrency');
    if (usage.delegationDepth > limits.maxDelegationDepth)
        reasons.push('max_delegation_depth');
    const projectedCostUsd: any = Math.max(usage.actualCostUsd, usage.estimatedCostUsd);
    const decision: any = reasons.length
        ? { status: 'budget_exhausted', allowed: false, approvalRequired: false, reasons }
        : projectedCostUsd > approvalThresholdUsd
            ? { status: 'waiting_approval', allowed: false, approvalRequired: true, reasons: ['cost_approval_threshold'] }
            : { status: 'allowed', allowed: true, approvalRequired: false, reasons: [] };
    usage.elapsedMs = elapsedMs;
    usage.updatedAt = timestamp;
    next.updatedAt = timestamp;
    if (!decision.allowed)
        next.status = decision.status;
    return { plan: next, decision };
}
export function replanAfterFailure(plan: any, { failedStepId, replacementSteps, reason, now = new Date() }: any = {}): any {
    validatePlan(plan);
    if ((plan.replanCount || 0) >= MAX_REPLANS) {
        throw new AutonomousWorkPlanError('replan_limit_reached', `工作计划最多允许 ${MAX_REPLANS} 次重规划。`);
    }
    const failed: any = plan.steps.find((step: any): any => step.stepId === failedStepId);
    if (!failed || failed.status !== 'failed') {
        throw new AutonomousWorkPlanError('step_not_failed', '只有已失败步骤可以被重规划替换。');
    }
    const normalizedReason: any = requiredText(reason, 'reason', 1000);
    try {
        assertNoSensitiveData(normalizedReason, 'replan.reason');
    }
    catch {
        throw new AutonomousWorkPlanError('sensitive_data_rejected', '重规划原因包含敏感凭据，已拒绝。');
    }
    const replacements: any = normalizeSteps(replacementSteps);
    const existingIds: any = new Set(plan.steps.map((step: any): any => step.stepId));
    const duplicate: any = replacements.find((step: any): any => existingIds.has(step.stepId));
    if (duplicate) {
        throw new AutonomousWorkPlanError('duplicate_step', `替代步骤 ${duplicate.stepId} 已存在。`);
    }
    if (replacements.some((step: any): any => step.dependsOn.includes(failedStepId))) {
        throw new AutonomousWorkPlanError('invalid_dependency', '替代步骤不能依赖被替换的失败步骤。');
    }
    const replacementIds: any = new Set(replacements.map((step: any): any => step.stepId));
    const replacementLeaves: any = replacements
        .filter((candidate: any): any => !replacements.some((step: any): any => step.dependsOn.includes(candidate.stepId)))
        .map((step: any): any => step.stepId);
    const timestamp: any = asIso(now);
    const next: any = clone(plan);
    const nextFailed: any = next.steps.find((step: any): any => step.stepId === failedStepId);
    nextFailed.status = 'superseded';
    nextFailed.supersededBy = replacementLeaves;
    nextFailed.updatedAt = timestamp;
    for (const step of next.steps) {
        if (!['pending', 'blocked'].includes(step.status) || !step.dependsOn.includes(failedStepId))
            continue;
        step.dependsOn = [...new Set(step.dependsOn.flatMap((dependency: any): any => (dependency === failedStepId ? replacementLeaves : [dependency])))];
    }
    next.steps.push(...replacements);
    validateDag(next.steps);
    next.version += 1;
    next.replanCount = (next.replanCount || 0) + 1;
    next.replanEvents = [
        ...(Array.isArray(next.replanEvents) ? next.replanEvents : []),
        {
            version: next.version,
            failedStepId,
            replacementStepIds: [...replacementIds],
            reason: normalizedReason,
            createdAt: timestamp
        }
    ];
    next.status = 'running';
    next.updatedAt = timestamp;
    return next;
}
function normalizeSteps(steps: any): any {
    if (!Array.isArray(steps) || !steps.length) {
        throw new AutonomousWorkPlanError('invalid_steps', '工作计划至少需要一个步骤。');
    }
    if (steps.length > 200)
        throw new AutonomousWorkPlanError('invalid_steps', '工作计划步骤过多。');
    const seen: any = new Set();
    return steps.map((step: any, index: any): any => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
            throw new AutonomousWorkPlanError('invalid_steps', `第 ${index + 1} 个步骤格式无效。`);
        }
        const stepId: any = identifier(step.stepId, 'stepId');
        if (seen.has(stepId))
            throw new AutonomousWorkPlanError('duplicate_step', `步骤 ${stepId} 重复。`);
        seen.add(stepId);
        return {
            stepId,
            objective: requiredText(step.objective, 'objective', 1000),
            dependsOn: textList(step.dependsOn, 'dependsOn', 100, 128),
            requiredCapabilities: textList(step.requiredCapabilities, 'requiredCapabilities', 100, 160),
            risk: normalizeRisk(step.risk),
            acceptanceCriteria: requiredTextList(step.acceptanceCriteria, 'acceptanceCriteria', 30, 500),
            status: 'pending',
            attempt: 0,
            checkpoint: null,
            artifactRefs: []
        };
    });
}
function validatePlan(plan: any): any {
    if (!plan || plan.schemaVersion !== WORK_PLAN_SCHEMA_VERSION || !Array.isArray(plan.steps)) {
        throw new AutonomousWorkPlanError('invalid_work_plan', '工作计划格式无效。');
    }
}
function assertTransition(current: any, next: any): any {
    const allowed: Record<string, any> = {
        pending: new Set(['running', 'failed', 'blocked']),
        running: new Set(['running', 'completed', 'failed', 'blocked']),
        blocked: new Set(['running', 'failed']),
        failed: new Set([]),
        completed: new Set([]),
        superseded: new Set([])
    };
    if (!allowed[current]?.has(next)) {
        throw new AutonomousWorkPlanError('invalid_step_transition', `步骤不能从 ${current} 变为 ${next}。`);
    }
}
function assertDependenciesSatisfied(plan: any, step: any): any {
    const byId: any = new Map(plan.steps.map((item: any): any => [item.stepId, item]));
    const unsatisfied: any = step.dependsOn.filter((id: any): any => !['completed', 'superseded'].includes(byId.get(id)?.status));
    if (unsatisfied.length) {
        throw new AutonomousWorkPlanError('dependency_not_satisfied', `步骤 ${step.stepId} 的依赖尚未完成：${unsatisfied.join(', ')}。`);
    }
}
function derivePlanStatus(steps: any): any {
    if (steps.some((step: any): any => step.status === 'failed'))
        return 'needs_replan';
    if (steps.every((step: any): any => ['completed', 'superseded'].includes(step.status)))
        return 'completed';
    return 'running';
}
function validateDag(steps: any): any {
    const ids: any = new Set(steps.map((step: any): any => step.stepId));
    for (const step of steps) {
        const missing: any = step.dependsOn.filter((dependency: any): any => !ids.has(dependency));
        if (missing.length) {
            throw new AutonomousWorkPlanError('invalid_dependency', `步骤 ${step.stepId} 引用了不存在的依赖：${missing.join(', ')}。`);
        }
        if (step.dependsOn.includes(step.stepId)) {
            throw new AutonomousWorkPlanError('dependency_cycle', `步骤 ${step.stepId} 不能依赖自身。`);
        }
    }
    const visiting: any = new Set();
    const visited: any = new Set();
    const byId: any = new Map(steps.map((step: any): any => [step.stepId, step]));
    const visit: any = (stepId: any): any => {
        if (visiting.has(stepId))
            throw new AutonomousWorkPlanError('dependency_cycle', '工作计划包含循环依赖。');
        if (visited.has(stepId))
            return;
        visiting.add(stepId);
        for (const dependency of byId.get(stepId).dependsOn)
            visit(dependency);
        visiting.delete(stepId);
        visited.add(stepId);
    };
    for (const step of steps)
        visit(step.stepId);
}
function validateGoalSpec(goalSpec: any): any {
    if (!goalSpec || goalSpec.schemaVersion !== 'agent.army/goal-spec/v1' || !goalSpec.goalId) {
        throw new AutonomousWorkPlanError('invalid_goal_spec', '工作计划需要规范化的 GoalSpec。');
    }
}
function normalizeRisk(value: any): any {
    const risk: any = String(value || 'low').trim().toLowerCase();
    if (!['low', 'medium', 'high'].includes(risk)) {
        throw new AutonomousWorkPlanError('invalid_step_risk', `不支持的步骤风险：${risk}。`);
    }
    return risk;
}
function normalizeBudgetPolicy(value: any): any {
    if (value === undefined || value === null) {
        return { hardLimits: { ...HARD_LIMITS }, approvalThresholdUsd: APPROVAL_THRESHOLD_USD };
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new AutonomousWorkPlanError('invalid_budget', '任务自主预算必须是对象。');
    }
    const durationMinutes: any = boundedBudgetNumber(value.maxDurationMinutes ?? value.maxRuntimeMinutes, HARD_LIMITS.maxDurationMs / 60000, 'maxDurationMinutes');
    return {
        hardLimits: {
            maxDurationMs: durationMinutes * 60000,
            maxModelCalls: boundedBudgetNumber(value.maxModelCalls, HARD_LIMITS.maxModelCalls, 'maxModelCalls', { integer: true }),
            maxConcurrency: boundedBudgetNumber(value.maxConcurrentSubtasks ?? value.maxConcurrency, HARD_LIMITS.maxConcurrency, 'maxConcurrentSubtasks', { integer: true }),
            maxDelegationDepth: boundedBudgetNumber(value.maxDelegationDepth ?? value.maxDependencyDepth, HARD_LIMITS.maxDelegationDepth, 'maxDelegationDepth', { integer: true })
        },
        approvalThresholdUsd: boundedBudgetNumber(value.maxCostUsd ?? value.paidApprovalThresholdUsd, APPROVAL_THRESHOLD_USD, 'maxCostUsd', { allowZero: true })
    };
}
function boundedBudgetNumber(value: any, hardMaximum: any, field: any, { integer = false, allowZero = false }: any = {}): any {
    if (value === undefined || value === null || value === '')
        return hardMaximum;
    const number: any = Number(value);
    const minimum: any = allowZero ? 0 : 1;
    if (!Number.isFinite(number) || number < minimum || number > hardMaximum || (integer && !Number.isSafeInteger(number))) {
        throw new AutonomousWorkPlanError('invalid_budget', `${field} 必须在 ${minimum} 到 ${hardMaximum} 之间。`);
    }
    return number;
}
function requiredText(value: any, field: any, maxLength: any): any {
    const text: any = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > maxLength) {
        throw new AutonomousWorkPlanError('invalid_steps', `${field} 不能为空且不能超过 ${maxLength} 字符。`);
    }
    return text;
}
function requiredTextList(value: any, field: any, maxItems: any, maxLength: any): any {
    const list: any = textList(value, field, maxItems, maxLength);
    if (!list.length)
        throw new AutonomousWorkPlanError('invalid_steps', `${field} 至少需要一项。`);
    return list;
}
function textList(value: any, field: any, maxItems: any, maxLength: any): any {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new AutonomousWorkPlanError('invalid_steps', `${field} 必须是最多 ${maxItems} 项的数组。`);
    }
    return [...new Set(value.map((item: any): any => requiredText(item, field, maxLength)))];
}
function identifier(value: any, field: any): any {
    const text: any = String(value || '').trim();
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text)) {
        throw new AutonomousWorkPlanError('invalid_steps', `${field} 格式无效。`);
    }
    return text;
}
function asIso(value: any): any {
    const date: any = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new AutonomousWorkPlanError('invalid_time', '时间格式无效。');
    return date.toISOString();
}
function nonNegativeNumber(value: any, field: any, { integer = false, fallback }: any = {}): any {
    if (value === undefined && fallback !== undefined)
        return fallback;
    const number: any = Number(value);
    if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) {
        throw new AutonomousWorkPlanError('invalid_usage', `${field} 必须是非负${integer ? '整数' : '数值'}。`);
    }
    return number;
}
function clone(value: any): any {
    return structuredClone(value);
}
export const AUTONOMY_LIMITS: any = Object.freeze({
    ...HARD_LIMITS,
    approvalThresholdUsd: APPROVAL_THRESHOLD_USD,
    maxReplans: MAX_REPLANS
});
