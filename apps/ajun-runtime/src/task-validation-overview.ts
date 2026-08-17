import { buildTaskFocus } from './task-overview-focus.ts';
import { buildValidationCampaign } from './workflow/validation-campaign.ts';
import { evaluateWorkflowTasks } from './workflow/evaluation.ts';

export async function buildTaskValidationOverview({
  tasks,
  approvals,
  store,
  capabilityCatalog,
  includeValidationCampaign = true,
  buildCampaign = buildValidationCampaign,
}: {
  tasks: readonly any[];
  approvals: readonly any[];
  store: {
    listProposals?: () => Promise<readonly any[]>;
    listWorkflowAcceptances?: () => Promise<readonly any[]>;
  };
  capabilityCatalog?: { openTaskDelegates?: () => Readonly<Record<string, string>> } | null;
  includeValidationCampaign?: boolean;
  buildCampaign?: typeof buildValidationCampaign;
}) {
  const evidenceContext = {
    proposals:await store.listProposals?.() || [],
    taskTypeDelegates:capabilityCatalog?.openTaskDelegates?.() || {},
  };
  const workflows = evaluateWorkflowTasks(
    tasks,
    await store.listWorkflowAcceptances?.() || [],
  );
  const overview = {
    workflows,
    taskFocus:buildTaskFocus(tasks, approvals, evidenceContext, workflows),
  };
  return Object.freeze(includeValidationCampaign
    ? { ...overview, validationCampaign:buildCampaign(tasks, evidenceContext) }
    : overview);
}
