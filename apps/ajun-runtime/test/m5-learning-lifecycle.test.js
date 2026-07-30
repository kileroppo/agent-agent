import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M5LearningLifecycle,
  M5LearningLifecycleError,
  buildOfflineReplay,
} from '../src/m5-learning-lifecycle.js';

const IDS = Object.freeze({
  case:'11111111-1111-4111-8111-111111111111',
  issue:'22222222-2222-4222-8222-222222222222',
  run:'33333333-3333-4333-8333-333333333333',
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
  assert.deepEqual(template.controls, safeControls());

  governance.pipelineOutputs.push(grayContentVersion(template.templateVersionId));
  assert.equal((await advance(lifecycle)).state, 'waiting_gray_quality_and_72h_metric');
  const gray = product(governance, 'TemplateGrayRelease').metadata.grayRelease;
  assert.equal(gray.maximumUses, 1);
  assert.equal(gray.usedUses, 1);
  assert.equal(gray.contentVersionId, 'content-gray-1');
  assert.equal((await advance(lifecycle)).state, 'waiting_gray_quality_and_72h_metric');

  governance.pipelineOutputs.push(
    machineReview('content-gray-1', { id:'review-gray-1' }),
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
  const templateId = product(governance, 'TemplateVersion').metadata.templateVersion.templateVersionId;
  governance.pipelineOutputs.push(
    grayContentVersion(templateId, 'content-gray-1'),
    grayContentVersion(templateId, 'content-gray-2'),
  );

  await assert.rejects(
    () => advance(lifecycle),
    /只能灰度一条内容，当前发现 2 条/,
  );
  assert.equal(product(governance, 'TemplateGrayRelease'), null);
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
  const templateId = product(governance, 'TemplateVersion').metadata.templateVersion.templateVersionId;
  governance.pipelineOutputs.push(grayContentVersion(templateId));
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
      snapshot:{
        snapshotId,
        contentVersionId,
        platform:'douyin',
        collectedAt:`2026-08-${String(index).padStart(2, '0')}T00:00:00.000Z`,
        metrics:{
          views:overrides.views ?? 100 * index,
          likes:overrides.likes ?? 10 * index,
        },
      },
    },
  };
}

function machineReview(contentVersionId, {
  id = `review-${contentVersionId}`,
  status = 'passed',
  failedCheck = null,
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
      reviewReport:{ status, contentVersionId, checks },
    },
  };
}

function grayContentVersion(templateVersionId, contentVersionId = 'content-gray-1') {
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
        platform:'douyin',
        templateVersionId,
        grayRelease:true,
      },
    },
  };
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
