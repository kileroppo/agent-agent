import { buildTaskFocus } from './task-overview-focus.ts';
import { buildValidationCampaign } from './workflow/validation-campaign.ts';

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
  return Object.freeze({
    taskFocus:buildTaskFocus(tasks, approvals, evidenceContext),
    validationCampaign:buildValidationCampaign(tasks, evidenceContext),
  });
}
