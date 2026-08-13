import { createHash } from 'node:crypto';
import {
  assertAutoAllowed,
  decideCapability,
  type CapabilityPolicyContext,
  type CapabilityRequest,
  type PolicyDecision,
} from './capability-policy.ts';
import { classifyCapabilityFailure, type CapabilityFailure } from './capability-failure.ts';
import {
  resolveCapabilityRoutes,
  type CapabilityRoute,
  type CapabilityRoutePlan,
  type ResolvedCapabilityRoute,
} from './capability-routing.ts';
import type { CapabilityAdapter, CapabilityAdapterResult } from './capability-adapter.ts';

export type { CapabilityAdapter, CapabilityAdapterResult } from './capability-adapter.ts';

export const EXECUTION_RECEIPT_VERSION = 'agent.army/execution-receipt/v2' as const;

export type ExecutionReceipt = Readonly<{
  schemaVersion: typeof EXECUTION_RECEIPT_VERSION;
  receiptId: string;
  requestId: string;
  workflowId: string;
  stepId: string;
  taskId: string;
  agentId: string;
  capabilityId: string;
  policyDecisionId: string;
  routeId: string;
  adapterId: string;
  provider: string;
  model: string | null;
  inputHash: string;
  outputHash: string | null;
  outcome: 'success' | 'confirmed_failure' | 'ambiguous';
  fallbackFrom: string | null;
  routeAttempts: readonly RouteAttemptReceipt[];
  attempts: number;
  totalAttempts: number;
  recovered: boolean;
  failureCode: string | null;
  costUsd: number | null;
  startedAt: string;
  completedAt: string;
}>;

export type RouteAttemptReceipt = Readonly<{
  routeId: string;
  adapterId: string;
  attempts: number;
  recovered: boolean;
  outcome: 'success' | 'confirmed_failure' | 'ambiguous';
  failureCode: string | null;
  failureCodes: readonly string[];
}>;

export type CapabilityExecutionResult = Readonly<{
  output: unknown;
  usage: unknown;
  decision: PolicyDecision;
  receipt: ExecutionReceipt;
}>;

export class CapabilityExecutionEngine {
  readonly adapter: CapabilityAdapter;
  readonly routes: readonly CapabilityRoute[];
  readonly plan?: CapabilityRoutePlan;
  readonly now: () => Date;
  readonly onReceipt?: (receipt: ExecutionReceipt) => void | Promise<void>;

  constructor({ adapter, routes, plan, now = () => new Date(), onReceipt }: {
    adapter?: CapabilityAdapter;
    routes?: readonly CapabilityRoute[];
    plan?: CapabilityRoutePlan;
    now?: () => Date;
    onReceipt?: (receipt: ExecutionReceipt) => void | Promise<void>;
  }) {
    const normalizedRoutes = routes?.length
      ? routes
      : adapter
        ? [Object.freeze({ routeId:clean(adapter.adapterId, 120), adapter })]
        : [];
    if (!normalizedRoutes.length) throw new TypeError('能力执行引擎至少需要一个 Adapter 或 Route。');
    this.routes = Object.freeze([...normalizedRoutes]);
    this.adapter = adapter || normalizedRoutes[0].adapter;
    this.plan = plan;
    this.now = now;
    this.onReceipt = onReceipt;
  }

