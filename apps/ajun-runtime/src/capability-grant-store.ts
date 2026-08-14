import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSensitiveData } from './goal-spec.ts';
const GRANT_SCHEMA_VERSION: any = 'agent.army/capability-grant/v1';
const STORE_SCHEMA_VERSION: any = 'agent.army/capability-grant-store/v1';
const RISKS: any = new Set(['low', 'medium', 'high']);
const REVIEW_STATUSES: any = new Set(['pending', 'passed', 'failed']);
export class CapabilityGrantError extends Error {
    code: any;
    name: any;
    constructor(code: any, message: any) {
        super(message);
        this.name = 'CapabilityGrantError';
        this.code = code;
    }
}
export function normalizeCapabilityGrant(input: any, { allowedPermissions = [], now = new Date() }: any = {}): any {
    rejectSensitiveData(input);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new CapabilityGrantError('invalid_grant', '能力授权必须是对象。');
    }
    const timestamp: any = asIso(now, 'now');
    const capabilityId: any = identifier(input.capabilityId, 'capabilityId');
    const source: any = normalizeSource(input.source);
    const version: any = requiredText(input.version, 'version', 120);
    const hash: any = normalizeHash(input.hash);
    const permissions: any = textList(input.permissions, 'permissions', 100, 160);
    const allowed: any = new Set(textList(allowedPermissions, 'allowedPermissions', 200, 160));
    const expandedPermissions: any = permissions.filter((permission: any): any => !allowed.has(permission));
    const risk: any = String(input.risk || 'medium').trim().toLowerCase();
    if (!RISKS.has(risk))
        throw new CapabilityGrantError('invalid_risk', `不支持的能力风险：${risk}。`);
    const audit: any = normalizeReview(input.audit, 'audit');
    const sandbox: any = normalizeReview(input.sandbox, 'sandbox');
    const expiresAt: any = input.expiresAt === undefined || input.expiresAt === null
        ? null
        : asIso(input.expiresAt, 'expiresAt');
    const rollbackRef: any = input.rollbackRef === undefined || input.rollbackRef === null
        ? null
        : requiredText(input.rollbackRef, 'rollbackRef', 500);
    const requiresCredentials: any = input.requiresCredentials === true;
    const externalWrite: any = input.externalWrite === true || permissions.some(isExternalWritePermission);
    const approvalReasons: any[] = [
        ...(risk !== 'low' ? [`risk:${risk}`] : []),
        ...(requiresCredentials ? ['requires_credentials'] : []),
        ...(externalWrite ? ['external_write'] : []),
        ...(expandedPermissions.length ? ['permission_expansion'] : [])
    ];
    const expired: any = expiresAt !== null && Date.parse(expiresAt) <= Date.parse(timestamp);
    const validationFailed: any = audit.status === 'failed' || sandbox.status === 'failed';
    const validationPending: any = audit.status !== 'passed' || sandbox.status !== 'passed';
    const status: any = expired
        ? 'expired'
        : validationFailed
            ? 'rejected'
            : validationPending
                ? 'pending_validation'
                : approvalReasons.length
                    ? 'waiting_approval'
                    : 'active';
    return {
        schemaVersion: GRANT_SCHEMA_VERSION,
        capabilityId,
        source,
        version,
        hash,
        permissions,
        risk,
        audit,
        sandbox,
        status,
        approval: {
            required: status === 'waiting_approval',
            reasons: approvalReasons,
            expandedPermissions
        },
        conditions: { requiresCredentials, externalWrite },
        expiresAt,
        rollbackRef,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}
