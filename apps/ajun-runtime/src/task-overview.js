import { reconcileUsageBilling, summarizeTaskUsage } from './task-usage.js';
import { presentTask } from './task-presentation.js';
import { isRoutineHealthTask } from './task-record-query.js';
import { privateReadGrantStatus } from './private-read-grant.js';
import { evaluateHermesCostPolicy } from './hermes-cost-policy.js';
import { evaluateWorkflowTasks } from './workflow/evaluation.ts';
import { agentCapabilityTruth } from './workflow/capability-truth.ts';
import { buildTaskValidationOverview } from './task-validation-overview.ts';
import { buildCapabilities } from './task-capability-overview.ts';
export class TaskOverview {
  constructor({
    registry,
    store,
    governance = null,
    executors = {},
    capabilityCatalog,
    skillExecutionRegistry,
    localAiCapabilityStatus = null,
    usageLedger = null,
    taskDetailBaseUrl = '',
    getFeishuChannelStatus = () => null,
    getAgentChannelStates = () => null,
    getWorkerStatus = () => null,
  }) {
    this.registry = registry;
    this.store = store;
    this.governance = governance;
    this.executors = executors;
    this.capabilityCatalog = capabilityCatalog;
    this.skillExecutionRegistry = skillExecutionRegistry;
    this.localAiCapabilityStatus = localAiCapabilityStatus;
    this.usageLedger = usageLedger;
    this.taskDetailBaseUrl = taskDetailBaseUrl;
    this.getFeishuChannelStatus = getFeishuChannelStatus;
    this.getAgentChannelStates = getAgentChannelStates;
    this.getWorkerStatus = getWorkerStatus;
  }

  async read({ includeTasks = true } = {}) {
    const [agents, manager, tasks, approvals, governance, skillReadiness, localAi] = await Promise.all([
      this.registry.list(),
      this.registry.get('ajun'),
      this.store.list(),
      this.store.listApprovals(),
      this.governance?.health() || { status:'planned', version:null },
      this.skillExecutionRegistry.overview(),
      this.localAiCapabilityStatus?.() || null,
    ]);
    const runtimeHealth = await executorRuntimeHealth(this.executors);
    const feishuChannel = channelCapability(this.getFeishuChannelStatus());
    const agentChannels = safeAgentChannelStates(this.getAgentChannelStates());
    const worker = safeWorkerStatus(this.getWorkerStatus(), tasks);
    const visibleAgents = agents.map((agent) => ({
      ...agent,
      capabilityTruth:agentCapabilityTruth({
        agent,
        tasks,
        runtimeHealth:runtimeHealth[agent.agentId],
        channel:agentChannels[agent.agentId],
      }),
      ...(runtimeHealth[agent.agentId] ? { runtimeHealth:runtimeHealth[agent.agentId] } : {}),
      ...(agent.interaction?.directFeishu !== 'disabled' && agentChannels[agent.agentId]
        ? { feishuChannel:withFeishuTaskEvidence(agentChannels[agent.agentId], agent.agentId, tasks) }
        : {}),
    }));
    const present = (task) => ({
      ...task,
      presentation:presentTask(task, { approvals, detailBaseUrl:this.taskDetailBaseUrl }),
    });
    const capabilities = buildCapabilities({
      governance,
      feishuChannel,
      worker,
      localAi,
      skillReadiness,
      runtimeHealth,
      tasks,
      approvals,
    });
    const taskValidation = await buildTaskValidationOverview({ tasks, approvals, store:this.store, capabilityCatalog:this.capabilityCatalog });
    return {
      agents:visibleAgents,
      alwaysOnAgents:[
        ...(manager ? [manager] : []),
        ...visibleAgents.filter((agent) => agent.interaction?.directFeishu !== 'disabled'),
      ],
      onDemandAgents:visibleAgents.filter((agent) => agent.interaction?.directFeishu === 'disabled'),
      ...(includeTasks ? {
        tasks:tasks.map(present),
        approvals:approvals.map((approval) => ({
          ...approval,
          ...(approval.privateReadGrant ? { privateReadGrantStatus:privateReadGrantStatus(approval.privateReadGrant) } : {}),
        })),
      } : {}),
      recentTasks:tasks.filter(isRecentConsoleTask).slice(0, 3).map(present),
      workflows:evaluateWorkflowTasks(tasks),
      skillReadiness,
      ...taskValidation,
      usage:summarizeTaskUsage(tasks, { since:startOfToday() }),
      billing:this.billing(tasks, [...agents, ...(manager ? [manager] : [])], startOfRecentDays(7)),
      capabilities,
    };
  }
  async usage() {
    const tasks = await this.store.list();
    const since = startOfToday();
    return {
      ...summarizeTaskUsage(tasks, { since }),
      billing:this.billing(tasks, await this.registry.list(), since),
    };
  }

