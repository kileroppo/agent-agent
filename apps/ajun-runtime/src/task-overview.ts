import { reconcileUsageBilling, summarizeTaskUsage } from './task-usage.ts';
import { presentTask } from './task-presentation.ts';
import { isRoutineHealthTask } from './task-record-query.ts';
import { privateReadGrantStatus } from './private-read-grant.ts';
import { evaluateHermesCostPolicy } from './hermes-cost-policy.ts';
import { buildCapabilities } from './task-capability-overview.ts';
import { ValidationError } from './task-validation-error.ts';
import { consoleOverviewReadView } from './console-overview-read-model.ts';
import { buildConsoleHealthTruth, buildRuntimeHealth, reliabilityForCurrentRuntime } from './runtime-health.ts';
import { TaskOverviewRuntimeProjection } from './task-overview-runtime-projection.ts';
import { TaskOverviewSnapshotCache } from './task-overview-snapshot-cache.ts';
const MAX_USAGE_RANGE_MS: any = 366 * 24 * 60 * 60 * 1000;

export function parseUsageRange(url: any): any {
    const sinceValue: any = String(url?.searchParams?.get('since') || '').trim();
    const untilValue: any = String(url?.searchParams?.get('until') || '').trim();
    if (!sinceValue && !untilValue)
        return {};
    if (!sinceValue || !untilValue)
        throw new ValidationError('请选择完整的开始和结束日期。');
    const since: any = new Date(sinceValue);
    const until: any = new Date(untilValue);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
        throw new ValidationError('日期格式无效，请重新选择。');
    if (until <= since)
        throw new ValidationError('结束日期必须晚于开始日期。');
    if (until.getTime() - since.getTime() > MAX_USAGE_RANGE_MS)
        throw new ValidationError('一次最多查询 366 天。');
    return { since, until };
}
export class TaskOverview {
    capabilityCatalog: any;
    governance: any;
    localAiCapabilityStatus: any;
    registry: any;
    skillExecutionRegistry: any;
    store: any;
    taskDetailBaseUrl: any;
    usageLedger: any;
    providerUsageLedger: any;
    runtimeProjection: any;
    taskSnapshotCache: any;
    governanceHealthInFlight: any;
    getReliabilitySnapshot: any;
    getRuntimeIdentity: any;
    constructor({ registry, store, governance = null, executors = {}, capabilityCatalog, skillExecutionRegistry, localAiCapabilityStatus = null, usageLedger = null, providerUsageLedger = null, taskDetailBaseUrl = '', getFeishuChannelStatus = (): any => null, getAgentChannelStates = (): any => null, getWorkerStatus = (): any => null, getReliabilitySnapshot = null, getRuntimeIdentity = null, }: any) {
        this.registry = registry;
        this.store = store;
        this.governance = governance;
        this.capabilityCatalog = capabilityCatalog;
        this.skillExecutionRegistry = skillExecutionRegistry;
        this.localAiCapabilityStatus = localAiCapabilityStatus;
        this.usageLedger = usageLedger;
        this.providerUsageLedger = providerUsageLedger;
        this.taskDetailBaseUrl = taskDetailBaseUrl;
        this.getReliabilitySnapshot = getReliabilitySnapshot;
        this.getRuntimeIdentity = getRuntimeIdentity;
        this.taskSnapshotCache = new TaskOverviewSnapshotCache({
            store:this.store,
            capabilityCatalog:this.capabilityCatalog,
        });
        this.governanceHealthInFlight = null;
        this.runtimeProjection = new TaskOverviewRuntimeProjection({
            executors,
            getFeishuChannelStatus,
            getAgentChannelStates,
            getWorkerStatus,
        });
    }
    async read({ includeTasks = true, includeBilling = true, cacheTaskSnapshot = false }: any = {}): Promise<any> {
        const [agents, manager, taskSnapshot, governance, skillReadiness, localAi] = await Promise.all([
            this.registry.list(),
            this.registry.get('ajun'),
            this.taskSnapshotCache.read({ includeValidationCampaign: includeTasks, cache: cacheTaskSnapshot }),
            this.readGovernanceHealth(),
            this.skillExecutionRegistry.overview(),
            this.localAiCapabilityStatus?.() || null,
        ]);
        const { tasks, approvals, taskValidation, usage } = taskSnapshot;
        const { runtimeHealth, feishuChannel, worker, visibleAgents } = await this.runtimeProjection.read(agents, tasks);
        const present: any = (task: any): any => ({
            ...task,
            presentation: presentTask(task, { approvals, detailBaseUrl: this.taskDetailBaseUrl }),
        });
        const capabilities: any = buildCapabilities({
            governance,
            feishuChannel,
            worker,
            localAi,
            skillReadiness,
            runtimeHealth,
            tasks,
            approvals,
        });
        return {
            manager:manager || null,
            agents: visibleAgents,
            alwaysOnAgents: [
                ...(manager ? [manager] : []),
                ...visibleAgents.filter((agent: any): any => agent.interaction?.directFeishu !== 'disabled'),
            ],
            onDemandAgents: visibleAgents.filter((agent: any): any => agent.interaction?.directFeishu === 'disabled'),
            ...(includeTasks ? {
                tasks: tasks.map(present),
                approvals: approvals.map((approval: any): any => ({
                    ...approval,
                    ...(approval.privateReadGrant ? { privateReadGrantStatus: privateReadGrantStatus(approval.privateReadGrant) } : {}),
                })),
            } : {}),
            recentTasks: tasks.filter(isRecentConsoleTask).slice(0, 3).map(present),
            skillReadiness,
            ...taskValidation,
            usage,
            ...(includeBilling ? { billing: this.billing(tasks, [...agents, ...(manager ? [manager] : [])], startOfRecentDays(7)) } : {}),
            capabilities,
        };
    }
    async readConsole(): Promise<any> {
        const [overview, runtimeHealth, reliability] = await Promise.all([
            this.readConsoleSnapshot(),
            this.health(),
            this.readReliability(),
        ]);
        return consoleOverviewReadView({
            ...overview,
            health:buildConsoleHealthTruth({ runtimeHealth, reliability, taskFocus:overview.taskFocus }),
        });
    }
    async readConsoleSnapshot(): Promise<any> {
        // Snapshot cache 只保存任务派生数据；易变依赖仍由 read() 每次读取。
        return this.read({ includeTasks: false, includeBilling: false, cacheTaskSnapshot: true });
    }
    async health({ optionalModules = [] }: any = {}): Promise<any> {
        const governance = await this.readGovernanceHealth();
        return buildRuntimeHealth({
            core: [
                { id: 'runtime', name: 'A君运行台', status: 'healthy', detail: '核心 HTTP 运行时可响应。' },
                {
                    id: 'paperclip',
                    name: 'Paperclip 治理连接',
                    status: governance.status === 'ready' ? 'healthy' : governance.status === 'unavailable' ? 'unavailable' : 'degraded',
                    detail: governance.status === 'ready'
                        ? '治理连接可用。'
                        : '治理连接暂不可用；任务事实仍保留，请检查 Paperclip 服务。',
                },
            ],
            optional: optionalModules,
            // /api/health 是存活探针，不为员工人数读取完整注册表或任务账本。
            summary: { version: governance.version },
        });
    }
    async readGovernanceHealth(): Promise<any> {
        // 同一轮并发的 /api/health 和 /api/console-overview 共享一次 Paperclip 探测；
        // 结果不持久缓存，下一次请求仍重新探测。
        if (!this.governanceHealthInFlight) {
            const pending: any = safeGovernanceHealth(this.governance);
            this.governanceHealthInFlight = pending;
            pending.finally((): any => {
                if (this.governanceHealthInFlight === pending)
                    this.governanceHealthInFlight = null;
            });
        }
        return this.governanceHealthInFlight;
    }
    async readReliability(): Promise<any> {
        if (typeof this.getReliabilitySnapshot !== 'function' || typeof this.getRuntimeIdentity !== 'function')
            return null;
        try {
            const [snapshot, identity] = await Promise.all([
                this.getReliabilitySnapshot(),
                this.getRuntimeIdentity(),
            ]);
            return reliabilityForCurrentRuntime(snapshot, identity);
        }
        catch {
            return { status:'unknown', detail:'暂时无法读取当前版本的稳定性观测，不能显示为稳定。', observedAt:null };
        }
    }
    async usage({ since = startOfToday(), until = null }: any = {}): Promise<any> {
        const [tasks, agents, manager]: any = await Promise.all([
            this.store.list(),
            this.registry.list(),
            this.registry.get('ajun'),
        ]);
        return {
            ...summarizeTaskUsage(tasks, { since, until }),
            billing: this.billing(tasks, [...agents, ...(manager ? [manager] : [])], since, until),
        };
    }
    billing(tasks: any, agents: any, since: any, until: any = null): any {
        const providerSnapshot: any = this.providerSnapshot({ since, until });
        if (!this.usageLedger?.summarize) {
            const billing: any = reconcileUsageBilling(tasks, null, { since, until, providerSnapshot });
            return { ...billing, health: evaluateHermesCostPolicy(billing) };
        }
        const agentIds: any = (Array.isArray(agents) ? agents : [])
            .filter((agent: any): any => agent.executionOwner === 'paperclip-hermes')
            .map((agent: any): any => agent.agentId);
        const billing: any = reconcileUsageBilling(tasks, this.usageLedger.summarize({ since, until, agentIds }), { since, until, providerSnapshot });
        return { ...billing, health: evaluateHermesCostPolicy(billing) };
    }
    providerSnapshot({ since, until }: any): any {
        if (!this.providerUsageLedger?.summarize)
            return null;
        try {
            return this.providerUsageLedger.summarize({ since, until });
        }
        catch {
            return { status: 'invalid', source: 'provider_usage_ledger' };
        }
    }
}
function isRecentConsoleTask(task: any): any {
    if (isRoutineHealthTask(task))
        return false;
    const channels: any = [task?.source?.channel, task?.source?.originChannel].map((value: any): any => String(value || '').trim());
    return channels.some((channel: any): any => ['feishu', 'local-ui', 'hermes-native'].includes(channel));
}
function startOfToday(): any {
    const now: any = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
function startOfRecentDays(days: any): any {
    const start: any = startOfToday();
    start.setDate(start.getDate() - Math.max(0, Number(days || 1) - 1));
    return start;
}
async function safeGovernanceHealth(governance: any): Promise<any> {
    if (typeof governance?.health !== 'function')
        return { status: 'degraded', version: null };
    try {
        const value: any = await governance.health();
        return {
            status: String(value?.status || 'degraded'),
            version: String(value?.version || '').trim() || null,
        };
    }
    catch {
        return { status: 'unavailable', version: null };
    }
}
