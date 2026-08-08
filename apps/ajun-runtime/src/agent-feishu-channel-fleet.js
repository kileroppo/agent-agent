import { OfficialFeishuChannelRunner } from './official-feishu-channel-runner.js';

export class AgentFeishuChannelFleet {
  constructor({ store, bridge, createChannel, taskStatus, completionWatchStoreFactory, completionWatcherFactory, enabled = true, externalAgentIds = [], logger = console, runnerFactory = (input) => new OfficialFeishuChannelRunner(input) } = {}) {
    this.store = store; this.bridge = bridge; this.createChannel = createChannel; this.taskStatus = taskStatus;
    this.completionWatchStoreFactory = completionWatchStoreFactory; this.completionWatcherFactory = completionWatcherFactory;
    this.enabled = enabled === true;
    this.externalAgentIds = new Set(safeAgentIds(externalAgentIds));
    this.logger = logger; this.runnerFactory = runnerFactory; this.runners = new Map(); this.states = new Map();
  }

  async start({ skipAgentIds = [] } = {}) {
    const skip = new Set(skipAgentIds);
    const apps = await this.store.listApps();
    await Promise.all(apps
      .filter((app) => !skip.has(app.agentId) || this.externalAgentIds.has(app.agentId))
      .map((app) => this.startApp(app)));
    return this.snapshot();
  }

  async startApp(app) {
    const previous = this.runners.get(app.agentId);
    if (previous?.stop) {
      try { await previous.stop(); }
      catch { /* 新配置仍可尝试接管；最终状态以新连接结果为准。 */ }
      this.runners.delete(app.agentId);
    }
    if (this.externalAgentIds.has(app.agentId)) {
      return this.remember(app.agentId, {
        status:'external',
        message:'该员工飞书入口已交由其独立 Hermes Profile Gateway 接管。'
      });
    }
    if (!this.enabled) {
      return this.remember(app.agentId, {
        status:'standby',
        message:'当前由另一运行环境接管员工飞书入口；本机不会建立重复长连接。'
      });
    }
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
  snapshot() {
    return Object.fromEntries([...this.states].map(([agentId, state]) => {
      const live = this.runners.get(agentId)?.snapshot?.();
      return [agentId, live?.status === 'delivery_uncertain' ? { ...live, agentId } : state];
    }));
  }
  remember(agentId, state) { this.states.set(agentId, { ...state, agentId }); return this.states.get(agentId); }
}

export function employeeFeishuChannelsEnabled({ deploymentMode = 'local', owner = 'local' } = {}) {
  const normalizedMode = String(deploymentMode || '').trim().toLowerCase();
  const normalizedOwner = String(owner || '').trim().toLowerCase();
  return ['local', 'cloud'].includes(normalizedMode)
    && ['local', 'cloud'].includes(normalizedOwner)
    && normalizedMode === normalizedOwner;
}

export function agentChannelOptions(app, appSecret) {
  return {
    appId:app.appId, appSecret, transport:'websocket', source:`agent-army-${app.agentId}`,
    policy:{ requireMention:true, dmMode:'allowlist', dmAllowlist:app.allowedUserIds, groupAllowlist:app.allowedGroupIds, respondToMentionAll:false, botLoopGuard:true },
    safety:{ dedup:{ ttl:10 * 60 * 1000, maxEntries:2000 }, chatQueue:{ enabled:true, mergeWhileBusy:false }, staleMessageWindowMs:5 * 60 * 1000 }
  };
}

export function feishuChannelStartupPlan({ apps = [], legacyAJunEnabled = false, hermesNativeAJunEnabled = false, hermesNativeEmployeeIds = [] } = {}) {
  const employeeIds = safeAgentIds(hermesNativeEmployeeIds).filter((agentId) => agentId !== 'ajun');
  if (hermesNativeAJunEnabled) {
    return {
      startLegacyAJun:false,
      skipAgentIds:[...new Set(['ajun', ...employeeIds])],
      ajunOwner:'hermes-native'
    };
  }
  const hasDedicatedAJun = apps.some((app) => app?.agentId === 'ajun' && app?.enabled !== false);
  return {
    startLegacyAJun: Boolean(legacyAJunEnabled && !hasDedicatedAJun),
    skipAgentIds: legacyAJunEnabled && !hasDedicatedAJun ? [...new Set(['ajun', ...employeeIds])] : employeeIds,
    ajunOwner:hasDedicatedAJun ? 'dedicated-app' : legacyAJunEnabled ? 'legacy-channel' : 'none'
  };
}

function safeError(error) { return String(error?.message || '未知问题').replace(/[\r\n]/g, ' ').slice(0, 180); }
function safeAgentIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((item) => String(item || '').trim()).filter((item) => /^[a-z][a-z0-9-]{0,63}$/.test(item)))];
}
