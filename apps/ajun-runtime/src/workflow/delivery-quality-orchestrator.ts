import { createHash } from 'node:crypto';
import {
  resolveDeliveryBrief,
  type DeliveryBrief,
} from './delivery-brief.ts';
import {
  buildQualityProfile,
  createAssuranceReviewRequest,
  normalizeQualityReview,
  type QualityProfile,
  type QualityReview,
} from './quality-review.ts';
import {
  createRevisionDirective,
  decideRevision,
  type RevisionDecision,
} from './revision-policy.ts';

export const DELIVERY_QUALITY_ORCHESTRATION_SCHEMA_VERSION = 'agent.army/delivery-quality-orchestration/v1' as const;

type Source = Readonly<Record<string, any>>;
type ReviewTaskRequest = NonNullable<ReturnType<typeof createAssuranceReviewRequest>>;
type RevisionDirective = NonNullable<ReturnType<typeof createRevisionDirective>>;

export type DeliveryQualityAction = 'request_review' | 'accept' | 'revise' | 'stop';

export type DeliveryQualityOrchestration = Readonly<{
  schemaVersion: typeof DELIVERY_QUALITY_ORCHESTRATION_SCHEMA_VERSION;
  taskId: string | null;
  idempotencyKey: string;
  action: DeliveryQualityAction;
  workflowStatus: 'waiting_acceptance' | 'waiting_validation' | 'partial';
  brief: DeliveryBrief;
  profile: QualityProfile;
  review: QualityReview | null;
  reviewTaskRequest: ReviewTaskRequest | null;
  revisionDecision: RevisionDecision | null;
  revisionDirective: RevisionDirective | null;
  reason: string;
}>;

/**
 * Pure, deterministic seam between a completed delivery and task creation.
 * The caller owns persistence: create `reviewTaskRequest` at most once using its
 * idempotency key, or execute `revisionDirective` without replacing old artifacts.
 */
export function orchestrateDeliveryQuality({
  completedTask,
  artifactRefs,
  reviewResult,
  revisionRound,
}: {
  completedTask: Source;
  artifactRefs?: readonly unknown[];
  reviewResult?: unknown;
  revisionRound?: unknown;
}): DeliveryQualityOrchestration {
  const taskId = identifier(completedTask.taskId, 160) || null;
  const brief = resolveDeliveryBrief(completedTask);
  const profile = buildQualityProfile(completedTask, brief);
  const artifacts = normalizeArtifactRefs(artifactRefs ?? completedTask.artifactRefs);
  const base = { taskId, brief, profile };

  if (!taskId) {
    return outcome(base, {
      action:'stop',
      workflowStatus:'waiting_validation',
      reason:'完成任务缺少可追踪 taskId，不能创建复核或返工任务。',
    });
  }
  if (!isCompleted(completedTask.status)) {
    return outcome(base, {
      action:'stop',
      workflowStatus:'waiting_validation',
      reason:'任务尚未形成成功完成记录，不能进入交付质量编排。',
    });
  }
  if (brief.readiness !== 'ready') {
    return outcome(base, {
      action:'stop',
      workflowStatus:'waiting_validation',
      reason:brief.clarification || '交付简报尚未就绪。',
    });
  }
  if (!artifacts.length) {
    return outcome(base, {
      action:'stop',
      workflowStatus:'waiting_validation',
      reason:'没有可追踪的产物引用，不能宣称交付通过或启动独立复核。',
    });
  }

  if (reviewResult === undefined || reviewResult === null) {
    if (!profile.independentReviewRequired) {
      return outcome(base, {
        action:'accept',
        workflowStatus:'waiting_acceptance',
        reason:'标准任务已完成岗位自检，等待负责人采用。',
      });
    }
    const reviewTaskRequest = createAssuranceReviewRequest({
      task:completedTask,
      brief,
      profile,
      artifactRefs:artifacts,
    });
    if (!reviewTaskRequest) {
      return outcome(base, {
        action:'stop',
        workflowStatus:'waiting_validation',
        reason:'任务需要独立复核，但未能生成复核任务请求。',
      });
    }
    return outcome(base, {
      action:'request_review',
      workflowStatus:'waiting_validation',
      reviewTaskRequest,
      reason:'重要或高风险交付需要由 reviewer 独立复核。',
    });
  }

  const reviewSource = reviewPayload(reviewResult);
  const review = normalizeQualityReview(reviewSource);
  if (profile.independentReviewRequired && !isIndependentReview(reviewResult, taskId)) {
    return outcome(base, {
      action:'stop',
      workflowStatus:'waiting_validation',
      review,
      reason:'复核结果没有绑定当前任务和独立 reviewer，不能据此放行或自动返工。',
    });
  }

  const decision = decideRevision({
    review,
    revisionRound:revisionRound ?? completedTask.revisionRound,
    hasUsableArtifact:true,
  });
  if (decision.action === 'accept') {
    return outcome(base, {
      action:'accept',
      workflowStatus:decision.workflowStatus,
      review,
      revisionDecision:decision,
      reason:decision.reason,
    });
  }
  if (decision.action === 'revise') {
    const revisionDirective = createRevisionDirective({
      task:{
        taskId,
        rootTaskId:completedTask.rootTaskId,
        artifactRefs:artifacts,
      },
      decision,
    });
    if (revisionDirective) {
      return outcome(base, {
        action:'revise',
        workflowStatus:decision.workflowStatus,
        review,
        revisionDecision:decision,
        revisionDirective,
        reason:decision.reason,
      });
    }
  }
  return outcome(base, {
    action:'stop',
    workflowStatus:decision.workflowStatus,
    review,
    revisionDecision:decision,
    reason:decision.reason,
  });
}

