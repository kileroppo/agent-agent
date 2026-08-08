import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTENT_CHANNEL_IDS,
  CONTENT_CHANNELS,
  CONTENT_METRIC_KEYS,
  CONTENT_PLATFORM_PLAYBOOKS,
  CONTENT_QUALITY_GATE_IDS,
  CONTENT_REVIEW_DECISIONS,
  M5_ALLOWED_PUBLISH_ACTIONS,
  M5_CONTRACT_ERROR_CODES,
  M5_PLATFORM_IDS,
  M5_PLATFORMS,
  M5_PROHIBITED_PUBLISH_ACTIONS,
  M5_SCHEMA_IDS,
  M5_SHA256_PATTERN,
  M5_STEPFUN_MODELS,
  M5_WORK_PRODUCT_KINDS,
  M5_WORK_PRODUCT_SCHEMAS,
  assertM5Platform,
  contentQualityChecklist,
  deriveContentMetrics,
  assertM5ProviderOperation,
  assertM5PublishAction,
  assertM5SchemaId,
  assertM5Sha256,
  assertM5WorkProductContract,
  assertM5WorkProductKind,
  getM5StepFunModel,
  getM5WorkProductSchema,
  canonicalizeM5Value,
  deriveM5WorkProductArtifactHash,
  m5Sha256,
  normalizeM5Platform,
  normalizeContentBrief,
  normalizeContentChannel,
  normalizeM5ProviderOperation,
  normalizeM5PublishAction,
  normalizeM5SchemaId,
  normalizeM5Sha256,
  normalizeM5WorkProductContract,
  normalizeM5WorkProductKind,
  validM5WorkProductArtifactHash,
  summarizeComparableContentMetrics,
} from '../src/index.ts';

test('平台契约规范化大小写和首尾空白，并拒绝未知平台', () => {
  assert.deepEqual(M5_PLATFORM_IDS, {
    DOUYIN:'douyin',
    XIAOHONGSHU:'xiaohongshu',
  });
  assert.deepEqual(M5_PLATFORMS, ['douyin', 'xiaohongshu']);
  assert.equal(normalizeM5Platform('  XiaoHongShu  '), 'xiaohongshu');
  assert.equal(assertM5Platform(' DOUYIN '), 'douyin');
  assert.throws(
    () => assertM5Platform('bilibili'),
    (error) => error?.code === 'm5_platform_unsupported',
  );
});

test('内容运营契约覆盖抖音、小红书、公众号和视频号且不扩大 M5 双平台 Campaign', () => {
  assert.deepEqual(CONTENT_CHANNEL_IDS, {
    DOUYIN:'douyin',
    XIAOHONGSHU:'xiaohongshu',
    WECHAT_OFFICIAL_ACCOUNT:'wechat_official_account',
    WECHAT_CHANNELS:'wechat_channels',
  });
  assert.deepEqual(CONTENT_CHANNELS, [
    'douyin',
    'xiaohongshu',
    'wechat_official_account',
    'wechat_channels',
  ]);
  assert.equal(normalizeContentChannel('xhs'), 'xiaohongshu');
  assert.equal(normalizeContentChannel('wechat_mp'), 'wechat_official_account');
  assert.equal(normalizeContentChannel('shipinhao'), 'wechat_channels');
  assert.equal(normalizeContentChannel('unknown'), null);
  assert.deepEqual(M5_PLATFORMS, ['douyin', 'xiaohongshu']);
  assert.equal(Object.isFrozen(CONTENT_PLATFORM_PLAYBOOKS.xiaohongshu), true);
});

