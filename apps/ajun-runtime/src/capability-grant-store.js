import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSensitiveData } from './goal-spec.js';

const GRANT_SCHEMA_VERSION = 'agent.army/capability-grant/v1';
const STORE_SCHEMA_VERSION = 'agent.army/capability-grant-store/v1';
const RISKS = new Set(['low', 'medium', 'high']);
const REVIEW_STATUSES = new Set(['pending', 'passed', 'failed']);

export class CapabilityGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapabilityGrantError';
    this.code = code;
  }
}

export function normalizeCapabilityGrant(input, { allowedPermissions = [], now = new Date() } = {}) {
  rejectSensitiveData(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityGrantError('invalid_grant', '能力授权必须是对象。');
  }
  const timestamp = asIso(now, 'now');
  const capabilityId = identifier(input.capabilityId, 'capabilityId');
  const source = normalizeSource(input.source);
  const version = requiredText(input.version, 'version', 120);
  const hash = normalizeHash(input.hash);
  const permissions = textList(input.permissions, 'permissions', 100, 160);
  const allowed = new Set(textList(allowedPermissions, 'allowedPermissions', 200, 160));
  const expandedPermissions = permissions.filter((permission) => !allowed.has(permission));
  const risk = String(input.risk || 'medium').trim().toLowerCase();
  if (!RISKS.has(risk)) throw new CapabilityGrantError('invalid_risk', `不支持的能力风险：${risk}。`);
  const audit = normalizeReview(input.audit, 'audit');
  const sandbox = normalizeReview(input.sandbox, 'sandbox');
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? null
    : asIso(input.expiresAt, 'expiresAt');
  const rollbackRef = input.rollbackRef === undefined || input.rollbackRef === null
    ? null
    : requiredText(input.rollbackRef, 'rollbackRef', 500);
  const requiresCredentials = input.requiresCredentials === true;
  const externalWrite = input.externalWrite === true || permissions.some(isExternalWritePermission);
  const approvalReasons = [
    ...(risk !== 'low' ? [`risk:${risk}`] : []),
    ...(requiresCredentials ? ['requires_credentials'] : []),
    ...(externalWrite ? ['external_write'] : []),
    ...(expandedPermissions.length ? ['permission_expansion'] : [])
  ];
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.parse(timestamp);
  const validationFailed = audit.status === 'failed' || sandbox.status === 'failed';
  const validationPending = audit.status !== 'passed' || sandbox.status !== 'passed';
  const status = expired
    ? 'expired'
    : validationFailed
      ? 'rejected'
      : validationPending
        ? 'pending_validation'
        : approvalReasons.length
          ? 'waiting_approval'
          : 'active';

  return {
    schemaVersion:GRANT_SCHEMA_VERSION,
    capabilityId,
    source,
    version,
    hash,
    permissions,
    risk,
    audit,
    sandbox,
    status,
    approval:{
      required:status === 'waiting_approval',
      reasons:approvalReasons,
      expandedPermissions
    },
    conditions:{ requiresCredentials, externalWrite },
    expiresAt,
    rollbackRef,
    createdAt:timestamp,
    updatedAt:timestamp
  };
}

export class CapabilityGrantStore {
  constructor({
    adapter = new MemoryCapabilityGrantAdapter(),
    allowedPermissions = [],
    clock = () => new Date()
  } = {}) {
    if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
      throw new CapabilityGrantError('invalid_adapter', '能力授权 Store 需要 load/save Adapter。');
    }
    if (typeof clock !== 'function') throw new CapabilityGrantError('invalid_clock', 'clock 必须是函数。');
    this.adapter = adapter;
    this.allowedPermissions = [...allowedPermissions];
    this.clock = clock;
  }

  async upsert(input, { allowedPermissions = this.allowedPermissions, now = this.clock() } = {}) {
    const grant = normalizeCapabilityGrant(input, { allowedPermissions, now });
    const records = await this.#load();
    const index = records.findIndex((item) => item.capabilityId === grant.capabilityId);
    if (index >= 0) records[index] = grant;
    else records.push(grant);
    await this.adapter.save(records.map(clone));
    return clone(grant);
  }

  async get(capabilityId, { now = this.clock() } = {}) {
    const id = identifier(capabilityId, 'capabilityId');
    const records = await this.#load();
    const grant = records.find((item) => item.capabilityId === id);
    return grant ? temporalView(grant, now) : null;
  }

  async list({ status = null, now = this.clock() } = {}) {
    const records = (await this.#load())
      .map((grant) => temporalView(grant, now))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
    return status ? records.filter((grant) => grant.status === status) : records;
  }

  async #load() {
    const records = await this.adapter.load();
    if (!Array.isArray(records)) {
      throw new CapabilityGrantError('invalid_store_data', '能力授权 Adapter 返回值必须是数组。');
    }
    return records.map((grant) => {
      rejectSensitiveData(grant);
      if (grant?.schemaVersion !== GRANT_SCHEMA_VERSION || !grant.capabilityId) {
        throw new CapabilityGrantError('invalid_store_data', '能力授权 Store 中存在无效记录。');
      }
      return clone(grant);
    });
  }
}