  billing(tasks, agents, since) {
    if (!this.usageLedger?.summarize) {
      const billing = reconcileUsageBilling(tasks, null, { since });
      return { ...billing, health:evaluateHermesCostPolicy(billing) };
    }
    const agentIds = (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent.executionOwner === 'paperclip-hermes')
      .map((agent) => agent.agentId);
    const billing = reconcileUsageBilling(tasks, this.usageLedger.summarize({ since, agentIds }), { since });
    return { ...billing, health:evaluateHermesCostPolicy(billing) };
  }
}
function isRecentConsoleTask(task) {
  if (isRoutineHealthTask(task)) return false;
  const channels = [task?.source?.channel, task?.source?.originChannel].map((value) => String(value || '').trim());
  return channels.some((channel) => ['feishu', 'local-ui', 'hermes-native'].includes(channel));
}

function safeAgentChannelStates(source) {
  try {
    const states = typeof source === 'function' ? source() : source;
    return Object.fromEntries(Object.entries(states || {}).flatMap(([agentId, state]) => {
      const status = String(state?.status || '').trim();
      const message = String(state?.message || '').trim();
      return status && message ? [[agentId, { status, message }]] : [];
    }));
  } catch { return {}; }
}

function safeWorkerStatus(source, tasks) {
  try {
    const value = typeof source === 'function' ? source(tasks) : source;
    const status = String(value?.status || '').trim();
    const detail = String(value?.detail || '').trim();
    return status && detail ? { status, detail } : { status:'local', detail:'当前由本机直接承接需要 Mac 的工作。' };
  } catch {
    return { status:'degraded', detail:'暂时无法读取 Mac工作间连接状态；任务事实不受影响。' };
  }
}

function withFeishuTaskEvidence(channel, agentId, tasks) {
  const verified = ['connected', 'external'].includes(channel.status) && (tasks || []).some((task) => task.source?.channel === 'feishu'
    && task.source?.targetAgentId === agentId
    && ['succeeded', 'failed', 'waiting_test', 'cancelled'].includes(task.status));
  return verified ? { ...channel, verified:true } : channel;
}

function channelCapability(source) {
  const state = typeof source === 'function' ? source() : source;
  if (state?.status === 'external') return { status:'ready', detail:state.message || 'A君飞书入口已由 Hermes 原生 Gateway 承载；会话、上下文与 MCP 工具链已接通。' };
  if (state?.status === 'connected') return { status:'ready', detail:'官方飞书入口已连接；消息、审批卡会回到原聊天，现有 A君入口仍可保留。' };
  if (state?.status === 'delivery_uncertain') return { status:'partial', detail:state.message || '飞书投递结果不确定；任务事实已保留，可安全重试跟进。' };
  if (state?.status === 'connecting') return { status:'partial', detail:'官方飞书入口正在连接；现有 A君入口仍可用。' };
  if (state?.status === 'failed') return { status:'partial', detail:'官方飞书入口本次没有连上；现有 A君入口不受影响，问题已记录等待处理。' };
  return { status:'partial', detail:'A君私聊与审批卡已可用；官方收发入口已装好并默认关闭，待限定允许人员后接入官方通道并做真实飞书回归。' };
}

async function executorRuntimeHealth(executors) {
  const entries = await Promise.all(Object.entries(executors || {}).map(async ([agentId, executor]) => {
    if (typeof executor?.health !== 'function') return null;
    try {
      const value = await executor.health();
      return [agentId, {
        status:['healthy', 'degraded', 'unavailable'].includes(value?.status) ? value.status : 'unavailable',
        checkedAt:String(value?.checkedAt || ''),
        requiredDatabases:{
          contact:value?.requiredDatabases?.contact === true,
          session:value?.requiredDatabases?.session === true,
          message:value?.requiredDatabases?.message === true,
        },
        safeMessage:String(value?.safeMessage || '本机执行器健康状态未知。').replace(/\s+/g, ' ').trim().slice(0, 300),
      }];
    } catch {
      return [agentId, {
        status:'unavailable',
        checkedAt:'',
        requiredDatabases:{ contact:false, session:false, message:false },
        safeMessage:'本机执行器健康检查失败，请由运维官检查。',
      }];
    }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfRecentDays(days) {
  const start = startOfToday();
  start.setDate(start.getDate() - Math.max(0, Number(days || 1) - 1));
  return start;
}
