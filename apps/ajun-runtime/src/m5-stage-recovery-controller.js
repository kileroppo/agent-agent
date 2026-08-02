import {
  healthyM5StageWorkProducts as kernelHealthy,
  m5StageWorkProductCandidates as kernelCandidates,
} from '@agent-army/m5-kernel/stage-recovery-controller';
import { normalizePaperclipWorkProduct } from '@agent-army/m5-kernel';

export {
  M5_STAGE_RECOVERY_LIMITS,
  M5StageRecoveryController,
  M5StageRecoveryError,
  consumeM5SystemPlanRevision,
  deriveM5StageRecoveryState,
  getActiveM5PlanRevision,
  planM5StageFailureRecovery,
} from '@agent-army/m5-kernel/stage-recovery-controller';

export function healthyM5StageWorkProducts(outputs, contract) {
  return preserveLegacyRecords(outputs, contract, kernelHealthy);
}

export function m5StageWorkProductCandidates(outputs, contract) {
  return preserveLegacyRecords(outputs, contract, kernelCandidates);
}

function preserveLegacyRecords(outputs, contract, select) {
  const source = Array.isArray(outputs) ? outputs : [];
  const canonical = source.map(normalizePaperclipWorkProduct);
  const selected = new Set(select(canonical, contract));
  return source.filter((_, index) => selected.has(canonical[index]));
}
