import { listM5RequiredAgentKeys } from './plan.ts';
export async function resolveLiveAgentBindings(adapter: any, definition: any) {
    if (!adapter?.request || !adapter.companyId) {
        throw new Error('解析 M5 岗位绑定需要已限定公司的 Paperclip adapter');
    }
    const payload = await adapter.request('GET', `/api/companies/${encodeURIComponent(adapter.companyId)}/agents`);
    const agents = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    const owners = listM5RequiredAgentKeys(definition);
    const agentIds: Record<string, string> = {};
    for (const owner of owners) {
        const matches = agents.filter((agent: any) => agent.status !== 'terminated'
            && agent.metadata?.agentArmyId === owner);
        if (matches.length !== 1) {
            throw new Error(`M5 岗位 ${owner} 必须且只能绑定一个活动 Paperclip Agent，当前为 ${matches.length} 个`);
        }
        agentIds[owner] = matches[0].id;
    }
    return { agentIds };
}
