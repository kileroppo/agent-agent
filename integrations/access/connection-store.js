import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_STATUSES = new Set(['active', 'expiring', 'expired', 'revoked', 'disabled', 'error']);
const VALID_BROWSERS = new Set(['chrome', 'chromium', 'brave', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale']);
const COOKIE_BRIDGE_PROVIDERS = new Set(['xhs', 'dy', 'bili', 'ks']);

export class ConnectionInputError extends Error {}

export class ConnectionStore {
  constructor(workDir) {
    this.file = path.join(workDir, 'connections.json');
    this.connections = new Map();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const records = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const record of records) this.connections.set(record.connectionId, record);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() { return [...this.connections.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toSafeConnection); }
  get(connectionId) { return this.connections.get(connectionId) || null; }
  getSafe(connectionId) { return toSafeConnection(this.get(connectionId)); }

  async createBrowserSessionConnection(input) {
    validateBrowserSessionConnection(input);
    throw new ConnectionInputError('不能建立浏览器会话账号连接。请勿把浏览器登录态交给 A君或 yt-dlp。');
  }

  async createCookieBridgeConnection(input) {
    const definition = validateCookieBridgeConnection(input);
    const now = new Date().toISOString();
    const connectionId = crypto.randomUUID();
    const connection = {
      schemaVersion: '3.0',
      connectionId,
      provider: definition.provider,
      accountAlias: definition.accountAlias,
      credentialRef: `cookiebridge:${definition.provider}:${definition.clientId}:${connectionId}`,
      credentialKind: 'cookie_bridge',
      cookieBridgeClientId: definition.clientId,
      grantedOperations: definition.grantedOperations,
      dataScope: definition.dataScope,
      allowedAgentIds: definition.allowedAgentIds,
      approvalPolicyRef: null,
      status: 'active',
      expiresAt: null,
      lastHealthAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.connections.set(connectionId, connection);
    await this.persist();
    return toSafeConnection(connection);
  }

  async updateStatus(connectionId, status) {
    if (!VALID_STATUSES.has(status)) throw new ConnectionInputError('不支持的连接状态。');
    const connection = this.get(connectionId);
    if (!connection) return null;
    connection.status = status;
    connection.updatedAt = new Date().toISOString();
    await this.persist();
    return toSafeConnection(connection);
  }

  async revoke(connectionId) { return this.updateStatus(connectionId, 'revoked'); }

  async disable(connectionId) { return this.updateStatus(connectionId, 'disabled'); }

  async reauthorizeCookieBridgeConnection(connectionId, input = {}) {
    const connection = this.get(connectionId);
    if (!connection) return null;
    if (connection.credentialKind !== 'cookie_bridge') throw new ConnectionInputError('该连接不支持通过受控账号重新授权。');
    if (input.provider !== undefined && String(input.provider).trim().toLowerCase() !== connection.provider) {
      throw new ConnectionInputError('重新授权的平台与原连接不一致。');
    }
    const definition = validateCookieBridgeConnection({
      ...input,
      provider:connection.provider,
      grantedOperations:connection.grantedOperations,
      dataScope:connection.dataScope,
      allowedAgentIds:connection.allowedAgentIds
    });
    const now = new Date().toISOString();
    connection.accountAlias = definition.accountAlias;
    connection.credentialRef = `cookiebridge:${connection.provider}:${definition.clientId}:${connection.connectionId}`;
    connection.cookieBridgeClientId = definition.clientId;
    connection.status = 'active';
    connection.expiresAt = null;
    connection.updatedAt = now;
    await this.persist();
    return toSafeConnection(connection);
  }

  async markHealth(connectionId) {
    const connection = this.get(connectionId);
    if (!connection) return null;
    const now = new Date().toISOString();
    connection.lastHealthAt = now;
    connection.updatedAt = now;
    await this.persist();
    return toSafeConnection(connection);
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.connections.values()], null, 2));
    await fs.rename(tmp, this.file);
  }
}

export function validateBrowserSessionConnection(input = {}) {
  const provider = normalizeIdentifier(input.provider, '平台');
  const accountAlias = String(input.accountAlias || '').trim();
  const browser = String(input.browser || '').trim().toLowerCase();
  const grantedOperations = normalizeStringList(input.grantedOperations, '允许动作');
  const dataScope = normalizeStringList(input.dataScope, '数据范围');
  const allowedAgentIds = normalizeStringList(input.allowedAgentIds, '允许 Agent');
  if (!accountAlias || accountAlias.length > 80) throw new ConnectionInputError('账户别名不能为空且不能超过 80 个字符。');
  if (!VALID_BROWSERS.has(browser)) throw new ConnectionInputError('浏览器类型不受支持，请选择受控浏览器。');
  rejectSecretLikeFields(input);
  return { provider, accountAlias, browser, grantedOperations, dataScope, allowedAgentIds };
}

export function validateCookieBridgeConnection(input = {}) {
  const provider = normalizeIdentifier(input.provider, '平台');
  const accountAlias = String(input.accountAlias || '').trim();
  const clientId = String(input.clientId || '').trim();
  const grantedOperations = normalizeStringList(input.grantedOperations, '允许动作');
  const dataScope = normalizeStringList(input.dataScope, '数据范围');
  const allowedAgentIds = normalizeStringList(input.allowedAgentIds, '允许 Agent');
  if (!COOKIE_BRIDGE_PROVIDERS.has(provider)) throw new ConnectionInputError('该平台暂不支持 CookieBridge 连接。');
  if (!accountAlias || accountAlias.length > 80) throw new ConnectionInputError('账户别名不能为空且不能超过 80 个字符。');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)) throw new ConnectionInputError('CookieBridge 账号标识格式不正确。');
  rejectSecretLikeFields(input);
  return { provider, accountAlias, clientId, grantedOperations, dataScope, allowedAgentIds };
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)) throw new ConnectionInputError(`${label}标识格式不正确。`);
  return normalized;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ConnectionInputError(`${label}至少需要一项。`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function rejectSecretLikeFields(input) {
  for (const key of ['cookie', 'cookies', 'token', 'password', 'authorization', 'credential', 'credentialRef']) {
    if (Object.hasOwn(input, key)) throw new ConnectionInputError('连接请求不得包含 Cookie、token、密码或其他原始凭据。');
  }
}

function toSafeConnection(connection) {
  if (!connection) return null;
  const { credentialRef, cookieBridgeClientId, ...safe } = connection;
  return { ...safe, hasCredentialReference: Boolean(credentialRef) };
}
