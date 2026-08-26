export type CredentialRecord = {
  connectionId: string;
  provider: string;
  name?: string;
  expiresAt?: string | null;
  lastVerifiedAt?: string | null;
  probeFn?: () => Promise<{ ok: boolean; status?: string; reason?: string }>;
};

export type DecayingAlert = {
  connectionId: string;
  provider: string;
  name: string;
  status: 'decaying' | 'expired' | 'probe_failed';
  reason: string;
  remainingHours?: number;
  recommendedAction: string;
};

export type CredentialDecayWarnerOptions = {
  warningWindowMs?: number; // 默认提前 48 小时预警
  onDecaying?: (alert: DecayingAlert) => Promise<void> | void;
  now?: () => number;
};

const DEFAULT_WARNING_WINDOW_MS = 48 * 3600 * 1000; // 48 hours

export class CredentialDecayWarner {
  private credentials = new Map<string, CredentialRecord>();
  private warningWindowMs: number;
  private onDecaying?: (alert: DecayingAlert) => Promise<void> | void;
  private now: () => number;

  constructor(options: CredentialDecayWarnerOptions = {}) {
    this.warningWindowMs = options.warningWindowMs ?? DEFAULT_WARNING_WINDOW_MS;
    this.onDecaying = options.onDecaying;
    this.now = options.now ?? (() => Date.now());
  }

  register(record: CredentialRecord) {
    if (!record?.connectionId) return;
    this.credentials.set(record.connectionId, record);
  }

  async checkCredential(connectionId: string, now = this.now()): Promise<DecayingAlert | null> {
    const cred = this.credentials.get(connectionId);
    if (!cred) return null;

    const providerName = cred.name || cred.provider || connectionId;

    // 1. 检查到期时间
    if (cred.expiresAt) {
      const expTime = new Date(cred.expiresAt).getTime();
      const diff = expTime - now;

      if (diff <= 0) {
        return {
          connectionId: cred.connectionId,
          provider: cred.provider,
          name: providerName,
          status: 'expired',
          reason: `${providerName} 凭据已于 ${cred.expiresAt} 过期。`,
          remainingHours: 0,
          recommendedAction: `请在运行台“连接管理”重新扫码或更新 ${providerName} Cookie。`,
        };
      }

      if (diff <= this.warningWindowMs) {
        const remainingHours = Math.round(diff / 3600000);
        return {
          connectionId: cred.connectionId,
          provider: cred.provider,
          name: providerName,
          status: 'decaying',
          reason: `${providerName} 凭据即将在 ${remainingHours} 小时后过期。`,
          remainingHours,
          recommendedAction: `请提前在“连接管理”刷新 ${providerName} 登录态，防止任务中断。`,
        };
      }
    }

    // 2. 检查主动探活探测器
    if (typeof cred.probeFn === 'function') {
      try {
        const probeRes = await cred.probeFn();
        if (!probeRes?.ok) {
          return {
            connectionId: cred.connectionId,
            provider: cred.provider,
            name: providerName,
            status: 'probe_failed',
            reason: `${providerName} 登录态心跳探针异常: ${probeRes?.reason || '风控或验证码拦截'}`,
            recommendedAction: `请检查 ${providerName} 账号状态并重新授权。`,
          };
        }
      } catch (err: any) {
        return {
          connectionId: cred.connectionId,
          provider: cred.provider,
          name: providerName,
          status: 'probe_failed',
          reason: `${providerName} 探针请求异常: ${err?.message || '网络或服务端错误'}`,
          recommendedAction: `请检查网络连通性或重新登录 ${providerName}。`,
        };
      }
    }

    return null;
  }

  async checkAll(now = this.now()): Promise<DecayingAlert[]> {
    const alerts: DecayingAlert[] = [];
    for (const connectionId of this.credentials.keys()) {
      const alert = await this.checkCredential(connectionId, now);
      if (alert) {
        alerts.push(alert);
        try {
          await this.onDecaying?.(alert);
        } catch {}
      }
    }
    return alerts;
  }

  async reconcile(): Promise<{ status: string; totalChecked: number; decayingCount: number }> {
    const alerts = await this.checkAll();
    return {
      status: 'reconciled',
      totalChecked: this.credentials.size,
      decayingCount: alerts.length,
    };
  }
}
