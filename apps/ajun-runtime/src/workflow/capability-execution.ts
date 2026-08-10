import { createHash } from 'node:crypto';
import {
  assertAutoAllowed,
  decideCapability,
  type CapabilityPolicyContext,
  type CapabilityRequest,
  type PolicyDecision,
} from './capability-policy.ts';

export const EXECUTION_RECEIPT_VERSION = 'agent.army/execution-receipt/v1' as const;

export type CapabilityAdapterResult = Readonly<{
  output: unknown;
  provider: string;
  model?: string | null;
  usage?: unknown;
  costUsd?: number | null;
}>;

export type CapabilityAdapter = Readonly<{
  adapterId: string;
  invoke(input: Readonly<{
    request: CapabilityRequest;
    payload: unknown;
    options: Readonly<Record<string, unknown>>;
    attempt: number;
  }>): Promise<CapabilityAdapterResult>;
  recover?(input: Readonly<{
    request: CapabilityRequest;
    errorCode: string;
  }>): Promise<'recovered' | 'unavailable'>;
}>;

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
  adapterId: string;
  provider: string;
  model: string | null;
  inputHash: string;
  outputHash: string;
  attempts: number;
  recovered: boolean;
  costUsd: number | null;
  completedAt: string;
}>;

export type CapabilityExecutionResult = Readonly<{
  output: unknown;
  usage: unknown;
  decision: PolicyDecision;
  receipt: ExecutionReceipt;
}>;

export class CapabilityExecutionEngine {
  readonly adapter: CapabilityAdapter;
  readonly now: () => Date;

  constructor({ adapter, now = () => new Date() }: { adapter: CapabilityAdapter; now?: () => Date }) {
    this.adapter = adapter;
    this.now = now;
  }

  async invoke({
    request,
    policy,
    payload,
    options = {},
  }: {
    request: CapabilityRequest;
    policy: CapabilityPolicyContext;
    payload: unknown;
    options?: Readonly<Record<string, unknown>>;
  }): Promise<CapabilityExecutionResult> {
    const decision = decideCapability(request, policy, { now:this.now });
    assertAutoAllowed(decision);
    let attempts = 0;
    let recovered = false;
    let result: CapabilityAdapterResult;
    try {
      attempts += 1;
      result = await this.adapter.invoke({ request:decision.request, payload, options, attempt:attempts });
    } catch (error) {
      const errorCode = clean((error as { code?: unknown })?.code, 120) || 'capability_execution_failed';
      if (!this.adapter.recover || !isRecoverable(errorCode, error)) throw normalizeExecutionError(error, decision);
      const recovery = await this.adapter.recover({ request:decision.request, errorCode });
      if (recovery !== 'recovered') throw normalizeExecutionError(error, decision);
      recovered = true;
      attempts += 1;
      try {
        result = await this.adapter.invoke({ request:decision.request, payload, options, attempt:attempts });
      } catch (retryError) {
        throw normalizeExecutionError(retryError, decision);
      }
    }
    const completedAt = this.now().toISOString();
    const inputHash = hash(payload);
    const outputHash = hash(result.output);
    const receipt: ExecutionReceipt = Object.freeze({
      schemaVersion:EXECUTION_RECEIPT_VERSION,
      receiptId:`receipt:${hash({ requestId:decision.request.requestId, inputHash, outputHash, completedAt }).slice(0, 32)}`,
      requestId:decision.request.requestId,
      workflowId:decision.request.workflowId,
      stepId:decision.request.stepId,
      taskId:decision.request.taskId,
      agentId:decision.request.agentId,
      capabilityId:decision.request.capabilityId,
      policyDecisionId:decision.decisionId,
      adapterId:clean(this.adapter.adapterId, 120),
      provider:clean(result.provider, 120),
      model:clean(result.model, 160) || null,
      inputHash:`sha256:${inputHash}`,
      outputHash:`sha256:${outputHash}`,
      attempts,
      recovered,
      costUsd:finiteCost(result.costUsd),
      completedAt,
    });
    return Object.freeze({ output:result.output, usage:result.usage || null, decision, receipt });
  }
}

function isRecoverable(code: string, error: unknown): boolean {
  if ((error as { retryable?: unknown })?.retryable === true) return true;
  return [
    'local_ai_control_unavailable',
    'local_ai_gateway_unavailable',
    'local_ai_failed',
    'local_model_failed',
    'local_model_timeout',
    'service_disabled',
    'service_start_timeout',
    'qwen_server_unavailable',
  ].includes(code);
}

function normalizeExecutionError(error: unknown, decision: PolicyDecision): Error {
  const original = error instanceof Error ? error : new Error('能力执行失败。');
  const code = clean((error as { code?: unknown })?.code, 120) || 'capability_execution_failed';
  return Object.assign(original, {
    code,
    category:code.includes('auth') || code.includes('credential') ? 'authorization' : 'capability_unavailable',
    retryable:false,
    policyDecision:decision,
    userMessage:code.includes('auth') || code.includes('credential')
      ? '当前能力缺少有效授权。'
      : '这项能力在自动恢复后仍不可用。',
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
