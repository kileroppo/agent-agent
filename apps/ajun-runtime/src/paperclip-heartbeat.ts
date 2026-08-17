import { consumeM5SystemControllerPlanRevision, isRecoverableM5SystemControllerFailure, markM5SystemControllerFailure, recoverM5SystemControllerFailure, } from './m5-system-controller-recovery.ts';
const COMPLETED_HEALTH_REPLAY_WINDOW_MS: any = 30000;
export class PaperclipHeartbeatHandler {
    governance: any;
    inFlightIssues: any;
    incidentDispatcher: any;
    now: any;
    operator: any;
    healthTransitionState: any;
    recentCompletions: any;
    constructor({ operator, governance, incidentDispatcher = null, healthTransitionState = null, now = (): any => new Date() }: any = {}) {
        this.operator = operator;
        this.governance = governance;
        this.incidentDispatcher = incidentDispatcher;
        this.healthTransitionState = healthTransitionState;
        this.now = now;
        this.inFlightIssues = new Map();
        this.recentCompletions = new Map();
    }
    async handle(payload: any): Promise<any> {
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId)
            throw new PaperclipHeartbeatError('Paperclip heartbeat 缺少运行或岗位标识。');
        if (!issueId)
            return { accepted: true, skipped: true, reason: '当前 heartbeat 没有分配任务。' };
        const nowMs: any = this.now().getTime();
        for (const [completedIssueId, completion] of this.recentCompletions) {
            if (completion.expiresAt <= nowMs)
                this.recentCompletions.delete(completedIssueId);
        }
        const recent: any = this.recentCompletions.get(issueId);
        if (recent?.agentId === agentId) {
            return {
                accepted: true,
                skipped: true,
                issueId,
                reason: '任务刚刚已由同一控制器完成，不重复执行。',
            };
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.executeIssue({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            const result: any = await execution;
            if (result?.accepted && !result?.skipped) {
                this.recentCompletions.set(issueId, {
                    agentId,
                    expiresAt: this.now().getTime() + COMPLETED_HEALTH_REPLAY_WINDOW_MS,
                });
            }
            return result;
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async executeIssue({ issueId, runId, agentId }: any): Promise<any> {
        const assignment: any = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: 'operations-health-controller',
        });
        const current: any = assignment.issue;
        const contractText: any = `${String(current.title || '')}\n${String(current.description || '')}`;
        if (!contractText.includes('[agent-army:operations-health:routine]')) {
            throw new PaperclipHeartbeatError('本机健康控制器只接受本机健康巡检 Routine。');
        }
        if (current.status === 'done')
            return { accepted: true, skipped: true, issueId, reason: '任务已完成，不重复执行。' };
        const task: Record<string, any> = {
            taskId: issueId,
            input: { title: 'Paperclip 指派的本机健康检查' },
            execution: { executor: 'paperclip-http-adapter', paperclipRunId: runId, paperclipAgentId: agentId, startedAt: this.now().toISOString() }
        };
        try {
            const result: any = await this.operator.execute(task);
            const healthReport: any = result.artifactRefs?.find((item: any): any => item.type === 'health_report')?.data;
            const health: any = healthReport?.overall === 'healthy' ? 'healthy' : 'degraded';
            const transition: any = this.healthTransitionState?.observe
                ? await this.healthTransitionState.observe({
                    status: health,
                    checkedAt: String(healthReport?.checkedAt || this.now().toISOString()),
                })
                : { previous: 'unknown', current: health, changed: true, enteredDegraded: health === 'degraded' };
            const incident: any = transition.enteredDegraded && typeof this.incidentDispatcher === 'function'
                ? await this.incidentDispatcher({
                    sourceIssueId: issueId,
                    sourceRunId: runId,
                    checkedAt: String(healthReport?.checkedAt || this.now().toISOString()),
                    report: healthReport,
                })
                : null;
            await this.governance.completePaperclipIssue(issueId, {
                runId,
                agentId,
                result,
                hideFromDashboard: health === 'healthy',
            });
            return {
                accepted: true,
                issueId,
                stage: result.currentStage,
                status: result.status,
                health,
                incident,
            };
        }
        catch (error: any) {
            await this.governance.failPaperclipIssue(issueId, { runId, agentId, error }).catch((): any => undefined);
            throw error;
        }
    }
}
export class PaperclipCampaignDailyHandler {
    campaignActivator: any;
    governance: any;
    inFlightIssues: any;
    now: any;
    constructor({ governance, campaignActivator, now = (): any => new Date() }: any = {}) {
        this.governance = governance;
        this.campaignActivator = campaignActivator;
        this.now = now;
        this.inFlightIssues = new Map();
    }
    async handle(payload: any): Promise<any> {
        assertNoDailySelectionParameters(payload);
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipHeartbeatError('M5 每日 HTTP heartbeat 缺少运行、控制器或任务标识。');
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.executeIssue({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            return await execution;
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async executeIssue({ issueId, runId, agentId }: any): Promise<any> {
        if (typeof this.campaignActivator !== 'function') {
            throw new PaperclipHeartbeatError('M5 每日 HTTP heartbeat 缺少确定性活动执行器。');
        }
        if (typeof this.governance?.verifySystemAssignment !== 'function') {
            throw new PaperclipHeartbeatError('M5 每日入口缺少 Paperclip 运行身份核验。');
        }
        const { issue } = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: 'm5-daily-controller',
        });
        if (issue.status === 'done') {
            return { accepted: true, skipped: true, issueId, reason: '当日入口任务已完成，不重复执行。' };
        }
        if (!String(issue.description || '').includes('[agent-army:m5:routine:m5-daily-campaign]')) {
            throw new PaperclipHeartbeatError('HTTP 控制器只接受 M5 每日 Routine 的固定任务。');
        }
        try {
            const activatedAt: any = this.now().toISOString();
            const activation: any = await this.campaignActivator();
            const result: Record<string, any> = {
                status: 'succeeded',
                currentStage: activation.activated ? 'campaign_day_activated' : 'campaign_day_already_active',
                execution: {
                    executor: 'm5-daily-http-controller',
                    mode: 'paperclip_daily_case_activation',
                    paperclipRunId: runId,
                    paperclipAgentId: agentId,
                    startedAt: activatedAt,
                    finishedAt: activatedAt,
                    outcome: activation.activated ? 'activated' : 'idempotent_replay',
                },
                artifactRefs: [{
                        artifactId: `campaign-daily-activation:${issueId}`,
                        taskId: issueId,
                        type: 'campaign_daily_activation',
                        title: 'M5 当日内容 Case 激活结果',
                        location: `paperclip://${issueId}/campaign-daily-activation`,
                        mimeType: 'application/json',
                        accessScope: 'local-owner',
                        validation: {
                            exists: true,
                            readable: true,
                            nonEmpty: true,
                            deterministic: true,
                            externalSideEffects: false,
                        },
                        createdAt: activatedAt,
                        data: activation,
                    }],
            };
            await this.governance.completePaperclipIssue(issueId, { runId, agentId, result });
            return {
                accepted: true,
                issueId,
                stage: result.currentStage,
                status: result.status,
                activation,
            };
        }
        catch (error: any) {
            await this.governance.failPaperclipIssue(issueId, { runId, agentId, error }).catch((): any => undefined);
            throw error;
        }
    }
}
export class PaperclipParallelWorkHandler {
    governance: any;
    inFlightIssues: any;
    now: any;
    reconcileParallelWork: any;
    constructor({ governance, reconcileParallelWork, now = (): any => new Date() }: any = {}) {
        this.governance = governance;
        this.reconcileParallelWork = reconcileParallelWork;
        this.now = now;
        this.inFlightIssues = new Map();
    }
    async handle(payload: any): Promise<any> {
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipHeartbeatError('M5 并行控制器 heartbeat 缺少运行、控制器或任务标识。');
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
                    routineKey: 'm5-parallel-join',
                    systemRole: 'm5-parallel-controller',
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
        if (typeof this.reconcileParallelWork !== 'function') {
            throw new PaperclipHeartbeatError('M5 并行控制器缺少确定性协调器。');
        }
        const { issue } = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: 'm5-parallel-controller',
        });
        if (issue.status === 'done') {
            return { accepted: true, skipped: true, issueId, reason: '并行门禁任务已完成。' };
        }
        const text: any = `${String(issue.title || '')}\n${String(issue.description || '')}`;
        if (!text.includes('[agent-army:m5:routine:m5-parallel-join]')) {
            throw new PaperclipHeartbeatError('并行控制器只接受 m5-parallel-join Routine。');
        }
        const caseId: any = text.match(/当前 Case 为 ([0-9a-f-]{8,80})/i)?.[1] || '';
        if (!caseId)
            throw new PaperclipHeartbeatError('并行门禁任务缺少可信日期 Case。');
        if (typeof this.governance.assertCaseIssueLink !== 'function') {
            throw new PaperclipHeartbeatError('并行控制器缺少 Paperclip Case/Issue 绑定核验。');
        }
        await this.governance.assertCaseIssueLink(caseId, issueId);
        await consumeM5SystemControllerPlanRevision({
            governance: this.governance,
            pipelineCaseId: caseId,
            runId,
            routineKey: 'm5-parallel-join',
            systemRole: 'm5-parallel-controller',
        });
        try {
            const result: any = await this.reconcileParallelWork(caseId);
            const completedAt: any = this.now().toISOString();
            if (!result.joined && result.dayCase?.stageKey === 'parallel_join_gate') {
                return { accepted: true, issueId, joined: false, waiting: true, result };
            }
            await this.governance.completePaperclipIssue(issueId, {
                runId,
                agentId,
                result: {
                    status: 'succeeded',
                    currentStage: result.joined ? 'parallel_join_completed' : 'parallel_join_waiting',
                    execution: {
                        owner: 'm5-parallel-controller',
                        outcome: result.joined ? 'joined' : 'waiting',
                        finishedAt: completedAt,
                    },
                    artifactRefs: [{
                            type: 'parallel_work_observation',
                            validation: { exists: true, readable: true, nonEmpty: true },
                            data: {
                                dayCaseId: caseId,
                                joined: result.joined,
                                dispatched: result.dispatched,
                                waiting: result.waiting,
                            },
                        }],
                },
            });
            return { accepted: true, issueId, joined: result.joined, result };
        }
        catch (error: any) {
            throw markM5SystemControllerFailure(error);
        }
    }
}
export function createOperationsHealthIncidentDispatcher({ tasks }: any = {}): any {
    if (typeof tasks?.create !== 'function') {
        throw new PaperclipHeartbeatError('运维事故派发器缺少任务服务。');
    }
    return async ({ sourceIssueId, sourceRunId, checkedAt, report }: any = {}): Promise<any> => {
        const unhealthyComponents: any = (Array.isArray(report?.components) ? report.components : [])
            .filter((item: any): any => item?.status !== 'healthy')
            .map((item: any): any => ({
            componentId: String(item?.id || 'unknown').slice(0, 80),
            name: String(item?.name || item?.id || '未知组件').slice(0, 120),
            status: String(item?.status || 'degraded').slice(0, 40),
            errorCode: String(item?.evidence?.errorCode || 'health_degraded').slice(0, 120),
        }))
            .sort((left: any, right: any): any => left.componentId.localeCompare(right.componentId));
        if (unhealthyComponents.length === 0) {
            throw new PaperclipHeartbeatError('健康报告未包含可派发的异常组件。');
        }
        const safeCheckedAt: any = validIsoDate(checkedAt) || new Date().toISOString();
        const day: any = shanghaiDate(safeCheckedAt);
        const signature: any = unhealthyComponents
            .map((item: any): any => `${safeKeyPart(item.componentId)}:${safeKeyPart(item.status)}:${safeKeyPart(item.errorCode)}`)
            .join('|');
        const summary: any = unhealthyComponents
            .map((item: any): any => `${item.name}(${item.errorCode})`)
            .join('、');
        return tasks.create({
            title: `本机巡检发现异常：${unhealthyComponents.map((item: any): any => item.name).join('、')}`,
            description: `确定性本机巡检发现 ${summary}。请只依据已登记的健康证据判断影响和安全恢复边界；不得读取凭据、登录、扩权或执行未登记命令。`,
            taskType: 'operations.incident-response',
            agentId: 'operator',
            idempotencyKey: `operations-health-incident:${day}:${signature}`,
            source: {
                channel: 'paperclip-health-controller',
                paperclipIssueId: String(sourceIssueId || '').slice(0, 120),
                paperclipRunId: String(sourceRunId || '').slice(0, 120),
            },
            context: {
                healthIncident: {
                    checkedAt: safeCheckedAt,
                    overall: 'degraded',
                    unhealthyComponents,
                    sourceIssueId: String(sourceIssueId || '').slice(0, 120),
                    sourceRunId: String(sourceRunId || '').slice(0, 120),
                },
            },
        });
    };
}
export class PaperclipHeartbeatError extends Error {
}
function validIsoDate(value: any): any {
    const parsed: any = new Date(String(value || ''));
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}
function shanghaiDate(value: any): any {
    const parts: any = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(value));
    const byType: any = Object.fromEntries(parts.map((part: any): any => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}
function safeKeyPart(value: any): any {
    return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'unknown';
}
function assertNoDailySelectionParameters(payload: any): any {
    const denied: any = new Set(['campaignId', 'scheduledDate', 'caseId', 'platform', 'contentVersion']);
    const queue: any[] = [payload];
    while (queue.length) {
        const value: any = queue.pop();
        if (!value || typeof value !== 'object')
            continue;
        for (const [key, child] of Object.entries(value)) {
            if (denied.has(key)) {
                throw new PaperclipHeartbeatError(`M5 每日 HTTP heartbeat 不接受调用方指定 ${key}。`);
            }
            if (child && typeof child === 'object')
                queue.push(child);
        }
    }
}
