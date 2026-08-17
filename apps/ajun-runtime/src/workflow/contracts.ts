import { createHash } from 'node:crypto';

export const WORKFLOW_SCHEMA_VERSION = 'agent.army/business-workflow/v1' as const;
export const WORKFLOW_STEP_SCHEMA_VERSION = 'agent.army/workflow-step/v1' as const;

export type WorkflowWorkKind = 'business' | 'validation' | 'system';

export type WorkflowType =
  | 'content-production'
  | 'technical-repair'
  | 'agent-governance'
  | 'private-read'
  | 'single-task';

export const WORKFLOW_STATUSES = [
  'received', 'planning', 'running', 'recovering', 'waiting_user', 'waiting_validation',
  'waiting_acceptance', 'partial', 'succeeded', 'failed', 'cancelled',
] as const;

export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];
export type WorkflowAcceptanceDecision = 'accepted' | 'revision_required' | null;
export type WorkflowTaskInput = Readonly<Record<string, unknown>>;

export type WorkflowLink = Readonly<{
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  workflowType: WorkflowType;
  workKind: WorkflowWorkKind;
  step: Readonly<{
    schemaVersion: typeof WORKFLOW_STEP_SCHEMA_VERSION;
    stepId: string;
    key: string;
    required: boolean;
  }>;
}>;

export type WorkflowArtifactEvidence = Readonly<{
  artifactId: string;
  type: string;
  verified: boolean;
  humanAccepted: boolean;
}>;

export type WorkflowStepEvaluation = Readonly<{
  stepId: string;
  taskId: string;
  agentId: string | null;
  taskType: string;
  status: WorkflowStatus;
  required: boolean;
  artifacts: readonly WorkflowArtifactEvidence[];
  verified: boolean;
  humanAccepted: boolean;
  failureCode: string | null;
}>;

export type WorkflowEvaluation = Readonly<{
  schemaVersion: 'agent.army/workflow-evaluation/v1';
  workflowId: string;
  workflowType: WorkflowType;
  status: WorkflowStatus;
  steps: readonly WorkflowStepEvaluation[];
  requiredStepsComplete: boolean;
  verifiedArtifactCount: number;
  humanAcceptanceRequired: boolean;
  humanAccepted: boolean;
  workKind: WorkflowWorkKind;
  acceptanceDecision: WorkflowAcceptanceDecision;
  acceptanceVersion: number;
  acceptanceTaskId: string | null;
  ownerAction: string | null;
}>;

const CONTENT_TASK_PREFIXES = ['content.', 'media.', 'office.presentation-package'];
const TECHNICAL_TASK_PREFIXES = ['operations.'];
const GOVERNANCE_TASK_PREFIXES = ['governance.'];

