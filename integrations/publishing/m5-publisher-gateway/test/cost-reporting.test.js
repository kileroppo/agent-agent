import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FakePlatformConnector,
  MemoryPublisherRepository,
  PublisherCostRecorder,
  PublisherGateway,
  parseOfficialTransportCost,
  publishIdempotencyKey,
} from '../src/index.ts';
import {
  actualCost,
  deterministicCostReporter,
} from '../test-support/cost-reporter.js';

const NOW = new Date('2026-07-30T04:00:00.000Z');
const CHECKSUM = `sha256:${'a'.repeat(64)}`;

test('确定性费用记录以provider请求幂等，重放和重启都不重复上报', async () => {
  const repository = new MemoryPublisherRepository();
  const reporter = deterministicCostReporter();
  const input = {
    campaignId:'campaign-cost-1',
    idempotencyKey:'campaign-cost-1:douyin:content-v1:2026-07-30',
    connectorMode:'real:douyin_official_api',
    operation:'upload_video',
    providerRequestId:'douyin-request-upload-1',
    amountUsd:0.012345,
    occurredAt:NOW,
  };
  const first = new PublisherCostRecorder({
    repository,
    costReporter:reporter,
    clock:() => new Date(NOW),
  });
  const created = await first.recordOfficialTransportAttempt(input);
  const restarted = new PublisherCostRecorder({
    repository,
    costReporter:reporter,
    clock:() => new Date(NOW),
  });
  const replayed = await restarted.recordOfficialTransportAttempt(input);

  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(reporter.reportCalls.length, 1);
  assert.equal(reporter.reportCalls[0].connectorMode, 'real:douyin_official_api');
  assert.equal(reporter.reportCalls[0].operation, 'upload_video');
  assert.equal(reporter.reportCalls[0].providerRequestId, 'douyin-request-upload-1');
  assert.equal(reporter.reportCalls[0].receiptRef, null);
  assert.equal(reporter.reportCalls[0].amountUsd, 0.012345);
  assert.equal(reporter.reportCalls[0].occurredAt, NOW.toISOString());
});

test('费用上报回执未决时持久化submitting并禁止重放计费', async () => {
  const repository = new MemoryPublisherRepository();
  const reporter = deterministicCostReporter({ reportError:new Error('lost') });
  const recorder = new PublisherCostRecorder({
    repository,
    costReporter:reporter,
    clock:() => new Date(NOW),
  });
  const input = {
    campaignId:'campaign-cost-2',
    idempotencyKey:'campaign-cost-2:xiaohongshu:content-v1:2026-07-30',
    connectorMode:'real:xiaohongshu_cua',
    operation:'publish',
    receiptRef:'campaign-cost-2:xiaohongshu:content-v1:2026-07-30',
    occurredAt:NOW,
  };

  await assert.rejects(
    recorder.recordLocalZeroAttempt(input),
    { code:'publisher_cost_reporting_ambiguous' },
  );
  await assert.rejects(
    recorder.recordLocalZeroAttempt(input),
    { code:'publisher_cost_reporting_ambiguous' },
  );
  assert.equal(reporter.reportCalls.length, 1);
  const state = await repository.read();
  assert.equal(Object.values(state.costRecords)[0].state, 'submitting');
  assert.equal(Object.values(state.costRecords)[0].amountUsd, 0);
});

test('官方API只接受传输层结构化实际费用，Fake和CUA金额不可伪造', async () => {
  assert.throws(
    () => parseOfficialTransportCost(null, { operation:'upload_video' }),
    { code:'publisher_transport_cost_unverified' },
  );
  assert.throws(
    () => parseOfficialTransportCost({
      ...actualCost('upload_video'),
      accessToken:'forbidden',
    }, { operation:'upload_video' }),
    { code:'publisher_transport_cost_unverified' },
  );
  const parsed = parseOfficialTransportCost(
    actualCost('upload_video', 0.02),
    { operation:'upload_video' },
  );
  assert.equal(parsed.amountUsd, 0.02);
  assert.equal(parsed.providerRequestId, 'douyin-request-upload_video');

  const repository = new MemoryPublisherRepository();
  const recorder = new PublisherCostRecorder({
    repository,
    costReporter:deterministicCostReporter(),
  });
  await assert.rejects(recorder.recordLocalZeroAttempt({
    campaignId:'campaign-cost-3',
    idempotencyKey:'campaign-cost-3:douyin:content-v1:2026-07-30',
    connectorMode:'real:douyin_official_api',
    operation:'publish',
    receiptRef:'receipt-1',
    amountUsd:999,
    occurredAt:NOW,
  }), { code:'publisher_cost_source_invalid' });
});

