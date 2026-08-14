import { consumeM5SystemControllerPlanRevision, isRecoverableM5SystemControllerFailure, recoverM5SystemControllerFailure, } from './m5-system-controller-recovery.ts';
import { MetricCheckpointExecution, PaperclipMetricMonitorError, } from './metric-checkpoint-execution.ts';
export { PaperclipMetricMonitorError, completedCheckpointLabels, trustedPublishReceipt, } from './metric-checkpoint-execution.ts';
const METRIC_SYSTEM_ROLE: any = 'm5-metrics-controller';
const METRIC_ROUTINE_MARKER: any = '[agent-army:m5:routine:m5-metrics]';
const METRIC_RECONCILE_ACTION: any = 'publisher.reconcile_stale_attempt';
const FORBIDDEN_CALLER_FIELDS: any = new Set([
    'receiptId',
    'collectionKey',
    'collectedAt',
    'publishedAt',
    'dueAt',
    'checkpoint',
    'campaignId',
    'accountRef',
    'connectorMode',
    'externalContentId',
    'metrics',
    'source',
    'trustedContext',
    'observation',
]);
export class PaperclipMetricMonitorHandler {
    execution: any;
    governance: any;
    inFlightIssues: any;
    now: any;
    publisher: any;
    constructor({ governance, publisher, now = (): any => new Date(), }: any = {}) {
        this.governance = governance;
        this.publisher = publisher;
        this.now = now;
        this.execution = new MetricCheckpointExecution({ governance, publisher, now });
        this.inFlightIssues = new Map();
    }
    async handle(payload: any): Promise<any> {
        assertNoMetricSelectionParameters(payload);
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipMetricMonitorError('M5 指标 HTTP heartbeat 缺少运行、控制器或任务标识。');
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.executeIssue({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            return await execution;
        }
        catch (error: any) {
            if (!isRecoverableM5SystemControllerFailure(error))
                throw error;
            try {
                return await recoverM5SystemControllerFailure({
                    governance: this.governance,
                    issueId,
                    runId,
                    agentId,
                    routineKey: 'm5-metrics',
                    systemRole: METRIC_SYSTEM_ROLE,
                    error,
                });
            }
            catch {
                throw error;
            }
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async executeIssue({ issueId, runId, agentId }: any): Promise<any> {
        this.assertDependencies();
        const verified: any = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: METRIC_SYSTEM_ROLE,
        });
        const issue: any = verified.issue;
        if (issue.status === 'done') {
            return { accepted: true, skipped: true, issueId, reason: '三个指标检查点已完成。' };
        }
        if (!['in_progress', 'in_review'].includes(issue.status)) {
            throw new PaperclipMetricMonitorError('指标 Monitor 任务必须处于 in_progress 或 in_review。');
        }
        if (!String(issue.description || '').includes(METRIC_ROUTINE_MARKER)) {
            throw new PaperclipMetricMonitorError('HTTP 控制器只接受 M5 指标回流 Routine 的固定任务。');
        }
        const existingMonitor: any = issue.executionPolicy?.monitor;
        if (existingMonitor?.recoveryPolicy === 'human_review'
            && existingMonitor?.recoveryAction?.action === METRIC_RECONCILE_ACTION) {
            return {
                accepted: true,
                issueId,
                waitingForHumanReview: true,
                recoveryAction: structuredClone(existingMonitor.recoveryAction),
            };
        }
        const caseId: any = metricCaseId(issue);
        await this.governance.assertCaseIssueLink(caseId, issueId);
        await consumeM5SystemControllerPlanRevision({
            governance: this.governance,
            pipelineCaseId: caseId,
            runId,
            routineKey: 'm5-metrics',
            systemRole: METRIC_SYSTEM_ROLE,
        });
        return this.execution.advance({ issue, caseId, runId, agentId });
    }
    assertDependencies(): any {
        this.#syncExecutionDependencies();
        this.assertIdentityDependencies();
        this.execution.assertDependencies();
    }
    assertIdentityDependencies(): any {
        if (typeof this.governance?.verifySystemAssignment !== 'function'
            || typeof this.governance?.assertCaseIssueLink !== 'function') {
            throw new PaperclipMetricMonitorError('M5 指标控制器缺少 Paperclip 原生 Monitor/Work Product 适配。');
        }
    }
    schedule(issue: any, context: any): any {
        this.#syncExecutionDependencies();
        return this.execution.schedule(issue, context);
    }
    scheduleRecovery(issue: any, context: any): any {
        this.#syncExecutionDependencies();
        return this.execution.scheduleRecovery(issue, {
            ...context,
            caseId: metricCaseId(issue),
        });
    }
    scheduleStaleInvocationReview(issue: any, context: any): any {
        this.#syncExecutionDependencies();
        return this.execution.scheduleStaleInvocationReview(issue, context);
    }
    scheduleReceiptRecovery(issue: any, context: any): any {
        this.#syncExecutionDependencies();
        return this.execution.scheduleReceiptRecovery(issue, context);
    }
    persistSnapshot(context: any): any {
        this.#syncExecutionDependencies();
        return this.execution.persistSnapshot(context);
    }
    #syncExecutionDependencies(): any {
        this.execution.governance = this.governance;
        this.execution.publisher = this.publisher;
        this.execution.now = this.now;
    }
}
function metricCaseId(issue: any): any {
    const value: any = String(issue?.description || '').match(/当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1];
    if (!value)
        throw new PaperclipMetricMonitorError('M5 指标任务缺少固定 Case 绑定。');
    return value;
}
function assertNoMetricSelectionParameters(payload: any): any {
    const queue: any[] = [payload];
    while (queue.length) {
        const value: any = queue.pop();
        if (!value || typeof value !== 'object')
            continue;
        for (const [key, child] of Object.entries(value)) {
            if (FORBIDDEN_CALLER_FIELDS.has(key)) {
                throw new PaperclipMetricMonitorError(`M5 指标 HTTP heartbeat 不接受调用方指定 ${key}。`, 'metric_selection_parameter_forbidden');
            }
            if (child && typeof child === 'object')
                queue.push(child);
        }
    }
}
