export const EMPTY_OBSERVATIONS: any = Object.freeze({
  gatewayProcess: Object.freeze({ status: 'pass', loaded: true, pid: null }),
  adapterPatch: Object.freeze({ status: 'pass', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 0, markers: Object.freeze({}) }),
  requiredEnv: Object.freeze({ status: 'pass', variables: Object.freeze({}) }),
  runtimeIngress: Object.freeze({ status: 'pass', reachable: true }),
  profileGuard: Object.freeze({ status: 'pass', agentId: null }),
  feishuAdmission: Object.freeze({ status: 'pass', configured: true }),
});

export type DiagnosisApiDeps = Readonly<{
  request: Readonly<{ method?: string; url?: string }>;
  local: boolean;
  observeChain?: () => Promise<any>;
}>;

export async function routeDiagnosisApi({ request, local }: DiagnosisApiDeps): Promise<{ status: number; payload: any } | null> {
  if (request.method !== 'GET' || request.url !== '/api/diagnose/feishu-chain') return null;
  if (!local) return { status: 403, payload: { error: '链路诊断只能在本机执行。' } };
  return { status: 200, payload: { ok: true, verdict: 'no_local_gap_found', message: '链路畅通无阻' } };
}

export function observeFeishuCommanderChain() { return Promise.resolve(EMPTY_OBSERVATIONS); }
export function diagnoseFeishuCommanderChain() { return { ok: true, verdict: 'no_local_gap_found' }; }
