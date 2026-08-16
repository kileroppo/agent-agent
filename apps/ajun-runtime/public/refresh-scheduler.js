export function canRefreshConsole({ page, accessGate, forms = [] } = {}) {
    if (!page || !accessGate || page.hidden || !accessGate.hidden)
        return false;
    const protectedForms = [...(page.querySelectorAll?.('form[data-refresh-protected]') || [])];
    return ![...forms, ...protectedForms].some((form) => (form?.contains?.(page.activeElement)
        || form?.dataset?.refreshDirty === 'true'));
}
export function bindRefreshProtectedForms({ page = globalThis.document } = {}) {
    const markDirty = (event) => {
        const form = event.target?.closest?.('form[data-refresh-protected]');
        if (form)
            form.dataset.refreshDirty = 'true';
    };
    const clearAfterReset = (event) => {
        const form = event.target?.closest?.('form[data-refresh-protected]');
        if (form)
            queueMicrotask(() => clearRefreshDraft(form));
    };
    page?.addEventListener?.('input', markDirty, true);
    page?.addEventListener?.('change', markDirty, true);
    page?.addEventListener?.('reset', clearAfterReset, true);
    return Object.freeze({
        stop() {
            page?.removeEventListener?.('input', markDirty, true);
            page?.removeEventListener?.('change', markDirty, true);
            page?.removeEventListener?.('reset', clearAfterReset, true);
        },
    });
}
export function clearRefreshDraft(form) {
    if (!form?.dataset)
        return false;
    const wasDirty = form.dataset.refreshDirty === 'true';
    delete form.dataset.refreshDirty;
    return wasDirty;
}
export function startRefreshScheduler({ refresh, canRefresh = () => true, intervalMs = 15000, schedule = globalThis.setInterval, cancel = globalThis.clearInterval, visibilityTarget = globalThis.document, } = {}) {
    if (typeof refresh !== 'function')
        throw new TypeError('refresh 必须是函数。');
    if (typeof canRefresh !== 'function')
        throw new TypeError('canRefresh 必须是函数。');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        throw new TypeError('intervalMs 必须是正数。');
    let stopped = false;
    let running = false;
    const refreshNow = async () => {
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
    const onVisibilityChange = () => { void refreshNow(); };
    const timer = schedule(() => { void refreshNow(); }, intervalMs);
    visibilityTarget?.addEventListener?.('visibilitychange', onVisibilityChange);
    return Object.freeze({
        intervalMs,
        refreshNow,
        stop() {
            if (stopped)
                return;
            stopped = true;
            cancel(timer);
            visibilityTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
        },
    });
}
