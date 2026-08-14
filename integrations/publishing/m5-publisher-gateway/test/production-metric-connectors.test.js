import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CUA_PROFILE_LEASE_SCHEMA,
  CUA_PUBLISH_ACTIONS,
  CUA_RUNNER_SCHEMA,
  CUA_SELECTOR_BUNDLE_SCHEMA,
  PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
  XHS_OWN_METRICS_CUA_ACTIONS,
  XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
  createProductionPublisherComposition,
  publishIdempotencyKey,
  selectorBundleChecksum,
} from '../src/index.ts';
import { deterministicCostReporter } from '../test-support/cost-reporter.js';

const PUBLISHED_AT = '2026-07-30T04:00:00.000Z';
const METRIC_COLLECTED_AT = '2026-07-30T06:00:00.000Z';
const ACCOUNT_REF = 'account:xhs:production-test';
const CONTENT_ID = 'xhs-content-production-test';
const IDENTITY_HASH = `sha256:${'d'.repeat(64)}`;

test('production composition 端到端隔离同平台发布批准与本人指标批准', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-xhs-metric-composition-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('controlled-xhs-production-composition-video');
  await fs.writeFile(path.join(root, 'xiaohongshu.mp4'), media);
  const checksum =
    `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const publishRunner = xhsPublishRunner();
  const metricTrust = xhsMetricTrust();
  const metricRunner = xhsMetricRunner(metricTrust.selectorBundle);
  let current = new Date(PUBLISHED_AT);
  const composition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot([
      connectorApproval({
        capability:'publish',
        connectorKind:'cua',
        suffix:'publish',
      }),
      connectorApproval({
        capability:'read_own_metrics',
        connectorKind:'xhs_own_metrics_cua',
        suffix:'metrics',
      }),
    ]),
    connectorDependencies:{
      cuaRunners:{ xiaohongshu:publishRunner },
      xhsOwnMetricsCua:{
        runner:metricRunner,
        selectorBundle:metricTrust.selectorBundle,
        profileLease:metricTrust.profileLease,
      },
    },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(current),
  });
  const runtime = composition.createRuntime();
  const request = publishRequest(checksum);

  const published = await runtime.publish(request);
  const publishActionsAfterPublish = [...publishRunner.actions];
  current = new Date(METRIC_COLLECTED_AT);
  const collectionKey = `${published.receipt.receiptId}:2h`;
  const collected = await runtime.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey,
    collectedAt:METRIC_COLLECTED_AT,
  });

  assert.equal(published.receipt.externalContentId, CONTENT_ID);
  assert.equal(
    published.receipt.connectorMode,
    'real:xiaohongshu_cua',
  );
  assert.deepEqual(publishActionsAfterPublish, [...CUA_PUBLISH_ACTIONS]);
  assert.deepEqual(
    publishRunner.actions,
    publishActionsAfterPublish,
    '读取指标不得再次调用发布 runner',
  );
  assert.equal(publishRunner.beginCalls.length, 1);
  assert.equal(publishRunner.endCalls.length, 1);

  assert.deepEqual(metricRunner.actions, [
    'navigate',
    'read',
    'filter',
    'open_detail',
    'read_metrics',
  ]);
  assert.deepEqual(metricRunner.actions, [...XHS_OWN_METRICS_CUA_ACTIONS]);
  assert.equal(metricRunner.beginCalls.length, 1);
  assert.equal(metricRunner.endCalls.length, 1);
  assert.deepEqual(metricRunner.beginCalls[0].profile, {
    mode:'isolated_named',
    name:'xhs-metrics-production-test',
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
  });
  assert.equal(metricRunner.beginCalls[0].accountRef, ACCOUNT_REF);
  assert.equal(
    metricRunner.beginCalls[0].externalContentId,
    CONTENT_ID,
  );
  assert.equal(
    metricRunner.beginCalls[0].selectorBundle.approvalRef,
    'paperclip:xhs-metrics-selector-production-test',
  );
  assert.equal(metricRunner.beginCalls[0].readOnly, true);

  assert.equal(collected.replayed, false);
  assert.deepEqual(collected.snapshot.metrics, {
    views:1200,
    likes:88,
    saves:31,
    comments:7,
  });
  assert.equal(collected.snapshot.accountRef, ACCOUNT_REF);
  assert.equal(collected.snapshot.externalContentId, CONTENT_ID);
  assert.equal(
    collected.snapshot.source.approvalRef,
    'paperclip:xhs-metrics-selector-production-test',
  );
});

test('发布批准不能替代同平台 read_own_metrics 的独立批准和依赖', () => {
  const publishRunner = xhsPublishRunner();
  const base = {
    enabled:true,
    workspaceRoot:'/tmp/m5-xhs-metric-approval-test',
    ledgerPath:'/tmp/m5-xhs-metric-approval-test-ledger.json',
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(PUBLISHED_AT),
  };
  assert.throws(
    () => createProductionPublisherComposition({
      ...base,
      approvalSnapshot:approvalSnapshot([
        connectorApproval({
          capability:'publish',
          connectorKind:'cua',
          suffix:'publish',
        }),
        connectorApproval({
          capability:'read_own_metrics',
          connectorKind:'xhs_own_metrics_cua',
          suffix:'metrics',
        }),
      ]),
      connectorDependencies:{
        cuaRunners:{ xiaohongshu:publishRunner },
      },
    }),
    { code:'publisher_metric_connector_dependency_missing' },
  );

  const composition = createProductionPublisherComposition({
    ...base,
    approvalSnapshot:approvalSnapshot([
      connectorApproval({
        capability:'publish',
        connectorKind:'cua',
        suffix:'publish-only',
      }),
    ]),
    connectorDependencies:{
      cuaRunners:{ xiaohongshu:publishRunner },
    },
  });
  const runtime = composition.createRuntime();
  assert.ok(runtime.connectors.xiaohongshu);
  assert.equal(runtime.metricConnectors.xiaohongshu, undefined);
  assert.equal(publishRunner.beginCalls.length, 0);
});

test('Runtime 长驻后 read_own_metrics 批准到期会在指标 runner 前硬停', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-xhs-metric-expiry-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const publishRunner = xhsPublishRunner();
  const trust = xhsMetricTrust();
  const metricRunner = xhsMetricRunner(trust.selectorBundle);
  let current = new Date(PUBLISHED_AT);
  const composition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot([
      connectorApproval({
        capability:'publish',
        connectorKind:'cua',
        suffix:'publish-expiry',
      }),
      connectorApproval({
        capability:'read_own_metrics',
        connectorKind:'xhs_own_metrics_cua',
        suffix:'metrics-expiry',
        expiresAt:'2026-07-30T05:00:00.000Z',
      }),
    ]),
    connectorDependencies:{
      cuaRunners:{ xiaohongshu:publishRunner },
      xhsOwnMetricsCua:{
        runner:metricRunner,
        selectorBundle:trust.selectorBundle,
        profileLease:trust.profileLease,
      },
    },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(current),
  });
  const runtime = composition.createRuntime();
  const receiptId = '22222222-2222-4222-8222-222222222222';
  await runtime.repository.update((state) => {
    state.receipts.seed = {
      receiptId,
      idempotencyKey:'seed',
      campaignId:'campaign-xhs-production-metrics-test',
      platform:'xiaohongshu',
      contentVersionId:'content-xhs-production-metrics-v1',
      contentChecksum:`sha256:${'a'.repeat(64)}`,
      scheduledDate:'2026-07-30',
      externalContentId:CONTENT_ID,
      evidence:`https://pro.xiaohongshu.com/content/${CONTENT_ID}`,
      accountRef:ACCOUNT_REF,
      publishedAt:PUBLISHED_AT,
      connectorMode:'real:xiaohongshu_cua',
    };
  });
  current = new Date(METRIC_COLLECTED_AT);

  await assert.rejects(
    runtime.collectMetricSnapshot({
      campaignId:'campaign-xhs-production-metrics-test',
      receiptId,
      collectionKey:`${receiptId}:2h`,
      collectedAt:METRIC_COLLECTED_AT,
    }),
    { code:'real_metric_connector_approval_invalid' },
  );
  assert.equal(metricRunner.beginCalls.length, 0);
});

