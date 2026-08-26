export type IngressLeaseResult = {
  allowed: boolean;
  reason?: 'in_flight' | 'recently_processed' | 'invalid_key';
  leaseToken?: string;
};

type ActiveLease = {
  token: string;
  expiresAt: number;
};

type ProcessedRecord = {
  processedAt: number;
  expiresAt: number;
};

export type IngressDeduplicatorOptions = {
  defaultLeaseTtlMs?: number; // 默认防并发租约 (默认 4 秒)
  defaultRetentionMs?: number; // 终态幂等保留窗口 (默认 60 秒)
  now?: () => number;
};

export class FeishuIngressDeduplicator {
  private defaultLeaseTtlMs: number;
  private defaultRetentionMs: number;
  private now: () => number;
  private activeLeases = new Map<string, ActiveLease>();
  private processed = new Map<string, ProcessedRecord>();

  constructor(options: IngressDeduplicatorOptions = {}) {
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 4000;
    this.defaultRetentionMs = options.defaultRetentionMs ?? 60000;
    this.now = options.now ?? (() => Date.now());
  }

  acquireLease(key: string, { ttlMs = this.defaultLeaseTtlMs, now = this.now() }: { ttlMs?: number; now?: number } = {}): IngressLeaseResult {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) {
      return { allowed: false, reason: 'invalid_key' };
    }

    this.pruneExpired(now);

    // 1. 检查是否在已处理的滑动窗口内
    const proc = this.processed.get(cleanKey);
    if (proc && proc.expiresAt > now) {
      return { allowed: false, reason: 'recently_processed' };
    }

    // 2. 检查是否有正在执行中的租约
    const lease = this.activeLeases.get(cleanKey);
    if (lease && lease.expiresAt > now) {
      return { allowed: false, reason: 'in_flight' };
    }

    // 3. 授予新租约
    const token = `lease_${now}_${Math.random().toString(36).slice(2, 8)}`;
    this.activeLeases.set(cleanKey, {
      token,
      expiresAt: now + ttlMs,
    });

    return {
      allowed: true,
      leaseToken: token,
    };
  }

  releaseLease(key: string, token?: string): boolean {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return false;
    const lease = this.activeLeases.get(cleanKey);
    if (!lease) return false;
    if (token && lease.token !== token) return false;

    this.activeLeases.delete(cleanKey);
    return true;
  }

  markProcessed(key: string, { retentionMs = this.defaultRetentionMs, token, now = this.now() }: { retentionMs?: number; token?: string; now?: number } = {}): void {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return;

    this.releaseLease(cleanKey, token);
    this.processed.set(cleanKey, {
      processedAt: now,
      expiresAt: now + retentionMs,
    });
  }

  isProcessed(key: string, now = this.now()): boolean {
    const cleanKey = String(key || '').trim();
    const proc = this.processed.get(cleanKey);
    return Boolean(proc && proc.expiresAt > now);
  }

  pruneExpired(now = this.now()): void {
    for (const [key, lease] of this.activeLeases.entries()) {
      if (lease.expiresAt <= now) this.activeLeases.delete(key);
    }
    for (const [key, proc] of this.processed.entries()) {
      if (proc.expiresAt <= now) this.processed.delete(key);
    }
  }

  clear(): void {
    this.activeLeases.clear;
    this.activeLeases.clear();
    this.processed.clear();
  }
}
