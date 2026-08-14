import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const ALLOWED_STATUSES: any = new Set(['active', 'expiring', 'expired', 'revoked', 'disabled', 'error']);
const CONNECTION_ID: any = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID: any = /^[a-zA-Z0-9_-]{1,128}$/;
const PROVIDERS: any = Object.freeze({
    xhs: { label: '小红书', loginUrl: 'https://www.xiaohongshu.com/' },
    dy: { label: '抖音', loginUrl: 'https://www.douyin.com/' },
    bili: { label: '哔哩哔哩', loginUrl: 'https://www.bilibili.com/' },
    ks: { label: '快手', loginUrl: 'https://www.kuaishou.com/' }
});
const execFileAsync: any = promisify(execFile);
export class AccessConnectionService {
    baseUrl: any;
    browserLauncher: any;
    fetchImpl: any;
    timeoutMs: any;
    constructor({ baseUrl = process.env.XIAOD_RUNTIME_URL || 'http://127.0.0.1:4318', fetchImpl = fetch, timeoutMs = 2500, browserLauncher = launchChrome }: any = {}) {
        this.baseUrl = normalizeLoopbackOrigin(baseUrl);
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.browserLauncher = browserLauncher;
    }
    async list(): Promise<any> {
        try {
            const payload: any = await this.request('/api/connections');
            return {
                status: 'ready',
                connections: Array.isArray(payload.connections) ? payload.connections.map(sanitizeConnection).filter(Boolean) : []
            };
        }
        catch {
            return {
                status: 'unavailable',
                message: '小D账号连接状态暂时不可用。',
                connections: []
            };
        }
    }
    async overview(): Promise<any> {
        const [connections, acquisition] = await Promise.all([
            this.list(),
            this.acquisitionStatus()
        ]);
        return { ...connections, acquisition };
    }
    async acquisitionStatus(): Promise<any> {
        try {
            const payload: any = await this.request('/api/health');
            const adapters: any = Array.isArray(payload?.commonAccess?.adapters)
                ? payload.commonAccess.adapters.map(sanitizeAdapter).filter(Boolean)
                : [];
            return {
                status: payload?.ok === true && payload?.commonAccess?.contentAcquisitionCenter === true
                    ? 'ready'
                    : 'unavailable',
                mediaCrawlerDeep: payload?.capabilities?.mediaCrawlerDeep === true,
                adapters
            };
        }
        catch {
            return {
                status: 'unavailable',
                mediaCrawlerDeep: false,
                adapters: []
            };
        }
    }
    async revoke(connectionId: any): Promise<any> {
        const id: any = normalizeConnectionId(connectionId);
        const payload: any = await this.request(`/api/connections/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
        const connection: any = sanitizeConnection(payload.connection);
        if (!connection)
            throw new AccessConnectionError('账号连接服务返回了无效状态。');
        return connection;
    }
    async disable(connectionId: any): Promise<any> {
        const id: any = normalizeConnectionId(connectionId);
        const payload: any = await this.request(`/api/connections/${encodeURIComponent(id)}/disable`, { method: 'POST' });
        const connection: any = sanitizeConnection(payload.connection);
        if (!connection)
            throw new AccessConnectionError('账号连接服务返回了无效状态。');
        return connection;
    }
    async setDefault(connectionId: any): Promise<any> {
        const id: any = normalizeConnectionId(connectionId);
        const payload: any = await this.request(`/api/connections/${encodeURIComponent(id)}/default`, { method: 'POST' });
        const connection: any = sanitizeConnection(payload.connection);
        if (!connection)
            throw new AccessConnectionError('账号连接服务返回了无效状态。');
        return connection;
    }
    async loginOptions(): Promise<any> {
        const payload: any = await this.request('/api/cookie-bridge/accounts');
        const accounts: any = Array.isArray(payload.accounts) ? payload.accounts.map(sanitizeAccount).filter(Boolean) : [];
        return {
            providers: Object.entries(PROVIDERS).map(([id, provider]: any): any => ({ id, label: provider.label })),
            accounts
        };
    }
    async openLogin(provider: any): Promise<any> {
        const id: any = normalizeProvider(provider);
        await this.browserLauncher(PROVIDERS[id].loginUrl);
        return { provider: id, status: 'opened', message: `已在 Google Chrome 打开${PROVIDERS[id].label}登录页。` };
    }
    async create(input: any): Promise<any> {
        const definition: any = connectionInput(input);
        const payload: any = await this.request('/api/connections/cookie-bridge', jsonPost({
            ...definition,
            grantedOperations: ['read_media_metadata', 'read_content_images', 'download_authorized_media'],
            dataScope: ['content:read'],
            allowedAgentIds: ['xiaod']
        }));
        const connection: any = sanitizeConnection(payload.connection);
        if (!connection)
            throw new AccessConnectionError('账号连接服务返回了无效状态。');
        return connection;
    }
    async reauthorize(connectionId: any, input: any): Promise<any> {
        const id: any = normalizeConnectionId(connectionId);
        const definition: any = connectionInput(input);
        const payload: any = await this.request(`/api/connections/${encodeURIComponent(id)}/reauthorize`, jsonPost(definition));
        const connection: any = sanitizeConnection(payload.connection);
        if (!connection)
            throw new AccessConnectionError('账号连接服务返回了无效状态。');
        return connection;
    }
    async request(pathname: any, options: any = {}): Promise<any> {
        const response: any = await this.fetchImpl(new URL(pathname, this.baseUrl), {
            ...options,
            headers: { accept: 'application/json', ...(options.headers || {}) },
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok)
            throw new AccessConnectionError(String(payload.error || '账号连接服务暂时不可用。'));
        return payload;
    }
}
export class AccessConnectionError extends Error {
}
function sanitizeAccount(account: any): any {
    if (!account || typeof account !== 'object' || !CLIENT_ID.test(String(account.clientId || '')) || account.connected !== true)
        return null;
    const platforms: any = safeList(account.platforms, 64).filter((provider: any): any => Object.hasOwn(PROVIDERS, provider));
    if (!platforms.length)
        return null;
    const nicknames: Record<string, any> = {};
    for (const provider of platforms)
        nicknames[provider] = safeText(account.nicknames?.[provider], 80);
    return { clientId: String(account.clientId), connected: true, platforms, nicknames };
}
function sanitizeConnection(connection: any): any {
    if (!connection || typeof connection !== 'object' || !CONNECTION_ID.test(String(connection.connectionId || '')))
        return null;
    const status: any = ALLOWED_STATUSES.has(connection.status) ? connection.status : 'error';
    return {
        connectionId: String(connection.connectionId),
        provider: safeText(connection.provider, 64),
        accountAlias: safeText(connection.accountAlias, 80),
        status,
        allowedAgentIds: safeList(connection.allowedAgentIds, 64),
        grantedOperations: safeList(connection.grantedOperations, 80),
        dataScope: safeList(connection.dataScope, 80),
        expiresAt: safeDate(connection.expiresAt),
        lastHealthAt: safeDate(connection.lastHealthAt),
        isDefault: connection.isDefault === true,
        lastVerification: sanitizeVerification(connection.lastVerification),
        hasCredentialReference: connection.hasCredentialReference === true
    };
}
function sanitizeVerification(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const at: any = safeDate(value.at);
    if (!at)
        return null;
    return {
        status: value.status === 'succeeded' ? 'succeeded' : 'failed',
        at,
        adapterId: safeText(value.adapterId, 100) || null,
        capabilities: safeList(value.capabilities, 80),
        failureCode: value.status === 'succeeded' ? null : safeText(value.failureCode, 100) || 'adapter_unavailable'
    };
}
function sanitizeAdapter(adapter: any): any {
    if (!adapter || typeof adapter !== 'object')
        return null;
    const id: any = safeText(adapter.id, 100);
    const priorityClass: any = ['specialized', 'general'].includes(adapter.priorityClass)
        ? adapter.priorityClass
        : 'general';
    const healthStatus: any = ['healthy', 'unavailable', 'degraded'].includes(adapter.healthStatus)
        ? adapter.healthStatus
        : 'unavailable';
    return id ? { id, priorityClass, healthStatus } : null;
}
function connectionInput(input: any = {}): any {
    for (const key of ['cookie', 'cookies', 'token', 'password', 'authorization', 'credential', 'credentialRef']) {
        if (Object.hasOwn(input, key))
            throw new AccessConnectionError('连接请求不得包含 Cookie、token、密码或其他原始凭据。');
    }
    const provider: any = normalizeProvider(input.provider);
    const clientId: any = String(input.clientId || '').trim();
    const accountAlias: any = safeText(input.accountAlias, 80);
    if (!CLIENT_ID.test(clientId))
        throw new AccessConnectionError('请选择已登录的受控账号。');
    if (!accountAlias)
        throw new AccessConnectionError('请填写连接名称。');
    return { provider, clientId, accountAlias };
}
function normalizeProvider(value: any): any {
    const provider: any = String(value || '').trim().toLowerCase();
    if (!Object.hasOwn(PROVIDERS, provider))
        throw new AccessConnectionError('该平台暂未开放受控登录。');
    return provider;
}
function normalizeConnectionId(value: any): any {
    const id: any = String(value || '').trim();
    if (!CONNECTION_ID.test(id))
        throw new AccessConnectionError('账号连接标识格式不正确。');
    return id;
}
function jsonPost(body: any): any {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
async function launchChrome(url: any): Promise<any> {
    try {
        await execFileAsync('/usr/bin/open', ['-a', 'Google Chrome', url], { timeout: 5000 });
    }
    catch {
        throw new AccessConnectionError('无法打开 Google Chrome，请确认浏览器已安装后重试。');
    }
}
function safeText(value: any, maxLength: any): any {
    return String(value || '').trim().slice(0, maxLength);
}
function safeList(value: any, maxLength: any): any {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter((item: any): any => typeof item === 'string').map((item: any): any => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, 24);
}
function safeDate(value: any): any {
    if (!value)
        return null;
    const timestamp: any = Date.parse(String(value));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function normalizeLoopbackOrigin(value: any): any {
    const url: any = new URL(String(value || ''));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\d{2,5}$/.test(url.port) || url.pathname !== '/') {
        throw new AccessConnectionError('账号连接服务必须使用固定的本机回环地址。');
    }
    return url.origin;
}
