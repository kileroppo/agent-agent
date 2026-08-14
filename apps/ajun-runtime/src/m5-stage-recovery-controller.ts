import { healthyM5StageWorkProducts as kernelHealthy, m5StageWorkProductCandidates as kernelCandidates, } from '@agent-army/m5-kernel/stage-recovery-controller';
import { normalizePaperclipWorkProduct } from '@agent-army/m5-kernel';
export { M5_STAGE_RECOVERY_LIMITS, M5StageRecoveryController, M5StageRecoveryError, M5StageRecoveryLedger, consumeM5SystemPlanRevision, deriveM5StageRecoveryState, getActiveM5PlanRevision, planM5StageFailureRecovery, } from '@agent-army/m5-kernel/stage-recovery-controller';
export function healthyM5StageWorkProducts(outputs: any, contract: any): any {
    return preserveLegacyRecords(outputs, contract, kernelHealthy);
}
export function m5StageWorkProductCandidates(outputs: any, contract: any): any {
    return preserveLegacyRecords(outputs, contract, kernelCandidates);
}
function preserveLegacyRecords(outputs: any, contract: any, select: any): any {
    const source: any = Array.isArray(outputs) ? outputs : [];
    const canonical: any = source.map(normalizePaperclipWorkProduct);
    const selected: any = new Set(select(canonical, contract));
    return source.filter((_: any, index: any): any => selected.has(canonical[index]));
}