test('指标批准在预算检查期间到期时由第二道门禁阻断且 attempt 保持 blocked', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-xhs-metric-toctou-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const publishRunner = xhsPublishRunner();
  const trust = xhsMetricTrust();
  const metricRunner = xhsMetricRunner(trust.selectorBundle);
  const expiresAt = '2026-07-30T06:00:00.001Z';
  let current = new Date(METRIC_COLLECTED_AT);
  const costReporter = deterministicCostReporter();
  const assertBudget = costReporter.assertCampaignBudget.bind(costReporter);
  costReporter.assertCampaignBudget = async (input) => {
    const result = await assertBudget(input);
    current = new Date(expiresAt);
    return result;
  };
  const composition = createProductionPublisherComposition({
    enabled:true,
    approvalSnapshot:approvalSnapshot([
      connectorApproval({
        capability:'publish',
        connectorKind:'cua',
        suffix:'publish-toctou',
      }),
      connectorApproval({
        capability:'read_own_metrics',
        connectorKind:'xhs_own_metrics_cua',
        suffix:'metrics-toctou',
        expiresAt,
      }),
    ]),
    connectorDependencies:{
      cuaRunners:{ xiaohongshu:publishRunner },
      xhsOwnMetricsCua:{
        runner:metricRunner,
        selectorBundle:trust.selectorBundle,
        profileLease:trust.profileLease,
      },
    },
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter,
    clock:() => new Date(current),
  });
  const runtime = composition.createRuntime();
  const receiptId = '33333333-3333-4333-8333-333333333333';
  const collectionKey = `${receiptId}:2h`;
  await runtime.repository.update((state) => {
    state.receipts.seed = {
      receiptId,
      idempotencyKey:'seed-toctou',
      campaignId:'campaign-xhs-production-metrics-test',
      platform:'xiaohongshu',
      contentVersionId:'content-xhs-production-metrics-v1',
      contentChecksum:`sha256:${'a'.repeat(64)}`,
      scheduledDate:'2026-07-30',
      externalContentId:CONTENT_ID,
      evidence:`https://pro.xiaohongshu.com/content/${CONTENT_ID}`,
      accountRef:ACCOUNT_REF,
      publishedAt:PUBLISHED_AT,
      connectorMode:'real:xiaohongshu_cua',
    };
  });

  await assert.rejects(
    runtime.collectMetricSnapshot({
      campaignId:'campaign-xhs-production-metrics-test',
      receiptId,
      collectionKey,
      collectedAt:METRIC_COLLECTED_AT,
    }),
    { code:'real_metric_connector_approval_invalid' },
  );

  const state = await runtime.repository.read();
  const attempt = state.attempts[`metric:${collectionKey}`];
  assert.equal(costReporter.budgetCalls.length, 1);
  assert.equal(metricRunner.beginCalls.length, 0);
  assert.equal(attempt.state, 'blocked');
  assert.equal(attempt.stopReason, 'real_metric_connector_approval_invalid');
});

