import { reconcileUsageBilling, summarizeTaskUsage } from './task-usage.ts';
import { presentTask } from './task-presentation.ts';
import { isRoutineHealthTask } from './task-record-query.ts';
import { privateReadGrantStatus } from './private-read-grant.ts';
import { evaluateHermesCostPolicy } from './hermes-cost-policy.ts';
import { agentCapabilityTruth } from './workflow/capability-truth.ts';
import { buildTaskValidationOverview } from './task-validation-overview.ts';
import { buildCapabilities } from './task-capability-overview.ts';
import { isTaskExecutionClosedStatus } from './task-status-policy.ts';
import { ValidationError } from './task-validation-error.ts';
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
    executors: any;
    getAgentChannelStates: any;
    getFeishuChannelStatus: any;
    getWorkerStatus: any;
    governance: any;
    localAiCapabilityStatus: any;
    registry: any;
    skillExecutionRegistry: any;
    store: any;
    taskDetailBaseUrl: any;
    usageLedger: any;
    providerUsageLedger: any;
    constructor({ registry, store, governance = null, executors = {}, capabilityCatalog, skillExecutionRegistry, localAiCapabilityStatus = null, usageLedger = null, providerUsageLedger = null, taskDetailBaseUrl = '', getFeishuChannelStatus = (): any => null, getAgentChannelStates = (): any => null, getWorkerStatus = (): any => null, }: any) {
        this.registry = registry;
        this.store = store;
        this.governance = governance;
        this.executors = executors;
        this.capabilityCatalog = capabilityCatalog;
        this.skillExecutionRegistry = skillExecutionRegistry;
        this.localAiCapabilityStatus = localAiCapabilityStatus;
        this.usageLedger = usageLedger;
        this.providerUsageLedger = providerUsageLedger;
        this.taskDetailBaseUrl = taskDetailBaseUrl;
        this.getFeishuChannelStatus = getFeishuChannelStatus;
        this.getAgentChannelStates = getAgentChannelStates;
        this.getWorkerStatus = getWorkerStatus;
    }
    async read({ includeTasks = true }: any = {}): Promise<any> {
        const [agents, manager, tasks, approvals, governance, skillReadiness, localAi] = await Promise.all([
            this.registry.list(),
            this.registry.get('ajun'),
            this.store.list(),
            this.store.listApprovals(),
            this.governance?.health() || { status: 'planned', version: null },
            this.skillExecutionRegistry.overview(),
            this.localAiCapabilityStatus?.() || null,
        ]);
        const runtimeHealth: any = await executorRuntimeHealth(this.executors);
        const feishuChannel: any = channelCapability(this.getFeishuChannelStatus());
        const agentChannels: any = safeAgentChannelStates(this.getAgentChannelStates());
        const worker: any = safeWorkerStatus(this.getWorkerStatus(), tasks);
        const visibleAgents: any = agents.map((agent: any): any => ({
            ...agent,
            capabilityTruth: agentCapabilityTruth({
                agent,
                tasks,
                runtimeHealth: runtimeHealth[agent.agentId],
                channel: agentChannels[agent.agentId],
            }),
            ...(runtimeHealth[agent.agentId] ? { runtimeHealth: runtimeHealth[agent.agentId] } : {}),
            ...(agent.interaction?.directFeishu !== 'disabled' && agentChannels[agent.agentId]
                ? { feishuChannel: withFeishuTaskEvidence(agentChannels[agent.agentId], agent.agentId, tasks) }
                : {}),
        }));
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
        const taskValidation: any = await buildTaskValidationOverview({ tasks, approvals, store: this.store, capabilityCatalog: this.capabilityCatalog });
        return {
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
            usage: summarizeTaskUsage(tasks, { since: startOfToday() }),
            billing: this.billing(tasks, [...agents, ...(manager ? [manager] : [])], startOfRecentDays(7)),
            capabilities,
        };
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
function safeAgentChannelStates(source: any): any {
    try {
        const states: any = typeof source === 'function' ? source() : source;
        return Object.fromEntries(Object.entries(states || {}).flatMap(([agentId, state]: any): any => {
            const status: any = String(state?.status || '').trim();
            const message: any = String(state?.message || '').trim();
            return status && message ? [[agentId, { status, message }]] : [];
        }));
    }
    catch {
        return {};
    }
}
function safeWorkerStatus(source: any, tasks: any): any {
    try {
        const value: any = typeof source === 'function' ? source(tasks) : source;
        const status: any = String(value?.status || '').trim();
        const detail: any = String(value?.detail || '').trim();
        return status && detail ? { status, detail } : { status: 'local', detail: '当前由本机直接承接需要 Mac 的工作。' };
    }
    catch {
        return { status: 'degraded', detail: '暂时无法读取 Mac工作间连接状态；任务事实不受影响。' };
    }
}
function withFeishuTaskEvidence(channel: any, agentId: any, tasks: any): any {
    const verified: any = ['connected', 'external'].includes(channel.status) && (tasks || []).some((task: any): any => task.source?.channel === 'feishu'
        && task.source?.targetAgentId === agentId
        && isTaskExecutionClosedStatus(task.status));
    return verified ? { ...channel, verified: true } : channel;
}
function channelCapability(source: any): any {
    const state: any = typeof source === 'function' ? source() : source;
    if (state?.status === 'external')
        return { status: 'ready', detail: state.message || 'A君飞书入口已由 Hermes 原生 Gateway 承载；会话、上下文与 MCP 工具链已接通。' };
    if (state?.status === 'connected')
        return { status: 'ready', detail: '官方飞书入口已连接；消息、审批卡会回到原聊天，现有 A君入口仍可保留。' };
    if (state?.status === 'delivery_uncertain')
        return { status: 'partial', detail: state.message || '飞书投递结果不确定；任务事实已保留，可安全重试跟进。' };
    if (state?.status === 'connecting')
        return { status: 'partial', detail: '官方飞书入口正在连接；现有 A君入口仍可用。' };
    if (state?.status === 'failed')
        return { status: 'partial', detail: '官方飞书入口本次没有连上；现有 A君入口不受影响，问题已记录等待处理。' };
    return { status: 'partial', detail: 'A君私聊与审批卡已可用；官方收发入口已装好并默认关闭，待限定允许人员后接入官方通道并做真实飞书回归。' };
}
async function executorRuntimeHealth(executors: any): Promise<any> {
    const entries: any = await Promise.all(Object.entries(executors || {}).map(async ([agentId, executor]: any): Promise<any> => {
        if (typeof executor?.health !== 'function')
            return null;
        try {
            const value: any = await executor.health();
            return [agentId, {
                    status: ['healthy', 'degraded', 'unavailable'].includes(value?.status) ? value.status : 'unavailable',
                    checkedAt: String(value?.checkedAt || ''),
                    requiredDatabases: {
                        contact: value?.requiredDatabases?.contact === true,
                        session: value?.requiredDatabases?.session === true,
                        message: value?.requiredDatabases?.message === true,
                    },
                    safeMessage: String(value?.safeMessage || '本机执行器健康状态未知。').replace(/\s+/g, ' ').trim().slice(0, 300),
                }];
        }
        catch {
            return [agentId, {
                    status: 'unavailable',
                    checkedAt: '',
                    requiredDatabases: { contact: false, session: false, message: false },
                    safeMessage: '本机执行器健康检查失败，请由运维官检查。',
                }];
        }
    }));
    return Object.fromEntries(entries.filter(Boolean));
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
