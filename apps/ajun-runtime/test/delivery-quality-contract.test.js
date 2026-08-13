import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeliveryBrief } from '../src/workflow/delivery-brief.ts';
import {
  buildQualityProfile,
  createAssuranceReviewRequest,
  normalizeQualityReview,
} from '../src/workflow/quality-review.ts';
import {
  createRevisionDirective,
  decideRevision,
  MAX_DELIVERY_REVISION_ROUNDS,
  normalizeRevisionRound,
} from '../src/workflow/revision-policy.ts';
import { attachDeliveryQualityContracts } from '../src/workflow/delivery-quality-intake.ts';
import { deliveryQualityReviewInput } from '../src/workflow/delivery-quality-review-input.ts';

test('DeliveryBrief复用明确输入并智能补齐用途字段', () => {
  const brief = resolveDeliveryBrief({
    taskType:'research.intel-report',
    title:'比较三种公开方案',
    goalSpec:{
      objective:'选择适合当前团队的实现方案',
      deliverables:['比较报告'],
      acceptanceCriteria:['至少读取两个独立来源'],
      constraints:['不访问登录内容'],
    },
  });

  assert.equal(brief.purpose, '选择适合当前团队的实现方案');
  assert.equal(brief.audience, '需要据此做判断的负责人');
  assert.equal(brief.usageScenario, '用于业务判断、方案选择或后续行动');
  assert.deepEqual(brief.deliverables, ['比较报告']);
  assert.deepEqual(brief.acceptanceCriteria, ['至少读取两个独立来源']);
  assert.deepEqual(brief.constraints, ['不访问登录内容']);
  assert.equal(brief.readiness, 'ready');
  assert.equal(brief.clarification, null);
  assert.equal(brief.inferredAssumptions.length, 2);
});

test('DeliveryBrief只保留一个真正阻断任务的追问', () => {
  const missingMaterial = resolveDeliveryBrief({
    taskType:'media.transcribe-and-refine',
    title:'整理成团队可读文档',
  });
  assert.equal(missingMaterial.readiness, 'needs_clarification');
  assert.equal(missingMaterial.clarification, '请提供需要处理的素材、文件或来源链接。');
  assert.equal(Array.isArray(missingMaterial.clarification), false);

  const explicit = resolveDeliveryBrief({
    taskType:'media.transcribe-and-refine',
    title:'整理视频',
    sourceUrl:'https://example.com/video',
    deliveryBrief:{ clarification:'这份材料主要给你自己看，还是直接发给团队？' },
  });
  assert.equal(explicit.clarification, '这份材料主要给你自己看，还是直接发给团队？');
});

test('旧任务没有DeliveryBrief也能生成保守兼容契约', () => {
  const brief = resolveDeliveryBrief({
    taskType:'legacy.unknown-task',
    input:{ title:'整理现有结果' },
  });
  assert.equal(brief.schemaVersion, 'agent.army/delivery-brief/v1');
  assert.equal(brief.purpose, '整理现有结果');
  assert.deepEqual(brief.deliverables, ['可直接使用的主要产物']);
  assert.equal(brief.readiness, 'ready');
});

test('质量等级区分标准、重要和高风险，岗位质量门保持具体', () => {
  const standardBrief = resolveDeliveryBrief({ taskType:'media.transcribe-and-refine', title:'整理音频', sourceUrl:'https://example.com/audio' });
  const standard = buildQualityProfile({ taskType:'media.transcribe-and-refine' }, standardBrief);
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.independentReviewRequired, false);
  assert.ok(standard.criteria.some((item) => item.key === 'transcript_accuracy'));

  const importantBrief = resolveDeliveryBrief({ taskType:'research.intel-report', title:'调研公开方案' });
  const important = buildQualityProfile({ taskType:'research.intel-report' }, importantBrief);
  assert.equal(important.tier, 'important');
  assert.equal(important.independentReviewRequired, true);
  assert.ok(important.criteria.some((item) => item.key === 'counter_evidence_checked'));

  const risky = buildQualityProfile({
    taskType:'content.platform-draft',
    input:{ title:'审核后对外发布', sideEffect:'external-write', qualityTier:'standard' },
  });
  assert.equal(risky.tier, 'high_risk');
  assert.equal(risky.independentReviewRequired, true);
});

