import type {
  CapabilityDataClass,
  CapabilityRequest,
  CapabilitySideEffect,
  PolicyDecision,
} from './capability-policy.ts';
import type { CapabilityAdapter } from './capability-adapter.ts';

export type CapabilityRoute = Readonly<{
  routeId: string;
  adapter: CapabilityAdapter;
  maxCostUsd?: number | null;
  dataClass?: CapabilityDataClass;
  sideEffect?: CapabilitySideEffect;
}>;

export type CapabilityRoutePlan = Readonly<{
  primaryRouteId: string;
  fallbackRouteIds: readonly string[];
  maxRoutes: number;
}>;

export type ResolvedCapabilityRoute = Readonly<{
  routeId: string;
  adapter: CapabilityAdapter;
  maxCostUsd: number | null;
}>;

/** Pure route resolution: selection never invokes providers or mutates health. */
export function resolveCapabilityRoutes(input: Readonly<{
  routes: readonly CapabilityRoute[];
  plan?: CapabilityRoutePlan;
  request: CapabilityRequest;
  decision: PolicyDecision;
}>): readonly ResolvedCapabilityRoute[] {
  const routes = normalizeRoutes(input.routes);
  const byId = new Map(routes.map((route) => [route.routeId, route]));
  const plan = input.plan || Object.freeze({
    primaryRouteId:routes[0]?.routeId || '',
    fallbackRouteIds:routes.slice(1).map((route) => route.routeId),
    maxRoutes:Math.min(routes.length, 3),
  });
  const orderedIds = [plan.primaryRouteId, ...(plan.fallbackRouteIds || [])];
  const maxRoutes = Math.min(assertPositiveInteger(plan.maxRoutes, 'maxRoutes'), 3);
  const approvedBudget = minimumFinite([input.request.maxCostUsd, input.decision.effectiveBudgetUsd]);
  let reservedCost = 0;
  const seen = new Set<string>();
  const selected: ResolvedCapabilityRoute[] = [];
  for (const id of orderedIds) {
    const routeId = clean(id, 120);
    if (!routeId || seen.has(routeId)) continue;
    seen.add(routeId);
    const route = byId.get(routeId);
    if (!route) throw new TypeError(`能力路线未登记：${routeId}`);
    if (!sameOrSaferDataClass(route.dataClass, input.request.dataClass)) continue;
    if (!sameOrSaferSideEffect(route.sideEffect, input.request.sideEffect)) continue;
    const routeCost = finiteCost(route.maxCostUsd);
    if (!withinBudget(routeCost, reservedCost, approvedBudget)) continue;
    selected.push(Object.freeze({ routeId, adapter:route.adapter, maxCostUsd:routeCost }));
    if (routeCost !== null) reservedCost += routeCost;
    if (selected.length >= maxRoutes) break;
  }
  if (!selected.length) throw Object.assign(new Error('没有符合数据、副作用和预算边界的能力路线。'), {
    name:'CapabilityRouteError', code:'capability_route_unavailable', retryable:false,
  });
  return Object.freeze(selected);
}

function normalizeRoutes(routes: readonly CapabilityRoute[]): readonly CapabilityRoute[] {
  if (!Array.isArray(routes) || !routes.length) throw new TypeError('至少需要登记一条能力路线。');
  const ids = new Set<string>();
  return Object.freeze(routes.map((route) => {
    const routeId = clean(route?.routeId, 120);
    if (!routeId || !route?.adapter?.invoke || !clean(route.adapter.adapterId, 120)) throw new TypeError('能力路线缺少身份或 Adapter。');
    if (ids.has(routeId)) throw new TypeError(`能力路线重复：${routeId}`);
    ids.add(routeId);
    return Object.freeze({ ...route, routeId });
  }));
}

function sameOrSaferDataClass(route: CapabilityDataClass | undefined, requested: CapabilityDataClass): boolean {
  if (!route) return true;
  const rank: Record<CapabilityDataClass, number> = { public:0, 'local-controlled':1, private:2, authenticated:3, 'cross-device':4 };
  return rank[route] <= rank[requested];
}

function sameOrSaferSideEffect(route: CapabilitySideEffect | undefined, requested: CapabilitySideEffect): boolean {
  if (!route) return true;
  const rank: Record<CapabilitySideEffect, number> = { read:0, 'local-write':1, 'external-write':2, 'permission-expansion':3 };
  return rank[route] <= rank[requested];
}

function withinBudget(routeCost: number | null, reservedCost: number, approvedBudget: number | null): boolean {
  // A finite budget is a hard ceiling, so an unbounded/unknown route cannot be
  // reserved safely. It may only participate when the caller has no finite cap.
  if (routeCost === null) return approvedBudget === null;
  return approvedBudget === null || reservedCost + routeCost <= approvedBudget;
}

function minimumFinite(values: readonly unknown[]): number | null {
  const finite = values.map(finiteCost).filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
}

function finiteCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function assertPositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${field} 必须是正整数。`);
  return number;
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
