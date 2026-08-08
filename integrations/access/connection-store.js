import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMutationSerializer, hardenPrivateFile, writePrivateJson } from './private-json-store.js';

const VALID_STATUSES = new Set(['active', 'expiring', 'expired', 'revoked', 'disabled', 'error']);
const VALID_BROWSERS = new Set(['chrome', 'chromium', 'brave', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale']);
const COOKIE_BRIDGE_PROVIDERS = new Set(['xhs', 'dy', 'bili', 'ks']);

export class ConnectionInputError extends Error {}

export class ConnectionStore {
  constructor(workDir) {
    this.file = path.join(workDir, 'connections.json');
    this.connections = new Map();
    this.serializeMutation = createMutationSerializer();
  }

  async runMutation(operation) {
    return this.serializeMutation(async () => {
      const snapshot = [...this.connections.entries()].map(([id, connection]) => [id, structuredClone(connection)]);
      try {
        return await operation();
      } catch (error) {
        this.connections = new Map(snapshot);
        throw error;
      }
    });
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const records = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const defaultProviders = new Set();
      let changed = false;
      for (const record of records) {
        const normalizedDefault = record.isDefault === true
          && !defaultProviders.has(record.provider)
          && record.status === 'active';
        if (record.isDefault !== normalizedDefault) changed = true;
        record.isDefault = normalizedDefault;
        if (record.isDefault) defaultProviders.add(record.provider);
        const normalizedVerification = normalizeStoredVerification(record.lastVerification);
        if (JSON.stringify(record.lastVerification || null) !== JSON.stringify(normalizedVerification)) changed = true;
        record.lastVerification = normalizedVerification;
        this.connections.set(record.connectionId, record);
      }
      const activeByProvider = new Map();
      for (const connection of this.connections.values()) {
        if (connection.status !== 'active') continue;
        const group = activeByProvider.get(connection.provider) || [];
        group.push(connection);
        activeByProvider.set(connection.provider, group);
      }
      for (const [provider, active] of activeByProvider) {
        if (active.length !== 1 || defaultProviders.has(provider)) continue;
        active[0].isDefault = true;
        defaultProviders.add(provider);
        changed = true;
      }
      if (changed) await this.persist();
      else await hardenPrivateFile(this.file);
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
    return this.runMutation(async () => {
      const now = new Date().toISOString();
      const connectionId = crypto.randomUUID();
      const hasActiveProviderConnection = [...this.connections.values()]
        .some((connection) => connection.provider === definition.provider && connection.status === 'active');
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
        isDefault: !hasActiveProviderConnection,
        expiresAt: null,
        lastHealthAt: null,
        lastVerification: null,
        createdAt: now,
        updatedAt: now
      };
      this.connections.set(connectionId, connection);
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async updateStatus(connectionId, status) {
    if (!VALID_STATUSES.has(status)) throw new ConnectionInputError('不支持的连接状态。');
    return this.runMutation(async () => {
      const connection = this.get(connectionId);
      if (!connection) return null;
      connection.status = status;
      if (status !== 'active') connection.isDefault = false;
      connection.updatedAt = new Date().toISOString();
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async revoke(connectionId) { return this.updateStatus(connectionId, 'revoked'); }

  async disable(connectionId) { return this.updateStatus(connectionId, 'disabled'); }

  async reauthorizeCookieBridgeConnection(connectionId, input = {}) {
    return this.runMutation(async () => {
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
      if (![...this.connections.values()].some((candidate) => (
        candidate.connectionId !== connection.connectionId
        && candidate.provider === connection.provider
        && candidate.status === 'active'
        && candidate.isDefault === true
      ))) connection.isDefault = true;
      connection.expiresAt = null;
      connection.updatedAt = now;
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async markHealth(connectionId) {
    return this.runMutation(async () => {
      const connection = this.get(connectionId);
      if (!connection) return null;
      const now = new Date().toISOString();
      connection.lastHealthAt = now;
      connection.updatedAt = now;
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async setDefault(connectionId) {
    return this.runMutation(async () => {
      const connection = this.get(connectionId);
      if (!connection) return null;
      if (connection.status !== 'active') throw new ConnectionInputError('只有当前可用的账号连接才能设为默认。');
      const now = new Date().toISOString();
      for (const candidate of this.connections.values()) {
        if (candidate.provider !== connection.provider) continue;
        candidate.isDefault = candidate.connectionId === connection.connectionId;
        candidate.updatedAt = now;
      }
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async recordVerification(connectionId, input = {}) {
    return this.runMutation(async () => {
      const connection = this.get(connectionId);
      if (!connection) return null;
      connection.lastVerification = normalizeVerification(input);
      connection.updatedAt = connection.lastVerification.at;
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async persist() {
    await writePrivateJson(this.file, [...this.connections.values()]);
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

function normalizeVerification(input = {}) {
  const status = input.status === 'succeeded' ? 'succeeded' : 'failed';
  return {
    status,
    at: new Date().toISOString(),
    adapterId: String(input.adapterId || '').trim().slice(0, 100) || null,
    capabilities: normalizeSafeList(input.capabilities, 80),
    failureCode: status === 'failed'
      ? String(input.failureCode || 'adapter_unavailable').trim().slice(0, 100)
      : null
  };
}

function normalizeStoredVerification(input) {
  if (!input || typeof input !== 'object') return null;
  const timestamp = Date.parse(String(input.at || ''));
  if (!Number.isFinite(timestamp)) return null;
  return {
    status: input.status === 'succeeded' ? 'succeeded' : 'failed',
    at: new Date(timestamp).toISOString(),
    adapterId: String(input.adapterId || '').trim().slice(0, 100) || null,
    capabilities: normalizeSafeList(input.capabilities, 80),
    failureCode: input.status === 'succeeded'
      ? null
      : String(input.failureCode || 'adapter_unavailable').trim().slice(0, 100)
  };
}

function normalizeSafeList(value, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))].slice(0, 24);
}
