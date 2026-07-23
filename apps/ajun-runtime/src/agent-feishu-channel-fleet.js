import { OfficialFeishuChannelRunner } from './official-feishu-channel-runner.js';

export class AgentFeishuChannelFleet {
  constructor({ store, bridge, createChannel, taskStatus, completionWatchStoreFactory, completionWatcherFactory, logger = console, runnerFactory = (input) => new OfficialFeishuChannelRunner(input) } = {}) {
    this.store = store; this.bridge = bridge; this.createChannel = createChannel; this.taskStatus = taskStatus;
    this.completionWatchStoreFactory = completionWatchStoreFactory; this.completionWatcherFactory = completionWatcherFactory;
    this.logger = logger; this.runnerFactory = runnerFactory; this.runners = new Map(); this.states = new Map();
  }

  async start({ skipAgentIds = [] } = {}) {
    const skip = new Set(skipAgentIds);
    const apps = await this.store.listApps();
    await Promise.all(apps.filter((app) => !skip.has(app.agentId)).map((app) => this.startApp(app)));
    return this.snapshot();
  }

  async startApp(app) {
    const secret = await this.store.getSecret(app.agentId);
    if (!secret) return this.remember(app.agentId, { status:'disabled', message:'缺少本机密钥；未连接该飞书智能体应用。' });
    const runner = this.runnerFactory({
      bridge:this.bridge, createChannel:this.createChannel, taskStatus:this.taskStatus,
      completionWatchStore:this.completionWatchStoreFactory?.(app.agentId), completionWatcherFactory:this.completionWatcherFactory,
      logger:this.logger, targetAgentId:app.agentId, channelOptions:agentChannelOptions(app, secret)
    });
    this.runners.set(app.agentId, runner);
    try { return this.remember(app.agentId, await runner.start()); }
    catch (error) { return this.remember(app.agentId, { status:'failed', message:`飞书智能体应用未连接：${safeError(error)}` }); }
  }

  async stop() { await Promise.all([...this.runners.values()].map((runner) => runner.stop())); this.runners.clear(); }
  snapshot() { return Object.fromEntries(this.states); }
  remember(agentId, state) { this.states.set(agentId, { ...state, agentId }); return this.states.get(agentId); }
}

export function agentChannelOptions(app, appSecret) {
  return {
    appId:app.appId, appSecret, transport:'websocket', source:`agent-army-${app.agentId}`,
    policy:{ requireMention:true, dmMode:'allowlist', dmAllowlist:app.allowedUserIds, groupAllowlist:app.allowedGroupIds, respondToMentionAll:false, botLoopGuard:true },
    safety:{ dedup:{ ttl:10 * 60 * 1000, maxEntries:2000 }, chatQueue:{ enabled:true, mergeWhileBusy:false }, staleMessageWindowMs:5 * 60 * 1000 }
  };
}

export function feishuChannelStartupPlan({ apps = [], legacyAJunEnabled = false } = {}) {
  const hasDedicatedAJun = apps.some((app) => app?.agentId === 'ajun' && app?.enabled !== false);
  return {
    startLegacyAJun: Boolean(legacyAJunEnabled && !hasDedicatedAJun),
    skipAgentIds: legacyAJunEnabled && !hasDedicatedAJun ? ['ajun'] : []
  };
}

function safeError(error) { return String(error?.message || '未知问题').replace(/[\r\n]/g, ' ').slice(0, 180); }
