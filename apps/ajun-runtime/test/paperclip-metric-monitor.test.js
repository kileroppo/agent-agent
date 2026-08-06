import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipMetricMonitorHandler,
  trustedPublishReceipt,
} from '../src/paperclip-metric-monitor.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const PUBLISHED_AT = '2026-07-30T00:00:00.000Z';
const HOUR_MS = 3_600_000;

function receiptOutput(overrides = {}) {
  return {
    id:'work_product:receipt',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/publish-receipt/v1',
      kind:'PublishReceipt',
      receipt:{
        receiptId:RECEIPT_ID,
        campaignId:'campaign-1',
        platform:'douyin',
        accountRef:'account:douyin:primary',
        connectorMode:'fake',
        contentVersionId:'content-v1',
        externalContentId:'douyin-content-1',
        evidence:'https://creator.douyin.com/content/1',
        publishedAt:PUBLISHED_AT,
      },
    },
    ...overrides,
  };
}

class FakeMetricGovernance {
  constructor(outputs = [receiptOutput()]) {
    this.issue = {
      id:ISSUE_ID,
      status:'in_progress',
      assigneeAgentId:AGENT_ID,
      description:`[agent-army:m5:routine:m5-metrics] 处理指标；当前 Case 为 ${CASE_ID}，版本为 1。`,
      executionPolicy:{ mode:'normal', commentRequired:true, stages:[] },
    };
    this.outputs = structuredClone(outputs);
    this.calls = [];
  }

  async verifySystemAssignment(input) {
    this.calls.push({ kind:'verify', input:structuredClone(input) });
    assert.equal(input.systemRole, 'm5-metrics-controller');
    assert.equal(input.paperclipAgentId, AGENT_ID);
    return { issue:structuredClone(this.issue), run:{ id:input.runId } };
  }

  async assertCaseIssueLink(caseId, issueId) {
    this.calls.push({ kind:'link', caseId, issueId });
    assert.equal(caseId, CASE_ID);
    assert.equal(issueId, ISSUE_ID);
  }

  async getPipelineCase(caseId) {
    assert.equal(caseId, CASE_ID);
    return {
      id:CASE_ID,
      version:1,
      parentCaseId:null,
      stageKey:'metrics',
      fields:{},
    };
  }

  async getPipelineCaseOutputs(caseId) {
    assert.equal(caseId, CASE_ID);
    return { caseId, items:structuredClone(this.outputs) };
  }

  async updateIssueExecutionPolicy(issueId, { runId, executionPolicy }) {
    assert.equal(issueId, ISSUE_ID);
    this.issue.executionPolicy = structuredClone(executionPolicy);
    this.calls.push({
      kind:'monitor',
      issueId,
      runId,
      monitor:structuredClone(executionPolicy.monitor),
    });
  }

  async createIssueWorkProduct(issueId, product, options) {
    assert.equal(issueId, ISSUE_ID);
    assert.equal(options.runId, product.createdByRunId);
    this.outputs.push({
      id:`work_product:${product.externalId}`,
      kind:'work_product',
      sourceTrust:null,
      ...structuredClone(product),
    });
    this.calls.push({ kind:'work-product', product:structuredClone(product) });
    return product;
  }

  async completeMetricMonitorIssue(issueId, payload) {
    assert.equal(issueId, ISSUE_ID);
    this.issue.status = 'done';
    this.issue.executionPolicy = structuredClone(payload.executionPolicy);
    this.calls.push({ kind:'complete', payload:structuredClone(payload) });
  }
}

class FakeMetricPublisher {
  constructor({ failFirst = false } = {}) {
    this.failFirst = failFirst;
    this.calls = [];
    this.authorizationContexts = [];
  }

  async collectMetricSnapshot(input, authorizationContext) {
    this.calls.push(structuredClone(input));
    this.authorizationContexts.push(structuredClone(authorizationContext));
    if (this.failFirst && this.calls.length === 1) {
      throw Object.assign(new Error('fake metric transport failed'), { code:'metric_collection_failed' });
    }
    return {
      replayed:false,
      snapshot:{
        snapshotId:`snapshot-${input.collectionKey}`,
        collectionKey:input.collectionKey,
        receiptId:input.receiptId,
        collectedAt:input.collectedAt,
        platform:'douyin',
        campaignId:'campaign-1',
        accountRef:'account:douyin:primary',
        connectorMode:'fake',
        externalContentId:'douyin-content-1',
        contentVersionId:'content-v1',
        metrics:{ views:100 + this.calls.length },
      },
    };
  }
}