function outcome(
  base: Readonly<{ taskId: string | null; brief: DeliveryBrief; profile: QualityProfile }>,
  value: Readonly<{
    action: DeliveryQualityAction;
    workflowStatus: DeliveryQualityOrchestration['workflowStatus'];
    review?: QualityReview | null;
    reviewTaskRequest?: ReviewTaskRequest | null;
    revisionDecision?: RevisionDecision | null;
    revisionDirective?: RevisionDirective | null;
    reason: string;
  }>,
): DeliveryQualityOrchestration {
  const review = value.review ?? null;
  const reviewTaskRequest = value.reviewTaskRequest ?? null;
  const revisionDecision = value.revisionDecision ?? null;
  const revisionDirective = value.revisionDirective ?? null;
  const identity = stableDigest({
    taskId:base.taskId,
    action:value.action,
    reviewTaskKey:reviewTaskRequest?.idempotencyKey || null,
    revisionRound:revisionDirective?.revisionRound || null,
    failedCriteria:revisionDirective?.failedCriteria || review?.failedCriteria || [],
  });
  return Object.freeze({
    schemaVersion:DELIVERY_QUALITY_ORCHESTRATION_SCHEMA_VERSION,
    taskId:base.taskId,
    idempotencyKey:`delivery-quality:${base.taskId || 'invalid'}:${identity.slice(0, 20)}`,
    action:value.action,
    workflowStatus:value.workflowStatus,
    brief:base.brief,
    profile:base.profile,
    review,
    reviewTaskRequest,
    revisionDecision,
    revisionDirective,
    reason:value.reason,
  });
}

function isCompleted(value: unknown): boolean {
  return ['succeeded', 'completed'].includes(clean(value, 40));
}

function isIndependentReview(value: unknown, taskId: string): boolean {
  const source = record(value);
  const payload = reviewPayload(value);
  const context = record(source.context);
  const payloadContext = record(payload.context);
  const reviewerAgentId = identifier(
    source.reviewerAgentId || source.assigneeAgentId || source.agentId
      || payload.reviewerAgentId || payload.assigneeAgentId || payload.agentId,
    160,
  );
  const sourceTaskId = identifier(
    source.sourceTaskId || context.sourceTaskId || payload.sourceTaskId || payloadContext.sourceTaskId,
    160,
  );
  return reviewerAgentId === 'reviewer' && sourceTaskId === taskId;
}

function reviewPayload(value: unknown): Source {
  const source = record(value);
  for (const candidate of [source.qualityReview, source.result, source.output, record(source.artifact).data]) {
    const payload = record(candidate);
    if (Object.keys(payload).length) return payload;
  }
  return source;
}

function normalizeArtifactRefs(value: unknown): readonly Readonly<{
  artifactId: string;
  type: string | null;
  contentHash: string | null;
}>[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const byId = new Map<string, Readonly<{ artifactId: string; type: string | null; contentHash: string | null }>>();
  for (const candidate of value) {
    const artifact = record(candidate);
    const artifactId = identifier(artifact.artifactId, 200);
    if (!artifactId) continue;
    const validation = record(artifact.validation);
    byId.set(artifactId, Object.freeze({
      artifactId,
      type:clean(artifact.type, 160) || null,
      contentHash:clean(artifact.contentHash || validation.contentHash || validation.sha256, 160) || null,
    }));
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)));
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function identifier(value: unknown, limit: number): string {
  const text = clean(value, limit);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text) ? text : '';
}

function record(value: unknown): Source {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Source
    : {};
}