export function deriveWorkflowType(taskType: unknown): WorkflowType {
  const value = clean(taskType, 160);
  if (value === 'wechat.chat.retrieval') return 'private-read';
  if (CONTENT_TASK_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'content-production';
  if (TECHNICAL_TASK_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'technical-repair';
  if (GOVERNANCE_TASK_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'agent-governance';
  if (value === 'army.cross-agent-mission') return 'content-production';
  return 'single-task';
}

export function workflowStepKey(taskType: unknown): string {
  const value = clean(taskType, 160);
  if (value.startsWith('research.')) return 'research';
  if (value.startsWith('media.')) return 'acquisition';
  if (value === 'content.video-benchmark-analysis' || value === 'content.analysis-program') return 'analysis';
  if (value.startsWith('content.')) return 'creation';
  if (value.startsWith('office.')) return 'office-delivery';
  if (value === 'operations.health-review') return 'health-observation';
  if (value.startsWith('operations.technical') || value === 'operations.engineering-resolution') return 'technical-repair';
  if (value.startsWith('operations.')) return 'operations';
  if (value === 'governance.agent-proposal' || value === 'governance.capability-design') return 'agent-design';
  if (value.startsWith('governance.architecture')) return 'architecture-review';
  if (value.startsWith('governance.approval') || value.startsWith('governance.assurance')) return 'assurance-review';
  if (value === 'wechat.chat.retrieval') return 'private-read';
  if (value === 'army.cross-agent-mission') return 'workflow-coordination';
  return value || 'task';
}

export function createWorkflowLink({
  taskType,
  idempotencyKey,
  workflowId,
  workflowType,
  workKind,
  stepId,
  stepKey,
  required = true,
}: {
  taskType: unknown;
  idempotencyKey: unknown;
  workflowId?: unknown;
  workflowType?: unknown;
  workKind?: unknown;
  stepId?: unknown;
  stepKey?: unknown;
  required?: unknown;
}): WorkflowLink {
  const key = clean(stepKey, 100) || workflowStepKey(taskType);
  const stableWorkflowId = validIdentifier(workflowId, 160)
    || `workflow:${digest(clean(idempotencyKey, 500) || `${clean(taskType, 160)}:${key}`).slice(0, 24)}`;
  const stableStepId = validIdentifier(stepId, 160)
    || `step:${key}:${digest(`${stableWorkflowId}:${clean(idempotencyKey, 500)}:${clean(taskType, 160)}`).slice(0, 16)}`;
  return Object.freeze({
    schemaVersion:WORKFLOW_SCHEMA_VERSION,
    workflowId:stableWorkflowId,
    workflowType:isWorkflowType(workflowType) ? workflowType : deriveWorkflowType(taskType),
    workKind:isWorkflowWorkKind(workKind) ? workKind : deriveWorkflowWorkKind({ taskType }),
    step:Object.freeze({
      schemaVersion:WORKFLOW_STEP_SCHEMA_VERSION,
      stepId:stableStepId,
      key,
      required:required !== false,
    }),
  });
}

export function deriveWorkflowWorkKind(task: unknown): WorkflowWorkKind {
  const record = asRecord(task);
  const workflow = asRecord(record?.workflow);
  const input = asRecord(record?.input);
  const context = asRecord(input?.context);
  const explicit = workflow?.workKind || record?.workKind || context?.workKind;
  const source = [
    asRecord(record?.source)?.channel,
    asRecord(record?.source)?.originChannel,
    asRecord(record?.source)?.eventRef,
    record?.idempotencyKey,
  ].map((value) => clean(value, 500).toLowerCase()).join('\n');
  const historicalPurpose = [input?.title, input?.description]
    .map((value) => clean(value, 1200))
    .join('\n');
  if (
    source.includes('product-maturity-validation')
    || source.includes('real-business-e2e')
    || historicalPurpose.includes('业务复验')
    || asRecord(context?.productMaturityAuthorization)?.kind === 'product-maturity-validation'
    || Boolean(context?.productMaturityBatchId)
    || Boolean(context?.validationPurpose)
    || Boolean(context?.validationRun)
    || Boolean(context?.businessValidation)
    || Boolean(context?.realBusinessE2e)
  ) return 'validation';
  if (isWorkflowWorkKind(explicit)) return explicit;
  const taskType = clean(record?.taskType, 160);
  if (
    taskType === 'operations.health-review'
    || (taskType === 'operations.failure-recovery' && source.includes('internal-recovery'))
  ) return 'system';
  return 'business';
}

export function workflowWorkKindForTasks(tasks: readonly unknown[]): WorkflowWorkKind {
  const kinds = tasks.map(deriveWorkflowWorkKind);
  if (kinds.includes('validation')) return 'validation';
  return kinds.length > 0 && kinds.every((kind) => kind === 'system') ? 'system' : 'business';
}

export function workflowIdFromTask(task: unknown): string | null {
  if (!isRecord(task)) return null;
  const nested = isRecord(task.workflow) ? task.workflow.workflowId : null;
  return validIdentifier(nested, 160) || null;
}

function isWorkflowType(value: unknown): value is WorkflowType {
  return [
    'content-production',
    'technical-repair',
    'agent-governance',
    'private-read',
    'single-task',
  ].includes(String(value));
}

function isWorkflowWorkKind(value: unknown): value is WorkflowWorkKind {
  return ['business', 'validation', 'system'].includes(String(value));
}

function validIdentifier(value: unknown, limit: number): string {
  const text = clean(value, limit);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text) ? text : '';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
