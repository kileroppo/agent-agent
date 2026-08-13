import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROTECTED_TASK_TYPES = new Set([
  'governance.agent-proposal',
  'operations.technical-repair',
  'content.video-script-package',
]);

type AuthorizedItem = Readonly<Record<string, any> & { key: string; taskType: string; agentId: string }>;
type SignedItem = Readonly<{
  key: string;
  taskType: string;
  agentId: string;
  title: string;
  description: string;
  acceptance: string;
  dependsOn: readonly string[];
  platforms: readonly string[];
  contentGoal: string;
  sourceTaskIds: readonly string[];
  requiredSourceTaskIds: readonly string[];
  executionMode: 'draft_only' | 'deterministic_fixture' | 'local_draft_only';
  approvedForUse: false;
  researchMode: 'off';
  maxModelCalls: 0;
  maxCostUsd: 0;
  costKnown: true;
  externalSideEffects: false;
  technicalContract: Readonly<Record<string, any>> | null;
}>;
type PolicyPayload = Readonly<{
  schemaVersion: 'agent.army/product-maturity-child-authorization/v1';
  batchId: string;
  issuedAt: string;
  expiresAt: string;
  maxModelCalls: 4;
  maxCostUsd: 0.08;
  items: readonly SignedItem[];
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
    const batchId = String(mission?.input?.context?.productMaturityBatchId || '');
    if (!batchId) return null;
    if (!PROTECTED_TASK_TYPES.has(String(subtask?.taskType || ''))) {
      throw new Error('产品成熟度批次拒绝额外或未签名的第四个子任务。');
    }
    const authorization = subtask?.context?.productMaturityAuthorization;
    const payload = this.#verify(authorization);
    if (payload.batchId !== batchId) {
      throw new Error('产品成熟度子任务授权不属于当前批次。');
    }
    const expected = payload.items.find((item) => item.key === subtask.key);
    if (!expected || !sameSignedItem(expected, normalizeItem(subtask))) {
      throw new Error('产品成熟度子任务超出固定授权范围。');
    }
    return payload;
  }

  verifyTaskAuthorization({ mission, task }: { mission: any; task: any }) {
    const payload = this.#verify(task?.input?.context?.productMaturityAuthorization);
    const batchId = String(mission?.input?.context?.productMaturityBatchId || '');
    const missionTaskId = String(mission?.taskId || '');
    const missionIdempotencyKey = String(mission?.idempotencyKey || '');
    const stepKey = String(task?.workflow?.step?.key || '');
    const taskType = String(task?.taskType || '');
    const agentId = String(task?.assigneeAgentId || '');
    if (
      payload.batchId !== batchId
      || payload.batchId !== String(task?.source?.eventRef || '')
      || !missionTaskId
      || !missionIdempotencyKey
      || String(task?.parentTaskId || '') !== missionTaskId
      || String(task?.source?.missionTaskId || '') !== missionTaskId
      || String(task?.input?.context?.missionTaskId || '') !== missionTaskId
    ) throw new Error('产品成熟度任务授权不属于当前批次或总任务。');
    const expected = payload.items.find((item) => item.key === stepKey);
    if (!expected || expected.taskType !== taskType || expected.agentId !== agentId) {
      throw new Error('产品成熟度任务的步骤、类型或岗位超出固定授权范围。');
    }
    if (String(task?.idempotencyKey || '') !== `${missionIdempotencyKey}:${expected.key}`) {
      throw new Error('产品成熟度任务的唯一分工标识与签名步骤不一致。');
    }
    assertTaskContract(task, expected);
    return Object.freeze({
      batchId:payload.batchId,
      stepKey:expected.key,
      taskType:expected.taskType,
      agentId:expected.agentId,
      maxModelCalls:expected.maxModelCalls,
      maxCostUsd:expected.maxCostUsd,
      costKnown:expected.costKnown,
      executionMode:expected.executionMode,
      sourceTaskIds:expected.sourceTaskIds,
      requiredSourceTaskIds:expected.requiredSourceTaskIds,
    });
  }

  verifyMissionAuthorization(mission: any) {
    const batchId = String(mission?.input?.context?.productMaturityBatchId || '');
    if (mission?.taskType !== 'army.cross-agent-mission'
      || mission?.assigneeAgentId !== 'ajun'
      || !batchId
      || String(mission?.source?.eventRef || '') !== batchId
      || String(mission?.idempotencyKey || '') !== `product-maturity-validation:${batchId}`) {
      throw new Error('产品成熟度总任务信封与固定批次合同不一致。');
    }
    const items = mission?.input?.context?.businessMissionItems;
    if (!Array.isArray(items) || items.length !== 3) {
      throw new Error('产品成熟度总任务必须携带三个固定签名分工。');
    }
    items.forEach((subtask: any) => this.assertAuthorized({ mission, subtask }));
    if (new Set(items.map((subtask: any) => subtask?.context?.productMaturityAuthorization?.token)).size !== 1) {
      throw new Error('产品成熟度总任务的三个分工没有绑定同一授权。');
    }
    return Object.freeze({
      batchId,
      executionMode:'mission_plan',
      maxModelCalls:0,
      maxCostUsd:0,
      costKnown:true,
    });
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
  const requiredSourceTaskIds = uniqueTaskIds(value?.requiredSourceTaskIds);
  if (requiredSourceTaskIds.length) result.requiredSourceTaskIds = requiredSourceTaskIds;
  if (value?.repairScope && typeof value.repairScope === 'object') result.repairScope = value.repairScope;
  if (value?.failure && typeof value.failure === 'object') result.failure = value.failure;
  if (typeof value?.acceptanceWorkspaceRoot === 'string') result.acceptanceWorkspaceRoot = value.acceptanceWorkspaceRoot.slice(0, 1000);
  if (value?.proposalOnly === true) result.proposalOnly = true;
  if (value?.draftOnly === true) result.draftOnly = true;
  if (value?.deterministicAcceptanceRepair === true) result.deterministicAcceptanceRepair = true;
  if (value?.researchMode === 'off') result.researchMode = 'off';
  if (value?.approvedForUse === false) result.approvedForUse = false;
  if (value?.modelPolicy && typeof value.modelPolicy === 'object') {
    result.modelPolicy = {
      maxCalls:Number(value.modelPolicy.maxCalls),
      maxCostUsd:Number(value.modelPolicy.maxCostUsd),
      costKnown:value.modelPolicy.costKnown === true,
    };
  }
  return result;
}

