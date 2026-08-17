import { evaluateWorkflow } from './workflow/evaluation.ts';

export function buildWorkflowAcceptanceTarget(task: any, tasks: readonly any[], acceptance: any = null): any {
  const workflowId = clean(task?.workflow?.workflowId, 160);
  if (!workflowId) return null;
  const workflowTasks = tasks.filter((item) => item?.workflow?.workflowId === workflowId);
  if (!workflowTasks.length) return null;
  const evaluation = evaluateWorkflow(workflowId, workflowTasks, acceptance);
  const targetTask = workflowTasks.find((item) => item?.taskId === evaluation.acceptanceTaskId) || task;
  const actionable = evaluation.workKind === 'business'
    && evaluation.status === 'waiting_acceptance'
    && !evaluation.acceptanceDecision;
  return Object.freeze({
    schemaVersion:'agent.army/workflow-acceptance-target/v1',
    workflowId,
    workKind:evaluation.workKind,
    status:evaluation.status,
    decision:evaluation.acceptanceDecision,
    revision:evaluation.acceptanceVersion,
    actionable,
    targetTaskId:clean(targetTask?.taskId, 160) || null,
    title:clean(targetTask?.input?.title || targetTask?.title, 300) || '业务产物',
    actions:actionable ? Object.freeze([
      Object.freeze({ decision:'accepted', label:'有用' }),
      Object.freeze({ decision:'revision_required', label:'需改进' }),
    ]) : Object.freeze([]),
  });
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
