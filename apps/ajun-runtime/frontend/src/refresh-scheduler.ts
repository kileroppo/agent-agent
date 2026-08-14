export function canRefreshConsole({ page, accessGate, forms = [] }: any = {}): any {
    if (!page || !accessGate || page.hidden || !accessGate.hidden)
        return false;
    return !forms.some((form: any): any => form?.contains?.(page.activeElement));
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