test('创作简报只接受最多三个受支持渠道并保留证据、假设与唯一实验', () => {
  const brief = normalizeContentBrief({
    accountPositioning:'真实 AI Agent 实战',
    audience:'正在搭建 Agent 工作流的经营者',
    goal:'解释一次可核验的完整交付',
    coreJudgment:'运行证据必须和代码完成分开。',
    evidenceRefs:['artifact:one', 'artifact:one', 'artifact:two'],
    constraints:['不编造外部结果'],
    channels:['douyin', 'xhs', 'wechat_mp', 'shipinhao'],
    primaryAction:'让读者检查自己的验收链',
    experiment:{
      variable:'开场结构',
      hypothesis:'先给证据会提高深度互动',
      successCriterion:'深度互动率高于同类中位数',
      observationWindow:'发布后72小时',
    },
    confirmationStatus:'assumed_defaults',
  });
  assert.deepEqual(brief.channels, ['douyin', 'xiaohongshu', 'wechat_official_account']);
  assert.deepEqual(brief.evidenceRefs, ['artifact:one', 'artifact:two']);
  assert.equal(brief.experiment.variable, '开场结构');
  assert.equal(normalizeContentBrief({ channels:['douyin'], goal:'x', coreJudgment:'y' }), null);
});

test('六项语义质量门覆盖证据、声音、平台、视觉、合规与交付完整性', () => {
  const checklist = contentQualityChecklist('xiaohongshu');
  assert.deepEqual(checklist.map((item) => item.gate), CONTENT_QUALITY_GATE_IDS);
  assert.equal(checklist.every((item) => item.required && item.instruction.length > 20), true);
  assert.match(checklist.find((item) => item.gate === 'platform_native').instruction, /每页只承担一个信息任务/);
});

test('内容指标派生在缺失或零分母时留空，并按中位数与P75总结同类样本', () => {
  const metrics = deriveContentMetrics({
    impressions:200,
    views:100,
    comments:2,
    saves:3,
    shares:5,
    newFollowers:4,
    conversions:2,
    productionMinutes:60,
    successfulOutputs:1,
  });
  assert.equal(metrics.followersPerThousandViews, 40);
  assert.equal(metrics.deepEngagementRate, 0.1);
  assert.equal(metrics.clickThroughRate, 0.5);
  assert.equal(metrics.conversionRate, 0.02);
  assert.equal(metrics.minutesPerSuccessfulOutput, 60);
  assert.equal(deriveContentMetrics({ views:0, newFollowers:2 }).followersPerThousandViews, null);
  const summary = summarizeComparableContentMetrics([
    { views:100, comments:1, saves:2, shares:2 },
    { views:200, comments:2, saves:4, shares:4 },
    { views:300, comments:3, saves:6, shares:6 },
    { views:400, comments:4, saves:8, shares:8 },
  ]);
  assert.equal(summary.views.median, 250);
  assert.equal(summary.views.p75, 325);
  assert.equal(summary.deepEngagementRate.median, 0.05);
  assert.equal(CONTENT_METRIC_KEYS.includes('attributedRevenue'), true);
  assert.deepEqual(CONTENT_REVIEW_DECISIONS, [
    'scale', 'repackage', 'adapt_platform', 'stop', 'collect_more_samples',
  ]);
});

test('Work Product kind 与 schema 必须成对匹配', () => {
  assert.deepEqual(
    normalizeM5WorkProductContract({
      kind:' publish receipt ',
      schemaVersion:' AGENT.ARMY/PUBLISH-RECEIPT/V1 ',
    }),
    {
      kind:'PublishReceipt',
      schemaVersion:'agent.army/publish-receipt/v1',
    },
  );
  assert.equal(
    normalizeM5WorkProductContract({
      kind:'PublishReceipt',
      schemaVersion:M5_SCHEMA_IDS.METRIC_SNAPSHOT,
    }),
    null,
  );
  assert.throws(
    () => assertM5WorkProductContract({
      kind:'PublishReceipt',
      schemaVersion:M5_SCHEMA_IDS.METRIC_SNAPSHOT,
    }),
    (error) => error?.code === 'm5_work_product_schema_mismatch',
  );
});

