import { createHash } from 'node:crypto';

export const CAPABILITY_POLICY_VERSION = 'agent.army/capability-policy/v1' as const;

export type CapabilityDataClass =
  | 'public'
  | 'local-controlled'
  | 'private'
  | 'authenticated'
  | 'cross-device';

export type CapabilitySideEffect =
  | 'read'
  | 'local-write'
  | 'external-write'
  | 'permission-expansion';

export type CapabilityDecisionOutcome =
  | 'auto_allow'
  | 'human_local'
  | 'human_paperclip'
  | 'deny';

export type CapabilityRequest = Readonly<{
  requestId: string;
  workflowId: string;
  stepId: string;
  taskId: string;
  agentId: string;
  capabilityId: string;
  dataClass: CapabilityDataClass;
  sideEffect: CapabilitySideEffect;
  maxCostUsd: number | null;
  costKnown: boolean;
  crossDevice: boolean;
  requiresCredentials: boolean;
}>;

export type CapabilityPolicyContext = Readonly<{
  manifestCapabilities: readonly string[];
  taskBudgetUsd?: number | null;
  agentApprovalThresholdUsd?: number | null;
  projectBudgetRemainingUsd?: number | null;
  companyBudgetRemainingUsd?: number | null;
}>;

export type PolicyDecision = Readonly<{
  schemaVersion: typeof CAPABILITY_POLICY_VERSION;
  decisionId: string;
  outcome: CapabilityDecisionOutcome;
  reasonCode: string;
  safeMessage: string;
  request: CapabilityRequest;
  effectiveBudgetUsd: number | null;
  decidedAt: string;
}>;

export function decideCapability(
  request: CapabilityRequest,
  context: CapabilityPolicyContext,
  { now = () => new Date() }: { now?: () => Date } = {},
): PolicyDecision {
  const normalized = normalizeCapabilityRequest(request);
  const allowed = new Set((context.manifestCapabilities || []).map((item) => clean(item, 120)).filter(Boolean));
  const effectiveBudgetUsd = minimumBudget([
    context.taskBudgetUsd,
    context.agentApprovalThresholdUsd,
    context.projectBudgetRemainingUsd,
    context.companyBudgetRemainingUsd,
  ]);
  let outcome: CapabilityDecisionOutcome = 'auto_allow';
  let reasonCode = 'registered_read_within_budget';
  let safeMessage = '能力已登记，数据范围和预算符合自动执行规则。';

  if (!allowed.has(normalized.capabilityId)) {
    outcome = 'deny';
    reasonCode = 'manifest_capability_required';
    safeMessage = '当前岗位没有登记这项能力。';
  } else if (normalized.sideEffect === 'external-write' || normalized.sideEffect === 'permission-expansion') {
    outcome = 'human_paperclip';
    reasonCode = normalized.sideEffect === 'external-write' ? 'external_write_approval_required' : 'permission_expansion_approval_required';
    safeMessage = '这项操作会产生外部写入或扩大权限，需要组织级批准。';
  } else if (
    normalized.crossDevice
    || normalized.requiresCredentials
    || ['private', 'authenticated', 'cross-device'].includes(normalized.dataClass)
  ) {
    outcome = 'human_local';
    reasonCode = 'sensitive_scope_approval_required';
    safeMessage = '这项操作涉及私有、登录态或跨设备数据，需要本次明确授权。';
  } else if (!normalized.costKnown && Number(normalized.maxCostUsd || 0) > 0) {
    outcome = 'human_paperclip';
    reasonCode = 'capability_cost_unknown';
    safeMessage = '这项能力的费用无法核定，不能自动执行。';
  } else if (
    Number(normalized.maxCostUsd || 0) > 0
    && (effectiveBudgetUsd === null || Number(normalized.maxCostUsd) > effectiveBudgetUsd)
  ) {
    outcome = 'human_paperclip';
    reasonCode = 'capability_budget_approval_required';
    safeMessage = '预计费用超过当前可自动使用的预算。';
  }

  const decidedAt = now().toISOString();
  return Object.freeze({
    schemaVersion:CAPABILITY_POLICY_VERSION,
    decisionId:`decision:${hash({ request:normalized, outcome, reasonCode, decidedAt }).slice(0, 32)}`,
    outcome,
    reasonCode,
    safeMessage,
    request:normalized,
    effectiveBudgetUsd,
    decidedAt,
  });
}

export function assertAutoAllowed(decision: PolicyDecision): void {
  if (decision.outcome === 'auto_allow') return;
  throw Object.assign(new Error(decision.safeMessage), {
    name:'CapabilityPolicyError',
    code:decision.reasonCode,
    category:decision.outcome === 'deny' ? 'denied' : 'approval_required',
    retryable:false,
    decision,
  });
}

function normalizeCapabilityRequest(request: CapabilityRequest): CapabilityRequest {
  const dataClass = String(request.dataClass) as CapabilityDataClass;
  const sideEffect = String(request.sideEffect) as CapabilitySideEffect;
  if (!['public', 'local-controlled', 'private', 'authenticated', 'cross-device'].includes(dataClass)) {
    throw new TypeError('能力请求缺少有效数据等级。');
  }
  if (!['read', 'local-write', 'external-write', 'permission-expansion'].includes(sideEffect)) {
    throw new TypeError('能力请求缺少有效副作用类型。');
  }
  const required = {
    requestId:clean(request.requestId, 160),
    workflowId:clean(request.workflowId, 160),
    stepId:clean(request.stepId, 160),
    taskId:clean(request.taskId, 160),
    agentId:clean(request.agentId, 100),
    capabilityId:clean(request.capabilityId, 120),
  };
  if (Object.values(required).some((value) => !value)) throw new TypeError('能力请求缺少执行身份。');
  const maxCost = request.maxCostUsd === null ? null : Number(request.maxCostUsd);
  if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0)) throw new TypeError('能力请求费用无效。');
  return Object.freeze({
    ...required,
    dataClass,
    sideEffect,
    maxCostUsd:maxCost,
    costKnown:request.costKnown === true,
    crossDevice:request.crossDevice === true,
    requiresCredentials:request.requiresCredentials === true,
  });
}

function minimumBudget(values: readonly unknown[]): number | null {
  const budgets = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return budgets.length ? Math.min(...budgets) : null;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
