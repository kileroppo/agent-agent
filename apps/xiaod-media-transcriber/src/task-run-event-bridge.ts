import crypto from 'node:crypto';

const SCHEMA_VERSION = 'agent.army/task-run-event/v1';

type EventRecord = Record<string, any>;
type RunEventSink = (event: Readonly<EventRecord>) => Promise<unknown> | unknown;

export function createTaskRunEventBridge({
  onRunEvent = null,
  clock = () => new Date().toISOString(),
}: Readonly<{
  onRunEvent?: RunEventSink | null;
  clock?: () => string;
}> = {}) {
  const emit = async (event: EventRecord): Promise<void> => {
    if (typeof onRunEvent !== 'function') return;
    try {
      await onRunEvent(sanitizeEvent(event, clock()));
    } catch {
      // Telemetry is best-effort. Business execution and its durable ledger win.
    }
  };

  return Object.freeze({
    async recordExecutionReceipt(
      receipt: EventRecord,
      { qualityResult = null }: Readonly<{ qualityResult?: EventRecord | null }> = {},
    ) {
      if (!receipt?.taskId || !receipt?.receiptId) return;
      const common = receiptCommon(receipt);
      await emit({
        ...common,
        eventId:eventId(receipt.receiptId, 'policy'),
        eventType:'capability_policy_decided',
        routeId:receipt.routeAttempts?.[0]?.routeId || receipt.routeId,
        status:'allowed',
        startedAt:receipt.startedAt,
      });
      const attempts = Array.isArray(receipt.routeAttempts) && receipt.routeAttempts.length
        ? receipt.routeAttempts
        : [{ routeId:receipt.routeId, adapterId:receipt.adapterId, attempts:receipt.totalAttempts || 1, outcome:receipt.outcome, failureCode:receipt.failureCode }];
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        if (index > 0) {
          await emit({
            ...common,
            eventId:eventId(receipt.receiptId, `fallback-${index + 1}`),
            eventType:'route_fallback_started',
            routeId:attempt.routeId,
            provider:providerFromRoute(attempt.routeId),
            attempt:index + 1,
            status:'fallback',
            startedAt:offsetTime(receipt.startedAt, index * 2 - 1),
            safeSummary:`${attempts[index - 1]?.routeId || 'primary_route'} confirmed failure; fallback route started.`,
          });
        }
        await emit({
          ...common,
          eventId:eventId(receipt.receiptId, `attempt-${index + 1}`),
          eventType:eventTypeForOutcome(attempt.outcome),
          routeId:attempt.routeId || receipt.routeId,
          provider:attempt.routeId === receipt.routeId ? receipt.provider : providerFromRoute(attempt.routeId),
          model:attempt.routeId === receipt.routeId ? receipt.model : null,
          attempt:index + 1,
          status:normalizeOutcome(attempt.outcome),
          startedAt:offsetTime(receipt.startedAt, index * 2),
          finishedAt:index === attempts.length - 1 ? receipt.completedAt : null,
          errorCode:attempt.outcome === 'success' ? null : attempt.failureCode || receipt.failureCode,
        });
      }
      if (qualityResult) await recordQualityResult(receipt, qualityResult, emit);
    },

    async recordVisualResult({
      job = {}, result = null, startedAt = null, completedAt = null, error = null,
    }: Readonly<{
      job?: EventRecord;
      result?: EventRecord | null;
      startedAt?: string | null;
      completedAt?: string | null;
      error?: EventRecord | Error | null;
    }> = {}) {
      const taskId = clean(job.agentArmyTaskId || job.taskId || job.id, 160) || 'unknown-task';
      const started = iso(startedAt, clock());
      const finished = iso(completedAt, clock());
      const failed = Boolean(error);
      const errorRecord = error && typeof error === 'object' ? error as EventRecord : {};
      const failureCode = failed ? clean(errorRecord.code || errorRecord.accessFailure?.code || 'visual_evidence_unavailable', 120) : null;
      const base = jobCommon(job, taskId, 'vision.extract-evidence');
      const operationId = shortDigest({ taskId, started, finished, failureCode });
      await emit({
        ...base,
        eventId:`visual:${operationId}:attempt-1`,
        eventType:failed ? 'capability_call_failed' : 'capability_call_succeeded',
        routeId:'vision.extract-evidence.local-ffmpeg',
        provider:'local-ffmpeg',
        attempt:1,
        status:failed ? 'confirmed_failure' : 'success',
        startedAt:started,
        finishedAt:finished,
        errorCode:failureCode,
        costAmount:0,
        costCurrency:'USD',
      });
      const quality = result?.output?.qualityResult || result?.qualityResult || (failed ? {
        status:'failed', reasons:[failureCode], passed:false,
      } : null);
      if (quality) {
        await emit({
          ...base,
          eventId:`visual:${operationId}:quality`,
          eventType:'quality_check_completed',
          routeId:'vision.extract-evidence.local-ffmpeg',
          provider:'local-ffmpeg',
          status:quality.status || (quality.passed ? 'passed' : 'failed'),
          startedAt:finished,
          errorCode:quality.passed ? null : clean(quality.reasons?.[0] || failureCode || 'quality_failed', 120),
          safeSummary:qualitySummary(quality),
        });
      }
    },

    async recordLarkDelivery({
      job = {}, delivery = null,
    }: Readonly<{ job?: EventRecord; delivery?: EventRecord | null }> = {}) {
      if (!delivery || !job?.id) return;
      const outcome = larkOutcome(delivery);
      if (!outcome) return;
      const occurredAt = iso(delivery.resolvedAt || delivery.completedAt || delivery.updatedAt, clock());
      await emit({
        ...jobCommon(job, job.agentArmyTaskId || job.taskId || job.id, 'document.deliver'),
        eventId:eventId(delivery.deliveryId || `lark-${shortDigest(job.id)}`, `${delivery.state}-${delivery.resolution || 'automatic'}-${occurredAt}`),
        eventType:eventTypeForOutcome(outcome.status),
        routeId:'document.deliver.lark-docx',
        provider:'lark',
        attempt:1,
        status:outcome.status,
        startedAt:delivery.startedAt || occurredAt,
        finishedAt:occurredAt,
        errorCode:outcome.errorCode,
        safeSummary:outcome.safeSummary,
        costAmount:0,
        costCurrency:'USD',
      });
    },
  });
}

