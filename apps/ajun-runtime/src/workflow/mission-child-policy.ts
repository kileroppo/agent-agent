import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROTECTED_TASK_TYPES = new Set([
  'governance.agent-proposal',
  'operations.technical-repair',
  'content.video-script-package',
]);

type AuthorizedItem = Readonly<{ key: string; taskType: string; agentId: string }>;
type PolicyPayload = Readonly<{
  schemaVersion: 'agent.army/product-maturity-child-authorization/v1';
  batchId: string;
  issuedAt: string;
  expiresAt: string;
  maxModelCalls: 4;
  maxCostUsd: 0.08;
  items: readonly AuthorizedItem[];
}>;

export type ProductMaturityAuthorization = Readonly<{
  kind: 'product-maturity-validation';
  token: string;
}>;

export class MissionChildPolicy {
  readonly #key: Buffer;

  private constructor(key: Buffer) { this.#key = key; }

  static async open({ keyPath }: { keyPath: string }) {
    const target = path.resolve(keyPath);
    let key: Buffer;
    try {
      key = Buffer.from((await fs.readFile(target, 'utf8')).trim(), 'base64url');
      if (key.length !== 32) throw new Error('invalid key');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('产品成熟度子任务授权密钥不可读取。');
      await fs.mkdir(path.dirname(target), { recursive:true });
      key = crypto.randomBytes(32);
      await fs.writeFile(target, `${key.toString('base64url')}\n`, { mode:0o600, flag:'wx' });
    }
    return new MissionChildPolicy(key);
  }

  issue(batchId: string, items: readonly AuthorizedItem[], now = new Date()): ProductMaturityAuthorization {
    const payload: PolicyPayload = Object.freeze({
      schemaVersion:'agent.army/product-maturity-child-authorization/v1',
      batchId:assertBatchId(batchId),
      issuedAt:now.toISOString(),
      expiresAt:new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      maxModelCalls:4,
      maxCostUsd:0.08,
      items:Object.freeze(items.map(normalizeItem)),
    });
    assertExactProtectedSet(payload.items);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return Object.freeze({ kind:'product-maturity-validation', token:`${encoded}.${this.#sign(encoded)}` });
  }

  assertAuthorized({ mission, subtask }: { mission: any; subtask: any }) {
    if (!PROTECTED_TASK_TYPES.has(String(subtask?.taskType || ''))) return null;
    const authorization = subtask?.context?.productMaturityAuthorization;
    const payload = this.#verify(authorization);
    if (payload.batchId !== String(mission?.input?.context?.productMaturityBatchId || '')) {
      throw new Error('产品成熟度子任务授权不属于当前批次。');
    }
    const expected = payload.items.find((item) => item.key === subtask.key);
    if (!expected || expected.taskType !== subtask.taskType || expected.agentId !== subtask.agentId) {
      throw new Error('产品成熟度子任务超出固定授权范围。');
    }
    return payload;
  }

  allowsApprovalInheritance({ child, parent }: { child: any; parent: any }) {
    try {
      const payload = this.#verify(child?.input?.context?.productMaturityAuthorization);
      const item = payload.items.find((candidate) => candidate.taskType === child?.taskType
        && candidate.agentId === child?.assigneeAgentId);
      return Boolean(item && payload.batchId === parent?.input?.context?.productMaturityBatchId);
    } catch { return false; }
  }

  #verify(value: any): PolicyPayload {
    if (value?.kind !== 'product-maturity-validation') throw new Error('缺少产品成熟度子任务授权。');
    const [encoded, signature, extra] = String(value.token || '').split('.');
    if (!encoded || !signature || extra || !safeEqual(signature, this.#sign(encoded))) {
      throw new Error('产品成熟度子任务授权签名无效。');
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PolicyPayload;
    if (payload.schemaVersion !== 'agent.army/product-maturity-child-authorization/v1'
      || payload.maxModelCalls !== 4 || payload.maxCostUsd !== 0.08
      || Date.parse(payload.expiresAt) <= Date.now()) throw new Error('产品成熟度子任务授权已失效。');
    assertBatchId(payload.batchId);
    assertExactProtectedSet(payload.items);
    return payload;
  }

  #sign(encoded: string) {
    return crypto.createHmac('sha256', this.#key).update(encoded).digest('base64url');
  }
}

export function normalizedProductMaturityContext(value: any) {
  const authorization = value?.productMaturityAuthorization;
  if (authorization?.kind !== 'product-maturity-validation' || typeof authorization?.token !== 'string') return undefined;
  const result: Record<string, unknown> = {
    productMaturityAuthorization:{ kind:authorization.kind, token:authorization.token.slice(0, 8192) },
  };
  if (Array.isArray(value?.sourceTaskIds)) result.sourceTaskIds = value.sourceTaskIds.map(String).slice(0, 2);
  if (value?.repairScope && typeof value.repairScope === 'object') result.repairScope = value.repairScope;
  if (value?.failure && typeof value.failure === 'object') result.failure = value.failure;
  if (typeof value?.acceptanceWorkspaceRoot === 'string') result.acceptanceWorkspaceRoot = value.acceptanceWorkspaceRoot.slice(0, 1000);
  return result;
}

function normalizeItem(value: AuthorizedItem): AuthorizedItem {
  return Object.freeze({ key:String(value.key), taskType:String(value.taskType), agentId:String(value.agentId) });
}

function assertExactProtectedSet(items: readonly AuthorizedItem[]) {
  if (!Array.isArray(items) || items.length !== 3
    || items.some((item) => !PROTECTED_TASK_TYPES.has(item.taskType))
    || new Set(items.map((item) => item.taskType)).size !== 3) throw new Error('产品成熟度批次必须且只能包含三个固定验证子任务。');
}

function assertBatchId(value: string) {
  if (!/^maturity-[0-9a-f-]{36}$/i.test(String(value || ''))) throw new Error('产品成熟度批次编号无效。');
  return value;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
