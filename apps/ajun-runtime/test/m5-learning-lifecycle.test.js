import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  M5LearningLifecycle,
  M5LearningLifecycleError,
  buildOfflineReplay,
} from '../src/m5-learning-lifecycle.js';
import { m5GrayProductionTemplateBinding } from '../src/m5-production-template-resolver.js';

const IDS = Object.freeze({
  case:'11111111-1111-4111-8111-111111111111',
  issue:'22222222-2222-4222-8222-222222222222',
  run:'33333333-3333-4333-8333-333333333333',
  grayCase:'44444444-4444-4444-8444-444444444444',
  grayDayCase:'55555555-5555-4555-8555-555555555555',
});

test('Paperclip Work Product 驱动离线回放、审核、单条灰度并验证新模板', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);

  assert.equal((await advance(lifecycle)).state, 'offline_replay_passed');
  const replay = product(governance, 'OfflineReplay').metadata.replay;
  assert.equal(replay.sampleCount, 5);
  assert.equal(replay.primaryMetric, 'views');
  assert.equal(replay.baselineMetrics.views, 300);
  assert.equal(replay.estimatedLift, null);
  assert.equal(replay.performanceClaimed, false);
  assert.deepEqual(replay.controls, safeControls());

  assert.equal((await advance(lifecycle)).state, 'waiting_reviewer_approval');
  const proposal = product(governance, 'LearningProposal');
  assert.equal(proposal.status, 'ready_for_review');
  assert.equal(proposal.reviewState, 'needs_board_review');
  assert.equal((await advance(lifecycle)).state, 'waiting_reviewer_approval');
  assert.equal(governance.created.length, 2);

  approveProposal(governance);
  assert.equal((await advance(lifecycle)).state, 'waiting_single_gray_content');
  const template = product(governance, 'TemplateVersion').metadata.templateVersion;
  assert.equal(template.state, 'gray_ready');
  assert.equal(template.grayReleaseLimit, 1);
  assert.equal(template.productionDefault, false);
  assert.equal(template.grayTargetCaseId, IDS.grayCase);
  assert.equal(template.grayTargetDayCaseId, IDS.grayDayCase);
  assert.equal(template.grayTargetPlatform, 'douyin');
  assert.deepEqual(template.controls, safeControls());

  governance.pipelineOutputs.push(grayContentVersion(template));
  assert.equal((await advance(lifecycle)).state, 'waiting_gray_quality_and_72h_metric');
  const gray = product(governance, 'TemplateGrayRelease').metadata.grayRelease;
  assert.equal(gray.maximumUses, 1);
  assert.equal(gray.usedUses, 1);
  assert.equal(gray.contentVersionId, 'content-gray-1');
  assert.equal((await advance(lifecycle)).state, 'waiting_gray_quality_and_72h_metric');

  governance.pipelineOutputs.push(
    machineReview('content-gray-1', { id:'review-gray-1' }),
    publishReceipt(6, { contentVersionId:'content-gray-1' }),
    metricSnapshot(6, {
      id:'metric-gray-1',
      snapshotId:'snapshot-gray-1',
      contentVersionId:'content-gray-1',
      views:350,
      likes:35,
    }),
  );
  const result = await advance(lifecycle);
  assert.equal(result.state, 'validated');
  const decision = product(governance, 'TemplateDecision').metadata.decision;
  assert.equal(decision.status, 'validated');
  assert.equal(decision.activeTemplateVersionId, template.templateVersionId);
  assert.equal(decision.productionDefault, true);
  assert.equal(decision.automaticRollback, false);
  assert.equal(decision.grayPublishReceiptId, metricReceiptId(6));
  assert.equal(decision.grayMetricCollectionKey, `${metricReceiptId(6)}:72h`);
  assert.equal(decision.grayLineage.variantKey, 'gray_douyin');
  assert.equal(decision.grayLineage.renderChecksum, contentChecksum(6));
  assert.deepEqual(decision.controls, safeControls());
  assert.equal(new Set(governance.created.map((item) => item.externalId)).size, 5);
  assert.equal(governance.created.some((item) =>
    Object.hasOwn(item.metadata, 'prompt')
    || Object.hasOwn(item.metadata, 'permissions')
    || Object.hasOwn(item.metadata, 'publishFrequency')), false);

  const replayed = await advance(lifecycle);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.state, 'validated');
  assert.equal(governance.created.length, 5);
});

