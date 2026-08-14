import http from 'node:http';
import path from 'node:path';
import { createPublisherRuntime } from './runtime.ts';
import { coded } from './policy.ts';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4390;
const MAX_JSON_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function createPublisherGatewayService({ mode = 'disabled', host = DEFAULT_HOST, port = DEFAULT_PORT, workspaceRoot, ledgerPath, paperclipControl, paperclipApiBase, paperclipApiKey, dailyRoutineId, productionComposition = null, requestAuthorizer = null, clock = () => new Date(), fetchImpl = fetch, }: any = {}) {
    const bindHost = validateLoopbackHost(host);
    const bindPort = validatePort(port);
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === 'real' && productionComposition != null) {
        throw coded('standalone_real_publisher_denied', '独立 Publisher service 禁止注入 real production composition；真实发布只能由 A君可信入口逐请求刷新 Paperclip 批准。');
    }
    const control = normalizedMode !== 'fake'
        ? paperclipControl || null
        : paperclipControl || new HttpPaperclipPublisherControl({
            apiBase: paperclipApiBase,
            apiKey: paperclipApiKey,
            dailyRoutineId,
            clock,
            fetchImpl,
        });
    let runtime: any = null;
    let runtimePromise: any = null;
    const getRuntime = async () => {
        if (runtime)
            return runtime;
        if (runtimePromise)
            return runtimePromise;
        runtimePromise = Promise.resolve().then(() => {
            if (normalizedMode === 'disabled')
                return null;
            if (normalizedMode === 'real') {
                throw coded('standalone_real_publisher_denied', '独立 Publisher service 不承载真实发布；请使用会逐请求刷新 Paperclip 批准的 A君可信入口。');
            }
            return createPublisherRuntime({
                mode: 'fake',
                workspaceRoot,
                ledgerPath,
                paperclipControl: control,
                clock,
            });
        });
        try {
            runtime = await runtimePromise;
            return runtime;
        }
        catch (error: any) {
            runtimePromise = null;
            throw error;
        }
    };
    const server = http.createServer((request: any, response: any) => {
        void routeRequest({
            request,
            response,
            getRuntime,
            peekRuntime: () => runtime,
            mode: normalizedMode,
            requestAuthorizer,
            productionConfigured: false,
        });
    });
    return {
        mode: normalizedMode,
        get runtime() {
            return runtime;
        },
        server,
        async listen() {
            await listen(server, bindPort, bindHost);
            const address = server.address();
            const actualHost = typeof address === 'object' && address ? address.address : bindHost;
            const actualPort = typeof address === 'object' && address ? address.port : bindPort;
            return {
                host: actualHost,
                port: actualPort,
                origin: `http://${formatHost(actualHost)}:${actualPort}`,
                mode: normalizedMode,
            };
        },
        async close() {
            if (!server.listening)
                return;
            await new Promise((resolve: any, reject: any) => {
                server.close((error: any) => error ? reject(error) : resolve());
            });
        },
    };
}
export function createPublisherGatewayServiceFromEnv(env: any = process.env, options: any = {}) {
    const mode = normalizeMode(env.M5_PUBLISHER_MODE);
    return createPublisherGatewayService({
        mode,
        host: env.M5_PUBLISHER_HOST || DEFAULT_HOST,
        port: env.M5_PUBLISHER_PORT === undefined
            ? DEFAULT_PORT
            : Number(env.M5_PUBLISHER_PORT),
        workspaceRoot: mode === 'fake'
            ? configuredAbsolutePath(env.M5_PUBLISHER_WORKSPACE_ROOT, 'M5_PUBLISHER_WORKSPACE_ROOT', mode)
            : undefined,
        ledgerPath: mode === 'fake'
            ? configuredAbsolutePath(env.M5_PUBLISHER_LEDGER_PATH, 'M5_PUBLISHER_LEDGER_PATH', mode)
            : undefined,
        paperclipApiBase: env.M5_PUBLISHER_PAPERCLIP_API_BASE,
        paperclipApiKey: env.M5_PUBLISHER_PAPERCLIP_API_KEY,
        dailyRoutineId: env.M5_PUBLISHER_DAILY_ROUTINE_ID,
        // The standalone service never accepts real production composition.
        // Real publication stays in A君's trusted per-request approval refresh path.
        productionComposition: options.productionComposition || null,
        requestAuthorizer: options.requestAuthorizer || null,
        ...options,
    });
}
export class HttpPaperclipPublisherControl {
    apiBase: any;
    apiKey: any;
    clock: any;
    dailyRoutineId: any;
    fetchImpl: any;
    constructor({ apiBase, apiKey, dailyRoutineId, clock = () => new Date(), fetchImpl = fetch, }: any = {}) {
        this.apiBase = validateLoopbackOrigin(apiBase);
        this.apiKey = String(apiKey || '').trim();
        this.dailyRoutineId = opaqueId(dailyRoutineId, 'M5 Publisher 必须显式绑定每日 Routine ID。');
        this.clock = clock;
        this.fetchImpl = fetchImpl;
    }
    async assertPublishAllowed({ campaignId, checkedAt }: any = {}) {
        const item = await this.getCampaignCase(campaignId);
        const trigger = await this.getDailyTrigger(item);
        const grant = item.fields?.campaignGrant;
        const now = validDate(checkedAt) || this.clock();
        if (item.parentCaseId
            || item.stageKey !== 'campaign_active'
            || grant?.status !== 'active'
            || trigger.enabled !== true
            || Date.parse(grant.startsAt) > now.getTime()
            || Date.parse(grant.expiresAt) <= now.getTime()) {
            throw coded('campaign_not_active', 'Paperclip CampaignGrant 未激活、已过期、父 Case 阶段错误或每日 Cron 未启用。');
        }
        return {
            campaignId: item.id,
            grantStatus: 'active',
            cronStatus: 'enabled',
            currentStage: item.stageKey,
            canonicalGrant: structuredClone(grant),
            checkedAt: now.toISOString(),
        };
    }
    async pauseCampaignAndDisableCron({ campaignId, reason, idempotencyKey }: any = {}) {
        let item = await this.getCampaignCase(campaignId);
        let trigger = await this.getDailyTrigger(item);
        if (trigger.enabled !== false) {
            await this.request('PATCH', `/api/routine-triggers/${encodeURIComponent(trigger.id)}`, { enabled: false });
        }
        const grant = item.fields?.campaignGrant;
        if (grant?.status !== 'paused') {
            const now = this.clock().toISOString();
            const patched = await this.request('PATCH', `/api/cases/${encodeURIComponent(item.id)}`, {
                expectedVersion: item.version,
                fields: {
                    ...(item.fields || {}),
                    campaignGrant: {
                        ...grant,
                        status: 'paused',
                        pausedAt: now,
                        pauseReason: safeReason(reason),
                    },
                },
            });
            item = normalizeCase(patched);
        }
        item = await this.getCampaignCase(campaignId);
        trigger = await this.getDailyTrigger(item);
        if (item.fields?.campaignGrant?.status !== 'paused' || trigger.enabled !== false) {
            throw coded('paperclip_pause_unverified', 'Paperclip 没有回读确认 CampaignGrant 已暂停且每日 Cron 已关闭。');
        }
        return {
            campaignId: item.id,
            grantStatus: 'paused',
            cronStatus: 'disabled',
            controlEventId: String(idempotencyKey || `publisher-pause:${item.id}`),
        };
    }
    async getCampaignCase(campaignId: any) {
        const id = opaqueId(campaignId, 'M5 Publisher campaignId 无效。');
        return normalizeCase(await this.request('GET', `/api/cases/${encodeURIComponent(id)}`));
    }
    async getDailyTrigger(item: any) {
        const detail = await this.request('GET', `/api/routines/${encodeURIComponent(this.dailyRoutineId)}`);
        const projectId = item.fields?.projectId || item.pipeline?.projectId || null;
        if (!projectId || detail?.projectId !== projectId) {
            throw coded('publisher_routine_scope_mismatch', '每日 Routine 与 Campaign Case 不属于同一个 Paperclip Project。');
        }
        const triggers = list(detail?.triggers).filter((entry: any) => entry.kind === 'schedule');
        if (triggers.length !== 1 || typeof triggers[0].enabled !== 'boolean') {
            throw coded('publisher_daily_trigger_invalid', `每日 Routine 必须恰好有一个明确状态的 schedule trigger，当前为 ${triggers.length} 个。`);
        }
        return triggers[0];
    }
    async request(method: any, requestPath: any, body: any = undefined) {
        const response = await this.fetchImpl(`${this.apiBase}${requestPath}`, {
            method,
            headers: {
                accept: 'application/json',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed: any = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch {
            parsed = null;
        }
        if (!response.ok) {
            throw coded('paperclip_control_unavailable', `Paperclip ${method} ${requestPath} 失败：HTTP ${response.status}。`);
        }
        return parsed;
    }
}
async function routeRequest({ request, response, getRuntime, peekRuntime, mode, requestAuthorizer, productionConfigured, }: any) {
    try {
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
            return json(response, 403, { error: 'publisher_loopback_only' });
        }
        const url = new URL(request.url || '/', 'http://publisher.local');
        if (request.method === 'GET' && url.pathname === '/health') {
            const activeRuntime = peekRuntime();
            const safety = activeRuntime ? await activeRuntime.getSafetyStatus() : null;
            return json(response, 200, {
                status: mode === 'disabled' ? 'disabled' : 'ok',
                mode,
                hardStop: safety?.active === true,
                realConnectorsConfigured: mode === 'real' && productionConfigured,
            });
        }
        if (mode === 'disabled') {
            return json(response, 503, {
                error: 'publisher_runtime_disabled',
                message: 'Publisher Gateway 默认关闭，未执行任何发布或指标动作。',
            });
        }
        if (request.method === 'POST' && url.pathname === '/publish') {
            const input = await readJson(request);
            await authorizeWriteRequest({
                requestAuthorizer,
                request,
                action: 'publisher.publish',
                campaignId: input.campaignId,
            });
            return json(response, 200, await (await getRuntime()).publish(input));
        }
        if (request.method === 'POST' && url.pathname === '/metrics') {
            const input = await readJson(request);
            const authorization = await authorizeWriteRequest({
                requestAuthorizer,
                request,
                action: 'publisher.read_own_metrics',
                campaignId: header(request, 'x-paperclip-campaign-id'),
            });
            return json(response, 200, await (await getRuntime()).collectMetricSnapshot({
                ...input,
                campaignId: authorization.campaignId,
            }));
        }
        const receiptMatch = url.pathname.match(/^\/receipts\/([^/]+)$/);
        if (request.method === 'GET' && receiptMatch) {
            const identifier = decodeURIComponent(receiptMatch[1]);
            if (!identifier || identifier.length > 320) {
                return json(response, 400, { error: 'invalid_receipt_identifier' });
            }
            const receipt = await (await getRuntime()).getReceipt(identifier);
            if (!receipt)
                return json(response, 404, { error: 'publish_receipt_not_found' });
            return json(response, 200, { receipt });
        }
        return json(response, 404, { error: 'not_found' });
    }
    catch (error: any) {
        const status = httpStatus(error);
        return json(response, status, {
            error: String(error?.code || 'publisher_service_failed'),
            message: String(error?.message || 'Publisher Gateway 请求失败。'),
        });
    }
}
async function authorizeWriteRequest({ requestAuthorizer, request, action, campaignId, }: any) {
    if (typeof requestAuthorizer?.authorize !== 'function') {
        throw coded('publisher_request_authorizer_required', 'Publisher 写接口缺少可信 Paperclip Run requestAuthorizer，Runtime 保持未初始化。');
    }
    const authorization = header(request, 'authorization');
    const runId = header(request, 'x-paperclip-run-id');
    const issueId = header(request, 'x-paperclip-issue-id');
    const bodyCampaignId = String(campaignId || '').trim();
    const headerCampaignId = header(request, 'x-paperclip-campaign-id');
    const presentedCampaignId = headerCampaignId;
    const authorizationId = header(request, 'x-paperclip-authorization-id');
    if (!/^Bearer\s+\S+$/i.test(authorization)
        || !validAuthorizationReference(runId)
        || !validAuthorizationReference(issueId)
        || !validAuthorizationReference(presentedCampaignId)
        || !validAuthorizationReference(authorizationId)) {
        throw coded('publisher_request_unauthorized', 'Publisher 写接口缺少完整的 Paperclip Run、Issue、Campaign 或一次性授权身份。');
    }
    if (action === 'publisher.publish' && bodyCampaignId !== headerCampaignId) {
        throw coded('publisher_authorization_scope_mismatch', '发布请求的 Campaign 与 Paperclip 一次性授权范围不一致。');
    }
    let result;
    try {
        result = await requestAuthorizer.authorize({
            action,
            bearerToken: authorization.replace(/^Bearer\s+/i, ''),
            runId,
            issueId,
            campaignId: presentedCampaignId,
            authorizationId,
        });
    }
    catch {
        throw coded('publisher_request_unauthorized', 'Paperclip Run 写入授权核验失败。');
    }
    if (result?.replayed === true) {
        throw coded('publisher_authorization_replayed', 'Paperclip 一次性发布授权已经使用，拒绝重放。');
    }
    if (result?.authorized !== true
        || result.action !== action
        || result.runId !== runId
        || result.issueId !== issueId
        || result.campaignId !== presentedCampaignId
        || result.authorizationId !== authorizationId) {
        throw coded('publisher_authorization_scope_mismatch', 'Paperclip 写入授权与 action、Run、Issue 或 Campaign 不一致。');
    }
    return result;
}
async function readJson(request: any) {
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
        throw coded('invalid_json_body', 'Publisher Gateway 只接受 application/json。');
    }
    const chunks: any[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_JSON_BYTES) {
            throw coded('request_body_too_large', 'Publisher Gateway 请求体超过 256 KiB。');
        }
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('object required');
        return parsed;
    }
    catch {
        throw coded('invalid_json_body', 'Publisher Gateway 请求体必须是 JSON 对象。');
    }
}
function json(response: any, status: any, payload: any) {
    if (response.headersSent)
        return;
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(`${JSON.stringify(payload)}\n`);
}
function httpStatus(error: any) {
    if (['invalid_json_body', 'request_body_too_large'].includes(error?.code))
        return 400;
    if (error?.code === 'publisher_request_unauthorized')
        return 401;
    if (error?.code === 'publisher_authorization_scope_mismatch')
        return 403;
    if (error?.code === 'publisher_authorization_replayed')
        return 409;
    if ([
        'publisher_request_authorizer_required',
        'production_composition_required',
        'standalone_real_publisher_denied',
    ]
        .includes(error?.code)) {
        return 503;
    }
    return error?.isPublisherError === true ? 422 : 500;
}
function header(request: any, name: any) {
    const value = request.headers[String(name).toLowerCase()];
    return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}
