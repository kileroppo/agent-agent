export type QuotaCheckResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  reason?: string;
  resetAt: string;
};

export type PlatformQuotaConfig = {
  dailyPublishLimit: number;
  hourlyMetricsLimit: number;
};

const DEFAULT_PLATFORM_LIMITS: Record<string, PlatformQuotaConfig> = {
  wechat: { dailyPublishLimit: 2, hourlyMetricsLimit: 60 },
  douyin: { dailyPublishLimit: 5, hourlyMetricsLimit: 120 },
  xiaohongshu: { dailyPublishLimit: 8, hourlyMetricsLimit: 120 },
  bilibili: { dailyPublishLimit: 10, hourlyMetricsLimit: 120 },
  default: { dailyPublishLimit: 5, hourlyMetricsLimit: 100 },
};

export class PublisherAccountQuotaGovernor {
  private publishCounts = new Map<string, number[]>(); // key -> day timestamps
  private metricsCounts = new Map<string, number[]>(); // key -> hour timestamps
  private platformLimits: Record<string, PlatformQuotaConfig>;
  private now: () => number;

  constructor(options: { customLimits?: Record<string, Partial<PlatformQuotaConfig>>; now?: () => number } = {}) {
    this.platformLimits = { ...DEFAULT_PLATFORM_LIMITS };
    if (options.customLimits) {
      for (const [p, lim] of Object.entries(options.customLimits)) {
        this.platformLimits[p] = {
          dailyPublishLimit: lim.dailyPublishLimit ?? DEFAULT_PLATFORM_LIMITS.default.dailyPublishLimit,
          hourlyMetricsLimit: lim.hourlyMetricsLimit ?? DEFAULT_PLATFORM_LIMITS.default.hourlyMetricsLimit,
        };
      }
    }
    this.now = options.now ?? (() => Date.now());
  }

  private accountKey(platform: string, accountId: string): string {
    return `${platform.toLowerCase()}:${String(accountId || 'default_acc')}`;
  }

  checkAndConsume(
    platform: string,
    accountId: string,
    action: 'publish' | 'metrics',
    now = this.now()
  ): QuotaCheckResult {
    const key = this.accountKey(platform, accountId);
    const plat = platform.toLowerCase();
    const config = this.platformLimits[plat] || this.platformLimits.default;

    if (action === 'publish') {
      const windowMs = 24 * 3600_000;
      const timestamps = (this.publishCounts.get(key) || []).filter((ts) => ts > now - windowMs);
      const limit = config.dailyPublishLimit;
      const remaining = Math.max(0, limit - timestamps.length);
      const nextResetTime = timestamps.length > 0 ? timestamps[0] + windowMs : now + windowMs;
      const resetAt = new Date(nextResetTime).toISOString();

      if (remaining <= 0) {
        return {
          allowed: false,
          remaining: 0,
          limit,
          reason: `${platform} 账号 [${accountId}] 已达单日发稿上限 (${limit} 篇/日)，已熔断拦截。`,
          resetAt,
        };
      }

      timestamps.push(now);
      this.publishCounts.set(key, timestamps);
      return {
        allowed: true,
        remaining: remaining - 1,
        limit,
        resetAt,
      };
    }

    // action === 'metrics'
    const windowMs = 3600_000;
    const timestamps = (this.metricsCounts.get(key) || []).filter((ts) => ts > now - windowMs);
    const limit = config.hourlyMetricsLimit;
    const remaining = Math.max(0, limit - timestamps.length);
    const nextResetTime = timestamps.length > 0 ? timestamps[0] + windowMs : now + windowMs;
    const resetAt = new Date(nextResetTime).toISOString();

    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        reason: `${platform} 账号 [${accountId}] 已达每小时回采频次上限 (${limit} 次/时)。`,
        resetAt,
      };
    }

    timestamps.push(now);
    this.metricsCounts.set(key, timestamps);
    return {
      allowed: true,
      remaining: remaining - 1,
      limit,
      resetAt,
    };
  }

  reset(platform?: string, accountId?: string): void {
    if (platform && accountId) {
      const key = this.accountKey(platform, accountId);
      this.publishCounts.delete(key);
      this.metricsCounts.delete(key);
    } else {
      this.publishCounts.clear();
      this.metricsCounts.clear();
    }
  }
}