export class CapabilityGrantStore {
    adapter: any;
    allowedPermissions: any;
    clock: any;
    constructor({ adapter = new MemoryCapabilityGrantAdapter(), allowedPermissions = [], clock = (): any => new Date() }: any = {}) {
        if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
            throw new CapabilityGrantError('invalid_adapter', '能力授权 Store 需要 load/save Adapter。');
        }
        if (typeof clock !== 'function')
            throw new CapabilityGrantError('invalid_clock', 'clock 必须是函数。');
        this.adapter = adapter;
        this.allowedPermissions = [...allowedPermissions];
        this.clock = clock;
    }
    async upsert(input: any, { allowedPermissions = this.allowedPermissions, now = this.clock() }: any = {}): Promise<any> {
        const grant: any = normalizeCapabilityGrant(input, { allowedPermissions, now });
        const records: any = await this.#load();
        const index: any = records.findIndex((item: any): any => item.capabilityId === grant.capabilityId);
        if (index >= 0)
            records[index] = grant;
        else
            records.push(grant);
        await this.adapter.save(records.map(clone));
        return clone(grant);
    }
    async get(capabilityId: any, { now = this.clock() }: any = {}): Promise<any> {
        const id: any = identifier(capabilityId, 'capabilityId');
        const records: any = await this.#load();
        const grant: any = records.find((item: any): any => item.capabilityId === id);
        return grant ? temporalView(grant, now) : null;
    }
    async list({ status = null, now = this.clock() }: any = {}): Promise<any> {
        const records: any = (await this.#load())
            .map((grant: any): any => temporalView(grant, now))
            .sort((left: any, right: any): any => left.capabilityId.localeCompare(right.capabilityId));
        return status ? records.filter((grant: any): any => grant.status === status) : records;
    }
    async #load(): Promise<any> {
        const records: any = await this.adapter.load();
        if (!Array.isArray(records)) {
            throw new CapabilityGrantError('invalid_store_data', '能力授权 Adapter 返回值必须是数组。');
        }
        return records.map((grant: any): any => {
            rejectSensitiveData(grant);
            if (grant?.schemaVersion !== GRANT_SCHEMA_VERSION || !grant.capabilityId) {
                throw new CapabilityGrantError('invalid_store_data', '能力授权 Store 中存在无效记录。');
            }
            return clone(grant);
        });
    }
}
export class MemoryCapabilityGrantAdapter {
    records: any;
    constructor(records: any = []) {
        this.records = clone(records);
    }
    async load(): Promise<any> {
        return clone(this.records);
    }
    async save(records: any): Promise<any> {
        this.records = clone(records);
    }
}
export class FileCapabilityGrantAdapter {
    filePath: any;
    constructor({ filePath }: any = {}) {
        const resolved: any = String(filePath || '').trim();
        if (!resolved || !path.isAbsolute(resolved)) {
            throw new CapabilityGrantError('invalid_file_path', '能力授权文件必须使用明确的绝对路径。');
        }
        this.filePath = resolved;
    }
    async load(): Promise<any> {
        try {
            const payload: any = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
            if (payload?.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(payload.grants)) {
                throw new CapabilityGrantError('invalid_store_data', '能力授权文件格式无效。');
            }
            return clone(payload.grants);
        }
        catch (error: any) {
            if (error?.code === 'ENOENT')
                return [];
            if (error instanceof CapabilityGrantError)
                throw error;
            throw new CapabilityGrantError('store_read_failed', `能力授权文件读取失败：${error.message}`);
        }
    }
    async save(records: any): Promise<any> {
        const directory: any = path.dirname(this.filePath);
        const temporaryPath: any = `${this.filePath}.${process.pid}.tmp`;
        const payload: Record<string, any> = {
            schemaVersion: STORE_SCHEMA_VERSION,
            grants: clone(records)
        };
        try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
            await fs.rename(temporaryPath, this.filePath);
            await fs.chmod(this.filePath, 0o600);
        }
        catch (error: any) {
            await fs.rm(temporaryPath, { force: true }).catch((): any => { });
            throw new CapabilityGrantError('store_write_failed', `能力授权文件写入失败：${error.message}`);
        }
    }
}
function normalizeSource(value: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CapabilityGrantError('invalid_source', '能力来源必须包含 kind 和 locator。');
    }
    return {
        kind: identifier(value.kind, 'source.kind'),
        locator: requiredText(value.locator, 'source.locator', 1000)
    };
}
function normalizeReview(value: any, field: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CapabilityGrantError('invalid_review', `${field} 必须是对象。`);
    }
    const status: any = String(value.status || 'pending').trim().toLowerCase();
    if (!REVIEW_STATUSES.has(status)) {
        throw new CapabilityGrantError('invalid_review', `${field}.status 无效。`);
    }
    return {
        status,
        evidenceRefs: textList(value.evidenceRefs, `${field}.evidenceRefs`, 100, 500)
    };
}
function normalizeHash(value: any): any {
    const hash: any = String(value || '').trim().toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
        throw new CapabilityGrantError('invalid_hash', '能力哈希必须是 sha256:<64 hex>。');
    }
    return hash;
}
function isExternalWritePermission(permission: any): any {
    return /^(?:external|feishu|slack|email|publish)[.:/-].*(?:write|send|publish)$/i.test(permission);
}
function rejectSensitiveData(value: any): any {
    try {
        assertNoSensitiveData(value, 'capabilityGrant');
    }
    catch {
        throw new CapabilityGrantError('sensitive_data_rejected', '能力授权包含敏感字段或凭据，已拒绝。');
    }
}
function requiredText(value: any, field: any, maxLength: any): any {
    const text: any = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > maxLength) {
        throw new CapabilityGrantError('invalid_grant', `${field} 不能为空且不能超过 ${maxLength} 字符。`);
    }
    return text;
}
function textList(value: any, field: any, maxItems: any, maxLength: any): any {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new CapabilityGrantError('invalid_grant', `${field} 必须是最多 ${maxItems} 项的数组。`);
    }
    return [...new Set(value.map((item: any): any => requiredText(item, field, maxLength)))];
}
function identifier(value: any, field: any): any {
    const text: any = String(value || '').trim();
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(text)) {
        throw new CapabilityGrantError('invalid_grant', `${field} 格式无效。`);
    }
    return text;
}
function asIso(value: any, field: any): any {
    const date: any = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new CapabilityGrantError('invalid_grant', `${field} 不是有效时间。`);
    return date.toISOString();
}
function temporalView(grant: any, now: any): any {
    const view: any = clone(grant);
    const timestamp: any = asIso(now, 'now');
    if (view.expiresAt && Date.parse(view.expiresAt) <= Date.parse(timestamp)) {
        view.status = 'expired';
        view.approval = { ...(view.approval || {}), required: false };
    }
    return view;
}
function clone(value: any): any {
    return structuredClone(value);
}
