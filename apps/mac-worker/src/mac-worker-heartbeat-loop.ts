export type HeartbeatLoopOptions = {
  cloud: {
    heartbeat: (taskId: string, payload: any) => Promise<any>;
  };
  taskId: string;
  workerId: string;
  leaseId: string;
  intervalMs?: number;
  maxConsecutiveFailures?: number;
  onLeaseLost?: (error: any) => void;
};

export class ResilientHeartbeatLoop {
  private cloud: { heartbeat: (taskId: string, payload: any) => Promise<any> };
  private taskId: string;
  private workerId: string;
  private leaseId: string;
  private intervalMs: number;
  private maxConsecutiveFailures: number;
  private onLeaseLost?: (error: any) => void;

  private timer: any = null;
  private consecutiveFailures = 0;
  private running = false;
  private getStageInfo: () => { stage: string; progress: number } = () => ({
    stage: 'working',
    progress: 0,
  });

  constructor(options: HeartbeatLoopOptions) {
    this.cloud = options.cloud;
    this.taskId = options.taskId;
    this.workerId = options.workerId;
    this.leaseId = options.leaseId;
    this.intervalMs = options.intervalMs ?? 15000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.onLeaseLost = options.onLeaseLost;
  }

  start(getStageInfo?: () => { stage: string; progress: number }): void {
    if (this.running) return;
    if (getStageInfo) this.getStageInfo = getStageInfo;
    this.running = true;
    this.consecutiveFailures = 0;

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      await this.tick();
      this.scheduleNext();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<{ ok: boolean; status: string }> {
    if (!this.running) return { ok: false, status: 'stopped' };

    const info = this.getStageInfo();
    try {
      await this.cloud.heartbeat(this.taskId, {
        workerId: this.workerId,
        leaseId: this.leaseId,
        stage: String(info.stage || 'working').slice(0, 120),
        progress: Number(info.progress || 0),
      });

      this.consecutiveFailures = 0;
      return { ok: true, status: 'heartbeat_sent' };
    } catch (err: any) {
      this.consecutiveFailures += 1;
      const status = Number(err?.status || err?.statusCode);

      // 422 / 404 表示云端已判定租约失效或任务不存在
      if (status === 422 || status === 404 || this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.stop();
        this.onLeaseLost?.(err);
        return { ok: false, status: 'lease_lost' };
      }

      return { ok: false, status: 'heartbeat_transient_failure' };
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isHealthy(): boolean {
    return this.running && this.consecutiveFailures === 0;
  }
}
