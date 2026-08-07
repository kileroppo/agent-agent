import { BoomIntegrationUnavailableError } from './service.js';

export async function routeBoomMonitorApi({
  method,
  url,
  local,
  enabled = true,
  readBody = async () => ({}),
  getService,
} = {}) {
  const parsed = new URL(url ?? '/', 'http://127.0.0.1');
  const pathname = parsed.pathname;
  if (!pathname.startsWith('/api/boom-monitor')) return null;
  if (!local) return response(403, { error:'爆款雷达只允许本机负责人访问。' });
  if (!enabled) return response(503, { detail:'A君原生爆款雷达已停用；当前可能处于旧 Docker 恢复模式。' });
  try {
    const service = await getService();
    if (method === 'GET' && pathname === '/api/boom-monitor/health') {
      return response(200, { ok:true, time:new Date().toISOString(), status:'running', runtime:'ajun-native' });
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/dashboard') return response(200, service.dashboard());
    if (method === 'GET' && pathname === '/api/boom-monitor/works') {
      return response(200, service.listWorks({
        grade:parsed.searchParams.get('grade'),
        platform:parsed.searchParams.get('platform'),
        creatorId:parsed.searchParams.get('creator_id'),
        limit:numberParameter(parsed, 'limit', 100),
      }));
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/versioned-scores') {
      const version = parsed.searchParams.get('version') ?? 'v2';
      return response(200, service.listVersionedScores(version, numberParameter(parsed, 'limit', 100)));
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/shadow-scores') {
      return response(200, service.listVersionedScores('v2', numberParameter(parsed, 'limit', 100)));
    }
    const workMatch = pathname.match(/^\/api\/boom-monitor\/works\/(\d+)$/);
    if (method === 'GET' && workMatch) {
      const result = service.getWork(Number(workMatch[1]));
      return result ? response(200, result) : response(404, { detail:'找不到作品' });
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/scan/jobs') {
      return response(200, service.listScanJobs(numberParameter(parsed, 'limit', 20)));
    }
    if (method === 'POST' && pathname === '/api/boom-monitor/scan/run') {
      const jobId = service.db.queueScanJob('manual', null, { mode:'manual' });
      return response(200, { job_id:jobId, message:'已入队' });
    }
    const scanPlatformMatch = pathname.match(/^\/api\/boom-monitor\/scan\/enqueue\/([^/]+)$/);
    if (method === 'POST' && scanPlatformMatch) {
      const platform = decodeURIComponent(scanPlatformMatch[1]);
      return response(200, { job_id:service.enqueueScan(platform), platform });
    }
    if (method === 'POST' && pathname === '/api/boom-monitor/import') {
      return response(200, service.importRecords(await readBody()));
    }
    if (method === 'POST' && pathname === '/api/boom-monitor/collect/url') {
      return response(200, await service.collectUrl(await readBody()));
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/analysis') return response(200, service.listAnalysis());
    if (method === 'POST' && ['/api/boom-monitor/analysis/run', '/api/boom-monitor/analysis/process'].includes(pathname)) {
      const input = await readBody();
      return response(200, await service.runAnalysisWorker({
        manual:input?.manual === true,
        workId:input?.work_id == null ? null : Number(input.work_id),
      }));
    }
    const queueMatch = pathname.match(/^\/api\/boom-monitor\/analysis\/queue\/(\d+)$/);
    if (method === 'POST' && queueMatch) {
      const result = service.enqueueWorkAnalysis(Number(queueMatch[1]));
      return result ? response(200, result) : response(404, { detail:'作品不存在' });
    }
    if (method === 'GET' && pathname === '/api/boom-monitor/settings') return response(200, service.getSettings());
    if (method === 'POST' && pathname === '/api/boom-monitor/settings') return response(200, service.updateSettings(await readBody()));
    return response(404, { error:'Boom Monitor API 不存在。' });
  } catch (error) {
    if (error instanceof BoomIntegrationUnavailableError) return response(503, { detail:error.message });
    if (isInputError(error)) return response(422, { detail:error.message });
    throw error;
  }
}

function isInputError(error) {
  return /(?:不可用|不受支持|缺少|必须|不能为空|未提供|为空|HTTP\(S\)|有效指标包)/.test(String(error?.message));
}
function numberParameter(url, key, fallback) {
  const value = Number(url.searchParams.get(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
function response(status, payload) { return { status, payload }; }
