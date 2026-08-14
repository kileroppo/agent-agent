import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipRetrospectiveError,
  PaperclipRetrospectiveHandler,
  trustedMetricSamples,
} from '../src/paperclip-retrospective.ts';
import {
  isValidM5WorkProductDate,
  trustedM5WorkProducts,
} from '../src/m5-work-product-trust.ts';

const IDS = Object.freeze({
  case:'11111111-1111-4111-8111-111111111111',
  issue:'22222222-2222-4222-8222-222222222222',
  agent:'33333333-3333-4333-8333-333333333333',
  run:'44444444-4444-4444-8444-444444444444',
});

test('少于5条同类型真实MetricSnapshot时写版本化insufficient_sample并结束复盘', async () => {
  const governance = new FakeRetrospectiveGovernance(
    Array.from({ length:4 }, (_, index) => metricSnapshot(index + 1)),
  );
  const handler = new PaperclipRetrospectiveHandler({
    governance,
    now:() => new Date('2026-08-08T00:00:00.000Z'),
  });

  const result = await handler.handle(payload());

  assert.equal(result.status, 'insufficient_sample');
  assert.equal(result.sampleCount, 4);
  assert.equal(governance.workProducts.length, 1);
  const product = governance.workProducts[0];
  assert.equal(product.metadata.schemaVersion, 'agent.army/m5-retrospective/v1');
  assert.equal(product.metadata.kind, 'Retrospective');
  assert.equal(product.metadata.version, 1);
  assert.equal(product.metadata.report.status, 'insufficient_sample');
  assert.equal(product.metadata.report.learningProposal, null);
  assert.deepEqual(governance.transitions, [{
    caseId:IDS.case,
    expectedVersion:7,
    toStageKey:'done',
    runId:IDS.run,
  }]);
  assert.equal(governance.completed, 1);
});

test('达到5条同类型真实内容后只生成待审核LearningProposal，不修改生产控制项', async () => {
  const governance = new FakeRetrospectiveGovernance(
    Array.from({ length:5 }, (_, index) => metricSnapshot(index + 1)),
  );
  const handler = new PaperclipRetrospectiveHandler({
    governance,
    now:() => new Date('2026-08-08T00:00:00.000Z'),
  });

  const result = await handler.handle(payload());

  assert.equal(result.status, 'proposal_ready');
  assert.equal(result.sampleCount, 5);
  const report = governance.workProducts[0].metadata.report;
  assert.equal(report.status, 'proposal_ready');
  assert.equal(report.metricSnapshotRefs.length, 5);
  assert.match(report.observations.join('\n'), /views 为 300/);
  assert.deepEqual(report.comparisonScope, {
    platform:'douyin',
    contentType:'ai-agent-practice',
    checkpoint:'72h',
    comparableSampleCount:5,
    statistics:['median', 'p75'],
    crossPlatformRawRanking:false,
  });
  assert.equal(report.comparableMetrics.views.median, 300);
  assert.equal(report.comparableMetrics.views.p75, 400);
  assert.equal(report.decision, 'repackage');
  assert.equal(report.singleExperiment.variable, '开场或第一屏结构');
  assert.deepEqual(report.controls, {
    promptMutation:false,
    permissionExpansion:false,
    frequencyIncrease:false,
    paidPromotion:false,
  });
  assert.equal(report.learningProposal.schemaVersion, 'agent.army/learning-proposal/v1');
  assert.equal(report.learningProposal.status, 'proposed');
  assert.equal(report.learningProposal.sourceSampleCount, 5);
  assert.equal(report.learningProposal.offlineReplayRequired, true);
  assert.equal(report.learningProposal.reviewerApprovalRequired, true);
  assert.equal(report.learningProposal.grayReleaseLimit, 1);
  assert.equal(report.learningProposal.automaticProductionMutation, false);
  assert.equal(report.learningProposal.singleExperimentRequired, true);
  assert.deepEqual(report.learningProposal.suggestedChanges, [
    '保留表现较好的开场和结构变量。',
    '下一版只调整一个主要变量，并继续关联原任务与版本。',
  ]);
  assert.deepEqual(governance.transitions, [{
    caseId:IDS.case,
    expectedVersion:7,
    toStageKey:'learning',
    runId:IDS.run,
  }]);
});