function payload(overrides = {}) {
  return {
    runId:'55555555-5555-4555-8555-555555555555',
    agentId:AGENT_ID,
    context:{ taskId:ISSUE_ID },
    ...overrides,
  };
}

test('指标控制器用 Paperclip Monitor 完成 2h/24h/72h，重启和重复唤醒不重复采集', async () => {
  const governance = new FakeMetricGovernance();
  const publisher = new FakeMetricPublisher();
  let current = new Date(Date.parse(PUBLISHED_AT) + HOUR_MS);
  let handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(current),
  });

  const early = await handler.handle(payload());
  assert.equal(early.waiting, true);
  assert.equal(early.checkpoint, '2h');
  assert.equal(publisher.calls.length, 0);
  assert.equal(governance.issue.executionPolicy.monitor.nextCheckAt, '2026-07-30T02:00:00.000Z');
  assert.equal(governance.issue.executionPolicy.monitor.kind, 'external_service');
  assert.equal(governance.issue.executionPolicy.monitor.recoveryPolicy, 'wake_owner');

  current = new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS);
  const first = await handler.handle(payload({ runId:'66666666-6666-4666-8666-666666666666' }));
  assert.equal(first.checkpoint, '2h');
  assert.equal(governance.issue.executionPolicy.monitor.nextCheckAt, '2026-07-31T00:00:00.000Z');
  assert.deepEqual(publisher.authorizationContexts[0], {
    action:'publisher.read_own_metrics',
    runId:'66666666-6666-4666-8666-666666666666',
    issueId:ISSUE_ID,
    campaignId:'campaign-1',
    agentId:AGENT_ID,
    authorizationId:
      'paperclip:66666666-6666-4666-8666-666666666666:22222222-2222-4222-8222-222222222222:publisher.read_own_metrics:2h',
  });

  current = new Date(Date.parse(PUBLISHED_AT) + 24 * HOUR_MS);
  handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(current),
  });
  const second = await handler.handle(payload({ runId:'77777777-7777-4777-8777-777777777777' }));
  assert.equal(second.checkpoint, '24h');

  const duplicate = await handler.handle(payload({ runId:'88888888-8888-4888-8888-888888888888' }));
  assert.equal(duplicate.waiting, true);
  assert.equal(duplicate.checkpoint, '72h');
  assert.equal(publisher.calls.length, 2);

  current = new Date(Date.parse(PUBLISHED_AT) + 72 * HOUR_MS);
  const third = await handler.handle(payload({ runId:'99999999-9999-4999-8999-999999999999' }));
  assert.equal(third.completed, true);
  assert.equal(third.checkpoint, '72h');
  assert.equal(publisher.calls.length, 3);
  assert.equal(governance.issue.status, 'done');
  assert.equal(governance.issue.executionPolicy.monitor, null);
  assert.equal(governance.outputs.filter((item) =>
    item.metadata?.schemaVersion === 'agent.army/metric-snapshot/v1',
  ).length, 3);

  const afterDone = await handler.handle(payload({ runId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  assert.equal(afterDone.skipped, true);
  assert.equal(publisher.calls.length, 3);
});

test('调用方不能伪造 receipt、采集键或时间，拒绝发生在身份核验之前', async () => {
  for (const [key, value] of [
    ['receiptId', RECEIPT_ID],
    ['collectionKey', `${RECEIPT_ID}:72h`],
    ['dueAt', '2099-01-01T00:00:00.000Z'],
    ['publishedAt', '2000-01-01T00:00:00.000Z'],
    ['campaignId', 'campaign-other'],
    ['accountRef', 'account:other'],
    ['connectorMode', 'real:other'],
    ['externalContentId', 'content-other'],
    ['metrics', { views:999 }],
    ['source', { origin:'https://attacker.invalid' }],
  ]) {
    const governance = new FakeMetricGovernance();
    const handler = new PaperclipMetricMonitorHandler({
      governance,
      publisher:new FakeMetricPublisher(),
    });
    await assert.rejects(
      () => handler.handle(payload({
        context:{ taskId:ISSUE_ID, nested:{ [key]:value } },
      })),
      (error) => (
        error.code === 'metric_selection_parameter_forbidden'
        && new RegExp(`不接受调用方指定 ${key}`).test(error.message)
      ),
    );
    assert.equal(governance.calls.length, 0);
  }
});

test('采集失败由原生 Monitor 延后恢复，同一检查点可安全重试', async () => {
  const governance = new FakeMetricGovernance();
  const publisher = new FakeMetricPublisher({ failFirst:true });
  let current = new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS);
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(current),
  });

  await assert.rejects(() => handler.handle(payload()), /指标采集失败，等待安全恢复/);
  assert.equal(
    governance.issue.executionPolicy.monitor.nextCheckAt,
    '2026-07-30T02:15:00.000Z',
  );
  assert.match(governance.issue.executionPolicy.monitor.notes, /采集失败/);

  current = new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS + 15 * 60_000);
  const recovered = await handler.handle(payload({ runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  assert.equal(recovered.checkpoint, '2h');
  assert.equal(publisher.calls.length, 2);
  assert.equal(governance.outputs.some((item) => item.metadata?.checkpoint === '2h'), true);
});

test('stale invoking 只读核对 attempt 后转 human_review，后续唤醒绝不自动重试 connector', async () => {
  const governance = new FakeMetricGovernance();
  const publisher = new FakeMetricPublisher();
  const current = new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS + 11 * 60_000);
  let attemptReads = 0;
  publisher.collectMetricSnapshot = async (input, authorizationContext) => {
    publisher.calls.push(structuredClone(input));
    publisher.authorizationContexts.push(structuredClone(authorizationContext));
    throw Object.assign(new Error('another runner is still invoking'), {
      code:'metric_collection_active',
    });
  };
  publisher.getAttempt = async (attemptKey) => {
    attemptReads += 1;
    assert.equal(attemptKey, `metric:${RECEIPT_ID}:2h`);
    return {
      attemptId:'attempt_metric_stale_human_review',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey:`${RECEIPT_ID}:2h`,
      receiptId:RECEIPT_ID,
      campaignId:'campaign-1',
      platform:'douyin',
      state:'invoking',
      retryCount:0,
      invokingAt:new Date(current.getTime() - 11 * 60_000).toISOString(),
    };
  };
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(current),
  });

  const first = await handler.handle(payload());

  assert.equal(first.waitingForHumanReview, true);
  assert.equal(
    first.recoveryAction.action,
    'publisher.reconcile_stale_attempt',
  );
  assert.deepEqual(first.recoveryAction.allowedConclusions, [
    'no_external_effect',
    'external_effect_verified',
  ]);
  assert.equal(publisher.calls.length, 1);
  assert.equal(attemptReads, 1);
  assert.equal(
    governance.issue.executionPolicy.monitor.recoveryPolicy,
    'human_review',
  );
  assert.equal(
    governance.issue.executionPolicy.monitor.automaticRetry,
    false,
  );
  assert.match(
    governance.issue.executionPolicy.monitor.notes,
    /禁止自动重试 connector/,
  );

  const repeated = await handler.handle(payload({
    runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }));

  assert.equal(repeated.waitingForHumanReview, true);
  assert.equal(publisher.calls.length, 1);
  assert.equal(attemptReads, 1);
  assert.equal(governance.outputs.length, 1);
});

