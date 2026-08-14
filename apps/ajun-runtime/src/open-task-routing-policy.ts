import { assertNoSensitiveData } from './goal-spec.ts';
import { INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT } from '@agent-army/m5-kernel/routine-execution-contract';
import { createM5ObservationDecision } from '@agent-army/m5-kernel/route-execution';
import { DEFAULT_TASK_CAPABILITY_CATALOG } from './task-capability-catalog.ts';
import { openTaskResearchState } from './open-task-research-state.ts';
const { progress: { requiredInteger: requiredProgressInteger, requiredBudgetInteger, }, healthyCompletion: healthyOpenResearchWorkProduct, } = openTaskResearchState;
const OPEN_TASK_DELEGATES: any = DEFAULT_TASK_CAPABILITY_CATALOG.openTaskDelegates();
function supportsOpenTask(task: any, agent: any): any {
    return Boolean(task
        && agent?.openTaskPolicy
        && (OPEN_TASK_DELEGATES as any)[task.taskType]
        && agent.acceptedTaskTypes?.includes(task.taskType));
}
function routeOpenTaskForExecutor(task: any, agent: any): any {
    if (!supportsOpenTask(task, agent))
        return task;
    return {
        ...task,
        taskType: (OPEN_TASK_DELEGATES as any)[task.taskType],
        input: {
            ...(task.input || {}),
            context: {
                ...(task.input?.context || {}),
                openTaskType: task.taskType,
                delegatedTaskType: (OPEN_TASK_DELEGATES as any)[task.taskType],
                controlPlane: 'paperclip',
                capabilityPolicy: 'agent-manifest'
            }
        }
    };
}
function inspectOpenTaskManifestCapabilities(task: any, agent: any): any {
    if (!supportsOpenTask(task, agent)) {
        return { allowed: true, requested: [], missing: [] };
    }
    assertNoSensitiveData(task.input?.goalSpec || {}, 'goalSpec');
    const requested: any[] = [...new Set([
            ...(Array.isArray(task.input?.goalSpec?.capabilityRequests)
                ? task.input.goalSpec.capabilityRequests.map((item: any): any => item?.capabilityId)
                : []),
            ...(Array.isArray(task.input?.goalSpec?.requestedPermissions)
                ? task.input.goalSpec.requestedPermissions
                : [])
        ]
            .map((item: any): any => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 12))];
    const manifestCapabilities: any = new Set([
        ...(Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : []),
        ...(Array.isArray(agent?.runtimeCapabilities?.mcpTools) ? agent.runtimeCapabilities.mcpTools : []),
        ...(Array.isArray(agent?.runtimeCapabilities?.skills) ? agent.runtimeCapabilities.skills : [])
    ].map((item: any): any => String(item || '').trim()).filter(Boolean));
    const missing: any = requested.filter((capabilityId: any): any => !manifestCapabilities.has(capabilityId));
    return {
        allowed: missing.length === 0,
        requested,
        missing
    };
}
function decideIntelResearchOpenTask({ task, agent, observation, progress = {}, budget = {}, now = (): any => new Date(), }: any = {}): any {
    const contract: any = INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT;
    if (task?.taskType !== contract.taskType
        || agent?.agentId !== contract.agentId
        || !supportsOpenTask(task, agent)) {
        throw new Error('当前任务不是小R受控开放研究任务。');
    }
    assertNoSensitiveData(observation || {}, 'observation');
    const runId: any = String(observation?.runId || '').trim();
    const issueId: any = String(observation?.issueId || '').trim();
    const observationId: any = String(observation?.observationId || '').trim();
    if (observation?.schemaVersion !== 'agent.army/tool-observation/v1'
        || !runId
        || !issueId
        || !observationId) {
        throw new Error('小R开放研究决策缺少真实 Paperclip Observation、Run 或 Issue。');
    }
    const remainingUnits: any = requiredBudgetInteger(budget.remainingUnits, 'remainingUnits');
    const estimatedNextStepUnits: any = requiredBudgetInteger(budget.estimatedNextStepUnits, 'estimatedNextStepUnits', { positive: true });
    const normalizedProgress: Record<string, any> = {
        stepsUsed: requiredProgressInteger(progress.stepsUsed, 'stepsUsed'),
        safeRetriesUsed: requiredProgressInteger(progress.safeRetriesUsed, 'safeRetriesUsed'),
        replansUsed: requiredProgressInteger(progress.replansUsed, 'replansUsed'),
    };
    let action: any = 'switch_adapter';
    let selectedToolId: any = ({
        pdf_detected: 'content.public.pdf.read',
        dynamic_page_required: 'content.public.dynamic.read',
        github_repository_detected: 'github.public.read',
    } as any)[observation.classification];
    if (!selectedToolId
        && observation?.outcome === 'succeeded'
        && observation?.classification === 'source_verified'
        && observation?.result?.acceptanceSatisfied === false) {
        action = 'continue';
        selectedToolId = String(observation?.result?.nextToolId || '').trim();
    }
    const completedWorkProduct: any = healthyOpenResearchWorkProduct(observation?.result?.workProduct, { runId });
    if (!selectedToolId
        && observation?.outcome === 'succeeded'
        && observation?.classification === 'goal_satisfied'
        && observation?.provenance === 'trusted_report_executor'
        && observation?.toolId === 'controlled.intel-research-report'
        && observation?.result?.acceptanceSatisfied === true
        && completedWorkProduct) {
        action = 'complete';
    }
    if (!selectedToolId
        && observation?.outcome === 'failed'
        && observation?.error?.retryable === true
        && normalizedProgress.safeRetriesUsed < contract.maxSafeRetries
        && normalizedProgress.stepsUsed < contract.maxSteps
        && remainingUnits >= estimatedNextStepUnits) {
        action = 'safe_retry';
        selectedToolId = String(observation.toolId || '').trim();
    }
    let limitReason: any = null;
    if (selectedToolId && normalizedProgress.stepsUsed >= contract.maxSteps) {
        limitReason = 'step_limit_exhausted';
    }
    else if (selectedToolId && remainingUnits < estimatedNextStepUnits) {
        limitReason = 'budget_insufficient';
    }
    if (limitReason) {
        action = 'request_replan';
        selectedToolId = null;
    }
    let replanAllowed: any = normalizedProgress.replansUsed < contract.maxReplans;
    if (!selectedToolId
        && observation?.outcome === 'failed') {
        action = 'request_replan';
    }
    if (!selectedToolId && !['request_replan', 'complete'].includes(action)) {
        throw new Error('当前 Observation 尚无受控研究路线。');
    }
    const manifestTools: any = new Set((Array.isArray(agent.toolAllowlist) ? agent.toolAllowlist : [])
        .map((item: any): any => String(item || '').trim())
        .filter(Boolean));
    if (selectedToolId
        && (!contract.toolIds.includes(selectedToolId) || !manifestTools.has(selectedToolId))) {
        throw new Error(`小R Manifest 未授权 ${selectedToolId}。`);
    }
    const consumesToolStep: any = Boolean(selectedToolId);
    const consumesReplan: any = action === 'request_replan' && replanAllowed;
    const successCondition: any = selectedToolId
        ? (contract.successConditions as any)[selectedToolId]
        : (contract.controlSuccessConditions as any)[action];
    const routeDecision: any = createM5ObservationDecision({
        runId,
        issueId,
        observation,
        action,
        selectedToolId,
        successCondition,
        budget: {
            stepsRemaining: Math.max(0, contract.maxSteps - normalizedProgress.stepsUsed - (consumesToolStep ? 1 : 0)),
            safeRetriesRemaining: Math.max(0, contract.maxSafeRetries
                - normalizedProgress.safeRetriesUsed
                - (action === 'safe_retry' ? 1 : 0)),
            replansRemaining: Math.max(0, contract.maxReplans - normalizedProgress.replansUsed - (consumesReplan ? 1 : 0)),
            remainingUnitsAfterDecision: Math.max(0, remainingUnits - (consumesToolStep ? estimatedNextStepUnits : 0)),
        },
        now,
    });
    return {
        ...routeDecision,
        schemaVersion: 'agent.army/intel-research-open-task-decision/v1',
        taskId: String(task.taskId || '').trim() || null,
        replanAllowed,
        limitReason,
        executionStatus: action === 'complete'
            ? 'complete'
            : action === 'request_replan' && !replanAllowed
                ? 'blocked'
                : 'ready',
        budget: {
            ...routeDecision.budget,
            remainingUnits,
            estimatedNextStepUnits,
        },
        progress: normalizedProgress,
        paperclipWrites: [
            {
                kind: 'append_run_observation',
                runId,
                issueId,
                sourceObservationId: observationId,
                recordedAt: now().toISOString(),
            },
            ...(action === 'request_replan' && replanAllowed ? [{
                    kind: 'request_plan_revision',
                    runId,
                    issueId,
                    sourceObservationId: observationId,
                }] : []),
            ...(action === 'request_replan' && !replanAllowed ? [{
                    kind: 'block_issue',
                    runId,
                    issueId,
                    sourceObservationId: observationId,
                    reason: 'replan_limit_exhausted',
                }] : []),
            ...(action === 'complete' ? [{
                    kind: 'create_work_product',
                    runId,
                    issueId,
                    sourceObservationId: observationId,
                    ...completedWorkProduct,
                }] : []),
        ],
    };
}
export const openTaskRoutingPolicy: any = Object.freeze({
    delegates: OPEN_TASK_DELEGATES,
    supports: supportsOpenTask,
    route: routeOpenTaskForExecutor,
    inspectManifest: inspectOpenTaskManifestCapabilities,
    decide: decideIntelResearchOpenTask,
});
