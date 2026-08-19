export function canRefreshConsole({ page, accessGate, forms = [] }: any = {}): any {
    if (!page || !accessGate || page.hidden || !accessGate.hidden)
        return false;
    const protectedForms: any[] = [...(page.querySelectorAll?.('form[data-refresh-protected]') || [])];
    return ![...forms, ...protectedForms].some((form: any): any => (
        form?.contains?.(page.activeElement)
        || form?.dataset?.refreshDirty === 'true'
    ));
}
export function bindRefreshProtectedForms({ page = globalThis.document }: any = {}): any {
    const markDirty: any = (event: any): any => {
        const form: any = event.target?.closest?.('form[data-refresh-protected]');
        if (form)
            form.dataset.refreshDirty = 'true';
    };
    const clearAfterReset: any = (event: any): any => {
        const form: any = event.target?.closest?.('form[data-refresh-protected]');
        if (form)
            queueMicrotask((): any => clearRefreshDraft(form));
    };
    page?.addEventListener?.('input', markDirty, true);
    page?.addEventListener?.('change', markDirty, true);
    page?.addEventListener?.('reset', clearAfterReset, true);
    return Object.freeze({
        stop(): any {
            page?.removeEventListener?.('input', markDirty, true);
            page?.removeEventListener?.('change', markDirty, true);
            page?.removeEventListener?.('reset', clearAfterReset, true);
        },
    });
}
export function clearRefreshDraft(form: any): any {
    if (!form?.dataset)
        return false;
    const wasDirty: any = form.dataset.refreshDirty === 'true';
    delete form.dataset.refreshDirty;
    return wasDirty;
}
export function startRefreshScheduler({ refresh, canRefresh = (): any => true, intervalMs = 15000, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout, visibilityTarget = globalThis.document, failureThreshold = 3, onDegraded, onRecovered, }: any = {}): any {
    if (typeof refresh !== 'function')
        throw new TypeError('refresh 必须是函数。');
    if (typeof canRefresh !== 'function')
        throw new TypeError('canRefresh 必须是函数。');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        throw new TypeError('intervalMs 必须是正数。');
    let stopped: any = false;
    let running: any = false;
    let consecutiveFailures: any = 0;
    let timer: any = null;
    const maxBackoffMs: any = 60000;
    function computeDelay(): any {
        if (consecutiveFailures === 0) return intervalMs;
        const exponent: any = Math.min(consecutiveFailures, 5);
        return Math.min(intervalMs * Math.pow(2, exponent), maxBackoffMs);
    }
    function scheduleNext(): any {
        if (stopped) return;
        timer = schedule((): any => { void refreshNow(); }, computeDelay());
    }
    const refreshNow: any = async (): Promise<any> => {
        if (stopped || running || !canRefresh())
            return false;
        running = true;
        try {
            await refresh({ background: true });
            const wasDegraded: any = consecutiveFailures >= failureThreshold;
            consecutiveFailures = 0;
            if (wasDegraded && typeof onRecovered === 'function')
                onRecovered();
            return true;
        }
        catch {
            consecutiveFailures += 1;
            if (consecutiveFailures >= failureThreshold && typeof onDegraded === 'function')
                onDegraded(consecutiveFailures);
            return false;
        }
        finally {
            running = false;
            scheduleNext();
        }
    };
    const onVisibilityChange: any = (): any => { void refreshNow(); };
    timer = schedule((): any => { void refreshNow(); }, intervalMs);
    visibilityTarget?.addEventListener?.('visibilitychange', onVisibilityChange);
    return Object.freeze({
        intervalMs,
        refreshNow,
        get consecutiveFailures(): any { return consecutiveFailures; },
        stop(): any {
            if (stopped)
                return;
            stopped = true;
            cancel(timer);
            visibilityTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
        },
    });
}
