export type BoomSignalData = {
  workRef: string;
  sourceUrl: string;
  grade: 'T1' | 'T2' | 'T3' | string;
  likes: number;
  favorites?: number;
  plays?: number;
};

export type SignalHistoryRecord = {
  workRef: string;
  sourceUrl: string;
  grade: string;
  likes: number;
  missionId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  version: number;
};

export type DedupDecision = {
  action: 'dispatch_new' | 'dispatch_significant_surge' | 'suppress_duplicate';
  reason: string;
  record?: SignalHistoryRecord;
};

export type DedupGovernorOptions = {
  retentionWindowMs?: number; // 默认 24 小时去重窗口
  surgeThresholdRatio?: number; // 增长超 30% 视为显著二次爆发
  now?: () => number;
};

export class BoomSignalDedupGovernor {
  private history = new Map<string, SignalHistoryRecord>();
  private retentionWindowMs: number;
  private surgeThresholdRatio: number;
  private now: () => number;

  constructor(options: DedupGovernorOptions = {}) {
    this.retentionWindowMs = options.retentionWindowMs ?? 24 * 3600_000;
    this.surgeThresholdRatio = options.surgeThresholdRatio ?? 0.3;
    this.now = options.now ?? (() => Date.now());
  }

  private signalKey(signal: BoomSignalData): string {
    return String(signal?.workRef || signal?.sourceUrl || '').trim();
  }

  evaluate(signal: BoomSignalData, now = this.now()): DedupDecision {
    const key = this.signalKey(signal);
    if (!key) {
      return {
        action: 'suppress_duplicate',
        reason: '无效的爆款信号标识。',
      };
    }

    this.pruneExpired(now);

    const existing = this.history.get(key);
    if (!existing) {
      return {
        action: 'dispatch_new',
        reason: '首次捕获的爆款候选作品。',
      };
    }

    const likesGrowth = (Number(signal.likes || 0) - existing.likes) / Math.max(1, existing.likes);

    // 显著爆发（点赞增长 >= 30%）
    if (likesGrowth >= this.surgeThresholdRatio) {
      return {
        action: 'dispatch_significant_surge',
        reason: `作品发生显著二次爆发（点赞量增长 ${(likesGrowth * 100).toFixed(1)}%），触发增量深度复盘。`,
        record: existing,
      };
    }

    return {
      action: 'suppress_duplicate',
      reason: `作品在 ${Math.round((now - existing.lastSeenAt) / 60000)} 分钟前已处理过，当前指标未见显著跳变（涨幅 ${(likesGrowth * 100).toFixed(1)}%），直接复用历史成果。`,
      record: existing,
    };
  }

  record(signal: BoomSignalData, { missionId, now = this.now() }: { missionId?: string; now?: number } = {}): void {
    const key = this.signalKey(signal);
    if (!key) return;

    const existing = this.history.get(key);
    if (existing) {
      existing.likes = Math.max(existing.likes, Number(signal.likes || 0));
      existing.lastSeenAt = now;
      existing.version += 1;
      if (missionId) existing.missionId = missionId;
    } else {
      this.history.set(key, {
        workRef: key,
        sourceUrl: signal.sourceUrl,
        grade: signal.grade,
        likes: Number(signal.likes || 0),
        missionId,
        firstSeenAt: now,
        lastSeenAt: now,
        version: 1,
      });
    }
  }

  pruneExpired(now = this.now()): void {
    for (const [key, record] of this.history.entries()) {
      if (now - record.lastSeenAt > this.retentionWindowMs) {
        this.history.delete(key);
      }
    }
  }

  clear(): void {
    this.history.clear();
  }
}
