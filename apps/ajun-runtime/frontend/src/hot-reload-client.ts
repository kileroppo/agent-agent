// Hot-reload browser client.
export function createHotReloadMonitor({ fetchImpl = globalThis.fetch, reload = (): any => globalThis.location?.reload(), }: any = {}): any {
    let revision: any = null;
    let reloaded: any = false;
    return Object.freeze({
        async check(): Promise<any> {
            if (reloaded)
                return { status: 'reloaded' };
            const response: any = await fetchImpl('/api/dev/hot-reload', { cache: 'no-store' });
            if (!response.ok)
                return { status: 'disabled' };
            const state: any = await response.json();
            if (!state?.enabled || !state.revision)
                return { status: 'disabled' };
            if (revision === null) {
                revision = state.revision;
                return { status: 'baseline', revision };
            }
            if (state.revision === revision)
                return { status: 'unchanged', revision };
            reloaded = true;
            reload();
            return { status: 'reloaded', revision: state.revision };
        },
    });
}
export function startBrowserHotReload({ schedule = globalThis.setInterval, cancel = globalThis.clearInterval, intervalMs = 800, ...monitorOptions }: any = {}): any {
    const monitor: any = createHotReloadMonitor(monitorOptions);
    let timer: any = null;
    const stop: any = (): any => {
        if (timer !== null)
            cancel(timer);
        timer = null;
    };
    const tick: any = async (): Promise<any> => {
        try {
            const result: any = await monitor.check();
            if (result.status === 'reloaded' || result.status === 'disabled')
                stop();
        }
        catch {
            // A backend restart creates a short connection gap; the next tick retries.
        }
    };
    const ready: any = monitor.check().then((result: any): any => {
        if (result.status === 'baseline' || result.status === 'unchanged') {
            timer = schedule(tick, intervalMs);
        }
        return result;
    }).catch((): any => ({ status: 'unavailable' }));
    return Object.freeze({ ...monitor, ready, stop });
}
