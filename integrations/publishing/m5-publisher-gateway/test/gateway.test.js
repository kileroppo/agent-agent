import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DisabledRealConnector,
  FakePlatformConnector,
  FilePublisherRepository,
  MemoryPublisherRepository,
  PublisherGateway,
  WorkspaceArtifactVerifier,
  publishIdempotencyKey
} from '../src/index.js';

const NOW = new Date('2026-07-30T00:00:00.000Z');
const CHECKSUM_A = `sha256:${'a'.repeat(64)}`;
const CHECKSUM_B = `sha256:${'b'.repeat(64)}`;

class FakePaperclipControl {
  constructor({
    pauseFailure = null,
    invalidPauseReceipt = false,
    canonicalGrant = grant(),
    currentStage = 'campaign_active',
  } = {}) {
    this.pauseFailure = pauseFailure;
    this.invalidPauseReceipt = invalidPauseReceipt;
    this.canonicalGrant = structuredClone(canonicalGrant);
    this.currentStage = currentStage;
    this.statuses = new Map();
    this.assertCalls = [];
    this.pauseCalls = [];
  }

  async assertPublishAllowed(input) {
    this.assertCalls.push(structuredClone(input));
    return {
      campaignId:input.campaignId,
      grantStatus:this.statuses.get(input.campaignId) || 'active',
      currentStage:this.currentStage,
      canonicalGrant:structuredClone(this.canonicalGrant),
    };
  }

  async pauseCampaignAndDisableCron(input) {
    this.pauseCalls.push(structuredClone(input));
    if (this.pauseFailure) throw this.pauseFailure;
    this.statuses.set(input.campaignId, 'paused');
    if (this.invalidPauseReceipt) {
      return { campaignId:input.campaignId, grantStatus:'paused', cronStatus:'enabled' };
    }
    return {
      campaignId:input.campaignId,
      grantStatus:'paused',
      cronStatus:'disabled',
      controlEventId:`control-${this.pauseCalls.length}`,
    };
  }
}

function grant(overrides = {}) {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{ douyin:'account:douyin:test', xiaohongshu:'account:xhs:test' },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history'],
    budgetCents:625,
    ...overrides
  };
}

function request(overrides = {}) {
  const value = {
    campaignId:'campaign-m5-1',
    grant:grant(),
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:CHECKSUM_A,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'AI Agent实战',
    body:'确定性假发布契约',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
      checks:{ facts:true, privacy:true, rights:true, media:true, claims:true, grantScope:true, duplicate:true }
    },
    ...overrides
  };
  value.idempotencyKey = publishIdempotencyKey(value);
  return value;
}

function setup({
  douyinScenarios = [],
  xhsScenarios = [],
  paperclipControl = new FakePaperclipControl(),
  clock = () => new Date(NOW),
} = {}) {
  const repository = new MemoryPublisherRepository();
  const douyin = new FakePlatformConnector('douyin', douyinScenarios);
  const xiaohongshu = new FakePlatformConnector('xiaohongshu', xhsScenarios);
  const gateway = new PublisherGateway({
    repository,
    connectors:{ douyin, xiaohongshu },
    artifactVerifier:{ verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }) },
    paperclipControl,
    clock,
  });
  return { gateway, repository, douyin, xiaohongshu, paperclipControl };
}

function douyinMetricResult() {
  return {
    views:100,
    likes:10,
    comments:0,
    shares:0,
    downloads:0,
    forwards:0,
  };
}

class FailReceiptCommitRepository extends MemoryPublisherRepository {
  constructor() {
    super();
    this.failReceiptCommit = true;
  }

  async update(mutator) {
    return super.update(async (draft) => {
      const result = await mutator(draft);
      if (this.failReceiptCommit && Object.keys(draft.receipts).length) {
        this.failReceiptCommit = false;
        throw new Error('simulated receipt disk failure');
      }
      return result;
    });
  }
}

class FailMetricHardStopBlockRepository extends MemoryPublisherRepository {
  constructor() {
    super();
    this.failHardStopBlock = true;
  }

  async update(mutator) {
    return super.update(async (draft) => {
      const result = await mutator(draft);
      const hardStoppedMetric = Object.values(draft.attempts).find((attempt) => (
        attempt.kind === 'metric_snapshot'
        && attempt.state === 'blocked'
        && attempt.hardStop === true
      ));
      if (this.failHardStopBlock && hardStoppedMetric) {
        this.failHardStopBlock = false;
        throw Object.assign(new Error('simulated metric hard-stop ledger failure'), {
          code:'publisher_ledger_write_failed',
        });
      }
      return result;
    });
  }
}

class FailMetricRecoveryCommitRepository extends MemoryPublisherRepository {
  constructor() {
    super();
    this.failRecoveryCommit = true;
  }

  async update(mutator) {
    return super.update(async (draft) => {
      const result = await mutator(draft);
      const recordedRecovery = Object.values(draft.attempts).find((attempt) => (
        attempt.kind === 'metric_snapshot'
        && attempt.metricRecovery
      ));
      if (this.failRecoveryCommit && recordedRecovery) {
        this.failRecoveryCommit = false;
        throw Object.assign(new Error('simulated metric recovery ledger failure'), {
          code:'publisher_ledger_write_failed',
        });
      }
      return result;
    });
  }
}

test('假抖音发布产生内容ID、成功证据和确定性回执', async () => {
  const { gateway } = setup({ douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }] });
  const result = await gateway.publish(request());
  assert.equal(result.replayed, false);
  assert.match(result.receipt.externalContentId, /^fake-douyin-/);
  assert.match(result.receipt.evidence, /^fake:\/\/douyin\/content\//);
  assert.equal(result.receipt.connectorMode, 'fake');
});

test('假小红书使用独立账号引用并产生平台回执', async () => {
  const { gateway, xiaohongshu } = setup({
    xhsScenarios:[{ type:'success', publishedAt:NOW.toISOString() }]
  });
  const xhs = request({
    platform:'xiaohongshu',
    mediaPath:'xiaohongshu.mp4'
  });
  xhs.idempotencyKey = publishIdempotencyKey(xhs);
  const result = await gateway.publish(xhs);
  assert.match(result.receipt.externalContentId, /^fake-xiaohongshu-/);
  assert.equal(xiaohongshu.publishCalls[0].accountRef, 'account:xhs:test');
});

test('历史或未来 scheduledDate 在产物和 connector 前失败并返回重排动作', async () => {
  for (const scheduledDate of ['2026-07-30', '2026-08-01']) {
    let artifactVerifications = 0;
    const { gateway, douyin } = setup({
      clock:() => new Date('2026-07-31T04:00:00.000Z'),
    });
    gateway.artifactVerifier = {
      async verify() {
        artifactVerifications += 1;
        throw new Error('日期错配不得读取发布产物');
      },
    };
    await assert.rejects(
      gateway.publish(request({ scheduledDate })),
      (error) => {
        assert.equal(error.code, 'publisher_scheduled_date_mismatch');
        assert.equal(
          error.recoveryAction?.action,
          'reschedule_platform_case_for_current_date',
        );
        assert.equal(error.recoveryAction?.executionDate, '2026-07-31');
        return true;
      },
    );
    assert.equal(artifactVerifications, 0);
    assert.equal(douyin.publishCalls.length, 0);
  }
});

