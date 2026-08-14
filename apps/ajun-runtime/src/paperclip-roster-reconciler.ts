export class PaperclipRosterReconciler {
    governance: any;
    intervalMs: any;
    onResult: any;
    registry: any;
    running: any;
    timer: any;
    constructor({ registry, governance, intervalMs = 60000, onResult = null }: any = {}) {
        this.registry = registry;
        this.governance = governance;
        this.intervalMs = intervalMs;
        this.onResult = onResult;
        this.timer = null;
        this.running = null;
    }
    start(): any {
        if (this.timer)
            return;
        void this.reconcile();
        this.timer = setInterval((): any => void this.reconcile(), this.intervalMs);
        this.timer.unref?.();
    }
    stop(): any {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async reconcile(): Promise<any> {
        if (this.running)
            return this.running;
        this.running = this.reconcileOnce()
            .then((result: any): any => {
            this.onResult?.(result);
            return result;
        })
            .finally((): any => { this.running = null; });
        return this.running;
    }
    async reconcileOnce(): Promise<any> {
        try {
            // A君不是普通员工，但仍需要一个受限的 Paperclip manager identity
            // 承接 M5 选题/复盘 Routine；主界面继续由 AgentRegistry 默认过滤 manager。
            const manifests: any = await this.registry.list({ includeManagers: true });
            return await this.governance.syncRoster(manifests);
        }
        catch {
            return { status: 'sync_pending', reason: '岗位清单暂时无法补同步。' };
        }
    }
}
