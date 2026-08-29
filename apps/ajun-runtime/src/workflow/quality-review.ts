import { createHash } from 'node:crypto';
import type { DeliveryBrief } from './delivery-brief.ts';

export const QUALITY_PROFILE_SCHEMA_VERSION = 'agent.army/delivery-quality-profile/v1' as const;
export const QUALITY_REVIEW_SCHEMA_VERSION = 'agent.army/delivery-quality-review/v1' as const;

export type QualityTier = 'standard' | 'important' | 'high_risk';
export type QualityReviewStatus = 'pending' | 'passed' | 'revise' | 'blocked';

export type QualityCriterion = Readonly<{
  key: string;
  label: string;
  required: true;
}>;

export type QualityProfile = Readonly<{
  schemaVersion: typeof QUALITY_PROFILE_SCHEMA_VERSION;
  tier: QualityTier;
  rubricVersion: 'agent.army/role-quality-rubric/v1';
  criteria: readonly QualityCriterion[];
  independentReviewRequired: boolean;
  reason: string;
}>;

export type QualityReview = Readonly<{
  schemaVersion: typeof QUALITY_REVIEW_SCHEMA_VERSION;
  status: QualityReviewStatus;
  failedCriteria: readonly string[];
  evidenceRefs: readonly string[];
  safeSummary: string | null;
}>;

type QualitySource = Readonly<Record<string, any>>;

const HIGH_RISK_SIDE_EFFECTS = new Set(['external-write', 'publish', 'delete', 'payment', 'permission-expansion']);
const HIGH_RISK_TEXT = /发布|外发|群发|删除|付款|付费|转账|扩权|账号|凭据|私密|敏感/i;
const IMPORTANT_TEXT = /正式|汇报|评审|团队|客户|对外|决策|重要|交付/i;

export function buildQualityProfile(source: QualitySource, brief?: DeliveryBrief): QualityProfile {
  const tier = classifyQualityTier(source, brief);
  const taskType = clean(source.taskType || record(source.input).taskType, 160);
  const criteria = criteriaFor(taskType);
  return Object.freeze({
    schemaVersion:QUALITY_PROFILE_SCHEMA_VERSION,
    tier,
    rubricVersion:'agent.army/role-quality-rubric/v1',
    criteria:Object.freeze(criteria),
    independentReviewRequired:tier !== 'standard' && taskType !== 'governance.assurance-review',
    reason:tierReason(tier, source),
  });
}

export function classifyQualityTier(source: QualitySource, brief?: DeliveryBrief): QualityTier {
  const input = record(source.input);
  const requested = clean(source.qualityTier || input.qualityTier, 40);
  if (requested === 'high_risk') return 'high_risk';
  if (requested === 'important') return 'important';

  const taskType = clean(source.taskType || input.taskType, 160);
  const sideEffect = clean(source.sideEffect || input.sideEffect || record(input.context).sideEffect, 80);
  const riskLevel = clean(source.riskLevel || input.riskLevel || record(input.context).riskLevel, 40);
  const taskText = [source.title, source.description, input.title, input.description]
    .map((value) => clean(value, 2_000))
    .filter(Boolean)
    .join(' ');
  if (
    riskLevel === 'high'
    || HIGH_RISK_SIDE_EFFECTS.has(sideEffect)
    || /(?:publisher|external-write|payment|destructive-action)/.test(taskType)
    || HIGH_RISK_TEXT.test(taskText)
  ) return 'high_risk';

  if (
    requested === 'important'
    || (taskType.startsWith('research.') && taskType !== 'research.github-search')
    || taskType === 'office.presentation-package'
    || taskType.startsWith('governance.assurance')
    || IMPORTANT_TEXT.test(taskText)
    || IMPORTANT_TEXT.test(`${brief?.audience || ''} ${brief?.usageScenario || ''}`)
  ) return 'important';
  return 'standard';
}

export function normalizeQualityReview(value: unknown): QualityReview {
  const review = record(value);
  const rawStatus = clean(review.status, 40);
  const failedCriteria = textList(review.failedCriteria, 100);
  const evidenceRefs = textList(review.evidenceRefs, 240);
  const candidateStatus: QualityReviewStatus = ['passed', 'revise', 'blocked'].includes(rawStatus)
    ? rawStatus as QualityReviewStatus
    : 'pending';
  const status = candidateStatus === 'passed' && failedCriteria.length
    ? 'revise'
    : candidateStatus === 'passed' && !evidenceRefs.length
      ? 'blocked'
      : candidateStatus;
  return Object.freeze({
    schemaVersion:QUALITY_REVIEW_SCHEMA_VERSION,
    status,
    failedCriteria:Object.freeze(failedCriteria),
    evidenceRefs:Object.freeze(evidenceRefs),
    safeSummary:clean(review.safeSummary, 1_000) || null,
  });
}

