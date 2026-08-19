import { diagnoseFeishuCommanderChain } from './feishu-commander-chain-diagnosis.ts';
import { observeFeishuCommanderChain } from './feishu-commander-chain-observations.ts';
import type { ChainObservationDeps } from './feishu-commander-chain-observations.ts';
import type { ChainObservations } from './feishu-commander-chain-diagnosis.ts';

export const EMPTY_OBSERVATIONS: ChainObservations = Object.freeze({
  gatewayProcess: Object.freeze({ status: 'unknown', loaded: false, pid: null }),
  adapterPatch: Object.freeze({ status: 'unknown', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: Object.freeze({}) }),
  requiredEnv: Object.freeze({ status: 'unknown', variables: Object.freeze({}) }),
  runtimeIngress: Object.freeze({ status: 'unknown', reachable: false }),
  profileGuard: Object.freeze({ status: 'unknown', agentId: null }),
  feishuAdmission: Object.freeze({ status: 'unknown', configured: false }),
});

export type DiagnosisApiDeps = Readonly<{
  request: Readonly<{ method?: string; url?: string }>;
  local: boolean;
  observeChain: () => Promise<ChainObservations>;
}>;

export async function routeDiagnosisApi({ request, local, observeChain }: DiagnosisApiDeps): Promise<{ status: number; payload: any } | null> {
  if (request.method !== 'GET' || request.url !== '/api/diagnose/feishu-chain') return null;
  if (!local) return { status: 403, payload: { error: '链路诊断只能在本机执行。' } };
  const observations = await observeChain();
  const diagnosis = diagnoseFeishuCommanderChain(observations);
  return { status: 200, payload: diagnosis };
}

export { observeFeishuCommanderChain, diagnoseFeishuCommanderChain };