test('重要任务生成稳定的governance.assurance-review请求，标准任务不生成', () => {
  const task = {
    taskId:'task-research-1',
    taskType:'research.intel-report',
    workflow:{ workflowId:'workflow-research-1' },
    input:{ title:'公开方案研究' },
  };
  const brief = resolveDeliveryBrief(task);
  const profile = buildQualityProfile(task, brief);
  const artifacts = [{ artifactId:'report-1', type:'intel_research_report', validation:{ sha256:'abc123' }, data:{ privateText:'不应进入请求' } }];
  const first = createAssuranceReviewRequest({ task, brief, profile, artifactRefs:artifacts });
  const replay = createAssuranceReviewRequest({ task, brief, profile, artifactRefs:artifacts });
  assert.deepEqual(first, replay);
  assert.equal(first.taskType, 'governance.assurance-review');
  assert.equal(first.agentId, 'reviewer');
  assert.equal(first.context.qualityTier, 'important');
  assert.deepEqual(first.context.artifactRefs, [{ artifactId:'report-1', type:'intel_research_report', contentHash:'abc123' }]);
  assert.doesNotMatch(JSON.stringify(first), /privateText/);

  const standardBrief = resolveDeliveryBrief({ taskType:'media.transcribe-and-refine', title:'整理', sourceUrl:'https://example.com/audio' });
  const standardProfile = buildQualityProfile({ taskType:'media.transcribe-and-refine' }, standardBrief);
  assert.equal(createAssuranceReviewRequest({ task, brief:standardBrief, profile:standardProfile }), null);
});

test('旧任务缺少质量审核时安全归一为pending', () => {
  assert.deepEqual(normalizeQualityReview(undefined), {
    schemaVersion:'agent.army/delivery-quality-review/v1',
    status:'pending',
    failedCriteria:[],
    evidenceRefs:[],
    safeSummary:null,
  });
  assert.equal(normalizeQualityReview({ status:'passed' }).status, 'blocked');
  assert.equal(normalizeQualityReview({ status:'passed', evidenceRefs:['artifact:report-1'] }).status, 'passed');
  assert.equal(normalizeQualityReview({ status:'passed', failedCriteria:['artifact_usable'] }).status, 'revise');
});

test('独立复核passed只接受绑定当前产物快照的证据引用', () => {
  const task = {
    taskType:'governance.assurance-review',
    input:{ context:{ artifactRefs:[{ artifactId:'report-1', contentHash:'sha256:abc123' }] } },
  };
  assert.throws(() => deliveryQualityReviewInput(task, {
    qualityReview:{ status:'passed', evidenceRefs:['artifact:other'] },
  }), /绑定当前产物/);
  assert.deepEqual(deliveryQualityReviewInput(task, {
    qualityReview:{ status:'passed', evidenceRefs:['artifact:report-1', 'artifact:other'] },
  }).evidenceRefs, ['artifact:report-1']);
});

test('质量不通过只允许两轮内部返工，第三次安全停止', () => {
  const review = normalizeQualityReview({
    status:'revise',
    failedCriteria:['claims_evidence_bound'],
  });
  const first = decideRevision({ review });
  assert.equal(first.action, 'revise');
  assert.equal(first.currentRound, 0);
  assert.equal(first.nextRound, 1);
  assert.equal(first.maxRounds, MAX_DELIVERY_REVISION_ROUNDS);

  const second = decideRevision({ review, revisionRound:first.nextRound });
  assert.equal(second.action, 'revise');
  assert.equal(second.nextRound, 2);

  const exhausted = decideRevision({ review, revisionRound:second.nextRound, hasUsableArtifact:true });
  assert.equal(exhausted.action, 'stop');
  assert.equal(exhausted.nextRound, null);
  assert.equal(exhausted.workflowStatus, 'partial');
  assert.match(exhausted.reason, /两轮/);
});

test('返工指令只携带失败项与旧产物引用，不覆盖已通过内容', () => {
  const review = normalizeQualityReview({ status:'revise', failedCriteria:['transcript_accuracy'] });
  const revisionDecision = decideRevision({ review, revisionRound:0 });
  const directive = createRevisionDirective({
    task:{
      taskId:'task-media-1',
      artifactRefs:[{ artifactId:'transcript-v1', type:'transcript', data:{ rawText:'不进入返工指令' } }],
    },
    decision:revisionDecision,
  });
  assert.equal(directive.revisionRound, 1);
  assert.deepEqual(directive.failedCriteria, ['transcript_accuracy']);
  assert.equal(directive.preservePassedContent, true);
  assert.deepEqual(directive.sourceArtifactRefs, [{ artifactId:'transcript-v1', type:'transcript' }]);
  assert.doesNotMatch(JSON.stringify(directive), /rawText/);
});

test('通过、阻断和旧任务异常轮次都有保守状态', () => {
  assert.equal(decideRevision({ review:normalizeQualityReview({ status:'passed', evidenceRefs:['artifact:verified'] }) }).workflowStatus, 'waiting_acceptance');
  assert.equal(decideRevision({ review:normalizeQualityReview({ status:'blocked' }) }).workflowStatus, 'waiting_validation');
  assert.equal(normalizeRevisionRound(undefined), 0);
  assert.equal(normalizeRevisionRound('bad'), 0);
  assert.equal(normalizeRevisionRound(99), 2);
});

test('返工任务从上下文继承轮次，避免每次重建都归零', () => {
  const task = attachDeliveryQualityContracts({
    taskType:'research.intel-report',
    input:{ title:'修订报告', context:{ deliveryRevision:{ revisionRound:2 } } },
  });
  assert.equal(task.revisionRound, 2);
});
