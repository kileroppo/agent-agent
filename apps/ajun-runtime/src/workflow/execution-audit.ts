export const EXECUTION_AUDIT_VERSION = 'agent.army/execution-audit/v1' as const;

type TaskUsage = Readonly<{
  model?: Readonly<{
    status?: unknown;
    provider?: unknown;
    model?: unknown;
    apiCalls?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  }>;
  cost?: Readonly<{
    status?: unknown;
    amount?: unknown;
    currency?: unknown;
    basis?: unknown;
    source?: unknown;
  }>;
}>;

type Artifact = Readonly<{
  validation?: Readonly<Record<string, unknown>>;
  data?: Readonly<Record<string, unknown>>;
}>;

export function buildExecutionAudit({
  usage,
  artifacts = [],
}: {
  usage?: TaskUsage | null;
  artifacts?: readonly Artifact[];
} = {}) {
  const model = usage?.model;
  const apiCalls = nonNegativeInteger(model?.apiCalls);
  const modelStatus = String(model?.status || '').trim();
  const providerCallStatus = modelStatus === 'reported' && apiCalls > 0
    ? 'used'
    : (!model || modelStatus === 'not_reported') && apiCalls === 0
      ? 'not_reported'
      : 'unknown';
  const cost = usage?.cost;
  const costBasis = normalizeCostBasis(cost?.basis);
  const costStatus = String(cost?.status || '').trim() === 'reported'
    ? costBasis === 'estimated'
      ? 'estimated'
      : costBasis === 'actual'
        ? 'actual'
        : costBasis === 'included'
          ? 'included'
          : 'reported'
    : providerCallStatus === 'used'
      ? 'unknown'
      : 'not_reported';
  const visionReceipt = artifacts
    .map((artifact) => artifact?.data?.visualExecutionReceipt)
    .find(validVisionReceipt) as Readonly<Record<string, unknown>> | undefined;
  const controlledVisionUsed = Boolean(visionReceipt);
  const controlledVisionInvoked = artifacts.some((artifact) => (
    artifact?.validation?.controlledVisionInvoked === true
  ));
  const controlledVisionNotUsed = artifacts.some((artifact) => (
    artifact?.validation
    && Object.hasOwn(artifact.validation, 'controlledVisionInvoked')
    && artifact.validation.controlledVisionInvoked === false
  ));
  const visualStatus = controlledVisionUsed
    ? 'used'
    : controlledVisionInvoked
      ? 'unknown'
      : controlledVisionNotUsed
        ? 'not_used'
        : 'not_reported';
  const visualCostUsd = finiteNonNegativeNumber(visionReceipt?.costUsd);

  return Object.freeze({
    schemaVersion:EXECUTION_AUDIT_VERSION,
    modelProvider:{
      status:providerCallStatus,
      provider:clean(model?.provider, 120) || null,
      model:clean(model?.model, 160) || null,
      apiCalls,
      inputTokens:nonNegativeInteger(model?.inputTokens),
      outputTokens:nonNegativeInteger(model?.outputTokens),
    },
    cost:{
      status:costStatus,
      amount:['reported', 'estimated', 'actual', 'included'].includes(costStatus)
        ? nonNegativeNumber(cost?.amount)
        : null,
      currency:['reported', 'estimated', 'actual', 'included'].includes(costStatus)
        ? clean(cost?.currency, 12) || null
        : null,
      basis:['reported', 'estimated', 'actual', 'included'].includes(costStatus)
        ? costBasis
        : null,
      source:['reported', 'estimated', 'actual', 'included'].includes(costStatus)
        ? clean(cost?.source, 80) || null
        : null,
      paidStatus:costStatus === 'actual'
        ? 'confirmed'
        : costStatus === 'included'
          ? 'not_paid'
          : 'unknown',
    },
    visualProvider:{
      status:visualStatus,
      provider:controlledVisionUsed ? clean(visionReceipt?.provider, 120) || null : null,
      model:controlledVisionUsed ? clean(visionReceipt?.model, 160) || null : null,
      receiptId:controlledVisionUsed ? clean(visionReceipt?.receiptId, 180) || null : null,
      cost:controlledVisionUsed ? {
        status:visualCostUsd === null ? 'not_reported' : 'reported',
        amountUsd:visualCostUsd,
        basis:visualCostUsd === null ? null : 'execution_receipt_adapter_reported',
        paidStatus:'unknown',
      } : null,
    },
    externalWrite:{
      status:'not_reported',
      note:'没有独立外部写入回执时，不得声称外部写入次数为零。',
    },
  });
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return nonNegativeNumber(value);
}

function normalizeCostBasis(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (['estimated', 'actual', 'included', 'mixed', 'task_usage_reported'].includes(normalized)) {
    return normalized;
  }
  return 'task_usage_reported';
}

function validVisionReceipt(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(clean((value as Record<string, unknown>).receiptId, 180));
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
