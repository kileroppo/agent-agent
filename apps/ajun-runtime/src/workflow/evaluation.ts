import {
  deriveWorkflowType,
  workflowWorkKindForTasks,
  type WorkflowAcceptanceDecision,
  type WorkflowEvaluation,
  type WorkflowStepEvaluation,
  type WorkflowTaskInput,
} from './contracts.ts';
import {
  ownerActionForWorkflowOutcome,
  workflowStatusForStepOutcomes,
  workflowStatusForTaskOutcome,
} from '../task-status-policy.ts';

export function evaluateWorkflowTasks(tasks: readonly unknown[], acceptances: readonly unknown[] = []): WorkflowEvaluation[] {
  const groups = new Map<string, unknown[]>();
  for (const task of tasks || []) {
    const workflowId = text(asRecord(asRecord(task)?.workflow)?.workflowId);
    if (!workflowId) continue;
    const group = groups.get(workflowId) || [];
    group.push(task);
    groups.set(workflowId, group);
  }
  return [...groups.entries()]
    .map(([workflowId, group]) => evaluateWorkflow(
      workflowId,
      group,
      acceptances.find((item) => asRecord(item)?.workflowId === workflowId) || null,
    ))
    .sort((left, right) => right.steps.length - left.steps.length || left.workflowId.localeCompare(right.workflowId));
}

export function evaluateWorkflow(workflowId: string, tasks: readonly unknown[], acceptance: unknown = null): WorkflowEvaluation {
  const steps = tasks.map(evaluateStep);
  const required = steps.filter((step) => step.required);
  const requiredStepsComplete = required.length > 0 && required.every((step) => step.verified);
  const workKind = workflowWorkKindForTasks(tasks);
  const acceptanceRecord = asRecord(acceptance);
  const acceptanceDecision = normalizedAcceptanceDecision(acceptanceRecord?.decision);
  const humanAcceptanceRequired = workKind === 'business' && steps.some((step) => qualityTask(step.taskType));
  const legacyHumanAccepted = steps.filter((step) => qualityTask(step.taskType)).every((step) => step.humanAccepted);
  const humanAccepted = !humanAcceptanceRequired || acceptanceDecision === 'accepted' || (!acceptanceDecision && legacyHumanAccepted);
  const evaluatedStatus = workflowStatusForStepOutcomes(steps, {
    requiredStepsComplete,
    humanAcceptanceRequired,
    humanAccepted,
  });
  const status = acceptanceDecision === 'revision_required' && evaluatedStatus === 'waiting_acceptance'
    ? 'succeeded'
    : evaluatedStatus;
  const acceptanceTaskId = acceptanceTargetStep(steps)?.taskId || null;
  const acceptanceVersion = typeof acceptanceRecord?.version === 'number' && Number.isSafeInteger(acceptanceRecord.version)
    ? acceptanceRecord.version
    : 0;
  return Object.freeze({
    schemaVersion:'agent.army/workflow-evaluation/v1',
    workflowId,
    workflowType:workflowTypeForTask(tasks[0]),
    status,
    steps,
    requiredStepsComplete,
    verifiedArtifactCount:steps.reduce((count, step) => count + step.artifacts.filter((item) => item.verified).length, 0),
    humanAcceptanceRequired,
    humanAccepted,
    workKind,
    acceptanceDecision,
    acceptanceVersion,
    acceptanceTaskId,
    ownerAction:workKind === 'business' && !acceptanceDecision
      ? ownerActionForWorkflowOutcome(steps, status)
      : null,
  });
}

export function acceptanceTargetStep(steps: readonly WorkflowStepEvaluation[]): WorkflowStepEvaluation | null {
  return steps.find((step) => qualityTask(step.taskType) && step.required && step.verified)
    || steps.find((step) => qualityTask(step.taskType) && step.verified)
    || steps.find((step) => step.required && step.verified)
    || steps.find((step) => step.verified)
    || null;
}

export function evaluateStep(task: unknown): WorkflowStepEvaluation {
  const record = asRecord(task);
  const artifacts = array(record?.artifactRefs).map((artifact) => Object.freeze({
    artifactId:text(asRecord(artifact)?.artifactId),
    type:text(asRecord(artifact)?.type),
    verified:verifiedArtifact(task, artifact),
    humanAccepted:humanAcceptedArtifact(artifact),
  }));
  const evaluation = asRecord(record?.evaluation);
  const humanAcceptance = asRecord(evaluation?.humanAcceptance);
  const verified = record?.status === 'succeeded' && artifacts.some((artifact) => artifact.verified);
  const humanAccepted = humanAcceptance?.status === 'accepted' || artifacts.some((artifact) => artifact.humanAccepted);
  return Object.freeze({
    stepId:text(asRecord(asRecord(record?.workflow)?.step)?.stepId) || text(record?.taskId),
    taskId:text(record?.taskId),
    agentId:text(record?.assigneeAgentId) || null,
    taskType:text(record?.taskType),
    status:workflowStatusForTaskOutcome({
      taskStatus:record?.status,
      verified,
      partial:artifactIsPartial(task),
      requiresAcceptance:qualityTask(record?.taskType),
      humanAccepted,
      recoveryPending:asRecord(asRecord(record?.recovery)?.coordination)?.status === 'pending',
    }),
    required:asRecord(asRecord(record?.workflow)?.step)?.required !== false,
    artifacts,
    verified,
    humanAccepted,
    failureCode:text(asRecord(record?.error)?.code) || null,
  });
}

