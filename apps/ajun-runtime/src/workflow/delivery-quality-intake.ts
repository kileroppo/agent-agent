import { resolveDeliveryBrief } from './delivery-brief.ts';
import { buildQualityProfile } from './quality-review.ts';

type TaskDraft = Readonly<Record<string, any>>;

export function attachDeliveryQualityContracts(task: TaskDraft) {
  const brief = resolveDeliveryBrief(task);
  const profile = buildQualityProfile(task, brief);
  const input = task.input && typeof task.input === 'object' ? task.input : {};
  return {
    ...task,
    deliveryBrief:brief,
    qualityProfile:profile,
    revisionRound:normalizeRevisionRound(input.context?.deliveryRevision?.revisionRound ?? task.revisionRound),
    input:{
      ...input,
      reviewPolicy:profile.independentReviewRequired ? 'required' : input.reviewPolicy,
    },
  };
}

export function deliveryBriefGuardPatch(task: TaskDraft) {
  if (task.deliveryBrief?.readiness !== 'needs_clarification') return null;
  const clarification = String(task.deliveryBrief.clarification || '请补充完成任务所需的信息。').slice(0, 500);
  return {
    status:'needs_input', currentStage:'delivery_brief_needs_clarification',
    error:{
      code:'delivery_brief_needs_clarification', message:clarification, userMessage:clarification,
      category:'needs_input', stage:'delivery_brief', retryable:false, occurredAt:new Date().toISOString(),
    },
  };
}

function normalizeRevisionRound(value: unknown): number {
  const round = Number(value);
  return Number.isInteger(round) && round >= 0 ? Math.min(round, 2) : 0;
}
