// Hot-reload browser client.
export function createHotReloadMonitor({ fetchImpl = globalThis.fetch, reload = () => globalThis.location?.reload(), } = {}) {
    let revision = null;
    let reloaded = false;
    return Object.freeze({
        async check() {
            if (reloaded)
                return { status: 'reloaded' };
            const response = await fetchImpl('/api/dev/hot-reload', { cache: 'no-store' });
            if (!response.ok)
                return { status: 'disabled' };
            const state = await response.json();
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
export function startBrowserHotReload({ schedule = globalThis.setInterval, cancel = globalThis.clearInterval, intervalMs = 800, ...monitorOptions } = {}) {
    const monitor = createHotReloadMonitor(monitorOptions);
    let timer = null;
    const stop = () => {
        if (timer !== null)
            cancel(timer);
        timer = null;
    };
    const tick = async () => {
        try {
            const result = await monitor.check();
            if (result.status === 'reloaded' || result.status === 'disabled')
                stop();
        }
        catch {
            // A backend restart creates a short connection gap; the next tick retries.
        }
    };
    const ready = monitor.check().then((result) => {
        if (result.status === 'baseline' || result.status === 'unchanged') {
            timer = schedule(tick, intervalMs);
        }
        return result;
    }).catch(() => ({ status: 'unavailable' }));
    return Object.freeze({ ...monitor, ready, stop });
}