test('小红书发布和指标不能复用同一命名 Profile', () => {
  const publishRunner = xhsPublishRunner();
  publishRunner.contract.profileName = 'xhs-metrics-production-test';
  const trust = xhsMetricTrust();
  assert.throws(
    () => createProductionPublisherComposition({
      enabled:true,
      approvalSnapshot:approvalSnapshot([
        connectorApproval({
          capability:'publish',
          connectorKind:'cua',
          suffix:'publish-profile-isolation',
        }),
        connectorApproval({
          capability:'read_own_metrics',
          connectorKind:'xhs_own_metrics_cua',
          suffix:'metrics-profile-isolation',
        }),
      ]),
      connectorDependencies:{
        cuaRunners:{ xiaohongshu:publishRunner },
        xhsOwnMetricsCua:{
          runner:xhsMetricRunner(trust.selectorBundle),
          selectorBundle:trust.selectorBundle,
          profileLease:trust.profileLease,
        },
      },
      workspaceRoot:'/tmp/m5-xhs-profile-isolation',
      ledgerPath:'/tmp/m5-xhs-profile-isolation-ledger.json',
      paperclipControl:paperclipControl(),
      costReporter:deterministicCostReporter(),
      clock:() => new Date(PUBLISHED_AT),
    }),
    { code:'publisher_cua_capability_isolation_required' },
  );
});