test('提案Work Product已写入且Case已到learning时只完成Issue，不重复生成复盘版本', async () => {
  const governance = new FakeRetrospectiveGovernance(
    Array.from({ length:5 }, (_, index) => metricSnapshot(index + 1)),
  );
  governance.case.stageKey = 'learning';
  governance.case.version = 8;
  governance.caseOutputs = [{
    id:'retrospective-work-product',
    kind:'work_product',
    type:'document',
    provider:'agent-army.m5-retrospective',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/m5-retrospective/v1',
      kind:'Retrospective',
      version:1,
      caseId:IDS.case,
      sourceCaseVersion:7,
      report:{
        status:'proposal_ready',
        sampleCount:5,
        learningProposal:{ status:'proposed' },
      },
    },
  }];
  const handler = new PaperclipRetrospectiveHandler({ governance });

  const result = await handler.handle(payload());

  assert.equal(result.replayed, true);
  assert.equal(result.status, 'proposal_ready');
  assert.equal(governance.workProducts.length, 0);
  assert.equal(governance.transitions.length, 0);
  assert.equal(governance.completed, 1);
});

test('样本只接受标准信任且日期有效的72h快照，并按contentVersion保留最新候选', async () => {
  const valid = Array.from({ length:4 }, (_, index) => metricSnapshot(index + 1));
  const outputs = [
    ...valid,
    metricSnapshot(1, {
      id:'duplicate-content',
      metadata:{
        ...metricSnapshot(1).metadata,
        snapshot:{
          ...metricSnapshot(1).metadata.snapshot,
          snapshotId:'snapshot-duplicate',
          collectedAt:'2026-08-09T00:00:00.000Z',
        },
      },
    }),
    metricSnapshot(5, { sourceTrust:{ disposition:'quarantined' } }),
    metricSnapshot(6, {
      metadata:{
        ...metricSnapshot(6).metadata,
        checkpoint:'24h',
      },
    }),
    metricSnapshot(7, {
      metadata:{
        ...metricSnapshot(7).metadata,
        snapshot:{ ...metricSnapshot(7).metadata.snapshot, platform:'xiaohongshu' },
      },
    }),
    metricSnapshot(8, {
      metadata:{
        ...metricSnapshot(8).metadata,
        snapshot:{ ...metricSnapshot(8).metadata.snapshot, collectedAt:'not-a-date' },
      },
    }),
    metricSnapshot(9, { healthStatus:'degraded' }),
  ];
  const samples = trustedMetricSamples({ items:outputs }, 'douyin');
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.map((item) => item.snapshotId), [
    'snapshot-2',
    'snapshot-3',
    'snapshot-4',
    'snapshot-duplicate',
  ]);

  const governance = new FakeRetrospectiveGovernance(outputs);
  const result = await new PaperclipRetrospectiveHandler({ governance }).handle(payload());
  assert.equal(result.sampleCount, 4);
  assert.equal(result.status, 'insufficient_sample');
});

test('可信Work Product Module保持空信任、默认状态、信封和日期强制转换语义', () => {
  const withoutSourceTrust = metricSnapshot(1);
  delete withoutSourceTrust.sourceTrust;
  const quarantined = metricSnapshot(2, { sourceTrust:{ disposition:'quarantined' } });
  const mutableStatuses = ['active'];
  const contract = {
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    schemaVersion:'agent.army/metric-snapshot/v1',
    kind:'MetricSnapshot',
  };

  assert.deepEqual(
    trustedM5WorkProducts({ items:[withoutSourceTrust, quarantined] }, contract)
      .map((item) => item.id),
    ['metric-1'],
  );
  assert.equal(trustedM5WorkProducts([withoutSourceTrust], {
    ...contract,
    statuses:undefined,
  }).length, 1);
  assert.equal(trustedM5WorkProducts([withoutSourceTrust], {
    ...contract,
    statuses:mutableStatuses,
  }).length, 1);
  assert.deepEqual(mutableStatuses, ['active']);
  assert.equal(isValidM5WorkProductDate(undefined), false);
  assert.equal(isValidM5WorkProductDate(0), Number.isFinite(Date.parse(0)));
});

test('同版本复盘Work Product不唯一时保持原错误语义并失败关闭', async () => {
  const governance = new FakeRetrospectiveGovernance([]);
  governance.caseOutputs = [
    retrospectiveWorkProduct('retrospective-first'),
    retrospectiveWorkProduct('retrospective-second'),
  ];
  const handler = new PaperclipRetrospectiveHandler({ governance });

  await assert.rejects(
    () => handler.handle(payload()),
    (error) => error instanceof PaperclipRetrospectiveError
      && error.message === '当前 Case 存在多个同版本复盘 Work Product，拒绝猜测。',
  );
  assert.equal(governance.transitions.length, 0);
  assert.equal(governance.completed, 0);
});

