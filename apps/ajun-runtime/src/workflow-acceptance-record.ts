import { createHash } from 'node:crypto';

export const WORKFLOW_ACCEPTANCE_SCHEMA_VERSION = 'agent.army/workflow-acceptance/v1' as const;

export type WorkflowAcceptanceDecision = 'accepted' | 'revision_required';
export type WorkflowAcceptanceSource = 'feishu_feedback' | 'local_console';

export type WorkflowAcceptanceRecord = Readonly<{
  schemaVersion: typeof WORKFLOW_ACCEPTANCE_SCHEMA_VERSION;
  workflowId: string;
  decision: WorkflowAcceptanceDecision;
  note: string;
  source: WorkflowAcceptanceSource;
  version: number;
  decidedAt: string;
  updatedAt: string;
  idempotencyReceipts: readonly Readonly<{
    key: string;
    fingerprint: string;
    version: number;
  }>[];
}>;

export function applyWorkflowAcceptanceDecision(
  current: WorkflowAcceptanceRecord | null,
  input: Readonly<{
    workflowId: string;
    decision: WorkflowAcceptanceDecision;
    note: string;
    source: WorkflowAcceptanceSource;
    expectedVersion: number | null;
    idempotencyKey: string;
  }>,
  now: string,
) {
  const fingerprint = acceptanceFingerprint(input);
  const replay = current?.idempotencyReceipts?.find((receipt) => receipt.key === input.idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw acceptanceStoreError(
      '同一个操作编号不能提交不同的验收结论。',
      'workflow_acceptance_idempotency_conflict',
    );
    return Object.freeze({ acceptance:current, created:false, duplicate:true });
  }
  const currentVersion = current?.version || 0;
  if (input.expectedVersion !== null && input.expectedVersion !== currentVersion) throw acceptanceStoreError(
    '这件工作的验收状态刚刚发生变化，请刷新后再操作。',
    'workflow_acceptance_version_conflict',
  );
  const version = currentVersion + 1;
  const acceptance: WorkflowAcceptanceRecord = Object.freeze({
    schemaVersion:WORKFLOW_ACCEPTANCE_SCHEMA_VERSION,
    workflowId:input.workflowId,
    decision:input.decision,
    note:input.note,
    source:input.source,
    version,
    decidedAt:now,
    updatedAt:now,
    idempotencyReceipts:Object.freeze([
      ...(current?.idempotencyReceipts || []),
      Object.freeze({ key:input.idempotencyKey, fingerprint, version }),
    ].slice(-20)),
  });
  return Object.freeze({ acceptance, created:!current, duplicate:false });
}

export function acceptanceFingerprint(input: Readonly<{
  workflowId: string;
  decision: string;
  note: string;
  source: string;
}>): string {
  return createHash('sha256').update(JSON.stringify({
    workflowId:input.workflowId,
    decision:input.decision,
    note:input.note,
    source:input.source,
  })).digest('hex');
}

function acceptanceStoreError(message: string, code: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
