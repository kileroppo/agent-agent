import type { QualityReview } from './quality-review.ts';
import { taskOutcomePolicy } from '../task-status-policy.ts';

export const MAX_DELIVERY_REVISION_ROUNDS = 2 as const;
export const REVISION_DECISION_SCHEMA_VERSION = 'agent.army/delivery-revision-decision/v1' as const;

export type RevisionDecision = Readonly<{
  schemaVersion: typeof REVISION_DECISION_SCHEMA_VERSION;
  action: 'accept' | 'revise' | 'stop';
  currentRound: number;
  nextRound: number | null;
  maxRounds: typeof MAX_DELIVERY_REVISION_ROUNDS;
  workflowStatus: 'waiting_acceptance' | 'waiting_validation' | 'partial';
  failedCriteria: readonly string[];
  preservePassedContent: true;
  reason: string;
}>;

type RevisionSource = Readonly<Record<string, any>>;

export function decideRevision({
  review,
  revisionRound,
  hasUsableArtifact = false,
}: {
  review: QualityReview;
  revisionRound?: unknown;
  hasUsableArtifact?: boolean;
}): RevisionDecision {
  const currentRound = normalizeRevisionRound(revisionRound);
  if (review.status === 'passed') {
    return decision({
      action:'accept',
      currentRound,
      nextRound:null,
      workflowStatus:revisionWorkflowStatus('waiting_acceptance'),
      failedCriteria:[],
      reason:'质量门已通过，等待负责人采用。',
    });
  }
  if (review.status === 'revise' && review.failedCriteria.length && currentRound < MAX_DELIVERY_REVISION_ROUNDS) {
    return decision({
      action:'revise',
      currentRound,
      nextRound:currentRound + 1,
      workflowStatus:revisionWorkflowStatus('waiting_validation'),
      failedCriteria:review.failedCriteria,
      reason:`只修复未通过项，进入第 ${currentRound + 1} 轮内部返工。`,
    });
  }
  if (review.status === 'revise' && !review.failedCriteria.length) {
    return decision({
      action:'stop',
      currentRound,
      nextRound:null,
      workflowStatus:stoppedWorkflowStatus(hasUsableArtifact),
      failedCriteria:[],
      reason:'审核要求修改但没有可执行失败项，停止自动返工并等待补充复核意见。',
    });
  }
  if (review.status === 'revise') {
    return decision({
      action:'stop',
      currentRound,
      nextRound:null,
      workflowStatus:stoppedWorkflowStatus(hasUsableArtifact),
      failedCriteria:review.failedCriteria,
      reason:'两轮内部返工已用尽，停止继续调用并保留当前最好版本。',
    });
  }
  return decision({
    action:'stop',
    currentRound,
    nextRound:null,
    workflowStatus:stoppedWorkflowStatus(hasUsableArtifact),
    failedCriteria:review.failedCriteria,
    reason:review.status === 'blocked'
      ? '质量复核被阻断，等待缺失证据、权限或输入恢复。'
      : '质量复核尚未完成，不能推进到人工采用。',
  });
}

function revisionWorkflowStatus(outcome: string): RevisionDecision['workflowStatus'] {
  return taskOutcomePolicy(outcome).workflowStatus as RevisionDecision['workflowStatus'];
}

function stoppedWorkflowStatus(hasUsableArtifact: boolean): RevisionDecision['workflowStatus'] {
  return revisionWorkflowStatus(hasUsableArtifact ? 'partial' : 'waiting_validation');
}

export function createRevisionDirective({
  task,
  decision:revisionDecision,
}: {
  task: RevisionSource;
  decision: RevisionDecision;
}) {
  if (revisionDecision.action !== 'revise' || revisionDecision.nextRound === null) return null;
  const taskId = identifier(task.taskId, 160);
  if (!taskId) return null;
  const artifactRefs = (Array.isArray(task.artifactRefs) ? task.artifactRefs : [])
    .map((artifact) => revisionArtifact(artifact))
    .filter((artifact): artifact is NonNullable<ReturnType<typeof revisionArtifact>> => Boolean(artifact));
  return Object.freeze({
    schemaVersion:'agent.army/delivery-revision-directive/v1' as const,
    sourceTaskId:taskId,
    rootTaskId:identifier(task.rootTaskId, 160) || taskId,
    revisionRound:revisionDecision.nextRound,
    failedCriteria:revisionDecision.failedCriteria,
    preservePassedContent:true as const,
    sourceArtifactRefs:Object.freeze(artifactRefs),
    instruction:'只修改失败项，并复查修改可能影响的相邻内容；不得覆盖或删除旧版本产物。',
  });
}

export function normalizeRevisionRound(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_DELIVERY_REVISION_ROUNDS);
}

function decision(input: Omit<RevisionDecision, 'schemaVersion' | 'maxRounds' | 'preservePassedContent'>): RevisionDecision {
  return Object.freeze({
    schemaVersion:REVISION_DECISION_SCHEMA_VERSION,
    ...input,
    failedCriteria:Object.freeze([...input.failedCriteria]),
    maxRounds:MAX_DELIVERY_REVISION_ROUNDS,
    preservePassedContent:true,
  });
}

function revisionArtifact(value: unknown): Readonly<{ artifactId: string; type: string | null }> | null {
  const artifact = record(value);
  const artifactId = identifier(artifact.artifactId, 200);
  return artifactId ? Object.freeze({ artifactId, type:clean(artifact.type, 160) || null }) : null;
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function identifier(value: unknown, limit: number): string {
  const text = clean(value, limit);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text) ? text : '';
}

function record(value: unknown): RevisionSource {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RevisionSource
    : {};
}