test('Work Product kind 与主要 schema 使用单一规范映射', () => {
  assert.ok(M5_WORK_PRODUCT_KINDS.includes('PublishReceipt'));
  assert.ok(M5_WORK_PRODUCT_KINDS.includes('SocialCardPackage'));
  assert.ok(M5_WORK_PRODUCT_KINDS.includes('WechatDraftReceipt'));
  assert.ok(M5_WORK_PRODUCT_KINDS.includes('MetricSnapshot'));
  assert.ok(M5_WORK_PRODUCT_KINDS.includes('LearningProposal'));
  assert.equal(normalizeM5WorkProductKind(' publish receipt '), 'PublishReceipt');
  assert.equal(assertM5WorkProductKind('METRIC-SNAPSHOT'), 'MetricSnapshot');
  assert.equal(
    getM5WorkProductSchema(' learning_proposal '),
    'agent.army/learning-proposal/v1',
  );
  assert.equal(
    M5_WORK_PRODUCT_SCHEMAS.PublishReceipt,
    M5_SCHEMA_IDS.PUBLISH_RECEIPT,
  );
  assert.equal(
    M5_WORK_PRODUCT_SCHEMAS.WechatDraftReceipt,
    M5_SCHEMA_IDS.WECHAT_DRAFT_RECEIPT,
  );
  assert.equal(
    M5_WORK_PRODUCT_SCHEMAS.SocialCardPackage,
    M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE,
  );
  assert.equal(
    normalizeM5SchemaId(' AGENT.ARMY/PUBLISH-RECEIPT/V1 '),
    M5_SCHEMA_IDS.PUBLISH_RECEIPT,
  );
  assert.equal(assertM5SchemaId(M5_SCHEMA_IDS.METRIC_SNAPSHOT), M5_SCHEMA_IDS.METRIC_SNAPSHOT);
  assert.throws(
    () => assertM5WorkProductKind('RawCredentials'),
    (error) => error?.code === 'm5_work_product_kind_unsupported',
  );
  assert.throws(
    () => assertM5SchemaId('agent.army/publish-receipt/v2'),
    (error) => error?.code === 'm5_schema_id_unsupported',
  );
});

test('Campaign 与并行生产协议的非 Work Product schema 也由共享注册表唯一持有', () => {
  assert.equal(M5_SCHEMA_IDS.CAMPAIGN_PLAN, 'agent.army/campaign-plan/v1');
  assert.equal(M5_SCHEMA_IDS.PARALLEL_WORK_BRANCH, 'agent.army/parallel-work-branch/v1');
  assert.equal(M5_SCHEMA_IDS.PARALLEL_WORK_BATCH, 'agent.army/parallel-work-batch/v1');
  assert.equal(M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE, 'agent.army/social-card-package/v1');
  assert.equal(
    M5_SCHEMA_IDS.PRODUCTION_TEMPLATE_BINDING,
    'agent.army/production-template-binding/v1',
  );
  assert.equal(
    assertM5SchemaId(M5_SCHEMA_IDS.PARALLEL_WORK_BATCH),
    M5_SCHEMA_IDS.PARALLEL_WORK_BATCH,
  );
});

test('StepFun 操作映射稳定返回唯一模型并拒绝未知操作', () => {
  assert.deepEqual(M5_STEPFUN_MODELS, {
    vision:'step-1o-turbo-vision',
    image_generate:'step-image-edit-2',
    image_edit:'step-image-edit-2',
    tts:'stepaudio-2.5-tts',
  });
  assert.equal(normalizeM5ProviderOperation(' Image Generate '), 'image_generate');
  assert.equal(assertM5ProviderOperation('IMAGE-EDIT'), 'image_edit');
  assert.equal(getM5StepFunModel(' vision '), 'step-1o-turbo-vision');
  assert.throws(
    () => getM5StepFunModel('video_generate'),
    (error) => error?.code === 'm5_provider_operation_unsupported',
  );
});

