export class PaperclipRosterReconciler {
  constructor({ registry, governance, intervalMs = 60_000, onResult = null } = {}) {
    this.registry = registry;
    this.governance = governance;
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
      const manifests = await this.registry.list();
      return await this.governance.syncRoster(manifests);
    } catch {
      return { status:'sync_pending', reason:'岗位清单暂时无法补同步。' };
    }
  }
}
