import { createHash } from 'node:crypto';

export const ASR_CAPABILITY_ID = 'audio.transcribe';
export const ASR_EXECUTION_RECEIPT_VERSION = 'agent.army/execution-receipt/v2';
type DynamicRecord = Record<string, any>;
type ExecutionOutcome = 'success' | 'ambiguous' | 'confirmed_failure';
type RouteDescriptor = Readonly<{ routeId: string; adapterId: string }>;
export type AsrRouteAttempt = RouteDescriptor & Readonly<{
  attempts: number;
  recovered: boolean;
  outcome: ExecutionOutcome;
  failureCode: string | null;
}>;
type ReceiptCarrierError = Error & { executionReceipt?: Readonly<Record<string, unknown>> };

const ROUTES: Readonly<Record<string, RouteDescriptor>> = Object.freeze({
  'source-subtitle':Object.freeze({ routeId:'audio.transcribe.source-subtitle', adapterId:'xiaod.source-subtitle' }),
  'mlx-whisper':Object.freeze({ routeId:'audio.transcribe.mlx-whisper', adapterId:'xiaod.mlx-whisper' }),
  'faster-whisper':Object.freeze({ routeId:'audio.transcribe.faster-whisper', adapterId:'xiaod.faster-whisper' })
});

export function asrQualityResult({ routing = {}, payload = null }: Readonly<{ routing?: DynamicRecord; payload?: DynamicRecord | null }> = {}) {
  const provider = clean(routing?.selectedProvider, 120);
  const evaluation = routing?.fastCandidate?.evaluation || null;
  const verification = routing?.fastCandidate?.verification || null;
  const signals = payload?.qualitySignals || evaluation?.qualitySignals || null;
  const reasons: string[] = [];
  const text = String(payload?.text || '').trim();
  const timed = String(payload?.timed || '').trim();
  if (provider !== 'source-subtitle' && text.length < 20) reasons.push('transcript_too_short');
  if (provider === 'mlx-whisper' && !timed) reasons.push('timed_transcript_missing');
  if (provider === 'faster-whisper' && evaluation?.accepted !== true) reasons.push('fast_quality_not_accepted');
  if (verification && verification.accepted !== true) reasons.push('quality_probe_disagreed');
  if (routing?.requiresHumanReview === true) reasons.push('human_review_required');
  return Object.freeze({
    schemaVersion:'agent.army/capability-quality-result/v1',
    capabilityId:ASR_CAPABILITY_ID,
    gateId:'xiaod.asr-transcript-quality',
    passed:reasons.length === 0,
    status:reasons.length === 0 ? 'passed' : 'review_required',
    reasons:Object.freeze([...new Set(reasons)]),
    evidence:provider === 'source-subtitle' ? Object.freeze(['validated_source_subtitle_available']) : Object.freeze([]),
    signals:signals ? Object.freeze({ ...signals }) : null
  });
}

