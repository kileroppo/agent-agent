import { reconcileUsageBilling, summarizeTaskUsage } from './task-usage.js';
import { presentTask } from './task-presentation.js';
import { isRoutineHealthTask } from './task-record-query.js';
import { buildTaskFocus } from './task-overview-focus.js';
import { privateReadGrantStatus } from './private-read-grant.js';
import { evaluateHermesCostPolicy } from './hermes-cost-policy.js';
import { evaluateWorkflowTasks } from './workflow/evaluation.ts';
import { agentCapabilityTruth, capabilityTruthState } from './workflow/capability-truth.ts';
export class TaskOverview {
  constructor({
    registry,
    store,
    governance = null,
    executors = {},
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
      taskFocus:buildTaskFocus(tasks, approvals),
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
function buildCapabilities({ governance, feishuChannel, worker, localAi, skillReadiness, runtimeHealth, tasks, approvals }) {
  const hasVerifiedTask = (...types) => tasks.some((task) => types.includes(task.taskType)
    && task.status === 'succeeded'
    && (task.artifactRefs || []).some((artifact) => artifact.validation?.exists === true && artifact.validation?.readable === true));
  const truth = ({ configured = true, live = true, verified = false, humanAccepted = false } = {}) => capabilityTruthState({
    declared:true,
    configured,
    live,
    verified,
    humanAccepted,
  });
  const capabilities = [
    { id:'task-coordination', name:'统一任务协调', status:tasks.length ? 'ready' : 'partial', detail:tasks.length ? '任务创建和路由已有真实记录；具体业务完成仍以 Workflow 验证为准。' : '任务协调已配置，但尚无真实业务记录。', truth:truth({ verified:tasks.length > 0 }) },
    { id:'agent-registry', name:'岗位注册表', status:'partial', detail:'岗位职责、任务类型和权限来自 Manifest；登记本身不代表岗位已通过业务验收。', truth:truth({ live:true, verified:false }) },
    { id:'approval-gate', name:'审批闸门', status:approvals.length ? 'ready' : 'partial', detail:approvals.length ? '审批闸门已有真实决定记录；自动能力决策与人工审批分别留痕。' : '审批闸门已配置，尚无当前真实决定证据。', truth:truth({ verified:approvals.length > 0 }) },
    { id:'content-public-web-fetch', name:'公开资料读取', status:hasVerifiedTask('report.public-material', 'research.intel-report', 'research.open-investigation') ? 'ready' : 'partial', detail:'公开网页、动态页面和 PDF 通过受控 Adapter 读取；真实可用性以研究 Workflow 产物为准。', truth:truth({ verified:hasVerifiedTask('report.public-material', 'research.intel-report', 'research.open-investigation') }) },
    { id:'authorized-content-read', name:'登录平台只读采集', status:'partial', detail:'通道已接入；每个平台、账号和数据范围仍需通过具体任务验证并完成真实只读验收。', truth:truth({ live:false, verified:false }) },
    { id:'governance', name:'Paperclip 治理投影', status:governance.status, detail:governance.status === 'ready' ? `本机 Paperclip 已连接（${governance.version || '未知版本'}）；连接不替代具体预算和审批验收。` : 'Paperclip 未连接；组织级请求必须等待治理恢复。', truth:truth({ configured:true, live:governance.status === 'ready', verified:approvals.some((item) => item.governanceMode === 'paperclip' && item.status !== 'pending') }) },
    { id:'feishu-channel', name:'飞书收发与员工入口', status:feishuChannel.status, detail:feishuChannel.detail, truth:truth({ live:feishuChannel.status === 'ready', verified:tasks.some((task) => task.source?.channel === 'feishu') }) },
    { id:'mac-worker', name:'Mac工作间安全接力', status:worker.status, detail:worker.detail, truth:truth({ live:['ready', 'local'].includes(worker.status), verified:tasks.some((task) => task.execution?.mode === 'mac_worker' && task.status === 'succeeded') }) },
    ...(localAi ? [{
      id:'local-ai',
      name:'本机 AI 全能力网关',
      status:localAi.status === 'healthy' ? 'ready' : localAi.status === 'degraded' ? 'partial' : 'unavailable',
      detail:String(localAi.safeMessage || '本机 AI 网关状态未知。').slice(0, 300),
      truth:capabilityTruthState({
        declared:true,
        configured:Array.isArray(localAi.capabilities) && localAi.capabilities.some((item) => item.configured),
        live:localAi.status === 'healthy' || localAi.status === 'degraded',
        verified:Array.isArray(localAi.capabilities) && localAi.capabilities.some((item) => item.e2eVerified),
        humanAccepted:false,
      }),
    }] : []),
    { id:'external-execution', name:'外部发布与写入', status:'planned', detail:'外部发布和其他写入动作尚未接入且故意关闭；登录型只读采集不等于已经开放写入。', truth:capabilityTruthState({ declared:false, configured:false, live:false, verified:false, humanAccepted:false }) },
  ];
  const presentationSkill = skillReadiness.find((item) => item.slug === 'open-kimi-ppt');
  if (presentationSkill) {
    const composeStatus = presentationSkill.modes?.compose?.status || presentationSkill.status;
    const exportStatus = presentationSkill.modes?.export?.status || presentationSkill.status;
    capabilities.push({
      id:'office-presentation',
      name:'小办演示文稿',
      status:composeStatus === 'ready' && exportStatus === 'ready'
        ? 'ready'
        : composeStatus === 'ready' ? 'partial' : 'unavailable',
      detail:[
        `PPTD ${composeStatus === 'ready' ? '可用' : `不可用（${composeStatus}）`}`,
        `PPTX ${exportStatus === 'ready' ? '可用' : `暂不可用（${exportStatus}）`}`,
        presentationSkill.recovery,
      ].filter(Boolean).join('；').slice(0, 500),
      truth:truth({
        configured:composeStatus === 'ready',
        live:composeStatus === 'ready',
        verified:hasVerifiedTask('office.presentation-package'),
      }),
    });
  }
  const wechatHealth = runtimeHealth['wechat-chat-retriever'];
  if (wechatHealth) capabilities.push({
    id:'wechat-private-read',
    name:'微信本机只读',
    status:wechatHealth.status === 'healthy' ? 'ready' : wechatHealth.status === 'degraded' ? 'partial' : 'unavailable',
    detail:wechatHealth.safeMessage,
    truth:truth({
      configured:true,
      live:['healthy', 'degraded'].includes(wechatHealth.status),
      verified:hasVerifiedTask('wechat.chat.retrieval'),
    }),
  });
  return capabilities;
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