test('灰度主指标下降或质量门禁失败时自动回退旧模板', async (t) => {
  await t.test('主指标下降', async () => {
    const fixture = await grayReadyFixture();
    fixture.governance.pipelineOutputs.push(
      machineReview('content-gray-1', { id:'review-gray-low' }),
      publishReceipt(6, { contentVersionId:'content-gray-1' }),
      metricSnapshot(6, {
        id:'metric-gray-low',
        snapshotId:'snapshot-gray-low',
        contentVersionId:'content-gray-1',
        views:299,
        likes:999,
      }),
    );
    const result = await advance(fixture.lifecycle);
    assert.equal(result.state, 'rolled_back');
    const decision = product(fixture.governance, 'TemplateDecision').metadata.decision;
    assert.equal(decision.activeTemplateVersionId, 'm5-template-default-v1');
    assert.equal(decision.automaticRollback, true);
    assert.equal(decision.performance.primaryMetric, 'views');
    assert.equal(decision.performance.declined, true);
    assert.match(decision.reasons.join('\n'), /历史均值 300 降至 299/);
  });

  await t.test('机器审核质量下降', async () => {
    const fixture = await grayReadyFixture();
    fixture.governance.pipelineOutputs.push(
      machineReview('content-gray-1', {
        id:'review-gray-failed',
        status:'failed',
        failedCheck:'privacy',
      }),
      publishReceipt(6, { contentVersionId:'content-gray-1' }),
      metricSnapshot(6, {
        id:'metric-gray-high',
        snapshotId:'snapshot-gray-high',
        contentVersionId:'content-gray-1',
        views:1000,
        likes:100,
      }),
    );
    const result = await advance(fixture.lifecycle);
    assert.equal(result.state, 'rolled_back');
    const decision = product(fixture.governance, 'TemplateDecision').metadata.decision;
    assert.equal(decision.qualityPassed, false);
    assert.equal(decision.performance.declined, false);
    assert.equal(decision.automaticRollback, true);
  });
});

test('审核要求修改时结束提案且不创建模板版本', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  await advance(lifecycle);
  await advance(lifecycle);
  const proposal = product(governance, 'LearningProposal');
  proposal.status = 'changes_requested';
  proposal.reviewState = 'changes_requested';

  const result = await advance(lifecycle);

  assert.equal(result.state, 'rejected');
  assert.equal(product(governance, 'TemplateVersion'), null);
  const decision = product(governance, 'TemplateDecision').metadata.decision;
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.activeTemplateVersionId, undefined);
  assert.deepEqual(decision.controls, safeControls());
});

test('同一模板出现第二条灰度内容时失败关闭', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  await advance(lifecycle);
  await advance(lifecycle);
  approveProposal(governance);
  await advance(lifecycle);
  const template = product(governance, 'TemplateVersion').metadata.templateVersion;
  governance.pipelineOutputs.push(
    grayContentVersion(template, 'content-gray-1'),
    grayContentVersion(template, 'content-gray-2'),
  );

  await assert.rejects(
    () => advance(lifecycle),
    /只能灰度一条内容，当前发现 2 条/,
  );
  assert.equal(product(governance, 'TemplateGrayRelease'), null);
});

