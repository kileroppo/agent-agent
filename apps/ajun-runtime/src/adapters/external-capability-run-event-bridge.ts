type RunEventSink = ((event: Readonly<Record<string, unknown>>) => void | Promise<void>) | null | undefined;

export type ExternalCapabilityEventContext = Readonly<{
  taskId: string;
  workflowId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  capabilityId: string;
  routeId: string;
  provider: string;
  model?: string | null;
}>;

type ExternalCapabilityEvidence = Readonly<{
  receiptId?: unknown;
  policyDecisionId?: unknown;
  inputHash?: unknown;
  outputHash?: unknown;
  checkpointRef?: unknown;
  costAmount?: unknown;
  costCurrency?: unknown;
  model?: unknown;
}>;

/**
 * Emits the same allow-listed shape consumed by TaskRunEventStore. Raw request,
 * response, URL, prompt and exception messages deliberately never cross this seam.
 */
export async function runExternalCapabilityWithEvents<T>({
  onRunEvent,
  context,
  execute,
  evidence = () => ({}),
  now = () => new Date(),
  hasRegisteredFallback = false,
}: Readonly<{
  onRunEvent?: RunEventSink;
  context: ExternalCapabilityEventContext;
  execute(): Promise<T>;
  evidence?(result: T): ExternalCapabilityEvidence;
  now?: () => Date;
  hasRegisteredFallback?: boolean;
}>): Promise<T> {
  const startedAt = now().toISOString();
  await emitExternalCapabilityRunEvent(onRunEvent, {
    ...context,
    eventType:'capability_call_started',
    status:'running',
    startedAt,
    safeSummary:`${safeId(context.capabilityId, 160)} 已开始调用登记路线 ${safeId(context.routeId, 160)}。`,
  });
  try {
    const result = await execute();
    const completedAt = now().toISOString();
    await emitExternalCapabilityRunEvent(onRunEvent, {
      ...context,
      ...normalizeEvidence(evidence(result)),
      eventType:'capability_call_succeeded',
      status:'success',
      startedAt,
      finishedAt:completedAt,
      durationMs:duration(startedAt, completedAt),
      safeSummary:`${safeId(context.capabilityId, 160)} 已由 ${safeId(context.provider, 120)} 返回确认回执。`,
    });
    return result;
  } catch (error) {
    const completedAt = now().toISOString();
    const ambiguous = externalOutcome(error) === 'ambiguous';
    const errorCode = safeId((error as { code?: unknown })?.code, 120) || 'capability_unavailable';
    await emitExternalCapabilityRunEvent(onRunEvent, {
      ...context,
      eventType:ambiguous ? 'capability_result_ambiguous' : 'capability_call_failed',
      status:ambiguous ? 'ambiguous' : 'failed',
      startedAt,
      finishedAt:completedAt,
      durationMs:duration(startedAt, completedAt),
      errorCode,
      safeSummary:ambiguous
        ? `${safeId(context.capabilityId, 160)} 的外部结果无法确认；已停止备用调用，避免重复写入或计费。`
        : hasRegisteredFallback
          ? `${safeId(context.capabilityId, 160)} 当前路线确认失败；交由受控路由判断已登记备用能力。`
          : `${safeId(context.capabilityId, 160)} 当前路线确认失败；未登记安全备用 Provider，已停止。`,
    });
    throw error;
  }
}

export async function emitExternalCapabilityRunEvent(
  onRunEvent: RunEventSink,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (typeof onRunEvent !== 'function') return;
  const safeEvent = allowlistedEvent(event);
  if (!safeEvent.taskId || !safeEvent.eventType) return;
  try {
    await onRunEvent(Object.freeze(safeEvent));
  } catch {
    // Telemetry is deliberately fail-open and must never change business outcome.
  }
}

/** Extracts only verified lineage fields from existing provider receipts. */
export function externalCapabilityEvidence(value: unknown): ExternalCapabilityEvidence {
  const result = record(value);
  const receipt = record(result.executionReceipt || result.receipt);
  const callRecord = record(result.callRecord || record(result.providerReceipt).callRecord);
  const costCommit = record(result.costCommit || record(result.providerReceipt).costCommit);
  const costEvent = record(costCommit.costEvent || callRecord.costEvent);
  const costCents = finiteNumber(costEvent.costCents);
  return Object.freeze({
    receiptId:safeId(receipt.receiptId, 160) || null,
    policyDecisionId:safeId(receipt.policyDecisionId, 160) || null,
    inputHash:hashRef(receipt.inputHash || callRecord.promptChecksum),
    outputHash:hashRef(receipt.outputHash || result.contentHash || result.checksum || result.observationChecksum),
    checkpointRef:safeId(
      costCommit.costEventId ? `cost-event:${costCommit.costEventId}` : callRecord.actionId,
      240,
    ) || null,
    costAmount:costCents === null ? finiteNumber(receipt.costUsd) : costCents / 100,
    costCurrency:costCents === null && receipt.costUsd == null ? null : 'USD',
    model:safeId(receipt.model || callRecord.model || result.model, 160) || null,
  });
}

function allowlistedEvent(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields = [
    'taskId', 'workflowId', 'stepId', 'agentId', 'eventType', 'capabilityId', 'routeId',
    'provider', 'model', 'attempt', 'status', 'startedAt', 'finishedAt', 'durationMs',
    'policyDecisionId', 'receiptId', 'checkpointRef', 'inputHash', 'outputHash',
    'errorCode', 'safeSummary', 'costAmount', 'costCurrency', 'retentionClass',
  ];
  return Object.fromEntries(fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [field, field === 'safeSummary'
      ? redact(value[field], 500)
      : typeof value[field] === 'string'
        ? safeId(value[field], field === 'checkpointRef' ? 240 : 160)
        : value[field]]));
}

function normalizeEvidence(value: ExternalCapabilityEvidence): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ''));
}

function externalOutcome(error: unknown): string {
  const value = record(error);
  return String(value.outcome || (value.ambiguous === true ? 'ambiguous' : '')).toLowerCase();
}

function hashRef(value: unknown): string | null {
  const normalized = safeId(value, 160).toLowerCase();
  const digest = normalized.startsWith('sha256:') ? normalized.slice(7) : normalized;
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null;
}

function duration(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function safeId(value: unknown, limit: number): string {
  return redact(value, limit).replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function redact(value: unknown, limit: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
    .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[已脱敏]')
    .slice(0, limit);
}
