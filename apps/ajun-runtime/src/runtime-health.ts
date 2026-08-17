const CORE_HEALTHY = new Set(['healthy', 'ready']);
const CORE_STATUSES = new Set(['healthy', 'degraded', 'unavailable']);
const OPTIONAL_STATUSES = new Set(['healthy', 'limited', 'disabled', 'unavailable']);

/**
 * 完成结论可保留 24 小时；运行中的长测另以小快照 heartbeat 证明仍在推进。
 * 两者都失效时必须回到 unknown，不能让旧结论永久染绿或显示降级。
 */
export const RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** 容忍写入机与运行台最多五分钟的时钟差；更远的未来时间一律不采信。 */
export const RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const RUNTIME_RELIABILITY_PROGRESS_MAX_AGE_MS = (2 * 60 * 60 + 60) * 1_000;

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
  progressObservedAt?: string | null;
  progressIntervalSeconds?: number | null;
  runtimeIdentity?: RuntimeObservationIdentity | null;
}>;

/**
 * 只有观测明确属于当前 git/release 身份时，才允许它改变运行台的可靠性结论。
 * 旧 release、候选构建或没有身份标记的报告都必须显示为 unknown。
 */
export function reliabilityForCurrentRuntime(
  snapshot: ReliabilitySnapshot | null | undefined,
  currentRuntime: RuntimeObservationIdentity | null | undefined,
  { checkedAt = Date.now() }: { checkedAt?: string | number | Date } = {},
) {
  const current = safeIdentity(currentRuntime);
  const observed = safeIdentity(snapshot?.runtimeIdentity);
  if (!current) {
    return unknownReliability('当前运行身份不完整或无效，不能采信任何稳定性观测。');
  }
  if (!observed || observed.gitHead !== current.gitHead || observed.releaseHash !== current.releaseHash) {
    return unknownReliability('稳定性观测不是当前 git/release 身份，不能显示为当前版本结论。');
  }
  const status = normalizeReliabilityStatus(snapshot?.status);
  if (status === 'unknown')
    return unknownReliability('当前版本的稳定性观测没有有效结论。');
  const freshness = reliabilityFreshness(snapshot, checkedAt);
  if (freshness !== null)
    return unknownReliability(freshness);
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
  const suppliedCore = Array.isArray(core) && core.length > 0;
  const coreComponents = Object.freeze((Array.isArray(core) ? core : [])
    .slice(0, 20)
    .map((item) => healthComponent(item, 'core')));
  const optionalComponents = Object.freeze((Array.isArray(optional) ? optional : [])
    .slice(0, 30)
    .map((item) => healthComponent(item, 'optional')));
  const coreStatus = !suppliedCore
    ? 'unknown'
    : coreComponents.every((item) => CORE_HEALTHY.has(item.status))
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

function safeIdentity(value: RuntimeObservationIdentity | null | undefined): Readonly<{ gitHead: string; releaseHash: string }> | null {
  const gitHead = safeText(value?.gitHead, 40).toLowerCase();
  const releaseHash = safeText(value?.releaseHash, 64).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(gitHead) || !/^[0-9a-f]{64}$/.test(releaseHash)) return null;
  return Object.freeze({ gitHead, releaseHash });
}

function unknownReliability(detail: string) {
  return Object.freeze({ status:'unknown', detail, observedAt:null });
}

function reliabilityFreshness(snapshot: ReliabilitySnapshot | null | undefined, checkedAt: string | number | Date): string | null {
  const checkedMs = checkedAt instanceof Date ? checkedAt.getTime() : typeof checkedAt === 'number'
    ? checkedAt
    : Date.parse(String(checkedAt || ''));
  const conclusion = reliabilityTime(snapshot?.observedAt);
  if (!Number.isFinite(checkedMs) || conclusion === null)
    return '稳定性结论缺少可校验时间，不能显示为当前版本结论。';
  if (conclusion > checkedMs + RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS)
    return '稳定性结论时间明显晚于本机时钟，不能显示为当前版本结论。';
  const progressValue = snapshot?.progressObservedAt;
  const progress = progressValue === undefined || progressValue === null ? null : reliabilityTime(progressValue);
  if (progressValue !== undefined && progressValue !== null && progress === null)
    return '稳定性观测推进时间无效，不能显示为当前版本结论。';
  if (progress !== null && progress > checkedMs + RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS)
    return '稳定性观测推进时间明显晚于本机时钟，不能显示为当前版本结论。';
  if (checkedMs - conclusion <= RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS) return null;
  if (progress !== null && checkedMs - progress <= reliabilityProgressMaxAgeMs(snapshot?.progressIntervalSeconds)) return null;
  return progress === null
    ? '稳定性结论已超过 24 小时，且没有正在推进的同身份观测，不能显示为当前版本结论。'
    : '稳定性观测推进已停止，不能显示为当前版本结论。';
}

function reliabilityTime(value: unknown): number | null {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function reliabilityProgressMaxAgeMs(intervalSeconds: unknown): number {
  const interval = Number(intervalSeconds);
  const valid = Number.isSafeInteger(interval) && interval > 0 && interval <= 3_600 ? interval : 30;
  return Math.min((2 * valid + 60) * 1_000, RUNTIME_RELIABILITY_PROGRESS_MAX_AGE_MS);
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