export function buildAsrExecutionReceipt({
  job = {},
  routing = {},
  input = null,
  payload = null,
  startedAt,
  completedAt = new Date().toISOString(),
  outcome = 'success',
  failureCode = null,
  routeAttempts = null
}: Readonly<{
  job?: DynamicRecord;
  routing?: DynamicRecord;
  input?: unknown;
  payload?: DynamicRecord | null;
  startedAt?: string | number | Date;
  completedAt?: string | number | Date;
  outcome?: ExecutionOutcome;
  failureCode?: unknown;
  routeAttempts?: readonly DynamicRecord[] | null;
}> = {}) {
  const selectedProvider = clean(routing.selectedProvider, 120) || 'unknown';
  const route = ROUTES[selectedProvider] || {
    routeId:`audio.transcribe.${identifier(selectedProvider)}`,
    adapterId:`xiaod.${identifier(selectedProvider)}`
  };
  const taskId = clean(job.agentArmyTaskId || job.taskId || job.id, 180) || 'unknown-task';
  const workflowId = clean(job.workflowId, 180) || `workflow:xiaod-media:${taskId}`;
  const stepId = clean(job.stepId, 180) || `step:audio-transcribe:${taskId}`;
  const requestId = clean(job.requestId, 180) || `request:audio-transcribe:${taskId}`;
  const normalizedStartedAt = iso(startedAt, completedAt);
  const normalizedCompletedAt = iso(completedAt, normalizedStartedAt);
  const fallbackFrom = routeIdFor(routing.fallbackFrom);
  const normalizedRouteAttempts = normalizeRouteAttempts(routeAttempts, routing, outcome, canonicalFailure(outcome, failureCode));
  const totalAttempts = normalizedRouteAttempts.reduce((sum, item) => sum + item.attempts, 0);
  const inputHash = digest(input || { taskId, sourceType:job.sourceType || null, durationSeconds:routing.durationSeconds ?? null });
  const outputHash = outcome === 'success' ? digest({ text:payload?.text || '', timed:payload?.timed || null }) : null;
  const canonicalFailureCode = outcome === 'success' ? null : clean(failureCode, 120) || 'capability_execution_failed';
  return Object.freeze({
    schemaVersion:ASR_EXECUTION_RECEIPT_VERSION,
    receiptId:`receipt:${digest({ requestId, routeId:route.routeId, outcome, inputHash, outputHash, normalizedCompletedAt }).slice(0, 32)}`,
    requestId,
    workflowId,
    stepId,
    taskId,
    agentId:clean(job.agentId, 120) || 'xiaod',
    capabilityId:ASR_CAPABILITY_ID,
    policyDecisionId:clean(job.policyDecisionId, 180) || 'policy:xiaod-media-local-asr',
    adapterId:route.adapterId,
    routeId:route.routeId,
    provider:selectedProvider,
    model:clean(routing.selectedModel, 180) || null,
    outcome,
    fallbackFrom,
    routeAttempts:normalizedRouteAttempts,
    attempts:totalAttempts,
    totalAttempts,
    recovered:normalizedRouteAttempts.some((item) => item.recovered),
    failureCode:canonicalFailureCode,
    inputHash:`sha256:${inputHash}`,
    outputHash:outputHash ? `sha256:${outputHash}` : null,
    costUsd:0,
    startedAt:normalizedStartedAt,
    completedAt:normalizedCompletedAt
  });
}

export function attachAsrCapabilityResult({ job = {}, routing = {}, input = null, payload = {}, startedAt, completedAt }: Readonly<{
  job?: DynamicRecord;
  routing?: DynamicRecord;
  input?: unknown;
  payload?: DynamicRecord;
  startedAt?: string | number | Date;
  completedAt?: string | number | Date;
}> = {}) {
  const qualityResult = asrQualityResult({ routing, payload });
  return Object.freeze({
    ...routing,
    qualityResult,
    executionReceipt:buildAsrExecutionReceipt({ job, routing, input, payload, startedAt, completedAt })
  });
}

export function attachAsrFailureReceipt(error: unknown, { job = {}, routing = {}, input = null, startedAt, outcome = 'confirmed_failure', routeAttempts = null }: Readonly<{
  job?: DynamicRecord;
  routing?: DynamicRecord;
  input?: unknown;
  startedAt?: string | number | Date;
  outcome?: ExecutionOutcome;
  routeAttempts?: readonly DynamicRecord[] | null;
}> = {}): ReceiptCarrierError {
  const failure = (error instanceof Error ? error : new Error(String(error || 'ASR 能力执行失败。'))) as ReceiptCarrierError;
  failure.executionReceipt = buildAsrExecutionReceipt({
    job,
    routing,
    input,
    startedAt,
    outcome,
    failureCode:clean(errorCode(error), 120) || classifyFailure(error),
    routeAttempts
  });
  return failure;
}