test('provider 原始错误中的路径、Token、Cookie 和 URL 不进入 Monitor notes 或响应错误', async () => {
  const governance = new FakeMetricGovernance();
  const publisher = new FakeMetricPublisher();
  const secret = 'sk-provider-secret-must-not-persist';
  publisher.collectMetricSnapshot = async () => {
    throw new Error(
      `provider failed /Users/alice/project/.env token=${secret} `
      + 'cookie=session-secret https://provider.invalid/debug?token=raw',
    );
  };
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS),
  });

  await assert.rejects(
    () => handler.handle(payload()),
    (error) => (
      error.code === 'metric_collection_failed'
      && !error.message.includes(secret)
      && !error.message.includes('/Users/alice')
      && !error.message.includes('session-secret')
      && !error.message.includes('provider.invalid')
    ),
  );
  const notes = governance.issue.executionPolicy.monitor.notes;
  assert.match(notes, /\[local-path\]/);
  assert.match(notes, /\[credential\]/);
  assert.match(notes, /\[external-url\]/);
  assert.doesNotMatch(notes, new RegExp(secret));
  assert.doesNotMatch(notes, /\/Users\/alice|session-secret|provider\.invalid/);
});

test('PublishReceipt 尚未写回时不猜测标识，并用原生 Monitor 等待恢复', async () => {
  const governance = new FakeMetricGovernance([]);
  const publisher = new FakeMetricPublisher();
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(PUBLISHED_AT),
  });

  await assert.rejects(() => handler.handle(payload()), /必须且只能有一个/);
  assert.equal(publisher.calls.length, 0);
  assert.equal(governance.issue.executionPolicy.monitor.nextCheckAt, '2026-07-30T00:15:00.000Z');
  assert.equal(
    governance.issue.executionPolicy.monitor.externalRef,
    `case:${CASE_ID}:publish-receipt`,
  );
});

