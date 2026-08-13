import {
  deriveWorkflowType,
  type WorkflowEvaluation,
  type WorkflowStepEvaluation,
} from './contracts.ts';
import {
  ownerActionForWorkflowOutcome,
  workflowStatusForStepOutcomes,
  workflowStatusForTaskOutcome,
} from '../task-status-policy.js';

export function evaluateWorkflowTasks(tasks: readonly any[]): WorkflowEvaluation[] {
  const groups = new Map<string, any[]>();
  for (const task of tasks || []) {
    const workflowId = String(task?.workflow?.workflowId || '').trim();
    if (!workflowId) continue;
    const group = groups.get(workflowId) || [];
    group.push(task);
    groups.set(workflowId, group);
  }
  return [...groups.entries()]
    .map(([workflowId, group]) => evaluateWorkflow(workflowId, group))
    .sort((left, right) => right.steps.length - left.steps.length || left.workflowId.localeCompare(right.workflowId));
}

export function evaluateWorkflow(workflowId: string, tasks: readonly any[]): WorkflowEvaluation {
  const steps = tasks.map(evaluateStep);
  const required = steps.filter((step) => step.required);
  const requiredStepsComplete = required.length > 0 && required.every((step) => step.verified);
  const humanAcceptanceRequired = steps.some((step) => qualityTask(step.taskType));
  const humanAccepted = !humanAcceptanceRequired || steps.filter((step) => qualityTask(step.taskType)).every((step) => step.humanAccepted);
  const status = workflowStatusForStepOutcomes(steps, {
    requiredStepsComplete,
    humanAcceptanceRequired,
    humanAccepted,
  });
  return Object.freeze({
    schemaVersion:'agent.army/workflow-evaluation/v1',
    workflowId,
    workflowType:tasks[0]?.workflow?.workflowType || deriveWorkflowType(tasks[0]?.taskType),
    status,
    steps,
    requiredStepsComplete,
    verifiedArtifactCount:steps.reduce((count, step) => count + step.artifacts.filter((item) => item.verified).length, 0),
    humanAcceptanceRequired,
    humanAccepted,
    ownerAction:ownerActionForWorkflowOutcome(steps, status),
  });
}

export function evaluateStep(task: any): WorkflowStepEvaluation {
  const artifacts = (Array.isArray(task?.artifactRefs) ? task.artifactRefs : []).map((artifact: any) => Object.freeze({
    artifactId:String(artifact?.artifactId || ''),
    type:String(artifact?.type || ''),
    verified:verifiedArtifact(artifact),
    humanAccepted:humanAcceptedArtifact(artifact),
  }));
  const verified = task?.status === 'succeeded' && artifacts.some((artifact: any) => artifact.verified);
  const humanAccepted = task?.evaluation?.humanAcceptance?.status === 'accepted'
    || artifacts.some((artifact: any) => artifact.humanAccepted);
  return Object.freeze({
    stepId:String(task?.workflow?.step?.stepId || task?.taskId || ''),
    taskId:String(task?.taskId || ''),
    agentId:String(task?.assigneeAgentId || '').trim() || null,
    taskType:String(task?.taskType || ''),
    status:workflowStatusForTaskOutcome({
      taskStatus:task?.status,
      verified,
      partial:artifactIsPartial(task),
      requiresAcceptance:qualityTask(task?.taskType),
      humanAccepted,
      recoveryPending:task?.recovery?.coordination?.status === 'pending',
    }),
    required:task?.workflow?.step?.required !== false,
    artifacts,
    verified,
    humanAccepted,
    failureCode:String(task?.error?.code || '').trim() || null,
  });
}

function verifiedArtifact(artifact: any): boolean {
  return artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty !== false
    && criticalValidationPassed(artifact?.validation);
}

function criticalValidationPassed(validation: any): boolean {
  return [
    'claimEvidenceBound',
    'minimumSourcesMet',
    'searchDiversityMet',
    'counterEvidenceSearched',
    'modeStructurePassed',
    'formalSourceConfirmed',
    'visualClaimsEvidenceLinked',
  ].every((key) => validation?.[key] !== false);
}

function humanAcceptedArtifact(artifact: any): boolean {
  return artifact?.validation?.humanAccepted === true
    || artifact?.validation?.ownerAccepted === true
    || Boolean(artifact?.validation?.humanAcceptedAt);
}

function artifactIsPartial(task: any): boolean {
  return (task?.artifactRefs || []).some((artifact: any) => (
    artifact?.validation?.completeness === 'partial'
    || artifact?.data?.completeness === 'partial'
  ));
}

function qualityTask(taskType: unknown): boolean {
  const value = String(taskType || '');
  return value.startsWith('research.')
    || value.startsWith('content.')
    || value.startsWith('office.');
}
