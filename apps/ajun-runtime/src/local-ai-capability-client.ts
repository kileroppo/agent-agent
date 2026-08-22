const CAPABILITIES: any = new Set([
    'text.generate',
    'vision.analyze',
    'video.analyze',
    'audio.transcribe',
    'audio.synthesize',
    'image.generate',
    'image.edit',
    'embedding.create',
    'rerank.score',
    'knowledge.index',
    'knowledge.search',
    'audio.clone_authorized',
    'video.generate',
]);
export const CAPABILITY_CATEGORIES: any = [
    { id: 'text', label: '\u6587\u672C\u751F\u6210', capabilities: ['text.generate'] },
    { id: 'voice', label: '\u8BED\u97F3', capabilities: ['audio.transcribe', 'audio.synthesize', 'audio.clone_authorized'] },
    { id: 'vision', label: '\u89C6\u89C9', capabilities: ['vision.analyze', 'video.analyze', 'video.generate'] },
    { id: 'image', label: '\u56FE\u7247', capabilities: ['image.generate', 'image.edit'] },
    { id: 'knowledge', label: '\u77E5\u8BC6\u68C0\u7D22', capabilities: ['embedding.create', 'rerank.score', 'knowledge.index', 'knowledge.search'] },
];
const SERVICE_IDS: any = new Set(['gateway', 'qwen35', 'qwen36-candidate', 'embedding', 'reranker', 'speech-tools', 'mflux', 'desktop-node', 'comfyui']);
// 网关路由未登记对应能力时，按服务本身回退到所属分组，避免分组丢失服务卡片。
const CATEGORY_SERVICE_FALLBACK: any = {
    knowledge: ['embedding', 'reranker'],
};
const SERVICE_ACTIONS: any = new Set(['start', 'stop', 'restart', 'reconnect']);
const SERVICE_MODES: any = new Set(['on_demand', 'always_on', 'disabled', 'per_request']);
export class LocalAiCapabilityClient {
    baseUrl: any;
    fetchImpl: any;
    gatewayControl: any;
    constructor({ baseUrl = process.env.LOCAL_AI_GATEWAY_URL || 'http://127.0.0.1:18082', fetchImpl = fetch, gatewayControl = controlGatewayLaunchAgent, }: any = {}) {
        this.baseUrl = normalizeLoopbackUrl(baseUrl);
        this.fetchImpl = fetchImpl;
        this.gatewayControl = gatewayControl;
    }
    async health(): Promise<any> {
        try {
            const response: any = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            if (!response.ok)
                return unavailable();
            const body: any = await response.json();
            const capabilities: any = (Array.isArray(body?.capabilities) ? body.capabilities : []).map((item: any): any => ({
                capability: String(item?.capability || '').slice(0, 80),
                configured: item?.configured === true,
                healthy: item?.healthy === true,
                e2eVerified: item?.e2eVerified === true,
                verifiedAt: validEvidenceTime(item?.verifiedAt),
                provider: String(item?.provider || '').slice(0, 80),
            })).filter((item: any): any => CAPABILITIES.has(item.capability));
            const ready: any = capabilities.filter((item: any): any => item.healthy && item.e2eVerified);
            return {
                status: body?.status === 'healthy' ? 'healthy' : 'degraded',
                node: String(body?.node || 'local').slice(0, 80),
                readyCount: ready.length,
                capabilities,
                desktopEnhancement: {
                    configured: body?.desktopEnhancement?.configured === true,
                    healthy: body?.desktopEnhancement?.healthy === true,
                },
                safeMessage: body?.status === 'healthy'
                    ? `本机 AI 网关健康，${ready.length} 项能力已通过端到端验收。`
                    : '本机 AI 网关可访问，但部分核心能力当前不可用。',
            };
        }
        catch {
            return unavailable();
        }
    }
    async invoke({ capability, input = {}, options = {}, requestId, approved = false }: any = {}): Promise<any> {
        if (!CAPABILITIES.has(capability))
            throw clientError('local_ai_capability_not_allowed', '未登记的本机 AI 能力。');
        let response: any;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/v1/invoke`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ capability, input, options, request_id: requestId, approved }),
                signal: AbortSignal.timeout(Math.max(1000, Math.min(Number(options?.timeoutSeconds || 300) * 1000, 3600000))),
            });
        }
        catch (error: any) {
            throw clientError('local_ai_gateway_unavailable', error?.message || '本机 AI 网关不可用。', 503, true);
        }
        const body: any = await response.json().catch((): any => ({}));
        if (!response.ok) {
            const code: any = String(body?.detail?.code || 'local_ai_failed').slice(0, 80);
            throw clientError(code, String(body?.detail?.message || '本机 AI 能力调用失败。').slice(0, 500), response.status);
        }
        return body;
    }
    async controlOverview(): Promise<any> {
        let body: any;
        try {
            body = await this.#request('/v1/control', { signal: AbortSignal.timeout(20000) });
        }
        catch {
            return unavailableControl();
        }
        const services: any = (Array.isArray(body?.services) ? body.services : []).map(sanitizeService).filter(Boolean);
        const routing: any = (Array.isArray(body?.routing) ? body.routing : []).map((route: any): any => ({
            capability: String(route?.capability || '').slice(0, 100),
            providers: (Array.isArray(route?.providers) ? route.providers : []).map((item: any): any => String(item).slice(0, 120)).slice(0, 5),
        })).filter((route: any): any => route.capability);
        const categories: any = buildCategories(routing, services);
        return {
            status: body?.status === 'ready' ? 'ready' : 'degraded',
            services,
            routing,
            categories,
        };
    }
    async controlService(serviceId: any, action: any): Promise<any> {
        if (!SERVICE_IDS.has(serviceId) || !SERVICE_ACTIONS.has(action))
            throw clientError('local_ai_service_action_not_allowed', '未登记的服务控制动作。');
        if (serviceId === 'gateway') {
            if (!['start', 'stop', 'restart'].includes(action))
                throw clientError('local_ai_service_action_not_allowed', '控制网关不支持该动作。');
            await this.gatewayControl(action);
            if (action === 'stop') {
                await new Promise((resolve: any): any => setTimeout(resolve, 500));
                return this.controlOverview();
            }
            let snapshot: any = unavailableControl();
            for (let attempt: any = 0; attempt < 30; attempt += 1) {
                await new Promise((resolve: any): any => setTimeout(resolve, 500));
                snapshot = await this.controlOverview();
                if (snapshot.services.some((service: any): any => service.id === 'gateway' && service.state === 'running'))
                    return snapshot;
            }
            return snapshot;
        }
        await this.#request(`/v1/control/services/${encodeURIComponent(serviceId)}/${encodeURIComponent(action)}`, {
            method: 'POST',
            signal: AbortSignal.timeout(action === 'start' || action === 'restart' ? 180000 : 30000),
        });
        return this.controlOverview();
    }
    async updateServicePolicy(serviceId: any, { mode, idleSeconds = 900 }: any = {}): Promise<any> {
        if (!SERVICE_IDS.has(serviceId) || !['on_demand', 'always_on', 'disabled'].includes(mode))
            throw clientError('local_ai_service_policy_not_allowed', '未登记的服务策略。');
        await this.#request(`/v1/control/services/${encodeURIComponent(serviceId)}/policy`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode, idle_seconds: Math.max(60, Math.min(Number(idleSeconds) || 900, 86400)) }),
            signal: AbortSignal.timeout(180000),
        });
        return this.controlOverview();
    }
    async #request(path: any, options: any = {}): Promise<any> {
        let response: any;
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, options);
        }
        catch (error: any) {
            throw clientError('local_ai_control_unavailable', error?.message || '本机 AI 控制网关不可用。', 503);
        }
        const body: any = await response.json().catch((): any => ({}));
        if (!response.ok) {
            throw clientError(String(body?.detail?.code || 'local_ai_control_failed').slice(0, 80), String(body?.detail?.message || '本机 AI 服务控制失败。').slice(0, 500), response.status);
        }
        return body;
    }
}
function validEvidenceTime(value: any): any {
    const text: any = String(value || '').trim();
    return Number.isFinite(Date.parse(text)) ? text : null;
}
function sanitizeService(item: any): any {
    const id: any = String(item?.id || '');
    if (!SERVICE_IDS.has(id))
        return null;
    const mode: any = String(item?.mode || 'on_demand');
    return {
        id,
        name: String(item?.name || id).slice(0, 100),
        node: item?.node === 'windows' ? 'windows' : 'mac',
        endpoint: String(item?.endpoint || '').slice(0, 120),
        mode: SERVICE_MODES.has(mode) ? mode : 'on_demand',
        state: ['running', 'stopped', 'ready', 'offline', 'unknown'].includes(item?.state) ? item.state : 'unknown',
        actions: id === 'gateway'
            ? ['start', 'stop', 'restart']
            : (Array.isArray(item?.actions) ? item.actions : []).filter((action: any): any => SERVICE_ACTIONS.has(action)),
        detail: String(item?.detail || '').slice(0, 300),
        idleSeconds: Number.isFinite(item?.idleSeconds) ? item.idleSeconds : null,
        managed: item?.managed === true ? true : item?.managed === false ? false : null,
    };
}
function buildCategories(routing: any[], services: any[]): any[] {
    const normalized: any = normalizeRouting(routing);
    const serviceMap: any = new Map(services.map((service: any): any => [service.id, service]));
    return CAPABILITY_CATEGORIES.map((category: any): any => {
        const capSet: any = new Set(category.capabilities);
        const matchedRoutes: any = normalized.filter((route: any): any => capSet.has(route.capability));
        const ready: any = matchedRoutes.filter((route: any): any => route.providers.length > 0).length;
        const serviceIds: any = new Set();
        for (const route of matchedRoutes) {
            for (const provider of route.providers) {
                const mapped: any = providerToServiceId(provider);
                if (mapped && SERVICE_IDS.has(mapped)) serviceIds.add(mapped);
            }
        }
        for (const fallbackId of CATEGORY_SERVICE_FALLBACK[category.id] || []) {
            if (serviceMap.has(fallbackId)) serviceIds.add(fallbackId);
        }
        const providers: any = new Set();
        for (const route of matchedRoutes) {
            for (const provider of route.providers) {
                providers.add(provider);
            }
        }
        return {
            id: category.id,
            label: category.label,
            capabilities: category.capabilities,
            readyCount: ready,
            totalCount: category.capabilities.length,
            serviceIds: [...serviceIds],
            providers: [...providers],
        };
    });
}

function providerToServiceId(provider: any): any {
    const text: any = String(provider || '').trim();
    const lower: any = text.toLowerCase();
    // Handle "serviceId/capability" format (used in tests)
    if (text.includes('/')) {
        const id: any = text.split('/')[0]?.trim() || '';
        if (id && SERVICE_IDS.has(id)) return id;
    }
    // Handle human-readable provider names from gateway
    if (lower.includes('qwen3.5') || lower.includes('qwen35')) return 'qwen35';
    if (lower.includes('qwen3.6') || lower.includes('qwen36')) return 'qwen36-candidate';
    if (lower.includes('whisper') || lower.includes('asr')) return 'speech-tools';
    if (lower.includes('tts')) return 'speech-tools';
    if (lower.includes('mflux')) return 'mflux';
    if (lower.includes('comfyui') || lower.includes('4070')) return 'comfyui';
    if (lower.includes('embedding')) return 'embedding';
    if (lower.includes('reranker')) return 'reranker';
    if (lower.includes('desktop-node')) return 'desktop-node';
    return null;
}

function normalizeRouting(routing: any[]): any[] {
    const expanded: any[] = [];
    const seen: any = new Set();
    for (const route of routing) {
        const capability: any = String(route?.capability || '').trim();
        if (!capability) continue;
        const parts: any = capability.split('/').map((part: any): any => part.trim()).filter(Boolean);
        if (parts.length > 1) {
            for (const part of parts) {
                const mapped: any = mapCombinedCapability(part);
                if (mapped && !seen.has(mapped)) {
                    seen.add(mapped);
                    expanded.push({ capability: mapped, providers: Array.isArray(route?.providers) ? route.providers : [] });
                }
            }
        } else if (!seen.has(capability)) {
            seen.add(capability);
            expanded.push({ capability, providers: Array.isArray(route?.providers) ? route.providers : [] });
        }
    }
    return expanded;
}

function mapCombinedCapability(part: any): any {
    const text: any = String(part || '').toLowerCase();
    if (text.includes('text') || text.includes('语言模型') || text.includes('模型')) return 'text.generate';
    if (text.includes('vision') || text.includes('视觉')) return 'vision.analyze';
    if (text.includes('video')) return 'video.analyze';
    if (text.includes('audio') && text.includes('transcribe')) return 'audio.transcribe';
    if (text.includes('audio') && text.includes('synthesize')) return 'audio.synthesize';
    if (text.includes('image') && text.includes('generate')) return 'image.generate';
    if (text.includes('image') && text.includes('edit')) return 'image.edit';
    return null;
}
function unavailableControl(): any {
    return {
        status: 'degraded',
        services: [{
                id: 'gateway',
                name: 'Mac AI 控制网关',
                node: 'mac',
                endpoint: '127.0.0.1:18082',
                mode: 'always_on',
                state: 'stopped',
                actions: ['start', 'restart'],
                detail: '轻量控制网关已停止；A君仍可重新启动。',
                idleSeconds: null,
                managed: null,
            }],
        routing: [],
        categories: buildCategories([], []),
    };
}
async function controlGatewayLaunchAgent(action: any): Promise<any> {
    const uid = process.getuid?.();
    if (!Number.isInteger(uid)) throw clientError('local_ai_gateway_control_unsupported', '当前系统不支持本机 LaunchAgent 控制。', 501);
    const target: any = `gui/${uid}/com.agent-army.local-ai.gateway`;
    const args: any = action === 'start'
        ? ['kickstart', target]
        : action === 'restart'
            ? ['kickstart', '-k', target]
            : ['kill', 'SIGTERM', target];
    try {
        await execFileAsync('/bin/launchctl', args, { timeout: 20000, windowsHide: true });
    }
    catch (error: any) {
        throw clientError('local_ai_gateway_control_failed', String(error?.stderr || error?.message || '控制网关操作失败。').slice(-500), 503);
    }
}
function unavailable(): any {
    return {
        status: 'unavailable',
        node: 'm1-max-primary',
        readyCount: 0,
        capabilities: [],
        desktopEnhancement: { configured: false, healthy: false },
        safeMessage: '本机 AI 网关未就绪。',
    };
}
function normalizeLoopbackUrl(value: any): any {
    const parsed: any = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
        || parsed.username
        || parsed.password) {
        throw clientError('local_ai_gateway_not_loopback', '本机 AI 客户端只允许连接回环网关。');
    }
    return parsed.origin;
}
function clientError(code: any, message: any, httpStatus: any = 422, retryable: any = false): any {
    const normalizedStatus: any = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 422;
    return Object.assign(new Error(message), { code, category: retryable ? 'retryable' : 'manual', retryable, httpStatus: normalizedStatus });
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync: any = promisify(execFile);