async function recordQualityResult(
  receipt: EventRecord,
  quality: EventRecord,
  emit: (event: EventRecord) => Promise<void>,
): Promise<void> {
  await emit({
    ...receiptCommon(receipt),
    eventId:eventId(receipt.receiptId, 'quality'),
    eventType:'quality_check_completed',
    routeId:receipt.routeId,
    provider:receipt.provider,
    model:receipt.model,
    status:quality.status || (quality.passed ? 'passed' : 'failed'),
    startedAt:receipt.completedAt,
    errorCode:quality.passed ? null : clean(quality.reasons?.[0] || 'quality_failed', 120),
    safeSummary:qualitySummary(quality),
  });
}

function receiptCommon(receipt: EventRecord): EventRecord {
  return {
    taskId:receipt.taskId,
    workflowId:receipt.workflowId,
    stepId:receipt.stepId,
    agentId:receipt.agentId,
    capabilityId:receipt.capabilityId,
    policyDecisionId:receipt.policyDecisionId,
    receiptId:receipt.receiptId,
    inputHash:receipt.inputHash,
    outputHash:receipt.outputHash,
    costAmount:receipt.costUsd,
    costCurrency:'USD',
  };
}

function jobCommon(job: EventRecord, taskId: unknown, capabilityId: string): EventRecord {
  return {
    taskId,
    workflowId:clean(job.workflowId, 160) || `workflow:xiaod-media:${taskId}`,
    stepId:clean(job.stepId, 160) || `step:${capabilityId}:${taskId}`,
    agentId:clean(job.agentId, 120) || 'xiaod',
    capabilityId,
  };
}

function larkOutcome(delivery: EventRecord): EventRecord | null {
  if (delivery.state === 'delivered') return { status:'success', errorCode:null, safeSummary:'Lark delivery and access confirmation recorded.' };
  if (delivery.state === 'uncertain') return { status:'ambiguous', errorCode:'external_result_ambiguous', safeSummary:'Lark may have accepted the write; automatic retry stopped.' };
  if (delivery.state === 'failed_before_create') {
    return {
      status:'confirmed_failure',
      errorCode:delivery.configured === false ? 'provider_not_configured' : 'delivery_failed_before_create',
      safeSummary:'Lark write was confirmed not created; durable ledger permits a controlled retry.',
    };
  }
  if (delivery.state === 'document_ready') return { status:'confirmed_failure', errorCode:'permission_not_confirmed', safeSummary:'Lark document exists but recipient access is not confirmed.' };
  return null;
}

