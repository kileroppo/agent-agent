import path from 'node:path';

import { IsolatedRepairWorkspace } from '../isolated-repair-workspace.js';
import { LocalTechnicalExpert } from '../local-technical-expert.js';
import { TechnicalExpertRunner } from '../technical-expert-runner.js';
import { TechnicalRepairDiagnoser } from '../technical-repair-diagnoser.js';
import { TechnicalRepairPromotion } from '../technical-repair-promotion.js';
import { TechnicalRepairWatchdog } from '../technical-repair-watchdog.js';

export function createRoleTechnicalExecutionComposition({ paths, runtimeSource }) {
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
    async diagnose(...args) {
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

export function createTechnicalRepairWatchdog({ store, governance }) {
  return new TechnicalRepairWatchdog({ store, governance });
}
