export async function routeLocalAiApi({ request, localAi, local, readBody, customAiStore }: any) {
  if (request.method === 'GET' && request.url === '/api/local-ai/control') {
    if (!local) return denied(403, 'AI 能力控制只能由老板在本机查看。');
    if (!localAi) return denied(503, '本机 AI 控制入口尚未接入。');
    const overview: any = await localAi.controlOverview();
    if (customAiStore) {
      const customs: any = await customAiStore.list();
      overview.customCapabilities = customs;
      if (customs.length && Array.isArray(overview.categories)) {
        const customCategory: any = { id: 'custom', label: '第三方/自定义', capabilities: customs.map((c: any): any => c.capabilityType), readyCount: customs.filter((c: any): any => c.lastHealthStatus === 'healthy').length, totalCount: customs.length, serviceIds: [] };
        overview.categories.push(customCategory);
      }
    }
    return { status:200, payload:overview };
  }
  const action = request.method === 'POST'
    ? request.url?.match(/^\/api\/local-ai\/services\/([a-z0-9-]+)\/(start|stop|restart|reconnect)$/)
    : null;
  if (action) {
    if (!local) return denied(403, 'AI 服务只能由老板在本机控制。');
    if (!localAi) return denied(503, '本机 AI 控制入口尚未接入。');
    return { status:200, payload:await localAi.controlService(action[1], action[2]) };
  }
  const policy = request.method === 'PUT'
    ? request.url?.match(/^\/api\/local-ai\/services\/([a-z0-9-]+)\/policy$/)
    : null;
  if (!policy) return null;
  if (!local) return denied(403, 'AI 服务策略只能由老板在本机修改。');
  if (!localAi) return denied(503, '本机 AI 控制入口尚未接入。');
  return { status:200, payload:await localAi.updateServicePolicy(policy[1], await readBody()) };
}

function denied(status: number, error: string) {
  return { status, payload:{ error } };
}
