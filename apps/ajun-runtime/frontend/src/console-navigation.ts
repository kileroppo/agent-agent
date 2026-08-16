const CONSOLE_ROUTES: any = Object.freeze({
    now: { page: 'overview', group: 'overview' },
    overview: { page: 'overview', group: 'overview' },
    runs: { page: 'records', group: 'records' },
    records: { page: 'records', group: 'records' },
    system: { page: 'system', group: 'system' },
    employees: { page: 'employees', group: 'system' },
    connections: { page: 'connections', group: 'system' },
    billing: { page: 'billing', group: 'system' },
    release: { page: 'release', group: 'system' },
    tools: { page: 'tools', group: 'tools' },
    campaigns: { page: 'campaigns', group: 'tools' },
    'boom-monitor': { page: 'boom-monitor', group: 'tools' },
});
export function resolveConsoleRoute(hash: any, { pathname = '' }: any = {}): any {
    const requested: any = String(hash || '').replace(/^#/, '').trim()
        || (taskIdFromPath(pathname) ? 'records' : 'overview');
    return CONSOLE_ROUTES[requested] || CONSOLE_ROUTES.overview;
}
export function createConsoleNavigation({ getHash, getPathname = (): any => '', replaceLocation = null, activate }: any): any {
    let initialized: any = false;
    function activateFromLocation(): any {
        const hash: any = getHash();
        const pathname: any = getPathname();
        const route: any = resolveConsoleRoute(hash, { pathname });
        if (taskIdFromPath(pathname) && hash && route.page !== 'records' && typeof replaceLocation === 'function') {
            replaceLocation(`/${hash.startsWith('#') ? hash : `#${hash}`}`);
        }
        activate(route.page, { navigationGroup: route.group });
    }
    return {
        initialize(): any {
            if (initialized)
                return false;
            initialized = true;
            activateFromLocation();
            return true;
        },
        locationChanged(): any {
            initialized = true;
            activateFromLocation();
        },
    };
}
export function taskIdFromPath(pathname: any): any {
    return String(pathname || '').match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}
