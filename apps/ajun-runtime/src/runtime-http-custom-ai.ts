export async function routeCustomAiApi({ request, local, store, readBody }: any): Promise<any> {
    const url: any = request.url || '';
    if (!url.startsWith('/api/custom-ai/')) return null;
    if (!local) return { status: 403, payload: { error: '自定义 AI 能力管理只能由老板在本机操作。' } };
    if (request.method === 'GET' && url === '/api/custom-ai/capabilities')
        return { status: 200, payload: { capabilities: await store.list() } };
    if (request.method === 'POST' && url === '/api/custom-ai/capabilities')
        return { status: 201, payload: { capability: await store.register(await readBody()) } };
    const deleteMatch: any = url.match(/^\/api\/custom-ai\/capabilities\/([0-9a-f-]{36})$/i);
    if (request.method === 'DELETE' && deleteMatch)
        return { status: 200, payload: await store.remove(deleteMatch[1]) };
    const healthMatch: any = url.match(/^\/api\/custom-ai\/capabilities\/([0-9a-f-]{36})\/health-check$/i);
    if (request.method === 'POST' && healthMatch)
        return { status: 200, payload: { capability: await store.checkHealth(healthMatch[1]) } };
    return null;
}
