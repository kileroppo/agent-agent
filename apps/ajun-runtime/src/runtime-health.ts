const CORE_HEALTHY = new Set(['healthy', 'ready']);
const CORE_STATUSES = new Set(['healthy', 'degraded', 'unavailable']);
const OPTIONAL_STATUSES = new Set(['healthy', 'limited', 'disabled', 'unavailable']);

export type RuntimeHealthComponent = Readonly<{
  id: string;
  name?: string;
  status: string;
  detail?: string;
}>;

export type RuntimeObservationIdentity = Readonly<{
  gitHead?: string | null;
  releaseHash?: string | null;
}>;

export type ReliabilitySnapshot = Readonly<{
  status?: string;
  detail?: string;
  observedAt?: string | null;
  runtimeIdentity?: RuntimeObservationIdentity | null;
}>;

/**
 * 只有观测明确属于当前 git/release 身份时，才允许它改变运行台的可靠性结论。
 * 旧 release、候选构建或没有身份标记的报告都必须显示为 unknown。
 */
export function reliabilityForCurrentRuntime(
  snapshot: ReliabilitySnapshot | null | undefined,
  currentRuntime: RuntimeObservationIdentity | null | undefined,
) {
  const current = safeIdentity(currentRuntime);
  const observed = safeIdentity(snapshot?.runtimeIdentity);
  const currentKeys = Object.keys(current);
  if (!currentKeys.length) {
    return unknownReliability('当前运行身份尚未提供，不能采信任何稳定性观测。');
  }
  if (!currentKeys.every((key) => observed[key] === current[key])) {
    return unknownReliability('稳定性观测不是当前 git/release 身份，不能显示为当前版本结论。');
  }
  const status = normalizeReliabilityStatus(snapshot?.status);
  if (status === 'unknown')
    return unknownReliability('当前版本的稳定性观测没有有效结论。');
  return Object.freeze({
    status,
    detail:safeText(snapshot?.detail, 240) || '可靠性状态来自当前版本的有效观测。',
    observedAt:safeText(snapshot?.observedAt, 40) || null,
  });
}

/**
 * 运行台展示的三层真相。它和 /api/health 的轻量存活探针分开：
 * 存活不等于近期可靠性，也不等于没有待复验或失败的业务债务。
 */
export function buildConsoleHealthTruth({
  runtimeHealth,
  taskFocus,
  reliability = null,
  checkedAt = new Date().toISOString(),
}: {
  runtimeHealth?: any;
  taskFocus?: any;
  reliability?: any;
  checkedAt?: string;
} = {}) {
  const core = runtimeHealth?.core;
  const coreStatus = String(core?.status || '').trim();
  const coreOnline = coreStatus === 'healthy'
    ? { status:'online', detail:'核心运行时和治理连接均可响应。' }
    : coreStatus === 'degraded'
      ? { status:'degraded', detail:'运行台可响应，但至少一个核心依赖处于降级状态。' }
      : coreStatus === 'unavailable'
        ? { status:'offline', detail:'至少一个核心依赖不可用。' }
        : { status:'unknown', detail:'尚未获得有效的核心存活结果。' };
  const reliabilityStatus = normalizeReliabilityStatus(reliability?.status);
  const reliabilityDetail = safeText(reliability?.detail, 240)
    || (reliabilityStatus === 'unknown'
      ? '尚无同版本、同环境的有效稳定性观测；不能据此显示为稳定。'
      : '可靠性状态来自最近一次有效观测。');
  const debt = debtSnapshot(taskFocus);
  return Object.freeze({
    schemaVersion:'agent.army/console-health/v1',
    checkedAt:safeText(checkedAt, 40) || new Date().toISOString(),
    coreOnline:Object.freeze(coreOnline),
    reliability:Object.freeze({
      status:reliabilityStatus,
      detail:reliabilityDetail,
      observedAt:safeText(reliability?.observedAt, 40) || null,
    }),
    businessDebt:Object.freeze(debt),
  });
}

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

function normalizeReliabilityStatus(value: unknown): 'healthy' | 'degraded' | 'unavailable' | 'unknown' {
  const status = safeText(value, 32).toLowerCase();
  return ['healthy', 'degraded', 'unavailable'].includes(status)
    ? status as 'healthy' | 'degraded' | 'unavailable'
    : 'unknown';
}

function safeIdentity(value: RuntimeObservationIdentity | null | undefined): Record<string, string> {
  return Object.fromEntries(['gitHead', 'releaseHash'].flatMap((key) => {
    const text = safeText(value?.[key as keyof RuntimeObservationIdentity], 160);
    return text ? [[key, text]] : [];
  }));
}

function unknownReliability(detail: string) {
  return Object.freeze({ status:'unknown', detail, observedAt:null });
}

function debtSnapshot(taskFocus: any) {
  const fields = ['reviewBacklog', 'verificationBacklog', 'unresolvedFailures', 'ownerActionable'];
  const values: any = Object.fromEntries(fields.map((field) => [field, safeCount(taskFocus?.[field])]));
  const known = fields.every((field) => values[field] !== null);
  const total = fields.reduce((sum, field) => sum + (values[field] || 0), 0);
  return {
    status:!known ? 'unknown' : total > 0 ? 'needs_attention' : 'clear',
    reviewBacklog:values.reviewBacklog,
    verificationBacklog:values.verificationBacklog,
    unresolvedFailures:values.unresolvedFailures,
    ownerActionable:values.ownerActionable,
    detail:!known
      ? '当前业务债务统计尚未就绪，不能显示为无待办。'
      : total > 0
        ? '仍有待复验、未解决失败或负责人动作；核心在线不代表这些债务已清零。'
        : '当前没有待复验、未解决失败或负责人动作。',
  };
}

function safeText(value: unknown, limit: number): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