test('小红书、跨日期Case或错误Template Work Product不能冒充目标灰度', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  await advance(lifecycle);
  await advance(lifecycle);
  approveProposal(governance);
  await advance(lifecycle);
  const template = product(governance, 'TemplateVersion').metadata.templateVersion;
  governance.pipelineOutputs.push(
    grayContentVersion(template, 'content-xhs', { platform:'xiaohongshu' }),
    grayContentVersion(template, 'content-other-day', {
      dayCaseId:'66666666-6666-4666-8666-666666666666',
    }),
    grayContentVersion(template, 'content-forged-template-product', {
      templateWorkProductId:'forged-template-product',
    }),
    grayContentVersion(template, 'content-forged-application', {
      templateApplication:{
        mode:'copy_only',
        variantKey:'gray_douyin',
        bindingHash:templateBindingHash(),
        scriptHash:scriptHash(),
        renderChecksum:contentChecksum(6),
      },
    }),
  );

  const result = await advance(lifecycle);
  assert.equal(result.state, 'waiting_single_gray_content');
  assert.equal(product(governance, 'TemplateGrayRelease'), null);
});

test('自洽但不是由目标 TemplateVersion canonical 字段派生的 bindingHash 不能冒充灰度', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  await advance(lifecycle);
  await advance(lifecycle);
  approveProposal(governance);
  await advance(lifecycle);
  const template = product(governance, 'TemplateVersion').metadata.templateVersion;
  governance.pipelineOutputs.push(grayContentVersion(template.templateVersionId));

  const result = await advance(lifecycle);

  assert.equal(result.state, 'waiting_single_gray_content');
  assert.equal(product(governance, 'TemplateGrayRelease'), null);
});

test('灰度学习拒绝错误文件哈希或日期的发布回执', async () => {
  const fixture = await grayReadyFixture();
  fixture.governance.pipelineOutputs.push(
    machineReview('content-gray-1', { id:'review-gray-forged-receipt' }),
    publishReceipt(6, {
      contentVersionId:'content-gray-1',
      contentChecksum:`sha256:${'f'.repeat(64)}`,
      scheduledDate:'2026-08-08',
    }),
    metricSnapshot(6, {
      id:'metric-gray-forged-receipt',
      snapshotId:'snapshot-gray-forged-receipt',
      contentVersionId:'content-gray-1',
      views:1000,
    }),
  );

  const result = await advance(fixture.lifecycle);

  assert.equal(result.state, 'waiting_gray_quality_and_72h_metric');
  assert.equal(product(fixture.governance, 'TemplateDecision'), null);
});

test('灰度学习拒绝同一回执标识对应多个可信PublishReceipt', async () => {
  const fixture = await grayReadyFixture();
  const first = publishReceipt(6, { contentVersionId:'content-gray-1' });
  const duplicate = structuredClone(first);
  duplicate.id = 'publish-receipt-duplicate';
  fixture.governance.pipelineOutputs.push(first, duplicate);

  await assert.rejects(
    () => advance(fixture.lifecycle),
    (error) => error instanceof M5LearningLifecycleError
      && error.message === `发布回执 ${metricReceiptId(6)} 不唯一。`,
  );
  assert.equal(product(fixture.governance, 'TemplateDecision'), null);
});

test('灰度学习拒绝与 ContentVersion 不同脚本或成片血缘的机器审核', async () => {
  const fixture = await grayReadyFixture();
  fixture.governance.pipelineOutputs.push(
    machineReview('content-gray-1', {
      id:'review-gray-forged-lineage',
      variantLineage:{
        variantKey:'gray_douyin',
        scriptHash:`sha256:${'f'.repeat(64)}`,
        templateBindingHash:templateBindingHash(),
        renderChecksum:contentChecksum(6),
      },
    }),
    publishReceipt(6, { contentVersionId:'content-gray-1' }),
    metricSnapshot(6, {
      id:'metric-gray-forged-review',
      snapshotId:'snapshot-gray-forged-review',
      contentVersionId:'content-gray-1',
      views:1000,
    }),
  );

  const result = await advance(fixture.lifecycle);

  assert.equal(result.state, 'waiting_gray_quality_and_72h_metric');
  assert.equal(product(fixture.governance, 'TemplateDecision'), null);
});