function uniqueTaskIds(value: any) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 2);
}

function normalizeItem(value: AuthorizedItem): SignedItem {
  const taskType = String(value.taskType || '');
  const context = value.context && typeof value.context === 'object' ? value.context : {};
  const sourceTaskIds = uniqueTaskIds(context.sourceTaskIds);
  const requiredSourceTaskIds = uniqueTaskIds(context.requiredSourceTaskIds);
  const technicalContract = normalizeTechnicalContract(context);
  const executionMode = taskType === 'governance.agent-proposal'
    && value.proposalOnly === true && value.draftOnly === true
    && context.proposalOnly === true && context.draftOnly === true
    ? 'draft_only'
    : taskType === 'operations.technical-repair'
      && value.deterministicAcceptanceRepair === true
      && context.deterministicAcceptanceRepair === true
      && technicalContract
      ? 'deterministic_fixture'
      : taskType === 'content.video-script-package'
        && value.researchMode === 'off' && value.approvedForUse === false
        && context.researchMode === 'off' && context.approvedForUse === false
        && context.modelPolicy?.maxCalls === 0
        && context.modelPolicy?.maxCostUsd === 0
        && context.modelPolicy?.costKnown === true
        && sourceTaskIds.length === 2
        && sameStrings(sourceTaskIds, requiredSourceTaskIds)
        ? 'local_draft_only'
        : null;
  if (!executionMode) throw new Error('产品成熟度子任务缺少确定性零模型执行契约。');
  return Object.freeze({
    key:String(value.key || ''),
    taskType,
    agentId:String(value.agentId || ''),
    title:String(value.title || ''),
    description:String(value.description || ''),
    acceptance:String(value.acceptance || ''),
    dependsOn:Object.freeze(uniqueStrings(value.dependsOn)),
    platforms:Object.freeze(uniqueStrings(value.platforms)),
    contentGoal:String(value.contentGoal || ''),
    sourceTaskIds:Object.freeze(sourceTaskIds),
    requiredSourceTaskIds:Object.freeze(requiredSourceTaskIds),
    executionMode,
    approvedForUse:false,
    researchMode:'off',
    maxModelCalls:0,
    maxCostUsd:0,
    costKnown:true,
    externalSideEffects:false,
    technicalContract,
  });
}

function assertExactProtectedSet(items: readonly SignedItem[]) {
  if (!Array.isArray(items) || items.length !== 3
    || items.some((item) => !PROTECTED_TASK_TYPES.has(item.taskType))
    || new Set(items.map((item) => item.taskType)).size !== 3) throw new Error('产品成熟度批次必须且只能包含三个固定验证子任务。');
}

