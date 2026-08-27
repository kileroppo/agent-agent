import type { JobStore } from './store.ts';

export type XiaodDataLifecycleOptions = {
  store: JobStore;
  intervalMs?: number;
  succeededRetentionMs?: number;
  failedRetentionMs?: number;
  now?: () => number;
};

export class XiaodDataLifecycleService {
  private store: JobStore;
  private intervalMs: number;
  private succeededRetentionMs?: number;
  private failedRetentionMs?: number;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastResult: any = null;

  constructor(options: XiaodDataLifecycleOptions) {
    this.store = options.store;
    this.intervalMs = options.intervalMs ?? (60 * 60 * 1000);
    this.succeededRetentionMs = options.succeededRetentionMs;
    this.failedRetentionMs = options.failedRetentionMs;
    this.now = options.now ?? (() => Date.now());
  }

  async runGc({ dryRun = false }: { dryRun?: boolean } = {}) {
    this.lastResult = await this.store.pruneExpiredJobs({
      now: this.now(),
      succeededRetentionMs: this.succeededRetentionMs,
      failedRetentionMs: this.failedRetentionMs,
      dryRun,
    });
    return this.lastResult;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runGc({ dryRun: false }).catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus() {
    return {
      status: 'active',
      intervalMs: this.intervalMs,
      lastResult: this.lastResult,
    };
  }
}