function approvalSnapshot(approvals) {
  return {
    schemaVersion:PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA,
    source:'paperclip',
    snapshotId:'paperclip:xhs-publish-and-metrics-approvals',
    capturedAt:'2026-07-30T03:59:00.000Z',
    approvals,
  };
}

function connectorApproval({
  capability,
  connectorKind,
  suffix,
  expiresAt = '2026-08-06T00:00:00.000Z',
}) {
  return {
    source:'paperclip',
    status:'approved',
    approvalRef:`paperclip:xhs-connector-${suffix}`,
    platform:'xiaohongshu',
    capability,
    connectorKind,
    expiresAt,
  };
}

function paperclipControl() {
  return {
    assertPublishAllowed:async ({ campaignId }) => ({
      campaignId,
      grantStatus:'active',
      currentStage:'campaign_active',
      canonicalGrant:campaignGrant(),
    }),
    pauseCampaignAndDisableCron:async ({ campaignId }) => ({
      campaignId,
      grantStatus:'paused',
      cronStatus:'disabled',
      controlEventId:'paperclip:test-pause-control',
    }),
  };
}

function campaignGrant() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:douyin:production-test',
      xiaohongshu:ACCOUNT_REF,
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

function publishRequest(checksum) {
  const request = {
    campaignId:'campaign-xhs-production-metrics-test',
    grant:campaignGrant(),
    platform:'xiaohongshu',
    contentVersionId:'content-xhs-production-metrics-v1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'xiaohongshu.mp4',
    title:'小红书发布和本人指标独立审批',
    body:'所有 runner 均为本地测试注入，不访问真实平台。',
    tags:['AI Agent'],
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
  };
  request.idempotencyKey = publishIdempotencyKey(request);
  return request;
}

function xhsPublishRunner() {
  return {
    contract:{
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode:'isolated_named',
      profileName:'xhs-publisher-production-test',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      allowedActions:[...CUA_PUBLISH_ACTIONS],
      arbitraryDesktop:false,
    },
    actions:[],
    beginCalls:[],
    endCalls:[],
    async beginSession(input) {
      this.beginCalls.push(structuredClone(input));
      return {
        sessionId:'xhs-publish-production-session',
        observation:{
          kind:'ok',
          pageState:'ready',
          origin:input.origin,
        },
      };
    },
    async perform(input) {
      this.actions.push(input.action);
      if (input.action === 'read_result') {
        return {
          kind:'ok',
          pageState:'published',
          origin:input.expectedOrigin,
          externalContentId:CONTENT_ID,
          evidence:`${input.expectedOrigin}/content/${CONTENT_ID}`,
          evidenceSnapshotHash:`sha256:${'e'.repeat(64)}`,
          selectorBundleVersion:'1.0.0',
          observedAt:PUBLISHED_AT,
          accountIdentityVerified:true,
          publishedAt:PUBLISHED_AT,
        };
      }
      return {
        kind:'ok',
        pageState:input.action === 'submit_publish'
          ? 'submitted'
          : 'editing',
        origin:input.expectedOrigin,
      };
    },
    async endSession(input) {
      this.endCalls.push(structuredClone(input));
    },
  };
}