test('活动预算不足时先暂停Campaign并关闭Cron，connector一次也不调用', async () => {
  const repository = new MemoryPublisherRepository();
  const connector = new FakePlatformConnector('douyin');
  const reporter = deterministicCostReporter({
    allowed:false,
    remainingAmountUsd:0,
  });
  const pauseCalls = [];
  const gateway = new PublisherGateway({
    repository,
    connectors:{ douyin:connector },
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl:{
      assertPublishAllowed:async ({ campaignId }) => ({
        campaignId,
        grantStatus:'active',
        currentStage:'campaign_active',
        canonicalGrant:grant(),
      }),
      pauseCampaignAndDisableCron:async (input) => {
        pauseCalls.push(structuredClone(input));
        return {
          campaignId:input.campaignId,
          grantStatus:'paused',
          cronStatus:'disabled',
          controlEventId:'paperclip:pause:budget',
        };
      },
    },
    costReporter:reporter,
    mode:'fake',
    clock:() => new Date(NOW),
  });

  await assert.rejects(
    gateway.publish(request()),
    { code:'publisher_budget_exceeded' },
  );
  assert.equal(reporter.budgetCalls.length, 1);
  assert.equal(connector.publishCalls.length, 0);
  assert.equal(reporter.reportCalls.length, 0);
  assert.equal(pauseCalls.length, 1);
  assert.equal(pauseCalls[0].reason, 'budget_exceeded');
  const attempt = await gateway.getAttempt(publishIdempotencyKey(request()));
  assert.equal(attempt.state, 'blocked');
  assert.equal(attempt.stopReason, 'budget_exceeded');
  assert.equal(attempt.pauseControl.grantStatus, 'paused');
  assert.equal(attempt.pauseControl.cronStatus, 'disabled');
});

test('调用方伪造费用字段在预算检查和connector之前拒绝', async () => {
  const connector = new FakePlatformConnector('douyin');
  const reporter = deterministicCostReporter();
  const gateway = new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{ douyin:connector },
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl:{
      assertPublishAllowed:async ({ campaignId }) => ({
        campaignId,
        grantStatus:'active',
        currentStage:'campaign_active',
        canonicalGrant:grant(),
      }),
      pauseCampaignAndDisableCron:async () => {
        throw new Error('不应暂停');
      },
    },
    costReporter:reporter,
    mode:'fake',
    clock:() => new Date(NOW),
  });
  await assert.rejects(
    gateway.publish(request({ amountUsd:999, providerRequestId:'forged' })),
    { code:'publish_preflight_failed' },
  );
  assert.equal(reporter.budgetCalls.length, 0);
  assert.equal(connector.publishCalls.length, 0);
});

test('预算补足并显式恢复活动后从预算门禁继续，不把未外发记录当成歧义发布', async () => {
  const connector = new FakePlatformConnector('douyin');
  const baseReporter = deterministicCostReporter();
  let allowed = false;
  baseReporter.assertCampaignBudget = async (input) => {
    baseReporter.budgetCalls.push(structuredClone(input));
    return {
      campaignId:input.campaignId,
      allowed,
      hardStopEnabled:true,
      remainingAmountUsd:allowed ? 1 : 0,
    };
  };
  const gateway = new PublisherGateway({
    repository:new MemoryPublisherRepository(),
    connectors:{ douyin:connector },
    artifactVerifier:{
      verify:async (relativePath, checksum) => ({ relativePath, checksum, bytes:1 }),
    },
    paperclipControl:{
      assertPublishAllowed:async ({ campaignId }) => ({
        campaignId,
        grantStatus:'active',
        currentStage:'campaign_active',
        canonicalGrant:grant(),
      }),
      pauseCampaignAndDisableCron:async (input) => ({
        campaignId:input.campaignId,
        grantStatus:'paused',
        cronStatus:'disabled',
        controlEventId:'paperclip:pause:budget-recovery',
      }),
    },
    costReporter:baseReporter,
    mode:'fake',
    clock:() => new Date(NOW),
  });

  await assert.rejects(gateway.publish(request()), { code:'publisher_budget_exceeded' });
  assert.equal(connector.publishCalls.length, 0);
  allowed = true;
  const recovered = await gateway.publish(request());
  assert.equal(recovered.replayed, false);
  assert.equal(connector.publishCalls.length, 1);
  assert.equal(baseReporter.reportCalls.length, 1);
});

function grant() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:douyin:test',
      xiaohongshu:'account:xhs:test',
    },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:[
      'upload',
      'fill_metadata',
      'schedule_or_publish',
      'read_own_metrics',
    ],
    prohibitedActions:[
      'direct_message',
      'comment',
      'follow',
      'paid_promotion',
      'payment',
      'account_settings',
      'delete_history',
    ],
    budgetCents:625,
  };
}

function request(overrides = {}) {
  const value = {
    campaignId:'campaign-cost-budget',
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:CHECKSUM,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'AI Agent 实战',
    body:'预算门禁测试',
    reviewReport:{
      status:'passed',
      checks:{
        facts:true,
        privacy:true,
        rights:true,
        media:true,
        claims:true,
        grantScope:true,
        duplicate:true,
      },
    },
    ...overrides,
  };
  value.idempotencyKey = publishIdempotencyKey(value);
  return value;
}