test('只接受 Case 中唯一、标准信任且结构完整的 PublishReceipt', () => {
  assert.equal(trustedPublishReceipt({ items:[receiptOutput()] }).receiptId, RECEIPT_ID);
  assert.throws(
    () => trustedPublishReceipt({ items:[receiptOutput({ sourceTrust:{
      preset:'low_trust_review',
      disposition:'quarantined',
    } })] }),
    /标准信任/,
  );
  assert.throws(
    () => trustedPublishReceipt({ items:[receiptOutput(), receiptOutput({ id:'second' })] }),
    /实际为 2 个/,
  );
  assert.throws(
    () => trustedPublishReceipt({ items:[receiptOutput({
      metadata:{
        schemaVersion:'agent.army/publish-receipt/v1',
        kind:'PublishReceipt',
        receipt:{ receiptId:'caller-controlled', platform:'douyin', publishedAt:PUBLISHED_AT },
      },
    })] }),
    /结构无效/,
  );
  const incomplete = receiptOutput();
  delete incomplete.metadata.receipt.externalContentId;
  assert.throws(
    () => trustedPublishReceipt({ items:[incomplete] }),
    /结构无效/,
  );
  for (const field of ['campaignId', 'accountRef', 'connectorMode']) {
    const invalid = receiptOutput();
    delete invalid.metadata.receipt[field];
    assert.throws(
      () => trustedPublishReceipt({ items:[invalid] }),
      (error) => (
        error.code === 'metric_publish_receipt_identity_invalid'
        && /结构无效/.test(error.message)
      ),
      field,
    );
  }
});

test('Publisher 返回跨回执或跨版本 MetricSnapshot 时拒绝写回健康 Work Product', async () => {
  const governance = new FakeMetricGovernance();
  const publisher = new FakeMetricPublisher();
  publisher.collectMetricSnapshot = async (input) => ({
    replayed:true,
    snapshot:{
      snapshotId:'snapshot-forged',
      collectionKey:input.collectionKey,
      receiptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      collectedAt:input.collectedAt,
      platform:'douyin',
      contentVersionId:'content-other',
      metrics:{ views:999 },
    },
  });
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS),
  });

  await assert.rejects(
    () => handler.handle(payload()),
    (error) => (
      error.code === 'metric_snapshot_identity_invalid'
      && /指标采集失败，等待安全恢复/.test(error.message)
    ),
  );
  assert.equal(
    governance.outputs.some((item) => item.metadata?.kind === 'MetricSnapshot'),
    false,
  );
});

test('历史标签和跨活动快照不算完成，fake/douyin 可从首个检查点安全重采', async () => {
  const labelOnly = metricSnapshotOutput('2h');
  delete labelOnly.metadata.snapshot;
  const wrongCampaign = metricSnapshotOutput('24h', {
    campaignId:'campaign-other',
  });
  const wrongExternalId = metricSnapshotOutput('72h');
  wrongExternalId.externalId = 'snapshot-other';
  const forged = [labelOnly, wrongCampaign, wrongExternalId];
  const governance = new FakeMetricGovernance([receiptOutput(), ...forged]);
  const publisher = new FakeMetricPublisher();
  const handler = new PaperclipMetricMonitorHandler({
    governance,
    publisher,
    now:() => new Date(Date.parse(PUBLISHED_AT) + 72 * HOUR_MS),
  });

  const result = await handler.handle(payload());

  assert.equal(result.completed, false);
  assert.equal(result.checkpoint, '2h');
  assert.equal(publisher.calls.length, 1);
  assert.equal(governance.issue.status, 'in_progress');
  assert.equal(
    governance.outputs.filter((item) =>
      item.metadata?.kind === 'MetricSnapshot'
      && item.metadata?.checkpoint === '2h'
      && item.metadata?.snapshot?.campaignId === 'campaign-1',
    ).length,
    1,
  );
});