function verifiedArtifact(task: unknown, artifact: unknown): boolean {
  const artifactRecord = asRecord(artifact);
  const validation = asRecord(artifactRecord?.validation);
  const generallyVerified = validation?.exists === true
    && validation?.readable === true
    && validation?.nonEmpty !== false
    && criticalValidationPassed(validation);
  if (!generallyVerified) return false;
  return artifactRecord?.type !== 'video_script_package'
    || verifiedVideoScriptPackage(task, artifact);
}

const VIDEO_SCRIPT_PACKAGE_FILES = Object.freeze([
  'script',
  'shots',
  'subtitles',
  'sources',
  'manifest',
]);

function verifiedVideoScriptPackage(task: unknown, artifact: unknown): boolean {
  const artifactRecord = asRecord(artifact);
  const validation = asRecord(artifactRecord?.validation);
  const data = asRecord(artifactRecord?.data);
  if (validation?.nonEmpty !== true) return false;
  const files = array(data?.productionFiles);
  const fileIds = new Set(files
    .map((file) => text(asRecord(file)?.id))
    .filter(Boolean));
  if (
    validation?.fileCount !== VIDEO_SCRIPT_PACKAGE_FILES.length
    || validation?.onePrimaryDraft !== true
    || files.length !== VIDEO_SCRIPT_PACKAGE_FILES.length
    || fileIds.size !== VIDEO_SCRIPT_PACKAGE_FILES.length
    || !VIDEO_SCRIPT_PACKAGE_FILES.every((fileId) => fileIds.has(fileId))
  ) return false;
  if (typeof data?.fullScript !== 'string' || !data.fullScript.trim()) return false;
  if (data?.publishingStatus !== 'draft_only') return false;
  if (validation?.externalSideEffects !== 0) return false;

  const taskRecord = asRecord(task);
  const requiredSourceTaskIds = normalizedIds(asRecord(asRecord(taskRecord?.input)?.context)?.requiredSourceTaskIds);
  if (!requiredSourceTaskIds.length) return true;
  const sourceTaskIds = new Set(normalizedIds(data?.sourceTaskIds));
  if (!requiredSourceTaskIds.every((taskId) => sourceTaskIds.has(taskId))) return false;
  const sourceRefs = new Set(normalizedIds(artifactRecord?.sourceRefs));
  if (sourceRefs.size < Math.max(2, requiredSourceTaskIds.length)) return false;
  const bindings = array(data?.sourceTaskBindings);
  return requiredSourceTaskIds.every((taskId) => bindings.some((binding) => {
    const bindingRecord = asRecord(binding);
    if (text(bindingRecord?.taskId) !== taskId) return false;
    const artifactIds = normalizedIds(bindingRecord?.artifactIds);
    return artifactIds.length > 0 && artifactIds.every((artifactId) => sourceRefs.has(artifactId));
  }));
}

function normalizedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function criticalValidationPassed(validation: unknown): boolean {
  const record = asRecord(validation);
  return [
    'claimEvidenceBound',
    'minimumSourcesMet',
    'searchDiversityMet',
    'counterEvidenceSearched',
    'modeStructurePassed',
    'formalSourceConfirmed',
    'visualClaimsEvidenceLinked',
  ].every((key) => record?.[key] !== false);
}

function humanAcceptedArtifact(artifact: unknown): boolean {
  const validation = asRecord(asRecord(artifact)?.validation);
  return validation?.humanAccepted === true || validation?.ownerAccepted === true || Boolean(validation?.humanAcceptedAt);
}

function artifactIsPartial(task: unknown): boolean {
  return array(asRecord(task)?.artifactRefs).some((artifact) => (
    asRecord(asRecord(artifact)?.validation)?.completeness === 'partial'
    || asRecord(asRecord(artifact)?.data)?.completeness === 'partial'
  ));
}

function qualityTask(taskType: unknown): boolean {
  const value = String(taskType || '');
  return value.startsWith('research.')
    || value.startsWith('content.')
    || value.startsWith('office.');
}

function normalizedAcceptanceDecision(value: unknown): WorkflowAcceptanceDecision {
  return value === 'accepted' || value === 'revision_required' ? value : null;
}

function workflowTypeForTask(task: unknown): WorkflowEvaluation['workflowType'] {
  const record = asRecord(task);
  const workflowType = asRecord(record?.workflow)?.workflowType;
  return workflowType === 'content-production' || workflowType === 'technical-repair' || workflowType === 'agent-governance' || workflowType === 'private-read' || workflowType === 'single-task'
    ? workflowType
    : deriveWorkflowType(record?.taskType);
}

function asRecord(value: unknown): WorkflowTaskInput | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowTaskInput : null; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return String(value || '').trim(); }