test('发布动作契约规范化分隔符，允许白名单并稳定拒绝敏感动作', () => {
  assert.deepEqual(M5_ALLOWED_PUBLISH_ACTIONS, [
    'upload',
    'fill_metadata',
    'schedule_or_publish',
    'read_own_metrics',
  ]);
  assert.deepEqual(M5_PROHIBITED_PUBLISH_ACTIONS, [
    'direct_message',
    'comment',
    'follow',
    'paid_promotion',
    'payment',
    'account_settings',
    'delete_history',
  ]);
  assert.equal(normalizeM5PublishAction('  Schedule Or Publish '), 'schedule_or_publish');
  assert.equal(assertM5PublishAction('FILL-METADATA'), 'fill_metadata');
  assert.throws(
    () => assertM5PublishAction(' paid promotion '),
    (error) => error?.code === 'm5_publish_action_prohibited'
      && error?.details?.action === 'paid_promotion',
  );
  assert.throws(
    () => assertM5PublishAction('repost'),
    (error) => error?.code === 'm5_publish_action_unsupported',
  );
});

test('公开常量与错误码不可被消费者修改', () => {
  for (const constant of [
    M5_PLATFORMS,
    M5_PLATFORM_IDS,
    M5_ALLOWED_PUBLISH_ACTIONS,
    M5_PROHIBITED_PUBLISH_ACTIONS,
    M5_STEPFUN_MODELS,
    M5_SCHEMA_IDS,
    M5_WORK_PRODUCT_SCHEMAS,
    M5_WORK_PRODUCT_KINDS,
    M5_CONTRACT_ERROR_CODES,
  ]) {
    assert.equal(Object.isFrozen(constant), true);
  }
  assert.equal(M5_CONTRACT_ERROR_CODES.PUBLISH_ACTION_PROHIBITED, 'm5_publish_action_prohibited');
  assert.throws(() => M5_PLATFORMS.push('bilibili'), TypeError);
  assert.throws(() => {
    M5_STEPFUN_MODELS.vision = 'drifted-model';
  }, TypeError);
});

test('SHA-256 格式、规范化与 canonical JSON 由共享契约唯一实现', () => {
  const digest = m5Sha256({ b:2, a:{ d:4, c:3 } });
  assert.match(digest, M5_SHA256_PATTERN);
  assert.equal(digest, m5Sha256({ a:{ c:3, d:4 }, b:2 }));
  assert.deepEqual(canonicalizeM5Value({ z:1, a:{ y:2, x:3 } }), {
    a:{ x:3, y:2 },
    z:1,
  });
  assert.equal(normalizeM5Sha256(digest.slice(7).toUpperCase()), digest);
  assert.equal(assertM5Sha256(` ${digest.toUpperCase()} `), digest);
  assert.equal(normalizeM5Sha256('md5:nope'), null);
  assert.throws(
    () => assertM5Sha256('nope'),
    (error) => error?.code === 'm5_sha256_invalid',
  );
});

test('Work Product artifact identity 对键顺序稳定并能验证完整 metadata', () => {
  const metadata = {
    sourceTaskId:'task-1',
    sourceArtifactId:'artifact-1',
    sourceIssueId:'issue-1',
    pipelineCaseId:'case-1',
    projectId:'project-1',
    sourceRunId:'run-1',
    artifactKind:'PublishReceipt',
    artifact:{ platform:'douyin', nested:{ b:2, a:1 } },
  };
  const artifactHash = deriveM5WorkProductArtifactHash(metadata);
  assert.equal(
    artifactHash,
    deriveM5WorkProductArtifactHash({
      ...metadata,
      artifact:{ nested:{ a:1, b:2 }, platform:'douyin' },
    }),
  );
  assert.equal(validM5WorkProductArtifactHash({ ...metadata, artifactHash }), true);
  assert.equal(validM5WorkProductArtifactHash({ ...metadata, artifactHash, projectId:'drifted' }), false);
  assert.throws(
    () => deriveM5WorkProductArtifactHash({ ...metadata, artifactKind:'' }),
    (error) => error?.code === 'm5_work_product_identity_invalid',
  );
});
