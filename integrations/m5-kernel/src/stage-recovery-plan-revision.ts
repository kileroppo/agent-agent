import { M5StageRecoveryLedger } from './stage-recovery-ledger.ts';

const RecoveryLedger = M5StageRecoveryLedger as unknown as new (
  input?: Record<string, unknown>,
) => M5StageRecoveryLedger;

async function getActiveM5PlanRevision({ governance, ...input }: Record<string, any> = {}) {
  return new RecoveryLedger({ governance }).getActivePlanRevision(input);
}

async function consumeM5SystemPlanRevision({ governance, now, ...input }: Record<string, any> = {}) {
  return new RecoveryLedger({ governance, now }).consumeSystemPlanRevision(input);
}

export const stageRecoveryPlanRevision = Object.freeze({
  active:getActiveM5PlanRevision,
  consume:consumeM5SystemPlanRevision,
});
