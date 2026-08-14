import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMutationSerializer, hardenPrivateFile, writePrivateJson } from './private-json-store.ts';

const VALID_STATUSES = new Set(['active', 'expiring', 'expired', 'revoked', 'disabled', 'error']);
const VALID_BROWSERS = new Set(['chrome', 'chromium', 'brave', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale']);
const COOKIE_BRIDGE_PROVIDERS = new Set(['xhs', 'dy', 'bili', 'ks']);

export class ConnectionInputError extends Error {}
export type ConnectionRecord = Record<string, any> & {
  connectionId: string;
  provider: string;
  accountAlias: string | null;
  credentialKind: string;
  status: string;
  grantedOperations: string[];
  dataScope: string[];
  allowedAgentIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type SafeConnection = Record<string, unknown> & Readonly<{
  connectionId: string;
  provider: string;
  accountAlias: string | null;
  credentialKind: string;
  status: string;
  grantedOperations: readonly string[];
  dataScope: readonly string[];
  allowedAgentIds: readonly string[];
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
  hasCredentialReference: boolean;
}>;
type ConnectionInput = Record<string, any>;

export class ConnectionStore {
  private readonly file: string;
  private connections: Map<string, ConnectionRecord>;
  private readonly serializeMutation: ReturnType<typeof createMutationSerializer>;

  constructor(workDir: string) {
    this.file = path.join(workDir, 'connections.json');
    this.connections = new Map();
    this.serializeMutation = createMutationSerializer();
  }

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(async () => {
      const snapshot: Array<[string, ConnectionRecord]> = [...this.connections.entries()]
        .map(([id, connection]) => [id, structuredClone(connection)]);
      try {
        return await operation();
      } catch (error) {
        this.connections = new Map(snapshot);
        throw error;
      }
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const records = JSON.parse(await fs.readFile(this.file, 'utf8')) as ConnectionRecord[];
      const defaultProviders = new Set<string>();
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
      const activeByProvider = new Map<string, ConnectionRecord[]>();
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
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  list(): SafeConnection[] {
    return [...this.connections.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toSafeConnection)
      .filter((connection): connection is SafeConnection => Boolean(connection));
  }
  get(connectionId: string) { return this.connections.get(connectionId) || null; }
  getSafe(connectionId: string) { return toSafeConnection(this.get(connectionId)); }

  async createBrowserSessionConnection(input: ConnectionInput) {
    validateBrowserSessionConnection(input);
    throw new ConnectionInputError('不能建立浏览器会话账号连接。请勿把浏览器登录态交给 A君或 yt-dlp。');
  }

  async createCookieBridgeConnection(input: ConnectionInput): Promise<SafeConnection> {
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
      return toSafeConnection(connection)!;
    });
  }

  async updateStatus(connectionId: string, status: string) {
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

  async revoke(connectionId: string) { return this.updateStatus(connectionId, 'revoked'); }

  async disable(connectionId: string) { return this.updateStatus(connectionId, 'disabled'); }

  async reauthorizeCookieBridgeConnection(connectionId: string, input: ConnectionInput = {}) {
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

  async markHealth(connectionId: string) {
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

  async setDefault(connectionId: string) {
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

  async recordVerification(connectionId: string, input: ConnectionInput = {}) {
    return this.runMutation(async () => {
      const connection = this.get(connectionId);
      if (!connection) return null;
      connection.lastVerification = normalizeVerification(input);
      connection.updatedAt = connection.lastVerification.at;
      await this.persist();
      return toSafeConnection(connection);
    });
  }

  async persist(): Promise<void> {
    await writePrivateJson(this.file, [...this.connections.values()]);
  }
}

export function validateBrowserSessionConnection(input: ConnectionInput = {}) {
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

export function validateCookieBridgeConnection(input: ConnectionInput = {}) {
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

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)) throw new ConnectionInputError(`${label}标识格式不正确。`);
  return normalized;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ConnectionInputError(`${label}至少需要一项。`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function rejectSecretLikeFields(input: ConnectionInput): void {
  for (const key of ['cookie', 'cookies', 'token', 'password', 'authorization', 'credential', 'credentialRef']) {
    if (Object.hasOwn(input, key)) throw new ConnectionInputError('连接请求不得包含 Cookie、token、密码或其他原始凭据。');
  }
}

function toSafeConnection(connection: ConnectionRecord | null): SafeConnection | null {
  if (!connection) return null;
  const { credentialRef, cookieBridgeClientId, ...safe } = connection;
  return { ...safe, hasCredentialReference: Boolean(credentialRef) };
}

function normalizeVerification(input: ConnectionInput = {}) {
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

function normalizeStoredVerification(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const value = input as ConnectionInput;
  const timestamp = Date.parse(String(value.at || ''));
  if (!Number.isFinite(timestamp)) return null;
  return {
    status: value.status === 'succeeded' ? 'succeeded' : 'failed',
    at: new Date(timestamp).toISOString(),
    adapterId: String(value.adapterId || '').trim().slice(0, 100) || null,
    capabilities: normalizeSafeList(value.capabilities, 80),
    failureCode: value.status === 'succeeded'
      ? null
      : String(value.failureCode || 'adapter_unavailable').trim().slice(0, 100)
  };
}

function normalizeSafeList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))].slice(0, 24);
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
}
