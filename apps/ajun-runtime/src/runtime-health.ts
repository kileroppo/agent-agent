const CORE_HEALTHY = new Set(['healthy', 'ready']);
const CORE_STATUSES = new Set(['healthy', 'degraded', 'unavailable']);
const OPTIONAL_STATUSES = new Set(['healthy', 'limited', 'disabled', 'unavailable']);

export type RuntimeHealthComponent = Readonly<{
  id: string;
  name?: string;
  status: string;
  detail?: string;
}>;

export function buildRuntimeHealth({
  core = [],
  optional = [],
  summary = {},
  checkedAt = new Date().toISOString(),
}: {
  core?: readonly RuntimeHealthComponent[];
  optional?: readonly RuntimeHealthComponent[];
  summary?: Record<string, unknown>;
  checkedAt?: string;
} = {}) {
  const coreComponents = Object.freeze((Array.isArray(core) ? core : [])
    .slice(0, 20)
    .map((item) => healthComponent(item, 'core')));
  const optionalComponents = Object.freeze((Array.isArray(optional) ? optional : [])
    .slice(0, 30)
    .map((item) => healthComponent(item, 'optional')));
  const coreStatus = coreComponents.every((item) => CORE_HEALTHY.has(item.status))
    ? 'healthy'
    : coreComponents.some((item) => item.status === 'unavailable')
      ? 'unavailable'
      : 'degraded';

  return Object.freeze({
    schemaVersion:'agent.army/runtime-health/v1',
    status:coreStatus === 'healthy' ? 'healthy' : 'degraded',
    checkedAt:safeText(checkedAt, 40) || new Date().toISOString(),
    core:Object.freeze({ status:coreStatus, components:coreComponents }),
    optional:Object.freeze({ components:optionalComponents }),
    summary:safeSummary(summary),
  });
}

function healthComponent(value: RuntimeHealthComponent, kind: 'core' | 'optional') {
  const requested = safeText(value?.status, 30).toLowerCase();
  const allowed = kind === 'core' ? CORE_STATUSES : OPTIONAL_STATUSES;
  const normalized = kind === 'core' && requested === 'ready' ? 'healthy' : requested;
  return Object.freeze({
    id:safeText(value?.id, 80) || 'unknown',
    name:safeText(value?.name || value?.id, 100) || '未命名能力',
    status:allowed.has(normalized) ? normalized : kind === 'core' ? 'unavailable' : 'limited',
    detail:safeText(value?.detail, 240) || null,
  });
}

function safeSummary(value: Record<string, unknown>) {
  return Object.freeze({
    employeeCount:safeCount(value?.employeeCount),
    ...(typeof value?.version === 'string' ? { version:safeText(value.version, 80) || null } : {}),
  });
}

function safeCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeText(value: unknown, limit: number): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
