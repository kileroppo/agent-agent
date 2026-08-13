import { M5StageRecoveryLedger } from './stage-recovery-ledger.js';

async function getActiveM5PlanRevision({ governance, ...input } = {}) {
  return new M5StageRecoveryLedger({ governance }).getActivePlanRevision(input);
}

async function consumeM5SystemPlanRevision({ governance, now, ...input } = {}) {
  return new M5StageRecoveryLedger({ governance, now }).consumeSystemPlanRevision(input);
}

export const stageRecoveryPlanRevision = Object.freeze({
  active:getActiveM5PlanRevision,
  consume:consumeM5SystemPlanRevision,
});
