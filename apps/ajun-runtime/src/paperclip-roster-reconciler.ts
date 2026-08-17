import crypto from 'node:crypto';

export class PaperclipRosterReconciler {
    governance: any;
    intervalMs: any;
    onResult: any;
    registry: any;
    running: any;
    timer: any;
    maxIntervalMs: any;
    failureCount: any;
    lastSyncedDigest: any;
    lastResultSignature: any;
    started: any;
    setTimer: any;
    clearTimer: any;
    constructor({ registry, governance, intervalMs = 60000, maxIntervalMs = 15 * 60_000, onResult = null, setTimer = setTimeout, clearTimer = clearTimeout }: any = {}) {
        this.registry = registry;
        this.governance = governance;
        this.intervalMs = intervalMs;
        this.maxIntervalMs = Math.max(intervalMs, maxIntervalMs);
        this.onResult = onResult;
        this.timer = null;
        this.running = null;
        this.failureCount = 0;
        this.lastSyncedDigest = '';
        this.lastResultSignature = '';
        this.started = false;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
    }
    start(): any {
        if (this.started)
            return;
        this.started = true;
        void this.tick();
    }
    stop(): any {
        if (this.timer)
            this.clearTimer(this.timer);
        this.timer = null;
        this.started = false;
    }
    async reconcile(): Promise<any> {
        if (this.running)
            return this.running;
        this.running = this.reconcileOnce()
            .then((result: any): any => {
            const signature: any = resultSignature(result);
            if (signature !== this.lastResultSignature) {
                this.lastResultSignature = signature;
                this.onResult?.(result);
            }
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
            const digest: any = rosterDigest(manifests);
            if (digest === this.lastSyncedDigest)
                return { status:'unchanged', reason:'岗位清单没有变化，无需重复同步。' };
            const result: any = await this.governance.syncRoster(manifests);
            if (result?.status !== 'sync_pending')
                this.lastSyncedDigest = digest;
            return result;
        }
        catch {
            return { status: 'sync_pending', reason: '岗位清单暂时无法补同步。' };
        }
    }
    async tick(): Promise<any> {
        const result: any = await this.reconcile();
        this.failureCount = result?.status === 'sync_pending' ? this.failureCount + 1 : 0;
        if (!this.started)
            return result;
        const delay: any = this.failureCount === 0
            ? this.intervalMs
            : Math.min(this.maxIntervalMs, this.intervalMs * (2 ** this.failureCount));
        this.timer = this.setTimer((): any => {
            this.timer = null;
            void this.tick();
        }, delay);
        this.timer.unref?.();
        return result;
    }
}

function rosterDigest(manifests: any): any {
    const stable: any = stableValue(Array.isArray(manifests) ? manifests : []);
    return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function stableValue(value: any): any {
    if (Array.isArray(value))
        return value.map(stableValue).sort((left: any, right: any): any => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map((key: any): any => [key, stableValue(value[key])]));
    return value;
}

function resultSignature(result: any): any {
    return JSON.stringify({ status:String(result?.status || ''), reason:String(result?.reason || '') });
}