  async invoke({
    request,
    policy,
    payload,
    options = {},
    routePlan,
  }: {
    request: CapabilityRequest;
    policy: CapabilityPolicyContext;
    payload: unknown;
    options?: Readonly<Record<string, unknown>>;
    routePlan?: CapabilityRoutePlan;
  }): Promise<CapabilityExecutionResult> {
    const startedAt = this.now().toISOString();
    const decision = decideCapability(request, policy, { now:this.now });
    assertAutoAllowed(decision);
    const inputHash = hash(payload);
    const candidates = resolveCapabilityRoutes({
      routes:this.routes,
      plan:routePlan || this.plan,
      request:decision.request,
      decision,
    });
    const routeAttempts: RouteAttemptReceipt[] = [];
    let totalAttempts = 0;
    let fallbackFrom: string | null = null;
    let accumulatedCost = 0;
    let hasKnownCost = false;

    for (let index = 0; index < candidates.length; index += 1) {
      const route = candidates[index];
      const execution = await invokeRoute(route, decision.request, payload, options);
      totalAttempts += execution.attempts;
      const errorCost = finiteCost((execution.error as { costUsd?: unknown })?.costUsd);
      if (errorCost !== null) { accumulatedCost += errorCost; hasKnownCost = true; }
      routeAttempts.push(Object.freeze({
        routeId:route.routeId,
        adapterId:clean(route.adapter.adapterId, 120),
        attempts:execution.attempts,
        recovered:execution.recovered,
        outcome:execution.failure?.outcome || 'success',
        failureCode:execution.failure?.code || null,
        failureCodes:Object.freeze([...execution.failureCodes]),
      }));
      if (execution.result) {
        const resultCost = finiteCost(execution.result.costUsd);
        if (resultCost !== null) { accumulatedCost += resultCost; hasKnownCost = true; }
        const receipt = createReceipt({
          decision, route, result:execution.result, inputHash, startedAt,
          routeAttempts, totalAttempts, fallbackFrom,
          costUsd:hasKnownCost ? accumulatedCost : null,
          completedAt:this.now().toISOString(),
        });
        await safelyRecord(this.onReceipt, receipt);
        return Object.freeze({ output:execution.result.output, usage:execution.result.usage || null, decision, receipt });
      }
      const failure = execution.failure as CapabilityFailure;
      const canFallback = failure.allowFallback && index < candidates.length - 1;
      if (canFallback) {
        fallbackFrom = route.routeId;
        continue;
      }
      const receipt = createReceipt({
        decision, route, error:execution.error, failure, inputHash, startedAt,
        routeAttempts, totalAttempts, fallbackFrom,
        costUsd:hasKnownCost ? accumulatedCost : null,
        completedAt:this.now().toISOString(),
      });
      await safelyRecord(this.onReceipt, receipt);
      throw normalizeExecutionError(execution.error, decision, receipt, failure);
    }
    throw new Error('能力路线执行异常终止。');
  }
}

async function safelyRecord(
  recorder: ((receipt: ExecutionReceipt) => void | Promise<void>) | undefined,
  receipt: ExecutionReceipt,
) {
  if (!recorder) return;
  try { await recorder(receipt); } catch { /* Observability must not change task outcome. */ }
}

async function invokeRoute(
  route: ResolvedCapabilityRoute,
  request: CapabilityRequest,
  payload: unknown,
  options: Readonly<Record<string, unknown>>,
): Promise<Readonly<{
  result?: CapabilityAdapterResult;
  error?: unknown;
  failure?: CapabilityFailure;
  attempts: number;
  recovered: boolean;
  failureCodes: readonly string[];
}>> {
  let attempts = 1;
  const failureCodes: string[] = [];
  try {
    const result = await invokeAdapter(route, request, payload, options, attempts);
    return { result, attempts, recovered:false, failureCodes:Object.freeze(failureCodes) };
  } catch (error) {
    let failure = classifyCapabilityFailure(error);
    failureCodes.push(failure.code);
    if (!failure.recoverCurrentRoute || !route.adapter.recover) {
      return { error, failure, attempts, recovered:false, failureCodes:Object.freeze(failureCodes) };
    }
    let recovery: 'recovered' | 'unavailable' = 'unavailable';
    try { recovery = await route.adapter.recover({ request, errorCode:failure.code }); } catch { recovery = 'unavailable'; }
    if (recovery !== 'recovered') {
      return { error, failure, attempts, recovered:false, failureCodes:Object.freeze(failureCodes) };
    }
    attempts += 1;
    try {
      const result = await invokeAdapter(route, request, payload, options, attempts);
      return { result, attempts, recovered:true, failureCodes:Object.freeze(failureCodes) };
    } catch (retryError) {
      failure = classifyCapabilityFailure(retryError);
      failureCodes.push(failure.code);
      return { error:retryError, failure, attempts, recovered:true, failureCodes:Object.freeze(failureCodes) };
    }
  }
}

async function invokeAdapter(
  route: ResolvedCapabilityRoute,
  request: CapabilityRequest,
  payload: unknown,
  options: Readonly<Record<string, unknown>>,
  attempt: number,
): Promise<CapabilityAdapterResult> {
  const result = await route.adapter.invoke({ request, payload, options, attempt });
  const qualityResult = adapterQualityResult(result);
  if (!qualityResult || qualityResult.passed === true) return result;
  throw qualityResultError(result, qualityResult);
}

