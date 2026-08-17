import { agentCapabilityTruth } from './workflow/capability-truth.ts';
import { isTaskExecutionClosedStatus } from './task-status-policy.ts';

/** Reads volatile executor/channel state and projects it onto registered agents. */
export class TaskOverviewRuntimeProjection {
    executors: any;
    getAgentChannelStates: any;
    getFeishuChannelStatus: any;
    getWorkerStatus: any;
    constructor({ executors = {}, getFeishuChannelStatus, getAgentChannelStates, getWorkerStatus }: any) {
        this.executors = executors;
        this.getFeishuChannelStatus = getFeishuChannelStatus;
        this.getAgentChannelStates = getAgentChannelStates;
        this.getWorkerStatus = getWorkerStatus;
    }
    async read(agents: any[], tasks: any[]): Promise<any> {
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
        return { runtimeHealth, feishuChannel, worker, visibleAgents };
    }
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
        return {
            status: 'partial',
            detail:state.message || (state.failedDeliveries
                ? '飞书投递明确失败；任务事实已保留，需显式恢复交付。'
                : '飞书投递结果不确定；任务事实已保留，必须先核对再决定是否恢复。'),
        };
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
