export class ApprovalExpiryReconciler {
  constructor({ tasks, intervalMs = 60_000, onResult = null } = {}) {
    this.tasks = tasks;
    this.intervalMs = intervalMs;
    this.onResult = onResult;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    try {
      const expired = await this.tasks.expirePendingApprovals();
      return { status:'synced', expired };
    } catch {
      return { status:'sync_pending', reason:'过期确认暂时无法自动整理。' };
    }
  }
}