function validAuthorizationReference(value: any) {
    return /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/.test(String(value || ''));
}
function normalizeMode(value: any) {
    const mode = String(value || '').trim().toLowerCase();
    if (!mode || mode === 'off')
        return 'disabled';
    if (!['disabled', 'fake', 'real'].includes(mode)) {
        throw coded('invalid_publisher_mode', 'Publisher 服务模式只允许 disabled、fake 或 real。');
    }
    return mode;
}
function validateLoopbackHost(value: any) {
    const host = String(value || DEFAULT_HOST).trim().toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
        throw coded('publisher_service_host_denied', 'Publisher Gateway 只能绑定 127.0.0.1、::1 或 localhost。');
    }
    return host;
}
function validatePort(value: any) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw coded('invalid_publisher_port', 'Publisher Gateway 端口必须是 0–65535 的整数。');
    }
    return port;
}
function validateLoopbackOrigin(value: any) {
    let url;
    try {
        url = new URL(String(value || ''));
    }
    catch {
        throw coded('invalid_paperclip_origin', 'Paperclip API 必须是合法的 loopback HTTP origin。');
    }
    if (url.protocol !== 'http:'
        || !LOOPBACK_HOSTS.has(url.hostname)
        || url.pathname !== '/'
        || url.search
        || url.hash) {
        throw coded('invalid_paperclip_origin', 'Paperclip API 只允许 loopback HTTP origin。');
    }
    return url.origin;
}
function configuredAbsolutePath(value: any, name: any, mode: any) {
    if (mode === 'disabled')
        return undefined;
    const configured = String(value || '').trim();
    if (!configured || !path.isAbsolute(configured)) {
        throw coded('publisher_service_config_invalid', `${name} 必须是显式绝对路径。`);
    }
    return configured;
}
function opaqueId(value: any, message: any) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/.test(id))
        throw coded('invalid_paperclip_reference', message);
    return id;
}
function normalizeCase(value: any) {
    const item = value?.case ?? value;
    const result: Record<string, any> = {
        ...(item || {}),
        stageKey: value?.stage?.key ?? item?.stageKey ?? null,
        pipeline: value?.pipeline ?? item?.pipeline ?? null,
    };
    if (!result.id || !result.fields?.campaignGrant) {
        throw coded('campaign_case_invalid', 'Paperclip 没有返回可信活动父 Case。');
    }
    return result;
}
function safeReason(value: any) {
    return String(value || 'publisher_safety_stop').replace(/\s+/g, ' ').trim().slice(0, 500);
}
function validDate(value: any) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}
function list(value: any) {
    return Array.isArray(value) ? value : [];
}
function isLoopbackAddress(value: any) {
    return LOOPBACK_ADDRESSES.has(String(value || ''));
}
function formatHost(host: any) {
    return host.includes(':') ? `[${host}]` : host;
}
async function listen(server: any, port: any, host: any) {
    await new Promise((resolve: any, reject: any) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
}
