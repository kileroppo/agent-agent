import path from 'node:path';
import { IsolatedRepairWorkspace } from '../isolated-repair-workspace.ts';
import { LocalTechnicalExpert } from '../local-technical-expert.ts';
import { TechnicalExpertRunner } from '../technical-expert-runner.ts';
import { TechnicalRepairDiagnoser } from '../technical-repair-diagnoser.ts';
import { TechnicalRepairPromotion } from '../technical-repair-promotion.ts';
import { TechnicalRepairWatchdog } from '../technical-repair-watchdog.ts';
import type {
  RoleTechnicalExecutionCompositionInput,
  TechnicalRepairWatchdogInput,
} from './composition-contracts.ts';

export function createRoleTechnicalExecutionComposition({
  paths,
  runtimeSource,
}: RoleTechnicalExecutionCompositionInput) {
  const repairWorkspace = new IsolatedRepairWorkspace({
    projectRoot:paths.sourceProjectRoot,
    parentDir:path.join(paths.repairWorktreeParent, 'ajun-repairs'),
    sourceIdentity:runtimeSource.sourceIdentity,
    verifySourceRoot:runtimeSource.verify,
  });
  const technicalRepairPromotion = new TechnicalRepairPromotion({
    projectRoot:paths.sourceProjectRoot,
    allowedWorkspaceRoots:[paths.repairWorktreeParent],
    sourceMode:runtimeSource.mode,
    sourceIdentity:runtimeSource.sourceIdentity,
    verifySourceRoot:runtimeSource.verify,
  });
  const unguardedTechnicalRepairDiagnoser = new TechnicalRepairDiagnoser();
  const technicalRepairDiagnoser = {
    async diagnose(...args: Parameters<TechnicalRepairDiagnoser['diagnose']>) {
      await runtimeSource.verify();
      return unguardedTechnicalRepairDiagnoser.diagnose(...args);
    },
  };

  return {
    technicalExpert:new LocalTechnicalExpert({
      workspace:repairWorkspace,
      runner:new TechnicalExpertRunner(),
      promotion:technicalRepairPromotion,
    }),
    technicalRepairDiagnoser,
  };
}

export function createTechnicalRepairWatchdog({ store, governance }: TechnicalRepairWatchdogInput) {
  return new TechnicalRepairWatchdog({ store, governance });
}
