import { summarizeTaskUsage } from './task-usage.ts';
import { buildTaskValidationOverview } from './task-validation-overview.ts';

/**
 * Caches only the task-derived portion of the console overview.
 * Runtime dependencies (governance, registry, skills and capabilities) stay in TaskOverview and are reread per request.
 */
export class TaskOverviewSnapshotCache {
    capabilityCatalog: any;
    store: any;
    getUsagePeriodStart: any;
    snapshot: any;
    unsubscribe: any;
    constructor({ store, capabilityCatalog, getUsagePeriodStart = startOfToday }: any) {
        this.store = store;
        this.capabilityCatalog = capabilityCatalog;
        this.getUsagePeriodStart = getUsagePeriodStart;
        this.snapshot = null;
        this.unsubscribe = typeof this.store?.subscribe === 'function'
            ? this.store.subscribe((): any => { this.snapshot = null; })
            : null;
    }
    async read({ includeValidationCampaign = true, cache = false }: any = {}): Promise<any> {
        if (!cache || !this.unsubscribe)
            return this.readDerived({ includeValidationCampaign });
        const revision: any = await this.readStoreRevision();
        const usagePeriodStart: any = this.getUsagePeriodStart().getTime();
        const current: any = this.snapshot;
        if (current && current.usagePeriodStart === usagePeriodStart && (revision === null || current.revision === revision))
            return current.value;
        const pending: any = this.readDerived({ includeValidationCampaign });
        const entry: any = { revision, usagePeriodStart, value: pending };
        this.snapshot = entry;
        pending.catch((): any => {
            if (this.snapshot === entry)
                this.snapshot = null;
        });
        return pending;
    }
    async readDerived({ includeValidationCampaign = true }: any = {}): Promise<any> {
        const [tasks, approvals]: any = await Promise.all([
            this.store.list(),
            this.store.listApprovals(),
        ]);
        const taskValidation: any = await buildTaskValidationOverview({
            tasks,
            approvals,
            store: this.store,
            capabilityCatalog: this.capabilityCatalog,
            includeValidationCampaign,
        });
        return {
            tasks,
            approvals,
            taskValidation,
            usage: summarizeTaskUsage(tasks, { since: this.getUsagePeriodStart() }),
        };
    }
    async readStoreRevision(): Promise<any> {
        const readRevision: any = this.store?.revision || this.store?.getRevision;
        if (typeof readRevision !== 'function')
            return null;
        try {
            return await readRevision.call(this.store);
        }
        catch {
            // Revision 不可读时不复用，避免让缓存把旧任务事实带到下一轮首页读取。
            this.snapshot = null;
            return Symbol('task-store-revision-unavailable');
        }
    }
}

function startOfToday(): any {
    const now: any = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