test('调用方篡改限额、账号、平台和有效期时一律使用 Paperclip canonical Grant', async () => {
  const { gateway, douyin, paperclipControl } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
  });
  const forged = request({
    grant:grant({
      totalPublishLimit:999,
      dailyPublishLimitPerPlatform:999,
      accountRefs:{
        douyin:'account:douyin:forged',
        xiaohongshu:'account:xhs:forged',
      },
      platforms:['xiaohongshu'],
      expiresAt:'2099-12-31T23:59:59.999Z',
    }),
  });
  forged.idempotencyKey = publishIdempotencyKey(forged);

  const result = await gateway.publish(forged);

  assert.match(result.receipt.externalContentId, /^fake-douyin-/);
  assert.equal(douyin.publishCalls[0].accountRef, 'account:douyin:test');
  assert.equal(douyin.publishCalls[0].grant.totalPublishLimit, 14);
  assert.equal(douyin.publishCalls[0].grant.dailyPublishLimitPerPlatform, 1);
  assert.deepEqual(douyin.publishCalls[0].grant.platforms, ['douyin', 'xiaohongshu']);
  assert.equal(douyin.publishCalls[0].grant.expiresAt, '2026-08-06T00:00:00.000Z');
  assert.equal(Object.hasOwn(paperclipControl.assertCalls[0], 'grant'), false);
});

test('Paperclip canonical Grant 自身越权时在接触平台前拒绝', async () => {
  const { gateway, douyin } = setup({
    paperclipControl:new FakePaperclipControl({
      canonicalGrant:grant({ totalPublishLimit:999 }),
    }),
  });
  await assert.rejects(gateway.publish(request()), { code:'publish_preflight_failed' });
  assert.equal(douyin.publishCalls.length, 0);
});

test('相同幂等键并发调用只触发一次平台发布', async () => {
  const { gateway, douyin } = setup({ douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }] });
  const [first, second] = await Promise.all([gateway.publish(request()), gateway.publish(request())]);
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(douyin.publishCalls.length, 1);
});

test('重启后幂等重放返回已有回执而不重复发布', async () => {
  const {
    gateway,
    repository,
    douyin,
    paperclipControl,
  } = setup({ douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }] });
  const first = await gateway.publish(request());
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin, xiaohongshu:new FakePlatformConnector('xiaohongshu') },
    artifactVerifier:{ verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }) },
    paperclipControl,
    clock:() => new Date(NOW)
  });
  const second = await restarted.publish(request());
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);
  assert.equal(douyin.publishCalls.length, 1);
});

test('平台成功但回执落账失败时重试只暂停核对，绝不重发', async () => {
  const repository = new FailReceiptCommitRepository();
  const douyin = new FakePlatformConnector('douyin', [{ type:'success', publishedAt:NOW.toISOString() }]);
  const options = {
    repository,
    connectors:{ douyin, xiaohongshu:new FakePlatformConnector('xiaohongshu') },
    artifactVerifier:{ verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }) },
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(NOW)
  };
  const gateway = new PublisherGateway(options);
  await assert.rejects(gateway.publish(request()), /simulated receipt disk failure/);
  assert.equal((await gateway.getAttempt(publishIdempotencyKey(request()))).state, 'external_succeeded');

  const restarted = new PublisherGateway(options);
  await assert.rejects(restarted.publish(request()), { code:'publish_attempt_ambiguous' });
  assert.equal(douyin.publishCalls.length, 1);
  assert.equal(options.paperclipControl.pauseCalls.length, 1);
  assert.equal(options.paperclipControl.statuses.get('campaign-m5-1'), 'paused');
});

test('回执可按receiptId或幂等键读取', async () => {
  const { gateway } = setup({ douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }] });
  const result = await gateway.publish(request());
  assert.match(result.receipt.receiptId, /^[0-9a-f-]{8,80}$/);
  assert.equal((await gateway.getReceipt(result.receipt.receiptId)).receiptId, result.receipt.receiptId);
  assert.equal((await gateway.getReceipt(result.receipt.idempotencyKey)).receiptId, result.receipt.receiptId);
});

test('验证码首次出现即停止并暂停整个活动', async () => {
  const { gateway, paperclipControl } = setup({
    douyinScenarios:[{ type:'stop', reason:'captcha' }]
  });
  await assert.rejects(gateway.publish(request()), { code:'publish_stopped_captcha' });
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'captcha');
  assert.equal(paperclipControl.statuses.get('campaign-m5-1'), 'paused');
});

test('账号风控或平台违规无需等待第二次失败就暂停', async () => {
  const { gateway, paperclipControl } = setup({ douyinScenarios:[{ type:'stop', reason:'risk_control' }] });
  await assert.rejects(gateway.publish(request()), { code:'publish_stopped_risk_control' });
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'risk_control');
});

test('同平台重复文件哈希暂停活动', async () => {
  let current = new Date(NOW);
  const { gateway, paperclipControl } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(current),
  });
  await gateway.publish(request());
  current = new Date('2026-07-31T00:00:00.000Z');
  const duplicate = request({
    contentVersionId:'content-v2',
    scheduledDate:'2026-07-31'
  });
  duplicate.idempotencyKey = publishIdempotencyKey(duplicate);
  await assert.rejects(gateway.publish(duplicate), { code:'duplicate_content' });
  assert.equal(paperclipControl.pauseCalls[0].reason, 'duplicate_content');
});

test('活动总量或每日平台上限在接触平台前硬停', async () => {
  const { gateway, douyin } = setup({ douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }] });
  await gateway.publish(request());
  const overLimit = request({
    contentVersionId:'content-v2',
    contentChecksum:CHECKSUM_B
  });
  overLimit.idempotencyKey = publishIdempotencyKey(overLimit);
  await assert.rejects(gateway.publish(overLimit), { code:'grant_limit_exceeded' });
  assert.equal(douyin.publishCalls.length, 1);
});

test('指标只能由 Paperclip Routine 显式调用并以 collectionKey 幂等', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
  };
  const first = await gateway.collectMetricSnapshot(input);
  const replay = await gateway.collectMetricSnapshot(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal(douyin.metricCalls.length, 1);
  assert.equal((await repository.read()).metricSnapshots.length, 1);
});

test('指标授权 Campaign 必须与可信回执一致，且平台指标拒绝额外或非精确字段', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };

  await assert.rejects(
    gateway.collectMetricSnapshot({ ...input, campaignId:'campaign-other' }),
    { code:'metric_campaign_scope_mismatch' },
  );
  assert.equal(douyin.metricCalls.length, 0);

  douyin.readOwnMetrics = async () => ({
    views:100,
    likes:10,
    comments:0,
    shares:0,
    downloads:0,
    forwards:0,
    cookie:'must-not-persist',
  });
  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_collection_failed' },
  );
  const state = await repository.read();
  assert.equal(state.metricSnapshots.length, 0);
  assert.equal(
    state.attempts[`metric:${input.collectionKey}`].stopReason,
    'metric_result_unverified',
  );
  assert.doesNotMatch(JSON.stringify(state), /must-not-persist/);
});

