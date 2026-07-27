const ALLOWED_STATUSES = new Set(['active', 'expiring', 'expired', 'revoked', 'disabled', 'error']);
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AccessConnectionService {
  constructor({
    baseUrl = process.env.XIAOD_RUNTIME_URL || 'http://127.0.0.1:4318',
    fetchImpl = fetch,
    timeoutMs = 2500
  } = {}) {
    this.baseUrl = normalizeLoopbackOrigin(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async list() {
    try {
      const payload = await this.request('/api/connections');
      return {
        status:'ready',
        connections:Array.isArray(payload.connections) ? payload.connections.map(sanitizeConnection).filter(Boolean) : []
      };
    } catch {
      return {
        status:'unavailable',
        message:'小D账号连接状态暂时不可用。',
        connections:[]
      };
    }
  }

  async revoke(connectionId) {
    const id = String(connectionId || '').trim();
    if (!CONNECTION_ID.test(id)) throw new AccessConnectionError('账号连接标识格式不正确。');
    const payload = await this.request(`/api/connections/${encodeURIComponent(id)}/revoke`, { method:'POST' });
    const connection = sanitizeConnection(payload.connection);
    if (!connection) throw new AccessConnectionError('账号连接服务返回了无效状态。');
    return connection;
  }

  async request(pathname, options = {}) {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
      ...options,
      headers:{ accept:'application/json', ...(options.headers || {}) },
      signal:AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AccessConnectionError(String(payload.error || '账号连接服务暂时不可用。'));
    return payload;
  }
}

export class AccessConnectionError extends Error {}

function sanitizeConnection(connection) {
  if (!connection || typeof connection !== 'object' || !CONNECTION_ID.test(String(connection.connectionId || ''))) return null;
  const status = ALLOWED_STATUSES.has(connection.status) ? connection.status : 'error';
  return {
    connectionId:String(connection.connectionId),
    provider:safeText(connection.provider, 64),
    accountAlias:safeText(connection.accountAlias, 80),
    status,
    allowedAgentIds:safeList(connection.allowedAgentIds, 64),
    grantedOperations:safeList(connection.grantedOperations, 80),
    dataScope:safeList(connection.dataScope, 80),
    expiresAt:safeDate(connection.expiresAt),
    lastHealthAt:safeDate(connection.lastHealthAt),
    hasCredentialReference:connection.hasCredentialReference === true
  };
}

function safeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function safeList(value, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, 24);
}

function safeDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeLoopbackOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\d{2,5}$/.test(url.port) || url.pathname !== '/') {
    throw new AccessConnectionError('账号连接服务必须使用固定的本机回环地址。');
  }
  return url.origin;
}
