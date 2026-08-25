export type ServiceHealthStatus = 'healthy' | 'degraded' | 'recovering' | 'offline';

export type ServiceProbeConfig = {
  key: string;
  name: string;
  url?: string;
  probeFn?: () => Promise<{ ok: boolean; latencyMs?: number; details?: any }>;
  restarter?: () => Promise<boolean>;
  maxRestartsPerWindow?: number;
  restartWindowMs?: number;
};

export type ServiceHealthState = {
  key: string;
  name: string;
  status: ServiceHealthStatus;
  consecutiveFailures: number;
  lastHealthyAt: string | null;
  lastProbedAt: string | null;
  lastLatencyMs?: number;
  restartHistory: number[];
  recovering: boolean;
};

export type CrossServiceHealthMeshOptions = {
  services?: ServiceProbeConfig[];
  onServiceRestored?: (serviceKey: string) => Promise<void> | void;
  onServiceDegraded?: (serviceKey: string, state: ServiceHealthState) => Promise<void> | void;
  now?: () => number;
  fetchFn?: typeof fetch;
};

const DEFAULT_RESTART_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RESTARTS = 3;

export class CrossServiceHealthMesh {
  private services = new Map<string, ServiceProbeConfig>();
  private states = new Map<string, ServiceHealthState>();
  private onServiceRestored?: (serviceKey: string) => Promise<void> | void;
  private onServiceDegraded?: (serviceKey: string, state: ServiceHealthState) => Promise<void> | void;
  private now: () => number;
  private fetchFn: typeof fetch;

  constructor(options: CrossServiceHealthMeshOptions = {}) {
    this.onServiceRestored = options.onServiceRestored;
    this.onServiceDegraded = options.onServiceDegraded;
    this.now = options.now ?? (() => Date.now());
    this.fetchFn = options.fetchFn ?? globalThis.fetch;

    for (const service of options.services || []) {
      this.registerService(service);
    }
  }

  registerService(config: ServiceProbeConfig) {
    if (!config?.key) return;
    this.services.set(config.key, config);
    if (!this.states.has(config.key)) {
      this.states.set(config.key, {
        key: config.key,
        name: config.name || config.key,
        status: 'healthy',
        consecutiveFailures: 0,
        lastHealthyAt: null,
        lastProbedAt: null,
        restartHistory: [],
        recovering: false,
      });
    }
  }

  getServiceState(key: string): ServiceHealthState | undefined {
    const s = this.states.get(key);
    return s ? { ...s, restartHistory: [...s.restartHistory] } : undefined;
  }

  getHealthMatrix(): Record<string, ServiceHealthState> {
    const matrix: Record<string, ServiceHealthState> = {};
    for (const [key, state] of this.states.entries()) {
      matrix[key] = { ...state, restartHistory: [...state.restartHistory] };
    }
    return Object.freeze(matrix);
  }

  async probeService(key: string, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<boolean> {
    const config = this.services.get(key);
    const state = this.states.get(key);
    if (!config || !state) return false;

    const currentTime = this.now();
    state.lastProbedAt = new Date(currentTime).toISOString();

    let probeOk = false;
    let latencyMs = 0;

    const started = this.now();
    try {
      if (typeof config.probeFn === 'function') {
        const res = await config.probeFn();
        probeOk = Boolean(res?.ok);
        latencyMs = res?.latencyMs ?? (this.now() - started);
      } else if (config.url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await this.fetchFn(config.url, { signal: controller.signal });
          probeOk = resp.ok;
        } finally {
          clearTimeout(timer);
        }
        latencyMs = this.now() - started;
      }
    } catch {
      probeOk = false;
      latencyMs = this.now() - started;
    }

    state.lastLatencyMs = latencyMs;
    const prevStatus = state.status;

    if (probeOk) {
      state.consecutiveFailures = 0;
      state.status = 'healthy';
      state.lastHealthyAt = new Date(currentTime).toISOString();
      state.recovering = false;

      if (prevStatus === 'degraded' || prevStatus === 'offline' || prevStatus === 'recovering') {
        try {
          await this.onServiceRestored?.(key);
        } catch {
          // Callback error swallowed
        }
      }
    } else {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= 3) {
        state.status = 'offline';
      } else {
        state.status = 'degraded';
      }

      if (prevStatus === 'healthy') {
        try {
          await this.onServiceDegraded?.(key, state);
        } catch {
          // Callback error swallowed
        }
      }

      // 触发受控自愈重启
      await this.attemptSelfHealing(key);
    }

    return probeOk;
  }

  async attemptSelfHealing(key: string): Promise<boolean> {
    const config = this.services.get(key);
    const state = this.states.get(key);
    if (!config || !state || typeof config.restarter !== 'function') return false;

    const currentTime = this.now();
    const windowMs = config.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    const maxRestarts = config.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS;

    // 清理窗口外的历史重启记录
    state.restartHistory = state.restartHistory.filter((t) => currentTime - t < windowMs);

    if (state.restartHistory.length >= maxRestarts) {
      // 达到熔断上限
      state.recovering = false;
      return false;
    }

    state.recovering = true;
    state.status = 'recovering';
    state.restartHistory.push(currentTime);

    try {
      const restarted = await config.restarter();
      return restarted;
    } catch {
      return false;
    }
  }

  async reconcile(): Promise<{
    status: string;
    healthyCount: number;
    totalCount: number;
    serviceStates: Record<string, ServiceHealthStatus>;
  }> {
    const keys = [...this.services.keys()];
    await Promise.all(keys.map((k) => this.probeService(k)));

    let healthyCount = 0;
    const serviceStates: Record<string, ServiceHealthStatus> = {};

    for (const [key, state] of this.states.entries()) {
      serviceStates[key] = state.status;
      if (state.status === 'healthy') healthyCount += 1;
    }

    return {
      status: 'reconciled',
      healthyCount,
      totalCount: keys.length,
      serviceStates,
    };
  }
}