export function asrRouteAttempt({ provider, attempts = 1, recovered = false, outcome = 'success', failureCode = null }: Readonly<{
  provider?: unknown;
  attempts?: unknown;
  recovered?: boolean;
  outcome?: ExecutionOutcome;
  failureCode?: unknown;
}> = {}): AsrRouteAttempt {
  return Object.freeze({
    ...routeDescriptor(provider),
    attempts:positiveInteger(attempts),
    recovered:recovered === true,
    outcome:normalizedOutcome(outcome),
    failureCode:outcome === 'success' ? null : clean(failureCode, 120) || 'capability_execution_failed'
  });
}

function normalizeRouteAttempts(provided: readonly DynamicRecord[] | null, routing: DynamicRecord, outcome: ExecutionOutcome, failureCode: string | null): readonly AsrRouteAttempt[] {
  if (Array.isArray(provided) && provided.length) {
    return Object.freeze(provided.map((item) => Object.freeze({
      routeId:clean(item?.routeId, 180),
      adapterId:clean(item?.adapterId, 180),
      attempts:positiveInteger(item?.attempts),
      recovered:item?.recovered === true,
      outcome:normalizedOutcome(item?.outcome),
      failureCode:item?.outcome === 'success' ? null : clean(item?.failureCode, 120) || 'capability_execution_failed'
    })));
  }
  const selected = routeDescriptor(routing?.selectedProvider);
  const records: AsrRouteAttempt[] = [];
  if (routing?.fallbackFrom) {
    const primary = routeDescriptor(routing.fallbackFrom);
    records.push(Object.freeze({
      ...primary,
      attempts:1,
      recovered:false,
      outcome:'confirmed_failure',
      failureCode:clean(routing?.primaryFailureCode, 120) || 'provider_unavailable'
    }));
  } else if (routing?.fastCandidate?.attempted && routing?.selectedProvider === 'mlx-whisper') {
    const fast = routeDescriptor('faster-whisper');
    records.push(Object.freeze({
      ...fast,
      attempts:1,
      recovered:false,
      outcome:'confirmed_failure',
      failureCode:routing.fastCandidate?.failure ? 'provider_unavailable' : 'quality_failed'
    }));
  }
  records.push(Object.freeze({
    ...selected,
    attempts:1,
    recovered:false,
    outcome:normalizedOutcome(outcome),
    failureCode:outcome === 'success' ? null : failureCode
  }));
  return Object.freeze(records);
}

function routeIdFor(provider: unknown): string | null {
  const normalized = clean(provider, 120);
  if (!normalized) return null;
  return (ROUTES[normalized] || {}).routeId || `audio.transcribe.${identifier(normalized)}`;
}

function routeDescriptor(provider: unknown): RouteDescriptor {
  const normalized = clean(provider, 120) || 'unknown';
  const route = ROUTES[normalized] || {
    routeId:`audio.transcribe.${identifier(normalized)}`,
    adapterId:`xiaod.${identifier(normalized)}`
  };
  return { routeId:route.routeId, adapterId:route.adapterId };
}

function canonicalFailure(outcome: ExecutionOutcome, failureCode: unknown): string | null {
  return outcome === 'success' ? null : clean(failureCode, 120) || 'capability_execution_failed';
}

function normalizedOutcome(value: unknown): ExecutionOutcome {
  return value === 'ambiguous' || value === 'confirmed_failure' ? value : 'success';
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function classifyFailure(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (/无法启动|enoent|spawn/.test(message)) return 'startup_failure';
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  if (/auth|credential|token|认证|凭据/.test(message)) return 'authentication_failed';
  if (/permission|eacces|权限/.test(message)) return 'permission_denied';
  if (/没有生成|invalid|格式/.test(message)) return 'invalid_output';
  return 'provider_unavailable';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

function identifier(value: unknown): string {
  return clean(value, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function iso(value: string | number | Date | undefined, fallback: string | number | Date | undefined): string {
  const date = new Date(value || fallback || Date.now());
  return Number.isNaN(date.valueOf()) ? new Date(fallback || Date.now()).toISOString() : date.toISOString();
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}