test('离线回放缺历史审核或安全控制漂移时不生成提案', () => {
  const governance = new FakeLearningGovernance();
  const retrospective = governance.caseOutputs[0];
  const withoutReview = governance.pipelineOutputs.filter((item) => item.metadata?.kind !== 'MachineReview');
  assert.throws(
    () => buildOfflineReplay(retrospective, withoutReview),
    /每条历史内容都能回到通过的 MachineReview/,
  );

  const unsafe = structuredClone(retrospective);
  unsafe.metadata.report.controls.frequencyIncrease = true;
  assert.throws(
    () => buildOfflineReplay(unsafe, governance.pipelineOutputs),
    /安全边界/,
  );

  const forged72h = structuredClone(governance.pipelineOutputs);
  const metric = forged72h.find((item) => item.metadata?.kind === 'MetricSnapshot');
  metric.metadata.collectionKey = 'forged:72h';
  assert.throws(
    () => buildOfflineReplay(retrospective, forged72h),
    /无法回读全部历史 MetricSnapshot/,
  );
});

test('学习入口拒绝空、重复或占位的模板改进建议', () => {
  const governance = new FakeLearningGovernance();
  for (const suggestedChanges of [
    [],
    ['只调整前三秒开场。', '只调整前三秒开场。'],
    ['TODO：待补充一个示例开场。'],
  ]) {
    const retrospective = structuredClone(governance.caseOutputs[0]);
    retrospective.metadata.report.learningProposal.suggestedChanges = suggestedChanges;
    assert.throws(
      () => buildOfflineReplay(retrospective, governance.pipelineOutputs),
      /模板改进建议/,
    );
  }
});

test('生命周期不接受调用方提供模板、指标或灰度选择，只读取 Paperclip 输出', async () => {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  const input = {
    caseId:IDS.case,
    issueId:IDS.issue,
    runId:IDS.run,
    templateVersion:{ forged:true },
    metricSnapshot:{ forged:true },
    grayContentVersionId:'forged',
  };

  const result = await lifecycle.advance(input);

  assert.equal(result.createdKind, 'OfflineReplay');
  assert.equal(product(governance, 'OfflineReplay').metadata.replay.baselineMetrics.views, 300);
  assert.equal(Object.hasOwn(lifecycle, 'state'), false);
  assert.equal(Object.hasOwn(lifecycle, 'store'), false);
});

async function grayReadyFixture() {
  const governance = new FakeLearningGovernance();
  const lifecycle = createLifecycle(governance);
  await advance(lifecycle);
  await advance(lifecycle);
  approveProposal(governance);
  await advance(lifecycle);
  const template = product(governance, 'TemplateVersion').metadata.templateVersion;
  governance.pipelineOutputs.push(grayContentVersion(template));
  await advance(lifecycle);
  return { governance, lifecycle };
}

function createLifecycle(governance) {
  return new M5LearningLifecycle({
    governance,
    now:() => new Date('2026-08-10T00:00:00.000Z'),
  });
}

function advance(lifecycle) {
  return lifecycle.advance({
    caseId:IDS.case,
    issueId:IDS.issue,
    runId:IDS.run,
  });
}

function approveProposal(governance) {
  const proposal = product(governance, 'LearningProposal');
  proposal.reviewState = 'approved';
}

function product(governance, kind) {
  return governance.caseOutputs.find((item) => item.metadata?.kind === kind) || null;
}

function retrospectiveProduct() {
  return {
    id:'retrospective-1',
    kind:'work_product',
    type:'document',
    provider:'agent-army.m5-retrospective',
    sourceTrust:null,
    status:'active',
    reviewState:'none',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/m5-retrospective/v1',
      kind:'Retrospective',
      report:{
        status:'proposal_ready',
        sampleType:'ai-agent-practice:douyin',
        sampleCount:5,
        metricSnapshotRefs:Array.from({ length:5 }, (_, index) => `snapshot-${index + 1}`),
        controls:safeControls(),
        learningProposal:{
          schemaVersion:'agent.army/learning-proposal/v1',
          proposalId:'learning_test_1',
          version:1,
          status:'proposed',
          sourceSampleType:'ai-agent-practice:douyin',
          sourceSampleCount:5,
          suggestedChanges:['只调整开场结构。'],
          offlineReplayRequired:true,
          reviewerApprovalRequired:true,
          grayReleaseLimit:1,
          automaticProductionMutation:false,
        },
      },
    },
  };
}

