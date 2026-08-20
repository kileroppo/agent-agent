export async function routeTaskSubmitApi({ request, local, tasks, registry, readBody }: any): Promise<any> {
    const url: any = request.url || '';
    if (!url.startsWith('/api/tasks/submit')) return null;
    if (!local) return { status: 403, payload: { error: '任务提交只能由老板在本机操作。' } };
    if (request.method === 'GET' && url === '/api/tasks/submit/options') {
        if (!registry) return { status: 200, payload: { agents: [] } };
        const agents: any = await registry.list();
        const options: any = agents
            .filter((agent: any): any => agent.entryCategories?.length || agent.entryDefault === true)
            .map((agent: any): any => ({ agentId: agent.agentId, name: agent.name, role: agent.role, taskLabel: agent.taskLabel || agent.name }));
        return { status: 200, payload: { agents: options } };
    }
    if (request.method === 'POST' && url === '/api/tasks/submit') {
        const body: any = await readBody();
        const title: any = String(body.title || '').trim();
        if (!title) return { status: 400, payload: { error: '请填写任务标题。' } };
        const description: any = String(body.description || '').trim() || undefined;
        const agentId: any = String(body.agentId || '').trim() || undefined;
        const task: any = await tasks.create({
            title,
            description,
            requesterName: 'console-owner',
            source: { channel: 'runtime-console' },
            ...(agentId ? { agentId } : {}),
        });
        return { status: 201, payload: { task } };
    }
    return null;
}