test('小红书 rawMetrics 只接受精确数字文本，凭据伪装不能进入指标账本', async () => {
  const secret = 'sk-provider-secret-must-not-persist';
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, xiaohongshu } = setup({
    xhsScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request({ platform:'xiaohongshu' }));
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  xiaohongshu.readOwnMetrics = async (receipt, collectedAt, context) => ({
    accountRef:receipt.accountRef,
    checkpoint:context.checkpoint,
    collectedAt,
    collectionKey:context.collectionKey,
    contentVersionId:receipt.contentVersionId,
    externalContentId:receipt.externalContentId,
    metrics:{ comments:0, likes:10, saves:5, views:100 },
    platform:'xiaohongshu',
    receiptId:receipt.receiptId,
    source:{
      approvalRef:'paperclip:xhs-own-metrics-selector-v1',
      capturedAt:collectedAt,
      kind:'official_creator_ui',
      origin:'https://pro.xiaohongshu.com',
      pageKind:'own_note_detail',
      rawMetrics:{ comments:'0', likes:'10', saves:'5', views:secret },
      selectorBundleVersion:'1.0.0',
      selectorChecksum:`sha256:${'a'.repeat(64)}`,
    },
  });

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_collection_failed' },
  );
  const state = await repository.read();
  assert.equal(state.metricSnapshots.length, 0);
  assert.equal(
    state.attempts[`metric:${input.collectionKey}`].stopReason,
    'metric_result_identity_mismatch',
  );
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
});

test('指标 CUA 验证码、风控或账号切换会暂停整个活动且同检查点禁止自动重试', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, paperclipControl } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  let metricCalls = 0;
  gateway.metricConnectors.douyin = {
    connectorMode:'fake',
    costReportingMode:'local_zero',
    async readOwnMetrics() {
      metricCalls += 1;
      throw Object.assign(new Error('risk'), {
        code:'xhs_metrics_cua_stopped_risk_control',
        hardStop:true,
        stopReason:'risk_control',
      });
    },
  };

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_collection_stopped_risk_control' },
  );
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'risk_control');
  const state = await repository.read();
  assert.equal(state.attempts[`metric:${input.collectionKey}`].state, 'blocked');
  assert.equal(state.attempts[`metric:${input.collectionKey}`].hardStop, true);

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_collection_hard_stopped' },
  );
  assert.equal(metricCalls, 1);
  assert.equal(paperclipControl.pauseCalls.length, 1);
});

test('指标硬停无法确认 Campaign/Cron 已停时激活全局门闩且不再启动连接器', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl({
    pauseFailure:Object.assign(new Error('paperclip unavailable'), {
      code:'paperclip_unavailable',
    }),
  });
  const { gateway, repository } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  let metricCalls = 0;
  gateway.metricConnectors.douyin = {
    connectorMode:'fake',
    costReportingMode:'local_zero',
    async readOwnMetrics() {
      metricCalls += 1;
      throw Object.assign(new Error('captcha'), {
        code:'xhs_metrics_cua_stopped_captcha',
        hardStop:true,
        stopReason:'captcha',
      });
    },
  };

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'paperclip_pause_failed_hard_stop' },
  );
  const latched = await repository.read();
  assert.deepEqual(latched.safetyLatch, {
    active:true,
    campaignId:published.receipt.campaignId,
    reason:'paperclip_pause_writeback_failed',
    controlError:'paperclip_unavailable',
    activatedAt:metricTime.toISOString(),
  });
  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'publisher_global_hard_stop' },
  );
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin:gateway.connectors.douyin },
    metricConnectors:{ douyin:gateway.metricConnectors.douyin },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(metricTime),
  });
  await assert.rejects(
    restarted.collectMetricSnapshot(input),
    { code:'publisher_global_hard_stop' },
  );
  assert.equal(metricCalls, 1);
});

test('指标硬停优先于零费用落账失败暂停活动并保留不可重试状态', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, paperclipControl } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  let metricCalls = 0;
  gateway.metricConnectors.douyin = {
    connectorMode:'fake',
    costReportingMode:'local_zero',
    async readOwnMetrics() {
      metricCalls += 1;
      throw Object.assign(new Error('account switched'), {
        code:'xhs_metrics_cua_stopped_account_switch',
        hardStop:true,
        stopReason:'account_switch',
      });
    },
  };
  gateway.costRecorder.recordLocalZeroAttempt = async () => {
    throw Object.assign(new Error('cost reporter unavailable'), {
      code:'cost_reporting_failed',
    });
  };

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'cost_reporting_failed' },
  );
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'account_switch');
  const attempt = (await repository.read())
    .attempts[`metric:${input.collectionKey}`];
  assert.equal(attempt.state, 'blocked');
  assert.equal(attempt.hardStop, true);
  assert.equal(attempt.pauseControl.grantStatus, 'paused');
  assert.equal(attempt.pauseControl.cronStatus, 'disabled');

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_collection_hard_stopped' },
  );
  assert.equal(metricCalls, 1);
});

test('指标 hard-stop 账本回写失败仍暂停 Paperclip、激活全局门闩且禁止再次外呼', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const repository = new FailMetricHardStopBlockRepository();
  const paperclipControl = new FakePaperclipControl();
  const publishingConnector = new FakePlatformConnector('douyin', [
    { type:'success', publishedAt:NOW.toISOString() },
  ]);
  let metricCalls = 0;
  const metricConnector = {
    connectorMode:'fake',
    costReportingMode:'local_zero',
    async readOwnMetrics() {
      metricCalls += 1;
      throw Object.assign(new Error('captcha'), {
        code:'xhs_metrics_cua_stopped_captcha',
        hardStop:true,
        stopReason:'captcha',
      });
    },
  };
  const gateway = new PublisherGateway({
    repository,
    connectors:{ douyin:publishingConnector },
    metricConnectors:{ douyin:metricConnector },
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_hard_stop_writeback_failed_hard_stop' },
  );
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'captcha');
  assert.deepEqual(await gateway.getSafetyStatus(), {
    active:true,
    campaignId:published.receipt.campaignId,
    reason:'metric_hard_stop_writeback_failed',
    controlError:'publisher_ledger_write_failed',
    activatedAt:metricTime.toISOString(),
  });

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'publisher_global_hard_stop' },
  );
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin:publishingConnector },
    metricConnectors:{ douyin:metricConnector },
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(metricTime),
  });
  await assert.rejects(
    restarted.collectMetricSnapshot(input),
    { code:'publisher_global_hard_stop' },
  );
  assert.equal(metricCalls, 1);
});