function xhsMetricTrust() {
  const selectorBundle = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.0.0',
    platform:'xiaohongshu',
    origin:'https://pro.xiaohongshu.com',
    selectorMap:{
      path:'/creator/content',
      identity:{
        accountTextPattern:'^production-test-account$',
        contentIdPattern:'^xhs-content-[a-z-]+$',
      },
      actions:{
        navigate:{ label:'打开本人内容列表' },
        read:{ label:'读取页面账号身份' },
        filter:{ label:'按内容 ID 筛选' },
        open_detail:{ label:'打开本人内容详情' },
        read_metrics:{ label:'读取四项精确指标' },
      },
      metrics:['views', 'likes', 'saves', 'comments'],
    },
  };
  selectorBundle.approval = {
    source:'paperclip',
    status:'approved',
    approvalRef:'paperclip:xhs-metrics-selector-production-test',
    platform:'xiaohongshu',
    bundleVersion:'1.0.0',
    selectorChecksum:selectorBundleChecksum(selectorBundle),
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
  const profileLease = {
    schemaVersion:CUA_PROFILE_LEASE_SCHEMA,
    source:'paperclip',
    status:'approved',
    leaseRef:'paperclip:xhs-metrics-profile-production-test',
    platform:'xiaohongshu',
    accountRef:ACCOUNT_REF,
    profileName:'xhs-metrics-production-test',
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
  return { selectorBundle, profileLease };
}

function xhsMetricRunner(selectorBundle) {
  return {
    contract:{
      schemaVersion:XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
      readOnly:true,
      arbitraryDesktop:false,
      profileMode:'isolated_named',
      profileName:'xhs-metrics-production-test',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      origin:'https://pro.xiaohongshu.com',
      allowedActions:[...XHS_OWN_METRICS_CUA_ACTIONS],
    },
    actions:[],
    beginCalls:[],
    endCalls:[],
    async beginSession(input) {
      this.beginCalls.push(structuredClone(input));
      return {
        sessionId:'xhs-metrics-production-session',
        observation:{
          kind:'ok',
          origin:input.origin,
          pageState:'ready',
          observedAt:'2026-07-30T05:59:58.000Z',
        },
      };
    },
    async perform(input) {
      this.actions.push(input.action);
      return metricObservation(input.action, selectorBundle);
    },
    async endSession(input) {
      this.endCalls.push(structuredClone(input));
    },
  };
}

function metricObservation(action, selectorBundle) {
  const base = {
    kind:'ok',
    origin:'https://pro.xiaohongshu.com',
    observedAt:'2026-07-30T05:59:58.000Z',
  };
  if (action === 'navigate') {
    return { ...base, pageState:'content_list' };
  }
  if (action === 'read') {
    return {
      ...base,
      pageState:'account_verified',
      accountRef:ACCOUNT_REF,
      identityClaim:{
        kind:'page_identity_sha256',
        value:IDENTITY_HASH,
      },
    };
  }
  if (action === 'filter') {
    return {
      ...base,
      pageState:'content_filtered',
      accountRef:ACCOUNT_REF,
      externalContentId:CONTENT_ID,
    };
  }
  if (action === 'open_detail') {
    return {
      ...base,
      pageState:'own_note_detail',
      accountRef:ACCOUNT_REF,
      externalContentId:CONTENT_ID,
    };
  }
  return {
    ...base,
    pageState:'own_note_detail',
    accountRef:ACCOUNT_REF,
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
    externalContentId:CONTENT_ID,
    selectorBundleVersion:'1.0.0',
    selectorChecksum:selectorBundleChecksum(selectorBundle),
    metrics:{
      views:'1,200',
      likes:88,
      saves:31,
      comments:7,
    },
  };
}