type AdapterQualityResult = Readonly<{
  passed?: unknown;
  status?: unknown;
  gateId?: unknown;
}>;

function adapterQualityResult(result: CapabilityAdapterResult): AdapterQualityResult | null {
  const candidate = (result as CapabilityAdapterResult & { qualityResult?: unknown }).qualityResult
    ?? (result.output as { qualityResult?: unknown } | null)?.qualityResult;
  return candidate && typeof candidate === 'object' ? candidate as AdapterQualityResult : null;
}

function qualityResultError(result: CapabilityAdapterResult, quality: AdapterQualityResult): Error {
  const status = clean(quality.status, 80).toLowerCase();
  const confirmed = ['failed', 'rejected', 'blocked'].includes(status);
  const error = Object.assign(new Error('能力输出未通过质量门。'), {
    code:confirmed ? 'capability_quality_failed' : 'capability_quality_ambiguous',
    failureKind:confirmed ? 'quality_failed' : 'ambiguous_result',
    ambiguous:!confirmed,
    retryable:false,
    provider:clean(result.provider, 120),
    model:clean(result.model, 160) || null,
    costUsd:finiteCost(result.costUsd),
    qualityGateId:clean(quality.gateId, 160) || null,
  });
  return error;
}

function createReceipt(input: Readonly<{
  decision: PolicyDecision;
  route: ResolvedCapabilityRoute;
  result?: CapabilityAdapterResult;
  error?: unknown;
  failure?: CapabilityFailure;
  inputHash: string;
  startedAt: string;
  routeAttempts: readonly RouteAttemptReceipt[];
  totalAttempts: number;
  fallbackFrom: string | null;
  costUsd: number | null;
  completedAt: string;
}>): ExecutionReceipt {
  const outputHash = input.result ? hash(input.result.output) : null;
  const outcome = input.failure?.outcome || 'success';
  return Object.freeze({
    schemaVersion:EXECUTION_RECEIPT_VERSION,
    receiptId:`receipt:${hash({ requestId:input.decision.request.requestId, inputHash:input.inputHash, outputHash, outcome, completedAt:input.completedAt }).slice(0, 32)}`,
    requestId:input.decision.request.requestId,
    workflowId:input.decision.request.workflowId,
    stepId:input.decision.request.stepId,
    taskId:input.decision.request.taskId,
    agentId:input.decision.request.agentId,
    capabilityId:input.decision.request.capabilityId,
    policyDecisionId:input.decision.decisionId,
    routeId:input.route.routeId,
    adapterId:clean(input.route.adapter.adapterId, 120),
    provider:clean(input.result?.provider || (input.error as { provider?: unknown })?.provider || input.route.adapter.adapterId, 120),
    model:clean(input.result?.model || (input.error as { model?: unknown })?.model, 160) || null,
    inputHash:`sha256:${input.inputHash}`,
    outputHash:outputHash ? `sha256:${outputHash}` : null,
    outcome,
    fallbackFrom:input.fallbackFrom,
    routeAttempts:Object.freeze([...input.routeAttempts]),
    attempts:input.totalAttempts,
    totalAttempts:input.totalAttempts,
    recovered:input.routeAttempts.some((attempt) => attempt.recovered),
    failureCode:input.failure?.code || null,
    costUsd:input.costUsd,
    startedAt:input.startedAt,
    completedAt:input.completedAt,
  });
}

function normalizeExecutionError(error: unknown, decision: PolicyDecision, receipt: ExecutionReceipt, failure: CapabilityFailure): Error {
  const original = error instanceof Error ? error : new Error('能力执行失败。');
  return Object.assign(original, {
    code:failure.code,
    failureKind:failure.kind,
    category:['authentication_failed', 'permission_denied'].includes(failure.kind) ? 'authorization' : 'capability_unavailable',
    retryable:false,
    policyDecision:decision,
    executionReceipt:receipt,
    userMessage:['authentication_failed', 'permission_denied'].includes(failure.kind)
      ? '当前能力缺少有效授权。'
      : failure.outcome === 'ambiguous'
        ? '这项能力的外部结果暂时无法确认，已停止重复提交。'
        : '这项能力在有界恢复和备用路线后仍不可用。',
  });
}

function finiteCost(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
