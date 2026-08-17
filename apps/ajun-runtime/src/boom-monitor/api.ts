import { BoomIntegrationUnavailableError } from './service.ts';
export async function routeBoomMonitorApi({ method, url, local, enabled = true, readBody = async (): Promise<any> => ({}), getService, }: any = {}): Promise<any> {
    const parsed: any = new URL(url ?? '/', 'http://127.0.0.1');
    const pathname: any = parsed.pathname;
    if (!pathname.startsWith('/api/boom-monitor'))
        return null;
    if (!local)
        return response(403, { error: '爆款雷达只允许本机负责人访问。' });
    if (!enabled)
        return response(503, {
            status: 'disabled',
            code: 'boom_monitor_disabled',
            detail: '爆款雷达当前未启用，历史数据不会被改动。',
            recommended_action: '需要查看历史记录或手动运行时，请设置 AJUN_BOOM_MONITOR_ENABLED=true 后重新发布 A君。',
        });
    try {
        const service: any = await getService();
        if (method === 'GET' && pathname === '/api/boom-monitor/health') {
            return response(200, {
                ...(typeof service.runtimeStatus === 'function'
                    ? service.runtimeStatus()
                    : { ok:true, status:'idle', runtime:'ajun-native' }),
                time: new Date().toISOString(),
            });
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/dashboard')
            return response(200, service.dashboard());
        if (method === 'GET' && pathname === '/api/boom-monitor/works') {
            await service.refreshAnalysisStatuses?.();
            return response(200, service.listWorks({
                grade: parsed.searchParams.get('grade'),
                platform: parsed.searchParams.get('platform'),
                creatorId: parsed.searchParams.get('creator_id'),
                limit: numberParameter(parsed, 'limit', 100),
            }));
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/versioned-scores') {
            const version: any = parsed.searchParams.get('version') ?? 'v2';
            return response(200, service.listVersionedScores(version, numberParameter(parsed, 'limit', 100)));
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/shadow-scores') {
            return response(200, service.listVersionedScores('v2', numberParameter(parsed, 'limit', 100)));
        }
        const workMatch: any = pathname.match(/^\/api\/boom-monitor\/works\/(\d+)$/);
        if (method === 'GET' && workMatch) {
            await service.refreshAnalysisStatuses?.();
            const result: any = service.getWork(Number(workMatch[1]));
            return result ? response(200, result) : response(404, { detail: '找不到作品' });
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/scan/jobs') {
            return response(200, service.listScanJobs(numberParameter(parsed, 'limit', 20)));
        }
        if (method === 'POST' && pathname === '/api/boom-monitor/scan/run') {
            const jobId: any = service.db.queueScanJob('manual', null, { mode: 'manual' });
            return response(200, { job_id: jobId, message: '已入队' });
        }
        const scanPlatformMatch: any = pathname.match(/^\/api\/boom-monitor\/scan\/enqueue\/([^/]+)$/);
        if (method === 'POST' && scanPlatformMatch) {
            const platform: any = decodeURIComponent(scanPlatformMatch[1]);
            return response(200, { job_id: service.enqueueScan(platform), platform });
        }
        if (method === 'POST' && pathname === '/api/boom-monitor/import') {
            return response(200, service.importRecords(await readBody()));
        }
        if (method === 'POST' && pathname === '/api/boom-monitor/collect/url') {
            return response(200, await service.collectUrl(await readBody()));
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/analysis') {
            await service.refreshAnalysisStatuses?.();
            return response(200, service.listAnalysis());
        }
        if (method === 'POST' && ['/api/boom-monitor/analysis/run', '/api/boom-monitor/analysis/process'].includes(pathname)) {
            const input: any = await readBody();
            return response(200, await service.runAnalysisWorker({
                manual: input?.manual === true,
                workId: input?.work_id == null ? null : Number(input.work_id),
            }));
        }
        const queueMatch: any = pathname.match(/^\/api\/boom-monitor\/analysis\/queue\/(\d+)$/);
        if (method === 'POST' && queueMatch) {
            const result: any = service.enqueueWorkAnalysis(Number(queueMatch[1]));
            return result ? response(200, result) : response(404, { detail: '作品不存在' });
        }
        if (method === 'GET' && pathname === '/api/boom-monitor/settings')
            return response(200, service.getSettings());
        if (method === 'POST' && pathname === '/api/boom-monitor/settings')
            return response(200, service.updateSettings(await readBody()));
        return response(404, { error: 'Boom Monitor API 不存在。' });
    }
    catch (error: any) {
        if (error instanceof BoomIntegrationUnavailableError)
            return response(503, { detail: error.message });
        if (isInputError(error))
            return response(422, { detail: error.message });
        throw error;
    }
}
function isInputError(error: any): any {
    return /(?:不可用|不受支持|缺少|必须|不能为空|未提供|为空|HTTP\(S\)|有效指标包)/.test(String(error?.message));
}
function numberParameter(url: any, key: any, fallback: any): any {
    const value: any = Number(url.searchParams.get(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
}
function response(status: any, payload: any): any { return { status, payload }; }
