const GATEWAY_URL: any = 'http://127.0.0.1:18082/health';
const TIMEOUT_MS: any = 3000;
export async function probeAgentManifestHealth({ manifests = [], fetchImpl = fetch }: any = {}): Promise<any> {
    const hermesAgents: any[] = (Array.isArray(manifests) ? manifests : [])
        .filter((manifest: any): any => manifest?.interaction?.runtime === 'hermes-profile')
        .map((manifest: any): any => String(manifest.agentId || manifest.id || '').trim())
        .filter(Boolean);
    if (hermesAgents.length === 0)
        return [];
    const checkedAt: any = new Date().toISOString();
    let gatewayOnline: any = false;
    try {
        const response: any = await fetchImpl(GATEWAY_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        gatewayOnline = response.ok === true;
    } catch {
        gatewayOnline = false;
    }
    return hermesAgents.map((agentId: any): any => ({
        agentId,
        profileOnline: gatewayOnline,
        checkedAt,
    }));
}
