import { buildTaskFocus } from './task-overview-focus.ts';
import { buildValidationCampaign } from './workflow/validation-campaign.ts';
import { evaluateWorkflowTasks } from './workflow/evaluation.ts';

export async function buildTaskValidationOverview({
  tasks,
  approvals,
  store,
  capabilityCatalog,
}: {
  tasks: readonly any[];
  approvals: readonly any[];
  store: { listProposals?: () => Promise<readonly any[]> };
  capabilityCatalog?: { openTaskDelegates?: () => Readonly<Record<string, string>> } | null;
}) {
  const evidenceContext = {
    proposals:await store.listProposals?.() || [],
    taskTypeDelegates:capabilityCatalog?.openTaskDelegates?.() || {},
  };
  const workflows = evaluateWorkflowTasks(tasks);
  return Object.freeze({
    workflows,
    taskFocus:buildTaskFocus(tasks, approvals, evidenceContext, workflows),
    validationCampaign:buildValidationCampaign(tasks, evidenceContext),
  });
}
