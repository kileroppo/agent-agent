/**
 * Delivery is a separate truth from a task's business result.  A task may have
 * a readable artifact while its external notification is still unconfirmed.
 * Keep this small contract transport-neutral so Feishu, Hermes and document
 * adapters do not each invent their own ambiguous-write state machine.
 */
export const DELIVERY_RECEIPT_STATES = Object.freeze([
  'prepared',
  'sending',
  'delivered',
  'delivery_unknown',
  'failed',
] as const);

export type DeliveryReceiptState = typeof DELIVERY_RECEIPT_STATES[number];

const KNOWN = new Set<string>(DELIVERY_RECEIPT_STATES);

export function normalizeDeliveryReceipt(input: any): any {
  if (!input || typeof input !== 'object') return null;
  const id = text(input.deliveryId || input.idempotencyKey || input.receiptId, 160);
  const status = normalizeState(input.status || input.state || input.deliveryState);
  if (!id || !status) return null;
  const evidence = normalizeEvidence(input.evidence || input.deliveryEvidence);
  const lease = normalizeLease(input.lease);
  const errorCode = safeCode(input.errorCode || input.reason)
    || ((status === 'delivery_unknown' || status === 'failed') && (input.errorCode || input.reason) ? 'delivery_outcome_unknown' : undefined);
  return Object.freeze({
    deliveryId:id,
    idempotencyKey:text(input.idempotencyKey || id, 160),
    status,
    channel:text(input.channel, 80) || undefined,
    kind:text(input.kind, 40) || undefined,
    targetStatus:text(input.targetStatus, 80) || undefined,
    preparedAt:iso(input.preparedAt || input.createdAt),
    sendingAt:iso(input.sendingAt || input.startedAt),
    ...(status === 'delivered' ? { deliveredAt:iso(input.deliveredAt) } : {}),
    ...(status === 'delivery_unknown' ? { unknownAt:iso(input.unknownAt || input.uncertainAt) } : {}),
    ...(status === 'failed' ? { failedAt:iso(input.failedAt) } : {}),
    attempt:positiveInteger(input.attempt || input.attemptCount) || undefined,
    errorCode,
    ...(status === 'sending' && lease ? { lease } : {}),
    ...(evidence ? { evidence } : {}),
  });
}

export function createDeliveryReceipt(input: any = {}): any {
  return normalizeDeliveryReceipt({ ...input, status:input.status || input.state || 'prepared' });
}

/** A user-facing completion claim needs a receipt, not merely a successful job. */
export function isDeliveryConfirmed(input: any): boolean {
  const receipt = normalizeDeliveryReceipt(input);
  return receipt?.status === 'delivered' && Boolean(receipt.evidence?.observedAt);
}

export function deliveryRecoveryAction(input: any): any {
  const receipt = normalizeDeliveryReceipt(input);
  if (!receipt) return null;
  if (receipt.status === 'delivery_unknown') return Object.freeze({
    action:'verify_delivery',
    label:'核对飞书送达',
    message:'交付结果不确定，已停止自动重发；请先核对原会话，再决定是否恢复发送。',
  });
  if (receipt.status === 'failed') return Object.freeze({
    action:'retry_delivery',
    label:'恢复交付',
    message:'交付确认未开始或明确失败，可按既有幂等键恢复发送。',
  });
  return null;
}

export function deliveryReceiptSummary(input: any): any {
  const receipt = normalizeDeliveryReceipt(input);
  if (!receipt) return null;
  return Object.freeze({
    deliveryId:receipt.deliveryId,
    idempotencyKey:receipt.idempotencyKey,
    status:receipt.status,
    confirmed:isDeliveryConfirmed(receipt),
    action:deliveryRecoveryAction(receipt),
    ...(receipt.evidence ? { evidence:receipt.evidence } : {}),
    ...(receipt.errorCode ? { errorCode:receipt.errorCode } : {}),
  });
}

function normalizeState(value: any): DeliveryReceiptState | null {
  const state = text(value, 80).toLowerCase();
  // Compatibility with the original completion-watch file and provider terms.
  const aliases: Record<string, DeliveryReceiptState> = {
    uncertain:'delivery_unknown', unknown:'delivery_unknown', ambiguous:'delivery_unknown',
    not_started:'failed', confirmed_failure:'failed', rejected_before_send:'failed',
    confirmed:'delivered', success:'delivered', succeeded:'delivered',
  };
  const normalized = aliases[state] || state;
  return KNOWN.has(normalized) ? normalized as DeliveryReceiptState : null;
}

function normalizeEvidence(value: any): any {
  if (!value || typeof value !== 'object') return null;
  const observedAt = iso(value.observedAt || value.at || value.acknowledgedAt);
  const type = text(value.type || value.kind, 80);
  if (!observedAt || !type) return null;
  return Object.freeze({
    type,
    observedAt,
    reference:safeReference(value.reference || value.providerMessageId || value.documentUrl),
  });
}

// A lease is local coordination evidence, not a provider delivery receipt. It
// is kept only while a send is in progress so a later process can recover a
// crashed sender without assuming that the provider deduplicated anything.
function normalizeLease(value: any): any {
  if (!value || typeof value !== 'object') return null;
  const owner = text(value.owner, 120);
  const token = text(value.token, 120);
  const expiresAt = iso(value.expiresAt);
  if (!owner || !token || !expiresAt) return null;
  return Object.freeze({ owner, token, expiresAt });
}

function safeReference(value: any): string | undefined {
  const raw = text(value, 320);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.username || parsed.password) return undefined;
      return `${parsed.origin}${parsed.pathname}`.slice(0, 320);
    }
    catch { return undefined; }
  }
  if (/(?:token|secret|password|authorization|cookie|bearer)/i.test(raw)) return undefined;
  return /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(raw) ? raw : undefined;
}

function positiveInteger(value: any): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function iso(value: any): string | undefined {
  const source = text(value, 80);
  return source && Number.isFinite(Date.parse(source)) ? new Date(source).toISOString() : undefined;
}

function safeCode(value: any): string | undefined {
  const raw = text(value, 120);
  // Stored receipts are an audit surface.  A provider's arbitrary exception is
  // not a safe error code (and commonly embeds auth headers or target ids).
  if (!/^[a-z][a-z0-9_.-]{0,119}$/i.test(raw) || /(?:token|secret|password|authorization|cookie)/i.test(raw)) return undefined;
  return raw;
}

function text(value: any, limit: number): string {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
}