test('重启遇到已持久 blocked hard-stop 时幂等补暂停且不再次调用指标 connector', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl();
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_crashed_before_pause',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'blocked',
      hardStop:true,
      stopReason:'risk_control',
      createdAt:metricTime.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl,
    clock:() => new Date(metricTime),
  });

  await assert.rejects(
    restarted.collectMetricSnapshot({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      collectedAt:metricTime.toISOString(),
    }),
    { code:'metric_collection_hard_stopped' },
  );
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'risk_control');
  assert.equal(douyin.metricCalls.length, 0);
  const attempt = (await repository.read()).attempts[attemptKey];
  assert.equal(attempt.pauseControl.grantStatus, 'paused');
  assert.equal(attempt.pauseControl.cronStatus, 'disabled');
});

test('重启补暂停无法确认时激活全局门闩并保持 connector 零调用', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl({
    pauseFailure:Object.assign(new Error('paperclip unavailable'), {
      code:'paperclip_unavailable',
    }),
  });
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_crashed_before_failed_pause',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'blocked',
      hardStop:true,
      stopReason:'risk_control',
      createdAt:metricTime.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl,
    clock:() => new Date(metricTime),
  });

  await assert.rejects(
    restarted.collectMetricSnapshot({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      collectedAt:metricTime.toISOString(),
    }),
    { code:'paperclip_pause_failed_hard_stop' },
  );
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(douyin.metricCalls.length, 0);
  assert.equal((await repository.read()).safetyLatch.active, true);
  await assert.rejects(
    restarted.collectMetricSnapshot({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      collectedAt:metricTime.toISOString(),
    }),
    { code:'publisher_global_hard_stop' },
  );
  assert.equal(douyin.metricCalls.length, 0);
});

test('付费指标读取在连接器前经过 Campaign 预算门并在不足时暂停活动', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, paperclipControl, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  gateway.costRecorder.assertCampaignBudget = async () => ({
    allowed:false,
    remainingUsd:0,
  });

  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'publisher_budget_exceeded' },
  );
  assert.equal(douyin.metricCalls.length, 0);
  assert.equal(paperclipControl.pauseCalls.length, 1);
  assert.equal(paperclipControl.pauseCalls[0].reason, 'budget_exceeded');
});

test('同一指标检查点并发只启动一次连接器，持久 claim 活跃时跨实例也拒绝重复会话', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin, paperclipControl } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  const original = douyin.readOwnMetrics.bind(douyin);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  douyin.readOwnMetrics = async (...args) => {
    await blocked;
    return original(...args);
  };

  const first = gateway.collectMetricSnapshot(input);
  const second = gateway.collectMetricSnapshot(input);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(douyin.metricCalls.length, 1);
  assert.equal(firstResult.snapshot.snapshotId, secondResult.snapshot.snapshotId);
  assert.equal((await repository.read()).metricSnapshots.length, 1);

  const otherCheckpoint = `${published.receipt.receiptId}:24h`;
  await repository.update((state) => {
    state.attempts[`metric:${otherCheckpoint}`] = {
      attemptId:'attempt_metric_active',
      kind:'metric_snapshot',
      idempotencyKey:`metric:${otherCheckpoint}`,
      collectionKey:otherCheckpoint,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:'douyin',
      state:'invoking',
      retryCount:0,
      claimToken:'other-process-claim',
      claimExpiresAt:new Date(
        NOW.getTime() + 24 * 3_600_000 + 5 * 60_000,
      ).toISOString(),
      createdAt:metricTime.toISOString(),
    };
  });
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl,
    clock:() => new Date(NOW.getTime() + 24 * 3_600_000),
  });
  await assert.rejects(
    restarted.collectMetricSnapshot({
      ...input,
      collectionKey:otherCheckpoint,
      collectedAt:new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    }),
    { code:'metric_collection_active' },
  );
  assert.equal(douyin.metricCalls.length, 1);
});

test('指标连接器缺失时记录执行失败，不创建内部调度', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const withoutConnector = new PublisherGateway({
    repository,
    connectors:{},
    artifactVerifier:{ verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }) },
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(metricTime)
  });
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
  };
  await assert.rejects(withoutConnector.collectMetricSnapshot(input), { code:'metric_connector_unavailable' });
  const state = await repository.read();
  assert.equal(state.attempts[`metric:${input.collectionKey}`].state, 'stopped');
  assert.equal(state.attempts[`metric:${input.collectionKey}`].stopReason, 'connector_unavailable');
});

test('指标读取失败后由 Paperclip 重唤醒时可按同一 collectionKey 恢复且只落一份快照', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
  };
  const original = douyin.readOwnMetrics.bind(douyin);
  let attempts = 0;
  douyin.readOwnMetrics = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('temporary'), { code:'temporary' });
    return original(...args);
  };

  await assert.rejects(gateway.collectMetricSnapshot(input), { code:'metric_collection_failed' });
  const recovered = await gateway.collectMetricSnapshot(input);
  assert.equal(recovered.replayed, false);
  assert.equal(attempts, 2);
  const state = await repository.read();
  assert.equal(state.metricSnapshots.length, 1);
  assert.equal(state.attempts[`metric:${input.collectionKey}`].retryCount, 1);
  assert.equal(state.attempts[`metric:${input.collectionKey}`].state, 'snapshot_recorded');
});

