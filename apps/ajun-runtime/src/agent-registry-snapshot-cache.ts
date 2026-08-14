export class AgentRegistrySnapshotCache {
  clock: () => number;
  expiresAt = 0;
  inFlight: Promise<any[]> | null = null;
  snapshot: any[] | null = null;
  ttlMs: number;

  constructor({ ttlMs = 1000, clock = Date.now }: { ttlMs?: number; clock?: () => number } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('岗位清单缓存时长必须是非负有限数字。');
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  async read(loader: () => Promise<any[]>): Promise<any[]> {
    if (this.snapshot && this.clock() < this.expiresAt) return structuredClone(this.snapshot);
    if (this.inFlight) return structuredClone(await this.inFlight);
    this.inFlight = loader();
    try {
      this.snapshot = await this.inFlight;
      this.expiresAt = this.clock() + this.ttlMs;
      return structuredClone(this.snapshot);
    } finally {
      this.inFlight = null;
    }
  }

  invalidate(): void {
    this.snapshot = null;
    this.expiresAt = 0;
  }
}
