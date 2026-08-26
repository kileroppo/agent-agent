import { PanoramicSystemHealthInspector } from './panoramic-system-health.ts';

const defaultPanoramicInspector = new PanoramicSystemHealthInspector();

export async function routeRuntimeHealthApi({ request, tasks, optional }: any) {
  if (request.method === 'GET' && (request.url === '/api/panoramic-health' || request.url?.startsWith('/api/panoramic-health?'))) {
    const report = await defaultPanoramicInspector.inspectAll();
    return {
      status: 200,
      payload: report,
    };
  }
  if (request.method !== 'GET' || request.url !== '/api/health') return null;
  if (typeof tasks?.healthOverview !== 'function') {
    return {
      status:503,
      payload:{
        schemaVersion:'agent.army/runtime-health/v1',
        status:'degraded',
        error:'A君健康检查尚未就绪，请稍后重试。',
      },
    };
  }
  return {
    status:200,
    payload:await tasks.healthOverview({ optionalModules:[
      optionalHealth('m5-runtime', 'M5 内容运营', optional?.m5RuntimeEnabled, '需要时设置 AJUN_M5_RUNTIME_ENABLED=true 后重新发布。'),
      boomMonitorHealth(optional),
      optionalHealth('product-maturity', '产品成熟度验证', optional?.productMaturityEnabled, '需要验证时启用 M5 管理工具。'),
    ] }),
  };
}

function optionalHealth(id: string, name: string, enabled: boolean, disabledDetail: string) {
  return { id, name, status:enabled ? 'healthy' : 'disabled', detail:enabled ? '已启用。' : disabledDetail };
}

function boomMonitorHealth(optional: any) {
  if (!optional?.boomMonitorEnabled) {
    return optionalHealth('boom-monitor', '爆款雷达', false, '爆款雷达已关闭；需要时设置 AJUN_BOOM_MONITOR_ENABLED=true。');
  }
  if (!optional?.boomMonitorAutoScheduleEnabled) {
    return { id:'boom-monitor', name:'爆款雷达', status:'limited', detail:'历史和手动工具可用，自动监控已关闭。' };
  }
  return { id:'boom-monitor', name:'爆款雷达', status:'healthy', detail:'自动监控已启用。' };
}