/** Keep only evidence references bound to the reviewed artifact snapshot. */
export function verifiableQualityEvidenceRefs(
  evidenceRefs: unknown,
  artifactRefs: unknown,
): readonly string[] {
  const supplied = textList(evidenceRefs, 240);
  const allowed = new Set<string>();
  for (const candidate of Array.isArray(artifactRefs) ? artifactRefs : []) {
    const artifact = record(candidate);
    const artifactId = identifier(artifact.artifactId, 200);
    const validation = record(artifact.validation);
    const contentHash = clean(artifact.contentHash || validation.contentHash || validation.sha256, 160);
    if (artifactId) {
      allowed.add(artifactId);
      allowed.add(`artifact:${artifactId}`);
    }
    if (contentHash) {
      allowed.add(contentHash);
      if (!contentHash.startsWith('sha256:')) allowed.add(`sha256:${contentHash}`);
    }
  }
  return Object.freeze(supplied.filter((reference) => allowed.has(reference)));
}

export function createAssuranceReviewRequest({
  task,
  brief,
  profile,
  artifactRefs = [],
}: {
  task: QualitySource;
  brief: DeliveryBrief;
  profile: QualityProfile;
  artifactRefs?: readonly unknown[];
}) {
  if (!profile.independentReviewRequired) return null;
  const taskId = identifier(task.taskId, 160) || 'unpersisted-task';
  const workflowId = identifier(record(task.workflow).workflowId, 160) || null;
  const safeArtifacts = artifactRefs.map(reviewArtifact).filter((value): value is NonNullable<ReturnType<typeof reviewArtifact>> => Boolean(value));
  const evidenceKey = digest(JSON.stringify(safeArtifacts));
  const title = clean(record(task.input).title || task.title || task.taskType, 300) || taskId;
  return Object.freeze({
    taskType:'governance.assurance-review' as const,
    agentId:'reviewer' as const,
    parentTaskId:taskId,
    idempotencyKey:`quality-review:${taskId}:${evidenceKey.slice(0, 16)}`,
    title:`交付质量复核：${title}`.slice(0, 500),
    description:'按交付简报逐项核对产物；只报告可定位证据、失败项和可执行修改，不替负责人做最终采用决定。',
    context:Object.freeze({
      sourceTaskId:taskId,
      workflowId,
      reviewKind:'delivery_quality',
      qualityTier:profile.tier,
      deliveryBrief:brief,
      rubricVersion:profile.rubricVersion,
      criteria:profile.criteria,
      artifactRefs:Object.freeze(safeArtifacts),
    }),
  });
}

function criteriaFor(taskType: string): QualityCriterion[] {
  const common = [
    criterion('goal_coverage', '产物完成交付简报中的目标和必需项'),
    criterion('artifact_usable', '主产物真实存在、可读且可直接使用'),
  ];
  if (taskType.startsWith('media.')) return [
    ...common,
    criterion('source_complete', '素材已完整读取，覆盖范围如实说明'),
    criterion('transcript_accuracy', '人名、术语、数字、结论和时间定位经过抽查'),
    criterion('summary_fidelity', '摘要忠于原始素材且未加入无依据判断'),
  ];
  if (taskType.startsWith('research.')) return [
    ...common,
    criterion('question_answered', '结论直接回答研究问题'),
    criterion('sources_readable', '关键来源正文已实际读取且时间有效'),
    criterion('claims_evidence_bound', '关键主张绑定具体证据'),
    criterion('counter_evidence_checked', '主动检查反例或相反证据'),
    criterion('uncertainty_explicit', '事实、推断和不确定项已区分'),
  ];
  if (taskType.startsWith('office.')) return [
    ...common,
    criterion('audience_fit', '结构和表达符合真实受众与使用场景'),
    criterion('content_complete', '要求的章节、数据和决定事项没有遗漏'),
    criterion('content_consistent', '名称、数字、日期和引用前后一致'),
    criterion('editable_output', '文件可打开、可编辑且没有占位内容'),
    ...(taskType === 'office.presentation-package'
      ? [criterion('visual_review_passed', '演示文稿通过结构与关键页面视觉检查')]
      : []),
  ];
  if (taskType.startsWith('vision.') || taskType.startsWith('image.')) return [
    ...common,
    criterion('visual_evidence_bound', '视觉判断绑定输入图像和可定位观察证据'),
    criterion('visual_constraints_met', '主体、文字、尺寸、风格和安全约束通过'),
  ];
  return common;
}

function tierReason(tier: QualityTier, source: QualitySource): string {
  if (tier === 'high_risk') return '任务涉及高风险动作、数据或权限，质量复核不能替代人工审批。';
  if (tier === 'important') return '产物用于研究、正式汇报、团队协作或业务判断，需要独立复核。';
  const taskType = clean(source.taskType || record(source.input).taskType, 160) || '当前任务';
  return `${taskType} 按标准任务执行岗位自检。`;
}

function criterion(key: string, label: string): QualityCriterion {
  return Object.freeze({ key, label, required:true });
}

function reviewArtifact(value: unknown): Readonly<{ artifactId: string; type: string | null; contentHash: string | null }> | null {
  const artifact = record(value);
  const artifactId = identifier(artifact.artifactId, 200);
  if (!artifactId) return null;
  const validation = record(artifact.validation);
  return Object.freeze({
    artifactId,
    type:clean(artifact.type, 160) || null,
    contentHash:clean(artifact.contentHash || validation.contentHash || validation.sha256, 160) || null,
  });
}

function textList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, limit)).filter(Boolean))].slice(0, 100);
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function identifier(value: unknown, limit: number): string {
  const text = clean(value, limit);
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(text) ? text : '';
}

function record(value: unknown): QualitySource {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as QualitySource
    : {};
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