test('小红书快照必须绑定回执账号、内容ID和获批官方只读来源', async () => {
  const validGovernance = new FakeMetricGovernance([xhsReceiptOutput()]);
  const validPublisher = xhsPublisher();
  const validHandler = new PaperclipMetricMonitorHandler({
    governance:validGovernance,
    publisher:validPublisher,
    now:() => new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS),
  });

  const accepted = await validHandler.handle(payload());
  assert.equal(accepted.checkpoint, '2h');
  const persisted = validGovernance.outputs.find(
    (item) => item.metadata?.kind === 'MetricSnapshot',
  );
  assert.equal(persisted.metadata.snapshot.accountRef, 'account:xhs:primary');
  assert.equal(
    persisted.metadata.snapshot.source.origin,
    'https://pro.xiaohongshu.com',
  );

  const mutations = [
    (snapshot) => { snapshot.accountRef = 'account:xhs:other'; },
    (snapshot) => { snapshot.externalContentId = 'note-other'; },
    (snapshot) => { snapshot.source.origin = 'https://www.xiaohongshu.com'; },
    (snapshot) => { snapshot.source.selectorChecksum = 'sha256:not-a-hash'; },
    (snapshot) => { snapshot.source.capturedAt = PUBLISHED_AT; },
    (snapshot) => {
      snapshot.source.rawMetrics.views = 'sk-provider-secret-must-not-persist';
    },
  ];
  for (const mutate of mutations) {
    const governance = new FakeMetricGovernance([xhsReceiptOutput()]);
    const publisher = xhsPublisher(mutate);
    const handler = new PaperclipMetricMonitorHandler({
      governance,
      publisher,
      now:() => new Date(Date.parse(PUBLISHED_AT) + 2 * HOUR_MS),
    });
    await assert.rejects(
      () => handler.handle(payload()),
      (error) => (
        error.code === 'metric_snapshot_identity_invalid'
        && /指标采集失败，等待安全恢复/.test(error.message)
      ),
    );
    assert.equal(
      governance.outputs.some((item) => item.metadata?.kind === 'MetricSnapshot'),
      false,
    );
  }
});

function metricSnapshotOutput(checkpoint, snapshotOverrides = {}) {
  const offsets = { '2h':2, '24h':24, '72h':72 };
  const dueAt = new Date(
    Date.parse(PUBLISHED_AT) + offsets[checkpoint] * HOUR_MS,
  ).toISOString();
  const collectionKey = `${RECEIPT_ID}:${checkpoint}`;
  const snapshot = {
    snapshotId:`snapshot-${checkpoint}`,
    collectionKey,
    receiptId:RECEIPT_ID,
    campaignId:'campaign-1',
    platform:'douyin',
    accountRef:'account:douyin:primary',
    connectorMode:'fake',
    externalContentId:'douyin-content-1',
    contentVersionId:'content-v1',
    collectedAt:dueAt,
    metrics:{ views:100 },
    ...snapshotOverrides,
  };
  return {
    id:`work_product:${snapshot.snapshotId}`,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    externalId:snapshot.snapshotId,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/metric-snapshot/v1',
      kind:'MetricSnapshot',
      checkpoint,
      dueAt,
      receiptId:RECEIPT_ID,
      collectionKey,
      snapshot,
    },
  };
}

function xhsReceiptOutput() {
  const output = receiptOutput();
  Object.assign(output.metadata.receipt, {
    platform:'xiaohongshu',
    accountRef:'account:xhs:primary',
    connectorMode:'real:xiaohongshu_own_metrics_cua',
    externalContentId:'note-owned-1',
    evidence:'https://pro.xiaohongshu.com/creator/content/note-owned-1',
  });
  return output;
}

function xhsPublisher(mutate = null) {
  const publisher = new FakeMetricPublisher();
  publisher.collectMetricSnapshot = async (input, authorizationContext) => {
    publisher.calls.push(structuredClone(input));
    publisher.authorizationContexts.push(structuredClone(authorizationContext));
    const snapshot = {
      snapshotId:`snapshot-${input.collectionKey}`,
      collectionKey:input.collectionKey,
      receiptId:input.receiptId,
      campaignId:'campaign-1',
      platform:'xiaohongshu',
      accountRef:'account:xhs:primary',
      connectorMode:'real:xiaohongshu_own_metrics_cua',
      externalContentId:'note-owned-1',
      contentVersionId:'content-v1',
      collectedAt:input.collectedAt,
      metrics:{ comments:0, likes:12, saves:3, views:120 },
      source:{
        approvalRef:'paperclip:xhs-own-metrics-selector-v1',
        capturedAt:new Date(Date.parse(input.collectedAt) - 2_000).toISOString(),
        kind:'official_creator_ui',
        origin:'https://pro.xiaohongshu.com',
        pageKind:'own_note_detail',
        rawMetrics:{ comments:'0', likes:'12', saves:'3', views:'120' },
        selectorBundleVersion:'1.0.0',
        selectorChecksum:`sha256:${'a'.repeat(64)}`,
      },
    };
    if (mutate) mutate(snapshot);
    return { replayed:false, snapshot };
  };
  return publisher;
}
