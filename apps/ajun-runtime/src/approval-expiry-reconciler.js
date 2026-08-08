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
      const decisions = typeof this.tasks.reconcilePendingPaperclipApprovals === 'function'
        ? await this.tasks.reconcilePendingPaperclipApprovals()
        : [];
      const expired = await this.tasks.expirePendingApprovals();
      const pending = decisions.filter((item) => item.status === 'sync_pending');
      return {
        status:pending.length ? 'sync_pending' : 'synced',
        ...(pending.length ? { reason:'已开始的组织级审批暂时无法完成本地收口。' } : {}),
        decisions,
        expired,
      };
    } catch {
      return { status:'sync_pending', reason:'过期确认暂时无法自动整理。' };
    }
  }
}
