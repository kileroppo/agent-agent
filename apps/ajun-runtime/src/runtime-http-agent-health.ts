import { probeAgentManifestHealth } from './agent-manifest-health-probe.ts';
export async function routeAgentHealthProbeApi({ request, local, manifests, fetchImpl }: any): Promise<any> {
    if (request.method !== 'GET' || request.url !== '/api/agents/health-probe')
        return null;
    if (!local)
        return { status: 403, payload: { error: '代理健康探针只能在本机执行。' } };
    const results: any = await probeAgentManifestHealth({ manifests, fetchImpl });
    return { status: 200, payload: { schemaVersion: 'agent.army/agent-health-probe/v1', results } };
}