function qualitySummary(quality: EventRecord): string {
  const reasons = Array.isArray(quality?.reasons) ? quality.reasons.map((value) => clean(value, 80)).filter(Boolean).slice(0, 8) : [];
  return reasons.length ? `Quality gate: ${reasons.join(', ')}` : `Quality gate: ${quality?.status || (quality?.passed ? 'passed' : 'failed')}`;
}

function sanitizeEvent(input: EventRecord, fallbackTime: string): Readonly<EventRecord> {
  const startedAt = iso(input.startedAt, fallbackTime);
  const finishedAt = input.finishedAt && Date.parse(input.finishedAt) >= Date.parse(startedAt)
    ? iso(input.finishedAt, startedAt)
    : null;
  const result = {
    schemaVersion:SCHEMA_VERSION,
    eventId:clean(input.eventId, 120),
    traceId:clean(input.traceId, 120) || null,
    spanId:clean(input.spanId, 120) || null,
    parentSpanId:clean(input.parentSpanId, 120) || null,
    taskId:clean(input.taskId, 160),
    workflowId:clean(input.workflowId, 160) || null,
    stepId:clean(input.stepId, 160) || null,
    agentId:clean(input.agentId, 120) || null,
    eventType:clean(input.eventType, 120),
    capabilityId:clean(input.capabilityId, 160) || null,
    routeId:clean(input.routeId, 160) || null,
    provider:clean(input.provider, 120) || null,
    model:clean(input.model, 160) || null,
    attempt:Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? input.attempt : null,
    status:clean(input.status, 80) || null,
    startedAt,
    finishedAt,
    durationMs:finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    policyDecisionId:clean(input.policyDecisionId, 160) || null,
    receiptId:clean(input.receiptId, 160) || null,
    checkpointRef:clean(input.checkpointRef, 240) || null,
    inputHash:clean(input.inputHash, 160) || null,
    outputHash:clean(input.outputHash, 160) || null,
    artifactRefs:[],
    errorCode:clean(input.errorCode, 120) || null,
    safeSummary:redact(input.safeSummary).slice(0, 500) || null,
    costAmount:Number.isFinite(input.costAmount) && input.costAmount >= 0 ? input.costAmount : null,
    costCurrency:clean(input.costCurrency, 12) || null,
    retentionClass:'detail',
  };
  return Object.freeze(result);
}

function eventTypeForOutcome(value: unknown): string {
  if (value === 'success') return 'capability_call_succeeded';
  if (value === 'ambiguous') return 'capability_result_ambiguous';
  return 'capability_call_failed';
}

function normalizeOutcome(value: unknown): string {
  return value === 'success' || value === 'ambiguous' ? value : 'confirmed_failure';
}

function providerFromRoute(value: unknown): string | null {
  const route = String(value || '');
  if (route === 'mediacrawlerpro-specialized-content') return 'mediacrawlerpro';
  if (route === 'yt-dlp-general-media') return 'yt-dlp';
  if (route === 'bilibili-native-subtitles') return 'bilibili';
  return clean(String(value || '').split('.').at(-1), 120) || null;
}

function eventId(prefix: unknown, suffix: unknown): string {
  const candidate = `${clean(prefix, 80)}:${shortDigest(suffix)}:${clean(suffix, 24)}`;
  return candidate.slice(0, 120);
}

function shortDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function offsetTime(value: unknown, milliseconds: number): string {
  const base = Date.parse(String(value || ''));
  return new Date((Number.isFinite(base) ? base : Date.now()) + milliseconds).toISOString();
}

function iso(value: unknown, fallback: unknown): string {
  const parsed = Date.parse(String(value || fallback || ''));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function clean(value: unknown, limit: number): string {
  return redact(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit);
}

function redact(value: unknown): string {
  return String(value || '')
    .replace(/\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[redacted]');
}
