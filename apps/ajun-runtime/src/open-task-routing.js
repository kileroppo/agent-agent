import { openTaskRoutingPolicy } from './open-task-routing-policy.js';
import { openTaskResearchExecution } from './open-task-research-execution.js';
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