test('调用方不能指定Case、平台、样本或Proposal，拒绝发生在Paperclip身份核验前', async () => {
  for (const key of ['caseId', 'platform', 'sampleType', 'learningProposal']) {
    let verified = false;
    const handler = new PaperclipRetrospectiveHandler({
      governance:{
        async verifySystemAssignment() {
          verified = true;
          throw new Error('should not reach');
        },
      },
    });
    await assert.rejects(
      () => handler.handle(payload({ context:{ taskId:IDS.issue, nested:{ [key]:'forged' } } })),
      new RegExp(`不接受调用方指定 ${key}`),
    );
    assert.equal(verified, false);
  }
});

function payload(overrides = {}) {
  return {
    runId:IDS.run,
    agentId:IDS.agent,
    context:{ taskId:IDS.issue },
    ...overrides,
  };
}

function metricSnapshot(index, overrides = {}) {
  const contentVersionId = `content-${index}`;
  return {
    id:`metric-${index}`,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/metric-snapshot/v1',
      kind:'MetricSnapshot',
      checkpoint:'72h',
      receiptId:`receipt-${index}`,
      snapshot:{
        snapshotId:`snapshot-${index}`,
        contentVersionId,
        platform:'douyin',
        collectedAt:`2026-08-0${index}T00:00:00.000Z`,
        metrics:{ views:100 * index, likes:10 * index },
      },
    },
    ...overrides,
  };
}

function retrospectiveWorkProduct(id) {
  return {
    id,
    kind:'work_product',
    type:'document',
    provider:'agent-army.m5-retrospective',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/m5-retrospective/v1',
      kind:'Retrospective',
      version:1,
      caseId:IDS.case,
      sourceCaseVersion:7,
      report:{ status:'proposal_ready', sampleCount:5 },
    },
  };
}

class FakeRetrospectiveGovernance {
  constructor(metricOutputs) {
    this.metricOutputs = structuredClone(metricOutputs);
    this.workProducts = [];
    this.caseOutputs = [];
    this.transitions = [];
    this.completed = 0;
    this.case = {
      id:IDS.case,
      version:7,
      stageKey:'retrospective',
      fields:{ platform:'douyin' },
    };
    this.issue = {
      id:IDS.issue,
      status:'in_progress',
      assigneeAgentId:IDS.agent,
      description:`[agent-army:m5:routine:m5-retrospective] 处理复盘阶段；当前 Case 为 ${IDS.case}，版本为 7。`,
    };
  }

  async verifySystemAssignment(input) {
    assert.deepEqual(input, {
      issueId:IDS.issue,
      runId:IDS.run,
      paperclipAgentId:IDS.agent,
      systemRole:'m5-retrospective-controller',
    });
    return { issue:structuredClone(this.issue), run:{ id:IDS.run } };
  }

  async assertCaseIssueLink(caseId, issueId) {
    assert.equal(caseId, IDS.case);
    assert.equal(issueId, IDS.issue);
  }

  async getPipelineCase(caseId) {
    assert.equal(caseId, IDS.case);
    return structuredClone(this.case);
  }

  async getPipelineCaseOutputs(caseId) {
    assert.equal(caseId, IDS.case);
    return { items:structuredClone(this.caseOutputs) };
  }

  async getRetrospectiveMetricOutputs(caseId) {
    assert.equal(caseId, IDS.case);
    return { items:structuredClone(this.metricOutputs) };
  }

  async createIssueWorkProduct(issueId, product, options) {
    assert.equal(issueId, IDS.issue);
    assert.equal(options.runId, IDS.run);
    this.workProducts.push(structuredClone(product));
    return { id:'retrospective-work-product', ...structuredClone(product) };
  }

  async transitionPipelineCase(caseId, payload, options) {
    assert.equal(options.runId, IDS.run);
    this.transitions.push({ caseId, ...structuredClone(payload), runId:options.runId });
    this.case.stageKey = payload.toStageKey;
    this.case.version += 1;
    return structuredClone(this.case);
  }

  async completeRetrospectiveIssue(issueId, payload) {
    assert.equal(issueId, IDS.issue);
    assert.equal(payload.runId, IDS.run);
    this.completed += 1;
    this.issue.status = 'done';
  }
}