function assertTaskContract(task: any, expected: SignedItem) {
  const context = task?.input?.context || {};
  const allowedInputKeys = new Set([
    'title', 'description', 'sourceUrl', 'sourceUrls', 'connectionId', 'query', 'repo', 'path', 'topic',
    'reviewPolicy', 'evidenceMode', 'analysisIntent', 'depth', 'visualMode', 'focus', 'platforms',
    'contentGoal', 'durationSeconds', 'researchMode', 'approvedForUse', 'sourceScriptTaskId', 'metrics',
    'goalSpec', 'context',
  ]);
  const allowedContextKeys = new Set([
    'productMaturityAuthorization', 'missionTaskId', 'parentPaperclipIssueId', 'missionSafeOnly',
    'dependsOn', 'dependsOnPrevious', 'dependencyTaskIds', 'sourceTaskIds', 'requiredSourceTaskIds',
    ...(expected.executionMode === 'draft_only' ? ['proposalOnly', 'draftOnly'] : []),
    ...(expected.executionMode === 'deterministic_fixture'
      ? ['deterministicAcceptanceRepair', 'acceptanceWorkspaceRoot', 'failure', 'repairScope'] : []),
    ...(expected.executionMode === 'local_draft_only' ? ['researchMode', 'approvedForUse', 'modelPolicy'] : []),
  ]);
  if (Object.keys(task?.input || {}).some((key) => !allowedInputKeys.has(key))
    || Object.keys(context).some((key) => !allowedContextKeys.has(key))) {
    throw new Error('产品成熟度任务包含签名合同之外的输入或控制面字段。');
  }
  if (String(task?.input?.title || '') !== expected.title
    || String(task?.input?.description || '') !== [
      expected.description,
      `来自多人协作分工。验收：${expected.acceptance}`,
    ].filter(Boolean).join('\n')
    || !sameStrings(uniqueStrings(context.dependsOn), expected.dependsOn)
    || !sameStrings(uniqueStrings(task?.input?.platforms), expected.platforms)
    || String(task?.input?.contentGoal || '') !== expected.contentGoal
    || !sameStrings(uniqueTaskIds(context.sourceTaskIds), expected.sourceTaskIds)
    || !sameStrings(uniqueTaskIds(context.requiredSourceTaskIds), expected.requiredSourceTaskIds)) {
    throw new Error('产品成熟度任务输入、依赖或来源与签名合同不一致。');
  }
  if (expected.executionMode === 'draft_only'
    && (context.proposalOnly !== true || context.draftOnly !== true)) {
    throw new Error('创建官产品成熟度任务没有锁定为 draft_only。');
  }
  if (expected.executionMode === 'deterministic_fixture'
    && (context.deterministicAcceptanceRepair !== true
      || JSON.stringify(normalizeTechnicalContract(context)) !== JSON.stringify(expected.technicalContract))) {
    throw new Error('技术专家产品成熟度任务没有锁定确定性夹具修复。');
  }
  if (expected.executionMode === 'local_draft_only'
    && (task?.input?.approvedForUse !== false
      || task?.input?.researchMode !== 'off'
      || context.approvedForUse !== false
      || context.researchMode !== 'off')) {
    throw new Error('小创产品成熟度任务没有锁定为禁用研究且未批准使用。');
  }
}

function normalizeTechnicalContract(context: any) {
  const root = String(context?.acceptanceWorkspaceRoot || '').trim();
  const failure = context?.failure;
  const scope = context?.repairScope;
  const files = uniqueStrings(scope?.files);
  const testSupportFiles = uniqueStrings(scope?.testSupportFiles);
  const testCommand = String(scope?.testCommand || '').trim();
  const recoveryCheck = String(scope?.recoveryCheck || '').trim();
  if (!path.isAbsolute(root) || !root.replaceAll('\\', '/').endsWith('/work/acceptance-runs')
    || files.length !== 1 || files[0] !== 'docs/acceptance-fixtures/technical-repair-sandbox/calculator.js'
    || testSupportFiles.length !== 2
    || !testSupportFiles.includes('docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js')
    || !testSupportFiles.includes('docs/acceptance-fixtures/technical-repair-sandbox/package.json')
    || testCommand !== 'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js'
    || !recoveryCheck
    || failure?.code !== 'acceptance_fixture_failure'
    || failure?.category !== 'code_defect'
    || failure?.stage !== 'test'
    || failure?.retryable !== false) return null;
  return Object.freeze({
    acceptanceWorkspaceRoot:root,
    failure:Object.freeze({ code:failure.code, category:failure.category, stage:failure.stage, retryable:false }),
    repairScope:Object.freeze({
      files:Object.freeze(files),
      testSupportFiles:Object.freeze(testSupportFiles),
      testCommand,
      recoveryCheck,
    }),
  });
}

function sameSignedItem(left: SignedItem, right: SignedItem) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(value: any) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertBatchId(value: string) {
  if (!/^maturity-[0-9a-f-]{36}$/i.test(String(value || ''))) throw new Error('产品成熟度批次编号无效。');
  return value;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
