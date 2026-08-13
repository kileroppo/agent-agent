import { stageRecoveryState } from './stage-recovery-state.js';
import { stageRecoveryPlanRevision } from './stage-recovery-plan-revision.js';
import { stageRecoveryExecution } from './stage-recovery-execution.js';
import { stageRecoveryLedger } from './stage-recovery-ledger.js';

export const {
  limits:M5_STAGE_RECOVERY_LIMITS,
  Error:M5StageRecoveryError,
  derive:deriveM5StageRecoveryState,
  plan:planM5StageFailureRecovery,
  workProducts:{
    healthy:healthyM5StageWorkProducts,
    candidates:m5StageWorkProductCandidates,
  },
} = stageRecoveryState;

export const {
  active:getActiveM5PlanRevision,
  consume:consumeM5SystemPlanRevision,
} = stageRecoveryPlanRevision;

export const {
  Controller:M5StageRecoveryController,
} = stageRecoveryExecution;

export const {
  Ledger:M5StageRecoveryLedger,
} = stageRecoveryLedger;