export class MemoryCapabilityGrantAdapter {
  constructor(records = []) {
    this.records = clone(records);
  }

  async load() {
    return clone(this.records);
  }

  async save(records) {
    this.records = clone(records);
  }
}

export class FileCapabilityGrantAdapter {
  constructor({ filePath } = {}) {
    const resolved = String(filePath || '').trim();
    if (!resolved || !path.isAbsolute(resolved)) {
      throw new CapabilityGrantError('invalid_file_path', '能力授权文件必须使用明确的绝对路径。');
    }
    this.filePath = resolved;
  }

  async load() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (payload?.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(payload.grants)) {
        throw new CapabilityGrantError('invalid_store_data', '能力授权文件格式无效。');
      }
      return clone(payload.grants);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      if (error instanceof CapabilityGrantError) throw error;
      throw new CapabilityGrantError('store_read_failed', `能力授权文件读取失败：${error.message}`);
    }
  }

  async save(records) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = {
      schemaVersion:STORE_SCHEMA_VERSION,
      grants:clone(records)
    };
    try {
      await fs.mkdir(directory, { recursive:true, mode:0o700 });
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode:0o600 });
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporaryPath, { force:true }).catch(() => {});
      throw new CapabilityGrantError('store_write_failed', `能力授权文件写入失败：${error.message}`);
    }
  }
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityGrantError('invalid_source', '能力来源必须包含 kind 和 locator。');
  }
  return {
    kind:identifier(value.kind, 'source.kind'),
    locator:requiredText(value.locator, 'source.locator', 1_000)
  };
}

function normalizeReview(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityGrantError('invalid_review', `${field} 必须是对象。`);
  }
  const status = String(value.status || 'pending').trim().toLowerCase();
  if (!REVIEW_STATUSES.has(status)) {
    throw new CapabilityGrantError('invalid_review', `${field}.status 无效。`);
  }
  return {
    status,
    evidenceRefs:textList(value.evidenceRefs, `${field}.evidenceRefs`, 100, 500)
  };
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new CapabilityGrantError('invalid_hash', '能力哈希必须是 sha256:<64 hex>。');
  }
  return hash;
}

function isExternalWritePermission(permission) {
  return /^(?:external|feishu|slack|email|publish)[.:/-].*(?:write|send|publish)$/i.test(permission);
}

function rejectSensitiveData(value) {
  try { assertNoSensitiveData(value, 'capabilityGrant'); }
  catch { throw new CapabilityGrantError('sensitive_data_rejected', '能力授权包含敏感字段或凭据，已拒绝。'); }
}

function requiredText(value, field, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength) {
    throw new CapabilityGrantError('invalid_grant', `${field} 不能为空且不能超过 ${maxLength} 字符。`);
  }
  return text;
}

function textList(value, field, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new CapabilityGrantError('invalid_grant', `${field} 必须是最多 ${maxItems} 项的数组。`);
  }
  return [...new Set(value.map((item) => requiredText(item, field, maxLength)))];
}

function identifier(value, field) {
  const text = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text)) {
    throw new CapabilityGrantError('invalid_grant', `${field} 格式无效。`);
  }
  return text;
}

function asIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new CapabilityGrantError('invalid_grant', `${field} 不是有效时间。`);
  return date.toISOString();
}

function temporalView(grant, now) {
  const view = clone(grant);
  const timestamp = asIso(now, 'now');
  if (view.expiresAt && Date.parse(view.expiresAt) <= Date.parse(timestamp)) {
    view.status = 'expired';
    view.approval = { ...(view.approval || {}), required:false };
  }
  return view;
}

function clone(value) {
  return structuredClone(value);
}
