import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
  normalizeM5ProviderOperation,
  normalizeM5PublishAction,
  normalizeM5SchemaId,
  normalizeM5Sha256,
  normalizeM5WorkProductContract,
  normalizeM5WorkProductKind,
  validM5WorkProductArtifactHash,
} from '../src/index.js';

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