function metricSnapshot(index, overrides = {}) {
  const contentVersionId = overrides.contentVersionId || `content-${index}`;
  const snapshotId = overrides.snapshotId || `snapshot-${index}`;
  const receiptId = overrides.receiptId || metricReceiptId(index);
  const publishedAt = metricPublishedAt(index);
  const dueAt = new Date(Date.parse(publishedAt) + 72 * 60 * 60 * 1_000).toISOString();
  const collectionKey = `${receiptId}:72h`;
  return {
    id:overrides.id || `metric-${index}`,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    sourceTrust:null,
    status:'active',
    reviewState:'none',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/metric-snapshot/v1',
      kind:'MetricSnapshot',
      checkpoint:'72h',
      receiptId,
      collectionKey,
      dueAt,
      snapshot:{
        snapshotId,
        contentVersionId,
        platform:'douyin',
        collectedAt:`2026-08-${String(index).padStart(2, '0')}T00:00:00.000Z`,
        receiptId,
        collectionKey,
        metrics:{
          views:overrides.views ?? 100 * index,
          likes:overrides.likes ?? 10 * index,
        },
      },
    },
  };
}

function publishReceipt(index, overrides = {}) {
  const contentVersionId = overrides.contentVersionId || `content-${index}`;
  const receiptId = overrides.receiptId || metricReceiptId(index);
  return {
    id:`publish-receipt-${index}`,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    sourceTrust:null,
    status:'active',
    reviewState:'none',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/publish-receipt/v1',
      kind:'PublishReceipt',
      receipt:{
        receiptId,
        contentVersionId,
        platform:'douyin',
        publishedAt:metricPublishedAt(index),
        contentChecksum:overrides.contentChecksum || contentChecksum(index),
        scheduledDate:overrides.scheduledDate || (index === 6 ? '2026-08-09' : '2026-08-01'),
      },
    },
  };
}

function metricReceiptId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function metricPublishedAt(index) {
  const collectedAt = Date.parse(`2026-08-${String(index).padStart(2, '0')}T00:00:00.000Z`);
  return new Date(collectedAt - 72 * 60 * 60 * 1_000).toISOString();
}

function machineReview(contentVersionId, {
  id = `review-${contentVersionId}`,
  status = 'passed',
  failedCheck = null,
  variantLineage = null,
} = {}) {
  const checks = Object.fromEntries([
    'facts',
    'privacy',
    'rights',
    'media',
    'claims',
    'grantScope',
    'duplicate',
  ].map((key) => [key, status === 'passed' && key !== failedCheck]));
  return {
    id,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'active',
    reviewState:'none',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/machine-review/v1',
      kind:'MachineReview',
      reviewReport:{
        status,
        contentVersionId,
        checks,
        ...(variantLineage || contentVersionId.startsWith('content-gray')
          ? {
            variantLineage:variantLineage || {
              variantKey:'gray_douyin',
              scriptHash:scriptHash(),
              templateBindingHash:templateBindingHash(),
              renderChecksum:contentChecksum(6),
            },
          }
          : {}),
      },
    },
  };
}

