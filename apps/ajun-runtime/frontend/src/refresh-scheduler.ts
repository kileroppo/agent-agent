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
export function startRefreshScheduler({ refresh, canRefresh = (): any => true, intervalMs = 15000, schedule = globalThis.setInterval, cancel = globalThis.clearInterval, visibilityTarget = globalThis.document, }: any = {}): any {
    if (typeof refresh !== 'function')
        throw new TypeError('refresh 必须是函数。');
    if (typeof canRefresh !== 'function')
        throw new TypeError('canRefresh 必须是函数。');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        throw new TypeError('intervalMs 必须是正数。');
    let stopped: any = false;
    let running: any = false;
    const refreshNow: any = async (): Promise<any> => {
        if (stopped || running || !canRefresh())
            return false;
        running = true;
        try {
            await refresh({ background: true });
            return true;
        }
        catch {
            return false;
        }
        finally {
            running = false;
        }
    };
    const onVisibilityChange: any = (): any => { void refreshNow(); };
    const timer: any = schedule((): any => { void refreshNow(); }, intervalMs);
    visibilityTarget?.addEventListener?.('visibilitychange', onVisibilityChange);
    return Object.freeze({
        intervalMs,
        refreshNow,
        stop(): any {
            if (stopped)
                return;
            stopped = true;
            cancel(timer);
            visibilityTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
        },
    });
}
