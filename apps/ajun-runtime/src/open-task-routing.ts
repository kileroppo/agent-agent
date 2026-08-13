// @ts-expect-error legacy policy implementation is migrated in a later bounded batch
import { openTaskRoutingPolicy } from './open-task-routing-policy.js';
// @ts-expect-error legacy execution implementation is migrated in a later bounded batch
import { openTaskResearchExecution } from './open-task-research-execution.js';
// @ts-expect-error legacy state implementation is migrated in a later bounded batch
import { openTaskResearchState } from './open-task-research-state.js';

export const {
  delegates:OPEN_TASK_DELEGATES,
  supports:supportsOpenTask,
  route:routeOpenTaskForExecutor,
  inspectManifest:inspectOpenTaskManifestCapabilities,
  decide:decideIntelResearchOpenTask,
} = openTaskRoutingPolicy;

export const {
  execute:executeIntelResearchOpenTaskStep,
} = openTaskResearchExecution;

export const {
  recover:recoverIntelResearchOpenTaskState,
} = openTaskResearchState;