function grayContentVersion(templateVersionInput, contentVersionId = 'content-gray-1', overrides = {}) {
  const templateVersion = templateVersionInput && typeof templateVersionInput === 'object'
    ? templateVersionInput
    : null;
  const templateVersionId = templateVersion?.templateVersionId || templateVersionInput;
  const checksum = overrides.checksum || contentChecksum(6);
  const templateWorkProductId = overrides.templateWorkProductId || 'learning-product-3';
  const bindingHash = overrides.templateBindingHash
    || (templateVersion
      ? m5GrayProductionTemplateBinding({
        templateVersion,
        templateWorkProductId,
      }).bindingHash
      : `sha256:${'9'.repeat(64)}`);
  return {
    id:`content-version-${contentVersionId}`,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'active',
    reviewState:'none',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/content-version/v1',
      kind:'ContentVersion',
      contentVersion:{
        contentVersionId,
        platform:overrides.platform || 'douyin',
        templateVersionId,
        templateWorkProductId,
        dayCaseId:overrides.dayCaseId || IDS.grayDayCase,
        platformCaseId:overrides.platformCaseId || IDS.grayCase,
        scheduledDate:overrides.scheduledDate || '2026-08-09',
        checksum,
        templateBindingHash:bindingHash,
        templateApplication:overrides.templateApplication || {
          mode:'verified_full_content_variant',
          variantKey:'gray_douyin',
          bindingHash,
          scriptHash:scriptHash(),
          renderChecksum:checksum,
        },
        grayRelease:true,
      },
    },
  };
}

function contentChecksum(index) {
  return `sha256:${crypto.createHash('sha256').update(`content-${index}`).digest('hex')}`;
}

function scriptHash() {
  return `sha256:${crypto.createHash('sha256').update('gray-script').digest('hex')}`;
}

function templateBindingHash() {
  return m5GrayProductionTemplateBinding({
    templateVersion:{
      templateVersionId:`template_${crypto.createHash('sha256')
        .update('learning_test_1:v2')
        .digest('hex')
        .slice(0, 24)}`,
      grayTargetCaseId:IDS.grayCase,
      grayTargetDayCaseId:IDS.grayDayCase,
      grayTargetScheduledDate:'2026-08-09',
      grayTargetPlatform:'douyin',
      applicationScope:'full_content_variant',
      suggestedChanges:['只调整开场结构。'],
      controls:safeControls(),
    },
    templateWorkProductId:'learning-product-3',
  }).bindingHash;
}

function safeControls() {
  return {
    promptMutation:false,
    permissionExpansion:false,
    frequencyIncrease:false,
    paidPromotion:false,
  };
}

class FakeLearningGovernance {
  constructor() {
    this.created = [];
    this.caseOutputs = [retrospectiveProduct()];
    this.pipelineOutputs = [
      ...this.caseOutputs,
      ...Array.from({ length:5 }, (_, index) => metricSnapshot(index + 1)),
      ...Array.from({ length:5 }, (_, index) => publishReceipt(index + 1)),
      ...Array.from({ length:5 }, (_, index) => machineReview(`content-${index + 1}`)),
    ];
  }

  async getPipelineCaseOutputs(caseId) {
    assert.equal(caseId, IDS.case);
    return { items:structuredClone(this.caseOutputs) };
  }

  async getRetrospectiveMetricOutputs(caseId) {
    assert.equal(caseId, IDS.case);
    return { items:structuredClone(this.pipelineOutputs) };
  }

  async getNextM5GrayTargetCase(caseId) {
    assert.equal(caseId, IDS.case);
    return {
      caseId:IDS.grayCase,
      dayCaseId:IDS.grayDayCase,
      scheduledDate:'2026-08-09',
      platform:'douyin',
    };
  }

  async createIssueWorkProduct(issueId, value, options) {
    assert.equal(issueId, IDS.issue);
    assert.equal(options.runId, IDS.run);
    const productValue = {
      id:`learning-product-${this.created.length + 1}`,
      kind:'work_product',
      sourceTrust:null,
      ...structuredClone(value),
    };
    this.created.push(productValue);
    this.caseOutputs.push(productValue);
    this.pipelineOutputs.push(structuredClone(productValue));
    return structuredClone(productValue);
  }
}

void M5LearningLifecycleError;