test('指标 claim 初次失败后最多安全重试两次，第 4 次在连接器前拒绝', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:2h`,
    collectedAt:metricTime.toISOString(),
  };
  let connectorCalls = 0;
  douyin.readOwnMetrics = async () => {
    connectorCalls += 1;
    throw Object.assign(new Error('temporary'), { code:'temporary' });
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      gateway.collectMetricSnapshot(input),
      { code:'metric_collection_failed' },
    );
  }
  await assert.rejects(
    gateway.collectMetricSnapshot(input),
    { code:'metric_retry_exhausted' },
  );

  const state = await repository.read();
  const attempt = state.attempts[`metric:${input.collectionKey}`];
  assert.equal(connectorCalls, 3);
  assert.equal(attempt.retryCount, 2);
  assert.equal(attempt.state, 'stopped');
  assert.equal(state.metricSnapshots.length, 0);
});

test('进程遗留且尚未外呼的过期指标 claim 可由 Paperclip 重唤醒恢复且只落一份快照', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_expired_metric_claim',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'prepared',
      retryCount:0,
      claimToken:'expired-claim',
      claimExpiresAt:new Date(metricTime.getTime() - 1).toISOString(),
      createdAt:NOW.toISOString(),
      updatedAt:NOW.toISOString(),
    };
  });

  const result = await gateway.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey,
    collectedAt:metricTime.toISOString(),
  });

  const state = await repository.read();
  const attempt = state.attempts[attemptKey];
  assert.equal(result.replayed, false);
  assert.equal(douyin.metricCalls.length, 1);
  assert.equal(state.metricSnapshots.length, 1);
  assert.equal(attempt.state, 'snapshot_recorded');
  assert.equal(attempt.retryCount, 1);
  assert.equal(Object.hasOwn(attempt, 'claimToken'), false);
  assert.equal(Object.hasOwn(attempt, 'claimExpiresAt'), false);
});

test('跨进程长指标调用超过十分钟仍由持久栅栏独占，第二 runner 不外呼、不复核预算也不计费', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-metric-invocation-fence-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const ledgerPath = path.join(root, 'publisher-ledger.json');
  let current = new Date(NOW);
  const clock = () => new Date(current);
  const firstRepository = new FilePublisherRepository(ledgerPath, { clock });
  const secondRepository = new FilePublisherRepository(ledgerPath, { clock });
  const paperclipControl = new FakePaperclipControl();
  const publishingConnector = new FakePlatformConnector('douyin', [
    { type:'success', publishedAt:NOW.toISOString() },
  ]);
  const dependencies = {
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl,
    clock,
  };
  const publishingGateway = new PublisherGateway({
    ...dependencies,
    repository:firstRepository,
    connectors:{ douyin:publishingConnector },
  });
  const published = await publishingGateway.publish(request());
  current = new Date(NOW.getTime() + 2 * 3_600_000);

  let firstConnectorCalls = 0;
  let secondConnectorCalls = 0;
  let firstEntered;
  let releaseFirst;
  const firstEnteredPromise = new Promise((resolve) => { firstEntered = resolve; });
  const firstReleasedPromise = new Promise((resolve) => { releaseFirst = resolve; });
  const firstConnector = new FakePlatformConnector('douyin');
  const secondConnector = new FakePlatformConnector('douyin');
  firstConnector.readOwnMetrics = async () => {
    firstConnectorCalls += 1;
    firstEntered();
    await firstReleasedPromise;
    return douyinMetricResult();
  };
  secondConnector.readOwnMetrics = async () => {
    secondConnectorCalls += 1;
    return douyinMetricResult();
  };
  const firstCosts = { budgetChecks:0, records:0 };
  const secondCosts = { budgetChecks:0, records:0 };
  const costRecorder = (counters) => ({
    async assertCampaignBudget() {
      counters.budgetChecks += 1;
      return { allowed:true, remainingUsd:1 };
    },
    async recordLocalZeroAttempt() {
      counters.records += 1;
      return { replayed:false };
    },
  });
  const firstGateway = new PublisherGateway({
    ...dependencies,
    repository:firstRepository,
    connectors:{ douyin:firstConnector },
    costRecorder:costRecorder(firstCosts),
  });
  const secondGateway = new PublisherGateway({
    ...dependencies,
    repository:secondRepository,
    connectors:{ douyin:secondConnector },
    costRecorder:costRecorder(secondCosts),
  });
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey,
    collectedAt:current.toISOString(),
  };

  const firstCollection = firstGateway.collectMetricSnapshot(input);
  await firstEnteredPromise;
  current = new Date(current.getTime() + 11 * 60 * 1000);
  await assert.rejects(
    secondGateway.collectMetricSnapshot(input),
    { code:'metric_collection_active' },
  );

  assert.equal(firstConnectorCalls, 1);
  assert.equal(secondConnectorCalls, 0);
  assert.deepEqual(firstCosts, { budgetChecks:1, records:0 });
  assert.deepEqual(secondCosts, { budgetChecks:0, records:0 });

  releaseFirst();
  const result = await firstCollection;
  assert.equal(result.replayed, false);
  assert.deepEqual(firstCosts, { budgetChecks:1, records:1 });
  assert.deepEqual(secondCosts, { budgetChecks:0, records:0 });
  const state = await secondRepository.read();
  assert.equal(state.metricSnapshots.length, 1);
  assert.equal(state.attempts[`metric:${collectionKey}`].state, 'snapshot_recorded');
});

test('Paperclip 人工核对 no_external_effect 幂等解除 invoking，但不在恢复调用内自动重试', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl();
  let recoveryAuthorizationCalls = 0;
  paperclipControl.assertMetricRecoveryAllowed = async (input) => {
    recoveryAuthorizationCalls += 1;
    return {
      ...input,
      authorized:true,
      source:'paperclip',
      approvalRef:'paperclip:approval:metric-recovery-no-effect',
    };
  };
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_reconcile_no_effect',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'invoking',
      retryCount:0,
      claimToken:'unconfirmed-external-call',
      invokingAt:metricTime.toISOString(),
      createdAt:NOW.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });
  const input = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey,
    conclusion:'no_external_effect',
    authorizationId:'paperclip:authorization:metric-recovery-no-effect',
    evidenceRef:'paperclip:work-product:metric-recovery-no-effect',
  };

  const recovered = await gateway.reconcileMetricInvocation(input);
  const replay = await gateway.reconcileMetricInvocation(input);

  assert.equal(recovered.replayed, false);
  assert.equal(recovered.recovery.state, 'failed');
  assert.equal(recovered.recovery.retryAllowed, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recovery.recoveryId, recovered.recovery.recoveryId);
  assert.equal(recoveryAuthorizationCalls, 2);
  assert.equal(douyin.metricCalls.length, 0);
  const state = await repository.read();
  assert.equal(state.attempts[attemptKey].state, 'failed');
  assert.equal(
    state.attempts[attemptKey].stopReason,
    'metric_invocation_confirmed_no_external_effect',
  );
  assert.equal(state.metricSnapshots.length, 0);
});

test('Paperclip 人工核对在最终账本变更或暂停前重新核验撤销状态', async () => {
  for (const conclusion of ['no_external_effect', 'external_effect_verified']) {
    let current = new Date(NOW.getTime() + 2 * 3_600_000);
    const paperclipControl = new FakePaperclipControl();
    let recoveryAuthorizationCalls = 0;
    paperclipControl.assertMetricRecoveryAllowed = async (input) => {
      recoveryAuthorizationCalls += 1;
      if (recoveryAuthorizationCalls === 1) {
        current = new Date(current.getTime() + 1_000);
        return {
          ...input,
          authorized:true,
          source:'paperclip',
          approvalRef:`paperclip:approval:metric-recovery-revoked-${conclusion}`,
        };
      }
      throw Object.assign(new Error('approval revoked'), {
        code:'paperclip_approval_revoked',
      });
    };
    const { gateway, repository } = setup({
      douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
      paperclipControl,
      clock:() => new Date(current),
    });
    const published = await gateway.publish(request({
      contentVersionId:`content-v1-${conclusion}`,
      contentChecksum:conclusion === 'no_external_effect' ? CHECKSUM_A : CHECKSUM_B,
    }));
    const collectionKey = `${published.receipt.receiptId}:2h`;
    const attemptKey = `metric:${collectionKey}`;
    await repository.update((state) => {
      state.attempts[attemptKey] = {
        attemptId:`attempt_metric_reconcile_revoked_${conclusion}`,
        kind:'metric_snapshot',
        idempotencyKey:attemptKey,
        collectionKey,
        receiptId:published.receipt.receiptId,
        campaignId:published.receipt.campaignId,
        platform:published.receipt.platform,
        state:'invoking',
        retryCount:0,
        claimToken:`unconfirmed-revoked-${conclusion}`,
        invokingAt:current.toISOString(),
        createdAt:NOW.toISOString(),
        updatedAt:current.toISOString(),
      };
    });

    await assert.rejects(
      gateway.reconcileMetricInvocation({
        campaignId:published.receipt.campaignId,
        receiptId:published.receipt.receiptId,
        collectionKey,
        conclusion,
        authorizationId:`paperclip:authorization:metric-recovery-revoked-${conclusion}`,
        evidenceRef:`paperclip:work-product:metric-recovery-revoked-${conclusion}`,
      }),
      { code:'metric_recovery_unauthorized' },
    );

    const state = await repository.read();
    assert.equal(recoveryAuthorizationCalls, 2);
    assert.equal(paperclipControl.pauseCalls.length, 0);
    assert.equal(state.attempts[attemptKey].state, 'invoking');
    assert.equal(state.attempts[attemptKey].metricRecovery, undefined);
  }
});

test('Paperclip 人工核对同请求并发只提交一次，且 invoking 缺失有效 claimToken 时在授权前拒绝', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl();
  let recoveryAuthorizationCalls = 0;
  paperclipControl.assertMetricRecoveryAllowed = async (input) => {
    recoveryAuthorizationCalls += 1;
    return {
      ...input,
      authorized:true,
      source:'paperclip',
      approvalRef:'paperclip:approval:metric-recovery-concurrent',
    };
  };
  const { gateway, repository } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  const recoveryInput = {
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey,
    conclusion:'no_external_effect',
    authorizationId:'paperclip:authorization:metric-recovery-concurrent',
    evidenceRef:'paperclip:work-product:metric-recovery-concurrent',
  };
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_reconcile_concurrent',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'invoking',
      retryCount:0,
      claimToken:'unconfirmed-concurrent',
      invokingAt:metricTime.toISOString(),
      createdAt:NOW.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });

  const concurrent = await Promise.all([
    gateway.reconcileMetricInvocation(recoveryInput),
    gateway.reconcileMetricInvocation(recoveryInput),
  ]);
  assert.deepEqual(
    concurrent.map((item) => item.replayed).sort(),
    [false, true],
  );
  assert.equal(recoveryAuthorizationCalls, 4);
  assert.equal(
    (await repository.read()).attempts[attemptKey].state,
    'failed',
  );

  for (const claimToken of [undefined, '']) {
    const invalidCheckpoint = claimToken === undefined ? '24h' : '72h';
    const invalidCollectionKey = `${published.receipt.receiptId}:${invalidCheckpoint}`;
    const invalidAttemptKey = `metric:${invalidCollectionKey}`;
    await repository.update((state) => {
      state.attempts[invalidAttemptKey] = {
        attemptId:`attempt_metric_reconcile_invalid_${invalidCheckpoint}`,
        kind:'metric_snapshot',
        idempotencyKey:invalidAttemptKey,
        collectionKey:invalidCollectionKey,
        receiptId:published.receipt.receiptId,
        campaignId:published.receipt.campaignId,
        platform:published.receipt.platform,
        state:'invoking',
        retryCount:0,
        ...(claimToken === undefined ? {} : { claimToken }),
        invokingAt:metricTime.toISOString(),
        createdAt:NOW.toISOString(),
        updatedAt:metricTime.toISOString(),
      };
    });
    await assert.rejects(
      gateway.reconcileMetricInvocation({
        ...recoveryInput,
        collectionKey:invalidCollectionKey,
        authorizationId:`paperclip:authorization:invalid-${invalidCheckpoint}`,
        evidenceRef:`paperclip:work-product:invalid-${invalidCheckpoint}`,
      }),
      { code:'metric_recovery_claim_invalid' },
    );
  }
  assert.equal(recoveryAuthorizationCalls, 4);
});

test('Paperclip 人工核对 authorizationId 全账本唯一，不能跨检查点或 attempt 重放', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl();
  let recoveryAuthorizationCalls = 0;
  paperclipControl.assertMetricRecoveryAllowed = async (input) => {
    recoveryAuthorizationCalls += 1;
    return {
      ...input,
      authorized:true,
      source:'paperclip',
      approvalRef:'paperclip:approval:metric-recovery-single-use',
    };
  };
  const { gateway, repository } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const authorizationId = 'paperclip:authorization:metric-recovery-single-use';
  for (const checkpoint of ['2h', '24h']) {
    const collectionKey = `${published.receipt.receiptId}:${checkpoint}`;
    await repository.update((state) => {
      state.attempts[`metric:${collectionKey}`] = {
        attemptId:`attempt_metric_reconcile_${checkpoint}`,
        kind:'metric_snapshot',
        idempotencyKey:`metric:${collectionKey}`,
        collectionKey,
        receiptId:published.receipt.receiptId,
        campaignId:published.receipt.campaignId,
        platform:published.receipt.platform,
        state:'invoking',
        retryCount:0,
        claimToken:`unconfirmed-${checkpoint}`,
        invokingAt:metricTime.toISOString(),
        createdAt:NOW.toISOString(),
        updatedAt:metricTime.toISOString(),
      };
    });
  }
  const firstCollectionKey = `${published.receipt.receiptId}:2h`;
  const secondCollectionKey = `${published.receipt.receiptId}:24h`;
  await gateway.reconcileMetricInvocation({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:firstCollectionKey,
    conclusion:'no_external_effect',
    authorizationId,
    evidenceRef:'paperclip:work-product:metric-recovery-first',
  });

  await assert.rejects(
    gateway.reconcileMetricInvocation({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey:secondCollectionKey,
      conclusion:'no_external_effect',
      authorizationId,
      evidenceRef:'paperclip:work-product:metric-recovery-second',
    }),
    { code:'metric_recovery_authorization_reused' },
  );
  const state = await repository.read();
  assert.equal(state.attempts[`metric:${firstCollectionKey}`].state, 'failed');
  assert.equal(state.attempts[`metric:${secondCollectionKey}`].state, 'invoking');
  assert.equal(recoveryAuthorizationCalls, 2);
});

test('Paperclip 人工核对 external_effect_verified 后持久 blocked，且无授权或错配授权均保持 invoking', async () => {
  for (const scenario of ['missing', 'mismatch', 'approved']) {
    const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
    const paperclipControl = new FakePaperclipControl();
    if (scenario !== 'missing') {
      paperclipControl.assertMetricRecoveryAllowed = async (input) => ({
        ...input,
        authorized:true,
        source:'paperclip',
        approvalRef:'paperclip:approval:metric-recovery-effect',
        ...(scenario === 'mismatch' ? { receiptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : {}),
      });
    }
    const { gateway, repository, douyin } = setup({
      douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
      paperclipControl,
      clock:() => new Date(metricTime),
    });
    const published = await gateway.publish(request());
    const collectionKey = `${published.receipt.receiptId}:2h`;
    const attemptKey = `metric:${collectionKey}`;
    await repository.update((state) => {
      state.attempts[attemptKey] = {
        attemptId:`attempt_metric_reconcile_${scenario}`,
        kind:'metric_snapshot',
        idempotencyKey:attemptKey,
        collectionKey,
        receiptId:published.receipt.receiptId,
        campaignId:published.receipt.campaignId,
        platform:published.receipt.platform,
        state:'invoking',
        retryCount:0,
        claimToken:`unconfirmed-${scenario}`,
        invokingAt:metricTime.toISOString(),
        createdAt:NOW.toISOString(),
        updatedAt:metricTime.toISOString(),
      };
    });
    const input = {
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      conclusion:'external_effect_verified',
      authorizationId:`paperclip:authorization:metric-recovery-${scenario}`,
      evidenceRef:`paperclip:work-product:metric-recovery-${scenario}`,
    };

    if (scenario === 'missing') {
      await assert.rejects(
        gateway.reconcileMetricInvocation(input),
        { code:'paperclip_metric_recovery_control_required' },
      );
    } else if (scenario === 'mismatch') {
      await assert.rejects(
        gateway.reconcileMetricInvocation(input),
        { code:'metric_recovery_authorization_scope_mismatch' },
      );
    } else {
      const result = await gateway.reconcileMetricInvocation(input);
      assert.equal(result.recovery.state, 'blocked');
      assert.equal(result.recovery.retryAllowed, false);
      assert.equal(paperclipControl.pauseCalls.length, 1);
      assert.equal(
        paperclipControl.pauseCalls[0].reason,
        'metric_invocation_external_effect_verified',
      );
      await assert.rejects(
        gateway.collectMetricSnapshot({
          campaignId:published.receipt.campaignId,
          receiptId:published.receipt.receiptId,
          collectionKey,
          collectedAt:metricTime.toISOString(),
        }),
        { code:'metric_collection_hard_stopped' },
      );
    }
    const state = await repository.read();
    assert.equal(
      state.attempts[attemptKey].state,
      scenario === 'approved' ? 'blocked' : 'invoking',
    );
    assert.equal(douyin.metricCalls.length, 0);
    assert.equal(state.metricSnapshots.length, 0);
  }
});

test('external_effect_verified 暂停失败时保持 invoking、激活全局门闩且重启后禁止外呼', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const paperclipControl = new FakePaperclipControl({
    pauseFailure:Object.assign(new Error('paperclip unavailable'), {
      code:'paperclip_unavailable',
    }),
  });
  paperclipControl.assertMetricRecoveryAllowed = async (input) => ({
    ...input,
    authorized:true,
    source:'paperclip',
    approvalRef:'paperclip:approval:metric-recovery-pause-failure',
  });
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_reconcile_pause_failure',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'invoking',
      retryCount:0,
      claimToken:'unconfirmed-pause-failure',
      invokingAt:metricTime.toISOString(),
      createdAt:NOW.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });

  await assert.rejects(
    gateway.reconcileMetricInvocation({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      conclusion:'external_effect_verified',
      authorizationId:'paperclip:authorization:metric-recovery-pause-failure',
      evidenceRef:'paperclip:work-product:metric-recovery-pause-failure',
    }),
    { code:'paperclip_pause_failed_hard_stop' },
  );
  const state = await repository.read();
  assert.equal(state.attempts[attemptKey].state, 'invoking');
  assert.equal(state.attempts[attemptKey].metricRecovery, undefined);
  assert.equal(state.safetyLatch.active, true);
  assert.equal(paperclipControl.pauseCalls.length, 1);
  await assert.rejects(
    gateway.collectMetricSnapshot({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      collectedAt:metricTime.toISOString(),
    }),
    { code:'publisher_global_hard_stop' },
  );
  const restarted = new PublisherGateway({
    repository,
    connectors:{ douyin },
    metricConnectors:{ douyin },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(metricTime),
  });
  await assert.rejects(
    restarted.collectMetricSnapshot({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      collectedAt:metricTime.toISOString(),
    }),
    { code:'publisher_global_hard_stop' },
  );
  assert.equal(douyin.metricCalls.length, 0);
});

test('external_effect_verified 暂停后核对账本提交失败时持久全局门闩', async () => {
  const metricTime = new Date(NOW.getTime() + 2 * 3_600_000);
  const repository = new FailMetricRecoveryCommitRepository();
  const paperclipControl = new FakePaperclipControl();
  paperclipControl.assertMetricRecoveryAllowed = async (input) => ({
    ...input,
    authorized:true,
    source:'paperclip',
    approvalRef:'paperclip:approval:metric-recovery-write-failure',
  });
  const douyin = new FakePlatformConnector('douyin', [
    { type:'success', publishedAt:NOW.toISOString() },
  ]);
  const gateway = new PublisherGateway({
    repository,
    connectors:{ douyin },
    artifactVerifier:{ verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }) },
    paperclipControl,
    clock:() => new Date(metricTime),
  });
  const published = await gateway.publish(request());
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const attemptKey = `metric:${collectionKey}`;
  await repository.update((state) => {
    state.attempts[attemptKey] = {
      attemptId:'attempt_metric_reconcile_write_failure',
      kind:'metric_snapshot',
      idempotencyKey:attemptKey,
      collectionKey,
      receiptId:published.receipt.receiptId,
      campaignId:published.receipt.campaignId,
      platform:published.receipt.platform,
      state:'invoking',
      retryCount:0,
      claimToken:'unconfirmed-write-failure',
      invokingAt:metricTime.toISOString(),
      createdAt:NOW.toISOString(),
      updatedAt:metricTime.toISOString(),
    };
  });

  await assert.rejects(
    gateway.reconcileMetricInvocation({
      campaignId:published.receipt.campaignId,
      receiptId:published.receipt.receiptId,
      collectionKey,
      conclusion:'external_effect_verified',
      authorizationId:'paperclip:authorization:metric-recovery-write-failure',
      evidenceRef:'paperclip:work-product:metric-recovery-write-failure',
    }),
    { code:'metric_recovery_writeback_failed_hard_stop' },
  );
  const state = await repository.read();
  assert.equal(state.attempts[attemptKey].state, 'invoking');
  assert.equal(state.attempts[attemptKey].metricRecovery, undefined);
  assert.deepEqual(state.safetyLatch, {
    active:true,
    campaignId:published.receipt.campaignId,
    reason:'metric_recovery_writeback_failed',
    controlError:'publisher_ledger_write_failed',
    activatedAt:metricTime.toISOString(),
  });
  assert.equal(paperclipControl.pauseCalls.length, 1);
});

test('指标入口拒绝任意 key、提前采集和跨回执重放', async () => {
  let current = new Date(NOW);
  const { gateway, repository, douyin } = setup({
    douyinScenarios:[{ type:'success', publishedAt:NOW.toISOString() }],
    clock:() => new Date(current),
  });
  const published = await gateway.publish(request());
  const validKey = `${published.receipt.receiptId}:2h`;

  await assert.rejects(gateway.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:'arbitrary-not-a-checkpoint',
    collectedAt:NOW.toISOString(),
  }), { code:'invalid_metric_collection_request' });
  await assert.rejects(gateway.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:validKey,
    collectedAt:new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
  }), { code:'metric_checkpoint_not_due' });
  assert.equal(douyin.metricCalls.length, 0);
  assert.equal((await repository.read()).metricSnapshots.length, 0);

  current = new Date(NOW.getTime() + 2 * 3_600_000);
  const recorded = await gateway.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:validKey,
    collectedAt:'2099-01-01T00:00:00.000Z',
  });
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.snapshot.collectedAt, current.toISOString());
  const otherReceiptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await assert.rejects(gateway.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:otherReceiptId,
    collectionKey:validKey,
    collectedAt:current.toISOString(),
  }), { code:'invalid_metric_collection_request' });
  assert.equal(douyin.metricCalls.length, 1);
  assert.equal((await repository.read()).metricSnapshots.length, 1);
});

test('真实连接器和真实网关默认不可启用', async () => {
  await assert.rejects(new DisabledRealConnector('douyin').publish(), { code:'real_connector_disabled' });
  assert.throws(() => new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{},
    mode:'real'
  }), { code:'real_gateway_disabled' });
  assert.throws(() => new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{ douyin:new FakePlatformConnector('douyin') },
    metricConnectors:{
      douyin:{
        connectorMode:'real:douyin_official_api',
        readOwnMetrics:async () => ({}),
      },
    },
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
    paperclipControl:new FakePaperclipControl(),
    mode:'fake',
  }), { code:'publisher_connector_mode_mismatch' });
});

test('fake 网关也必须注入 Paperclip 控制适配器', () => {
  assert.throws(() => new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{},
    artifactVerifier:{ verify:async () => ({ checksum:CHECKSUM_A }) },
  }), { code:'paperclip_control_required' });
});

test('暂停回写失败时持久化全局硬停，后续请求不接触平台', async () => {
  const paperclipControl = new FakePaperclipControl({
    pauseFailure:Object.assign(new Error('paperclip unavailable'), { code:'paperclip_unavailable' }),
  });
  const { gateway, repository, douyin } = setup({
    paperclipControl,
    douyinScenarios:[
      { type:'stop', reason:'risk_control' },
      { type:'success', publishedAt:NOW.toISOString() },
    ],
  });
  await assert.rejects(gateway.publish(request()), { code:'paperclip_pause_failed_hard_stop' });
  assert.equal((await repository.read()).safetyLatch.active, true);
  const second = request({
    contentVersionId:'content-v2',
    contentChecksum:CHECKSUM_B,
    scheduledDate:'2026-07-31',
  });
  second.idempotencyKey = publishIdempotencyKey(second);
  await assert.rejects(gateway.publish(second), { code:'publisher_global_hard_stop' });
  assert.equal(douyin.publishCalls.length, 1);
});

test('暂停回执未证明 Cron 已关闭时同样全局硬停', async () => {
  const { gateway, repository } = setup({
    paperclipControl:new FakePaperclipControl({ invalidPauseReceipt:true }),
    douyinScenarios:[{ type:'stop', reason:'platform_violation' }],
  });
  await assert.rejects(gateway.publish(request()), { code:'paperclip_pause_failed_hard_stop' });
  assert.equal((await repository.read()).safetyLatch.controlError, 'invalid_paperclip_pause_receipt');
});

test('账本不保存活动状态或指标定时任务的第二份真相', async () => {
  const repository = new MemoryPublisherRepository({
    campaigns:{ stale:{ status:'paused' } },
    metricSchedules:[{ receiptId:'stale' }],
    failures:{ stale:2 },
  });
  const state = await repository.read();
  assert.deepEqual(Object.keys(state).sort(), [
    'attempts',
    'costRecords',
    'metricSnapshots',
    'receipts',
    'safetyLatch',
    'schemaVersion',
  ]);
});

test('越权动作、未审核或伪造幂等键在接触平台前被拒绝', async () => {
  const { gateway, douyin } = setup();
  const invalid = request({
    grant:grant({ allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics', 'comment'] }),
    reviewReport:{ status:'passed', checks:{ facts:true } },
    idempotencyKey:'forged'
  });
  invalid.idempotencyKey = 'forged';
  await assert.rejects(gateway.publish(invalid), { code:'publish_preflight_failed' });
  assert.equal(douyin.publishCalls.length, 0);
});

test('工作区验证器读取实际文件哈希并拒绝路径逃逸或审核后替换', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-media-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const bytes = Buffer.from('reviewed-video');
  await fs.writeFile(path.join(root, 'douyin.mp4'), bytes);
  const checksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const verifier = new WorkspaceArtifactVerifier(root);
  assert.equal((await verifier.verify('douyin.mp4', checksum)).checksum, checksum);
  await assert.rejects(verifier.verify('douyin.mp4', CHECKSUM_A), { code:'media_checksum_mismatch' });
  await assert.rejects(verifier.verify('../outside.mp4', checksum), { code:'invalid_media_path' });
});

test('连接器只能读取审核哈希绑定的私有快照，源文件随后替换也不会改变上传字节', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-lease-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const source = path.join(root, 'douyin.mp4');
  const reviewed = Buffer.from('reviewed-video-bytes');
  await fs.writeFile(source, reviewed);
  const checksum = `sha256:${crypto.createHash('sha256').update(reviewed).digest('hex')}`;
  let uploaded = null;
  let connectorRequest = null;
  const connector = {
    async publish(input) {
      connectorRequest = input;
      await fs.writeFile(source, 'replaced-after-review');
      const chunks = [];
      for await (const chunk of input.mediaLease.createReadStream()) chunks.push(chunk);
      uploaded = Buffer.concat(chunks);
      return {
        state:'published',
        externalContentId:'fake-douyin-immutable-lease',
        evidence:'fake://douyin/content/immutable-lease',
        accountRef:input.accountRef,
        publishedAt:NOW.toISOString(),
      };
    },
  };
  const gateway = new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{ douyin:connector },
    artifactVerifier:new WorkspaceArtifactVerifier(root),
    paperclipControl:new FakePaperclipControl(),
    clock:() => new Date(NOW),
  });
  const input = request({ contentChecksum:checksum });
  input.idempotencyKey = publishIdempotencyKey(input);

  await gateway.publish(input);

  assert.deepEqual(uploaded, reviewed);
  assert.equal(Object.hasOwn(connectorRequest, 'mediaPath'), false);
  assert.deepEqual(connectorRequest.verifiedMedia, {
    relativePath:'douyin.mp4',
    checksum,
    bytes:reviewed.length,
    immutableLease:true,
  });
  assert.deepEqual(await fs.readdir(path.join(root, '.publisher-leases')), []);
});

test('文件账本用跨进程锁拒绝并发事务而不是丢更新', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-ledger-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'ledger.json');
  const first = new FilePublisherRepository(file);
  const second = new FilePublisherRepository(file);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const firstUpdate = first.update(async (draft) => {
    entered();
    await held;
    draft.receipts.first = { receiptId:'first' };
  });
  await enteredPromise;
  await assert.rejects(second.update((draft) => {
    draft.receipts.second = { receiptId:'second' };
  }), /其他进程占用|未恢复锁/);
  release();
  await firstUpdate;
  assert.equal((await first.read()).receipts.first.receiptId, 'first');
});
