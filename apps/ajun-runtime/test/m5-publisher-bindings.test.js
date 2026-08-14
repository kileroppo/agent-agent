import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createM5PublisherBindings,
  LazyProductionPublisher,
  M5PublisherBindingError,
  PaperclipPublisherControl,
} from '../src/m5-publisher-bindings.ts';
import { routeM5PublisherApi } from '../src/m5-publisher-api.ts';

const NOW = new Date('2026-07-30T04:00:00.000Z');
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';

test('A君指标直连把可信授权 Campaign 注入 Gateway 并覆盖调用方自报值', async () => {
  const calls = [];
  const publisher = overridablePublisher();
  publisher.authorize = async () => ({ campaignId:CAMPAIGN_ID });
  publisher.getRuntime = async () => ({
    async collectMetricSnapshot(input) {
      calls.push(structuredClone(input));
      return { replayed:false };
    },
  });

  await publisher.collectMetricSnapshot(
    {
      campaignId:'forged-campaign',
      receiptId:'55555555-5555-4555-8555-555555555555',
      collectionKey:'55555555-5555-4555-8555-555555555555:2h',
      collectedAt:NOW.toISOString(),
    },
    { campaignId:CAMPAIGN_ID },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].campaignId, CAMPAIGN_ID);
});

test('A君只在恢复授权 exact/replay 核验后委托 Runtime，并暴露只读 attempt', async () => {
  const calls = {
    authorize:[],
    runtime:[],
    attempts:[],
  };
  let replayed = false;
  const publisher = overridablePublisher();
  publisher.authorize = async (...args) => {
    const context = args[2];
    calls.authorize.push(structuredClone(context));
    return { ...structuredClone(context), replayed };
  };
  publisher.runtime = {
    gateway:{
      async getAttempt(idempotencyKey) {
        calls.attempts.push(idempotencyKey);
        return { attemptId:'attempt-metric-stale', state:'invoking' };
      },
    },
  };
  publisher.getRuntime = async () => ({
    async reconcileMetricInvocation(input) {
      calls.runtime.push({
        input:structuredClone(input),
      });
      return { replayed:false, recovery:{ state:'failed' } };
    },
  });
  const authorization = {
    action:'publisher.reconcile_stale_attempt',
    runId:RUN_ID,
    issueId:ISSUE_ID,
    campaignId:CAMPAIGN_ID,
    agentId:AGENT_ID,
    authorizationId:'paperclip:authorization:metric-recovery-binding',
  };
  const input = {
    campaignId:CAMPAIGN_ID,
    receiptId:'55555555-5555-4555-8555-555555555555',
    collectionKey:'55555555-5555-4555-8555-555555555555:2h',
    conclusion:'no_external_effect',
    authorizationId:'caller-forged-authorization',
    evidenceRef:'paperclip:work-product:metric-recovery-binding',
  };

  assert.deepEqual(
    await publisher.getAttempt(`metric:${input.collectionKey}`),
    { attemptId:'attempt-metric-stale', state:'invoking' },
  );
  const result = await publisher.reconcileMetricInvocation(input, authorization);
  assert.equal(result.recovery.state, 'failed');
  assert.equal(calls.runtime.length, 1);
  assert.equal(
    calls.runtime[0].input.authorizationId,
    authorization.authorizationId,
  );
  assert.equal(calls.runtime[0].input.campaignId, CAMPAIGN_ID);
  assert.deepEqual(calls.authorize, [authorization]);

  replayed = true;
  await assert.rejects(
    publisher.reconcileMetricInvocation(input, {
      ...authorization,
      authorizationId:'paperclip:authorization:metric-recovery-replayed',
    }),
    { code:'publisher_authorization_replayed' },
  );
  assert.equal(calls.runtime.length, 1);
  assert.deepEqual(calls.attempts, [`metric:${input.collectionKey}`]);
});

test('A君真实 exact replay 保持 authorize→runtime→replay lookup 顺序', async () => {
  const order = [];
  const authorization = {
    action:'publisher.reconcile_stale_attempt',
    runId:RUN_ID,
    issueId:ISSUE_ID,
    campaignId:CAMPAIGN_ID,
    agentId:AGENT_ID,
    authorizationId:'paperclip:authorization:metric-recovery-existing',
  };
  const input = {
    campaignId:CAMPAIGN_ID,
    receiptId:'55555555-5555-4555-8555-555555555555',
    collectionKey:'55555555-5555-4555-8555-555555555555:2h',
    conclusion:'no_external_effect',
    evidenceRef:'paperclip:work-product:metric-recovery-existing',
  };
  const attempt = {
    attemptId:'attempt-metric-recovery-existing',
    kind:'metric_snapshot',
    idempotencyKey:`metric:${input.collectionKey}`,
    campaignId:CAMPAIGN_ID,
    receiptId:input.receiptId,
    collectionKey:input.collectionKey,
    state:'failed',
    metricRecovery:{
      recoveryId:'metric_recovery_existing',
      action:'publisher.reconcile_stale_attempt',
      authorizationId:authorization.authorizationId,
      conclusion:input.conclusion,
      approvalRef:'paperclip:approval:metric-recovery-existing',
      evidenceRef:input.evidenceRef,
      resolvedAt:'2026-07-30T10:00:00.000Z',
    },
  };
  let reconcileCalls = 0;
  const runtime = {
    gateway:{
      getAttempt:async () => {
        order.push('replay_lookup');
        const existing = structuredClone(attempt);
        attempt.state = 'invoking';
        delete attempt.metricRecovery;
        return existing;
      },
    },
    reconcileMetricInvocation:async () => {
      reconcileCalls += 1;
      throw new Error('trusted exact replay 绝不能进入可写 reconcile');
    },
  };
  const publisher = overridablePublisher({
    authorizePublisherRequest:async (actual) => {
      order.push('authorize');
      return { ...actual, authorized:true, replayed:true };
    },
  });
  publisher.getRuntime = async (actual) => {
    order.push(`runtime:${actual.replayed}`);
    return runtime;
  };

  const replay = await publisher.reconcileMetricInvocation(input, authorization);
  assert.deepEqual(replay, {
    replayed:true,
    recovery:{
      recoveryId:'metric_recovery_existing',
      action:'publisher.reconcile_stale_attempt',
      conclusion:'no_external_effect',
      evidenceRef:input.evidenceRef,
      resolvedAt:'2026-07-30T10:00:00.000Z',
      state:'failed',
      retryAllowed:true,
      nextAction:'request_new_read_own_metrics_authorization',
    },
  });
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(order, ['authorize', 'runtime:true', 'replay_lookup']);

  attempt.state = 'failed';
  attempt.metricRecovery = {
    recoveryId:replay.recovery.recoveryId,
    action:replay.recovery.action,
    authorizationId:authorization.authorizationId,
    conclusion:replay.recovery.conclusion,
    approvalRef:'paperclip:approval:metric-recovery-existing',
    evidenceRef:'paperclip:work-product:different-evidence',
    resolvedAt:replay.recovery.resolvedAt,
  };
  await assert.rejects(
    publisher.reconcileMetricInvocation(input, authorization),
    { code:'publisher_authorization_replayed' },
  );
  assert.equal(reconcileCalls, 0);
});

test('A君 Publisher 接线默认关闭并拒绝真实模式或相对路径', () => {
  assert.deepEqual(createM5PublisherBindings({
    env:{},
    dataDir:'/tmp/ajun-m5-test',
  }), {
    runtime:null,
    publisher:null,
    toolExecutor:null,
  });
  assert.throws(() => createM5PublisherBindings({
    env:{
      AJUN_M5_PUBLISHER_MODE:'real',
      AJUN_M5_PUBLISHER_PRODUCTION_ENABLED:'1',
      AJUN_M5_PUBLISHER_APPROVAL_SNAPSHOT:'paperclip:forged-from-env',
      AJUN_M5_PUBLISHER_CONNECTOR_KIND:'douyin_official_api',
      AJUN_M5_PUBLISHER_ACCOUNT_IDENTITY_VERIFIER:'forged-from-env',
    },
    dataDir:'/tmp/ajun-m5-test',
  }), { code:'real_gateway_disabled' });
  assert.throws(() => createM5PublisherBindings({
    env:{
      AJUN_M5_PUBLISHER_MODE:'fake',
      AJUN_M5_PUBLISHER_WORKSPACE_ROOT:'relative/workspace',
    },
    dataDir:'/tmp/ajun-m5-test',
  }), M5PublisherBindingError);
  assert.throws(() => createM5PublisherBindings({
    env:{ AJUN_M5_PUBLISHER_MODE:'fake' },
    dataDir:'/tmp/ajun-m5-test',
  }), M5PublisherBindingError);
});

test('A君保留旧 Publisher public shape且构造后依赖替换立即生效', async () => {
  const publisher = overridablePublisher();
  for (const property of [
    'mode',
    'paperclipAccess',
    'connectorDependencies',
    'workspaceRoot',
    'ledgerPath',
    'paperclipControl',
    'clock',
    'runtime',
    'runtimePromise',
    'approvalSnapshotId',
    'approvalSnapshotFingerprint',
    'approvalSnapshotValidUntil',
  ]) {
    assert.equal(Object.hasOwn(publisher, property), true, property);
  }
  for (const method of [
    'authorize',
    'getRuntime',
    'productionConnectorDependencies',
    'paperclipCostReporter',
    'paperclipAccountIdentityVerifier',
  ]) {
    assert.equal(typeof publisher[method], 'function', method);
  }

  publisher.connectorDependencies = {
    douyinOfficialApi:{ httpRequest:async () => ({ status:500 }) },
  };
  const connector = publisher.productionConnectorDependencies().douyinOfficialApi;
  const costReporter = publisher.paperclipCostReporter();
  const accountVerifier = publisher.paperclipAccountIdentityVerifier();
  const calls = [];
  publisher.paperclipAccess = {
    ...publisher.paperclipAccess,
    authorizePublisherRequest:async (input) => {
      calls.push('authorize');
      return { ...input, authorized:true, replayed:false };
    },
    getPublisherConnectorApprovalSnapshot:async () => {
      calls.push('snapshot');
      return approvalSnapshot();
    },
    resolvePublisherCredentialReference:async () => {
      calls.push('secret');
      return { accessToken:'replacement' };
    },
    assertPublisherCampaignBudget:async () => {
      calls.push('budget');
      return { allowed:true };
    },
    recordPublisherConnectorAttempt:async () => {
      calls.push('cost');
      return { reportRef:'paperclip:replacement' };
    },
    verifyPublisherAccountIdentity:async () => {
      calls.push('identity');
      return { verified:true };
    },
  };

  const authorization = authorizationContext(
    'paperclip:authorization:replacement-dependencies',
  );
  await publisher.authorize(
    authorization.action,
    authorization.campaignId,
    authorization,
  );
  await publisher.getRuntime(authorization);
  await connector.credentialResolver({ platform:'douyin' });
  await costReporter.assertCampaignBudget({ campaignId:CAMPAIGN_ID });
  await costReporter.recordConnectorAttempt({ campaignId:CAMPAIGN_ID });
  await accountVerifier.verify({ platform:'douyin' });

  assert.deepEqual(calls, [
    'authorize',
    'snapshot',
    'secret',
    'budget',
    'cost',
    'identity',
  ]);
  assert.equal(publisher.runtime?.mode, 'real');
  assert.equal(publisher.runtimePromise, null);
  assert.equal(publisher.approvalSnapshotId, approvalSnapshot().snapshotId);
  assert.match(publisher.approvalSnapshotFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    publisher.approvalSnapshotValidUntil,
    Date.parse('2026-08-06T00:00:00.000Z'),
  );
});

test('A君显式 production 依赖在启动时不读取批准、Secret或构造real Runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-m5-production-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const workspaceRoot = path.join(root, 'content-growth-artifacts');
  await fs.mkdir(workspaceRoot, { recursive:true });
  const media = Buffer.from('ajun-controlled-real-publisher-video');
  await fs.writeFile(path.join(workspaceRoot, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const calls = {
    authorize:0,
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
  };
  const campaignGrant = activeGrant();
  const paperclipAccess = {
    async authorizePublisherRequest(input) {
      calls.authorize += 1;
      return { ...input, authorized:true, replayed:false };
    },
    async getPublisherConnectorApprovalSnapshot() {
      calls.snapshot += 1;
      return approvalSnapshot();
    },
    async resolvePublisherCredentialReference(input) {
      calls.secret += 1;
      assert.deepEqual(input, {
        accountRef:'account:douyin:test',
        platform:'douyin',
        purpose:'publish',
      });
      return { accessToken:'memory-only-test-token', openId:'owner-open-id' };
    },
    async verifyPublisherAccountIdentity(input) {
      calls.identity += 1;
      assert.equal(input.platform, 'douyin');
      assert.equal(input.accountRef, 'account:douyin:test');
      assert.equal(input.providerIdentity.kind, 'open_id_sha256');
      assert.match(input.providerIdentity.value, /^sha256:[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(input).includes('owner-open-id'), false);
      return {
        verified:true,
        ...structuredClone(input),
        verificationRef:'paperclip:publisher-account:douyin-test',
      };
    },
    async assertPublisherCampaignBudget(input) {
      calls.budget += 1;
      return {
        campaignId:input.campaignId,
        allowed:true,
        hardStopEnabled:true,
        remainingAmountUsd:5,
      };
    },
    async recordPublisherConnectorAttempt(input) {
      calls.cost += 1;
      return { reportRef:`paperclip:${input.costRecordId}` };
    },
    async assertPublisherMetricRecoveryAllowed(input) {
      return { ...input, authorized:true, source:'paperclip' };
    },
  };
  const binding = createM5PublisherBindings({
    env:{},
    dataDir:root,
    clock:() => new Date(NOW),
    getCampaignService:async () => campaignService(campaignGrant),
    production:{
      enabled:true,
      paperclipAccess,
      workspaceRoot,
      ledgerPath:path.join(root, 'publisher-ledger.json'),
      connectorDependencies:{
        douyinOfficialApi:{
          httpRequest:async (request) => {
            calls.http += 1;
            const actualCost = {
              amountUsd:0,
              providerRequestId:`stepfun-test:${request.operation}`,
              occurredAt:NOW.toISOString(),
            };
            if (request.operation === 'upload_video') {
              return {
                status:200,
                actualCost,
                body:{ data:{ video:{ video_id:'video-owned-1' } } },
              };
            }
            if (request.operation === 'create_video') {
              return {
                status:200,
                actualCost,
                body:{ data:{ item_id:'item-owned-1', video_id:'video-owned-1' } },
              };
            }
            return {
              status:200,
              actualCost,
              body:{
                data:{
                  list:[{
                    item_id:'item-owned-1',
                    video_id:'video-owned-1',
                    share_url:'https://www.douyin.com/video/item-owned-1',
                    create_time:NOW.getTime() / 1000,
                  }],
                },
              },
            };
          },
        },
      },
    },
  });

  assert.equal(binding.runtime, null);
  assert.deepEqual(calls, {
    authorize:0,
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
  });

  const result = await binding.publisher.publish(
    publishRequest(checksum, campaignGrant),
    authorizationContext('paperclip:authorization:publish-1'),
  );
  assert.equal(binding.runtime?.mode, 'real');
  assert.equal(result.receipt.connectorMode, 'real:douyin_official_api');
  assert.equal(result.receipt.externalContentId, 'item-owned-1');
  assert.deepEqual(calls, {
    authorize:1,
    snapshot:1,
    secret:1,
    identity:1,
    budget:1,
    cost:3,
    http:3,
  });
});

test('A君按规范化指纹复用同一批准集，忽略顺序和重新捕获时间', async (context) => {
  const publishApproval = approvalSnapshot().approvals[0];
  const metricApproval = {
    ...publishApproval,
    capability:'read_own_metrics',
    approvalRef:'paperclip:connector-approval:douyin-metrics',
  };
  const snapshots = [
    approvalSnapshot({ approvals:[publishApproval, metricApproval] }),
    approvalSnapshot({
      capturedAt:'2026-07-30T03:59:30.000Z',
      approvals:[metricApproval, publishApproval],
    }),
  ];
  const fixture = await lazyPublisherFixture(context, {
    getSnapshot:() => snapshots.shift(),
  });

  const first = await fixture.publisher.getRuntime(
    authorizationContext('paperclip:authorization:fingerprint-first'),
  );
  const second = await fixture.publisher.getRuntime(
    authorizationContext('paperclip:authorization:fingerprint-second'),
  );

  assert.strictEqual(second, first);
  assert.equal(fixture.calls.snapshot, 2);
  assertNoExternalPublisherCalls(fixture.calls);
});

test('A君拒绝同 snapshotId 下批准内容漂移且不读取Secret或调用connector', async (context) => {
  let snapshot = approvalSnapshot();
  const fixture = await lazyPublisherFixture(context, {
    getSnapshot:() => structuredClone(snapshot),
  });
  await fixture.publisher.getRuntime(
    authorizationContext('paperclip:authorization:drift-first'),
  );
  snapshot = approvalSnapshot({
    approvals:[{
      ...snapshot.approvals[0],
      approvalRef:'paperclip:connector-approval:douyin-drifted',
    }],
  });

  await assert.rejects(
    fixture.publisher.getRuntime(
      authorizationContext('paperclip:authorization:drift-second'),
    ),
    { code:'publisher_approval_snapshot_changed' },
  );
  assert.equal(fixture.calls.snapshot, 2);
  assertNoExternalPublisherCalls(fixture.calls);
});

test('A君在同 snapshotId 批准到期后停止复用Runtime且不触碰外部依赖', async (context) => {
  let current = new Date(NOW);
  const snapshot = approvalSnapshot({
    approvals:[{
      ...approvalSnapshot().approvals[0],
      expiresAt:'2026-07-30T04:05:00.000Z',
    }],
  });
  const fixture = await lazyPublisherFixture(context, {
    clock:() => new Date(current),
    getSnapshot:() => structuredClone(snapshot),
  });
  await fixture.publisher.getRuntime(
    authorizationContext('paperclip:authorization:expiry-first'),
  );
  current = new Date('2026-07-30T04:05:00.000Z');

  await assert.rejects(
    fixture.publisher.getRuntime(
      authorizationContext('paperclip:authorization:expiry-second'),
    ),
    { code:'publisher_approval_snapshot_expired' },
  );
  assert.equal(fixture.calls.snapshot, 2);
  assertNoExternalPublisherCalls(fixture.calls);
});

test('A君拒绝来自未来的批准快照且不构造Runtime或触碰外部依赖', async (context) => {
  const fixture = await lazyPublisherFixture(context, {
    getSnapshot:() => approvalSnapshot({
      capturedAt:'2026-07-30T04:00:00.001Z',
    }),
  });

  await assert.rejects(
    fixture.publisher.getRuntime(
      authorizationContext('paperclip:authorization:future-snapshot'),
    ),
    { code:'publisher_approval_snapshot_invalid' },
  );
  assert.equal(fixture.publisher.runtime, null);
  assertNoExternalPublisherCalls(fixture.calls);
});

test('A君并发初始化把runtimePromise绑定批准指纹，不同快照双方均失败关闭', async (context) => {
  const firstSnapshot = approvalSnapshot();
  const secondSnapshot = approvalSnapshot({
    approvals:[{
      ...firstSnapshot.approvals[0],
      approvalRef:'paperclip:connector-approval:douyin-concurrent-change',
    }],
  });
  const snapshots = [firstSnapshot, secondSnapshot];
  const fixture = await lazyPublisherFixture(context, {
    getSnapshot:() => structuredClone(snapshots.shift() || firstSnapshot),
  });

  const results = await Promise.allSettled([
    fixture.publisher.getRuntime(
      authorizationContext('paperclip:authorization:concurrent-first'),
    ),
    fixture.publisher.getRuntime(
      authorizationContext('paperclip:authorization:concurrent-second'),
    ),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected'],
  );
  for (const result of results) {
    assert.equal(result.reason.code, 'publisher_approval_snapshot_changed');
  }
  assert.equal(fixture.publisher.runtime, null);
  assert.equal(fixture.publisher.runtimePromise, null);
  assert.equal(fixture.calls.snapshot, 2);
  assertNoExternalPublisherCalls(fixture.calls);

  const retried = await fixture.publisher.getRuntime(
    authorizationContext('paperclip:authorization:concurrent-retry'),
  );
  assert.strictEqual(fixture.publisher.runtime, retried);
  assert.equal(fixture.publisher.runtimePromise, null);
  assert.equal(fixture.calls.snapshot, 3);
});

test('A君 production 授权错误或重放不会读取批准、Secret或触碰connector', async () => {
  const calls = {
    authorize:0,
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
  };
  let scenario = 'mismatch';
  const binding = createM5PublisherBindings({
    env:{},
    dataDir:'/tmp/ajun-m5-production-denied',
    getCampaignService:async () => campaignService(activeGrant()),
    production:{
      enabled:true,
      paperclipAccess:{
        async authorizePublisherRequest(input) {
          calls.authorize += 1;
          if (scenario === 'replay') return { ...input, authorized:true, replayed:true };
          return { ...input, authorized:true, action:'publisher.read_own_metrics' };
        },
        async getPublisherConnectorApprovalSnapshot() {
          calls.snapshot += 1;
          return approvalSnapshot();
        },
        async resolvePublisherCredentialReference() {
          calls.secret += 1;
          return { accessToken:'must-not-be-read', openId:'must-not-be-read' };
        },
        async verifyPublisherAccountIdentity() {
          calls.identity += 1;
          throw new Error('授权失败不得核验账号身份');
        },
        async assertPublisherCampaignBudget() {
          calls.budget += 1;
          throw new Error('授权失败不得读取预算');
        },
        async recordPublisherConnectorAttempt() {
          calls.cost += 1;
          throw new Error('授权失败不得上报费用');
        },
        async assertPublisherMetricRecoveryAllowed() {
          throw new Error('授权失败不得核验恢复审批');
        },
      },
      connectorDependencies:{
        douyinOfficialApi:{
          async httpRequest() {
            calls.http += 1;
            throw new Error('授权失败不得触碰 connector');
          },
        },
      },
    },
  });
  const input = { campaignId:CAMPAIGN_ID };

  await assert.rejects(
    binding.publisher.publish(
      input,
      authorizationContext('paperclip:authorization:mismatch'),
    ),
    { code:'publisher_authorization_scope_mismatch' },
  );
  assert.equal(binding.runtime, null);
  assert.deepEqual(calls, {
    authorize:1,
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
  });

  scenario = 'replay';
  await assert.rejects(
    binding.publisher.publish(
      input,
      authorizationContext('paperclip:authorization:replay'),
    ),
    { code:'publisher_authorization_replayed' },
  );
  assert.equal(binding.runtime, null);
  assert.deepEqual(calls, {
    authorize:2,
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
  });
});

test('A君只从Paperclip provider注入账号核验；错配时保留account_mismatch且0 HTTP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-m5-account-mismatch-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const workspaceRoot = path.join(root, 'content-growth-artifacts');
  await fs.mkdir(workspaceRoot, { recursive:true });
  const media = Buffer.from('ajun-account-mismatch-video');
  await fs.writeFile(path.join(workspaceRoot, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const campaignGrant = activeGrant();
  let httpCalls = 0;
  let identityInput = null;
  let grantStatus = 'active';
  let triggerEnabled = true;
  const service = {
    async getRawCase() {
      return {
        id:CAMPAIGN_ID,
        stageKey:'campaign_active',
        fields:{
          campaignGrant:{
            ...structuredClone(campaignGrant),
            status:grantStatus,
          },
        },
      };
    },
    async getDailyRoutineTrigger() {
      return { enabled:triggerEnabled };
    },
    async control() {
      grantStatus = 'paused';
      triggerEnabled = false;
    },
  };
  const binding = createM5PublisherBindings({
    env:{},
    dataDir:root,
    clock:() => new Date(NOW),
    getCampaignService:async () => service,
    production:{
      enabled:true,
      workspaceRoot,
      ledgerPath:path.join(root, 'publisher-ledger.json'),
      paperclipAccess:{
        async authorizePublisherRequest(input) {
          return { ...input, authorized:true, replayed:false };
        },
        async getPublisherConnectorApprovalSnapshot() {
          return approvalSnapshot();
        },
        async resolvePublisherCredentialReference() {
          return {
            accessToken:'memory-only-test-token',
            openId:'owner-open-id-mismatch',
          };
        },
        async verifyPublisherAccountIdentity(input) {
          identityInput = structuredClone(input);
          return {
            verified:false,
            ...structuredClone(input),
            verificationRef:'paperclip:publisher-account:mismatch',
          };
        },
        async assertPublisherCampaignBudget(input) {
          return {
            campaignId:input.campaignId,
            allowed:true,
            hardStopEnabled:true,
            remainingAmountUsd:5,
          };
        },
        async recordPublisherConnectorAttempt() {
          throw new Error('账号错配不得产生connector费用');
        },
        async assertPublisherMetricRecoveryAllowed() {
          throw new Error('账号错配不得核验恢复审批');
        },
      },
      connectorDependencies:{
        douyinOfficialApi:{
          async httpRequest() {
            httpCalls += 1;
            throw new Error('账号错配不得调用HTTP');
          },
        },
      },
    },
  });
  const input = publishRequest(checksum, campaignGrant);

  await assert.rejects(
    binding.publisher.publish(
      input,
      authorizationContext('paperclip:authorization:account-mismatch'),
    ),
    { code:'publish_attempt_ambiguous' },
  );
  assert.equal(httpCalls, 0);
  assert.equal(identityInput.platform, 'douyin');
  assert.equal(identityInput.accountRef, 'account:douyin:test');
  assert.equal(identityInput.providerIdentity.kind, 'open_id_sha256');
  assert.equal(JSON.stringify(identityInput).includes('owner-open-id-mismatch'), false);
  const attempt = await binding.runtime.gateway.getAttempt(input.idempotencyKey);
  assert.equal(attempt.state, 'ambiguous');
  assert.equal(attempt.ambiguousReason, 'account_mismatch');
});

test('PaperclipPublisherControl 每次发布都核验父Case有效期和 Cron', async () => {
  const canonicalGrant = {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{ douyin:'account:douyin:test', xiaohongshu:'account:xhs:test' },
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history'],
    budgetCents:625,
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
  const campaignCase = {
    id:'case-1',
    stageKey:'campaign_active',
    fields:{
      campaignGrant:canonicalGrant,
    },
  };
  const trigger = { enabled:true };
  const service = {
    getRawCase:async () => structuredClone(campaignCase),
    getDailyRoutineTrigger:async () => structuredClone(trigger),
    control:async () => undefined,
  };
  const control = new PaperclipPublisherControl({
    getCampaignService:async () => service,
    clock:() => new Date('2026-07-30T00:00:00.000Z'),
  });
  assert.deepEqual(await control.assertPublishAllowed({ campaignId:'case-1' }), {
    campaignId:'case-1',
    grantStatus:'active',
    cronStatus:'enabled',
    currentStage:'campaign_active',
    canonicalGrant,
    checkedAt:'2026-07-30T00:00:00.000Z',
  });

  trigger.enabled = false;
  await assert.rejects(
    control.assertPublishAllowed({ campaignId:'case-1' }),
    /Cron 未启用/,
  );
  trigger.enabled = true;
  canonicalGrant.expiresAt = '2026-07-30T00:00:00.000Z';
  await assert.rejects(
    control.assertPublishAllowed({ campaignId:'case-1' }),
    /已过期/,
  );
  canonicalGrant.expiresAt = '2026-08-06T00:00:00.000Z';
  campaignCase.stageKey = 'topic';
  await assert.rejects(
    control.assertPublishAllowed({ campaignId:'case-1' }),
    /campaign_active/,
  );
});

test('PaperclipPublisherControl 暂停后回读 Grant 和 Cron 双重确认', async () => {
  const campaignCase = {
    id:'case-1',
    stageKey:'campaign_active',
    fields:{
      campaignGrant:{
        status:'active',
        startsAt:'2026-07-29T00:00:00.000Z',
        expiresAt:'2026-08-06T00:00:00.000Z',
      },
    },
  };
  const trigger = { enabled:true };
  const service = {
    getRawCase:async () => structuredClone(campaignCase),
    getDailyRoutineTrigger:async () => structuredClone(trigger),
    control:async (campaignId, action) => {
      assert.equal(campaignId, 'case-1');
      assert.equal(action, 'pause');
      campaignCase.fields.campaignGrant.status = 'paused';
      trigger.enabled = false;
    },
  };
  const control = new PaperclipPublisherControl({
    getCampaignService:async () => service,
  });
  assert.deepEqual(await control.pauseCampaignAndDisableCron({
    campaignId:'case-1',
    reason:'risk_control',
    idempotencyKey:'publisher-pause:case-1:risk_control',
  }), {
    campaignId:'case-1',
    grantStatus:'paused',
    cronStatus:'disabled',
    controlEventId:'publisher-pause:case-1:risk_control',
  });

  service.control = async () => {
    campaignCase.fields.campaignGrant.status = 'paused';
    trigger.enabled = true;
  };
  await assert.rejects(
    control.pauseCampaignAndDisableCron({
      campaignId:'case-1',
      reason:'risk_control',
      idempotencyKey:'second',
    }),
    /Cron 已关闭/,
  );
});

test('PaperclipPublisherControl 把指标恢复精确委托给 Board Approval/证据核验器', async () => {
  const calls = [];
  const control = new PaperclipPublisherControl({
    getCampaignService:async () => campaignService(activeGrant()),
    paperclipAccess:{
      async assertPublisherMetricRecoveryAllowed(input) {
        calls.push(structuredClone(input));
        return {
          ...input,
          authorized:true,
          source:'paperclip',
          approvalRef:'paperclip:approval:metric-recovery-binding',
        };
      },
    },
  });
  const input = {
    action:'publisher.reconcile_stale_attempt',
    campaignId:CAMPAIGN_ID,
    receiptId:'55555555-5555-4555-8555-555555555555',
    collectionKey:'55555555-5555-4555-8555-555555555555:2h',
    attemptId:'attempt-metric-recovery-binding',
    conclusion:'no_external_effect',
    authorizationId:'paperclip:authorization:metric-recovery-binding',
    evidenceRef:'paperclip:work-product:metric-recovery-binding',
    checkedAt:NOW.toISOString(),
  };

  const result = await control.assertMetricRecoveryAllowed(input);
  assert.equal(result.approvalRef, 'paperclip:approval:metric-recovery-binding');
  assert.deepEqual(calls, [input]);

  const missing = new PaperclipPublisherControl({
    getCampaignService:async () => campaignService(activeGrant()),
  });
  await assert.rejects(
    missing.assertMetricRecoveryAllowed(input),
    { code:'paperclip_metric_recovery_access_required' },
  );
});

test('发布接口拒绝非本机请求且不初始化 Publisher 服务', async () => {
  let initialized = false;
  const result = await routeM5PublisherApi({
    method:'POST',
    url:'/api/tool-executions',
    local:false,
    getService:async () => {
      initialized = true;
      return {};
    },
  });
  assert.equal(result.status, 403);
  assert.equal(initialized, false);
});

test('本机工具接口缺少Paperclip短期Run凭证时不初始化服务', async () => {
  let initialized = false;
  const result = await routeM5PublisherApi({
    method:'POST',
    url:'/api/tool-executions',
    local:true,
    getService:async () => {
      initialized = true;
      return {};
    },
  });
  assert.equal(result.status, 401);
  assert.equal(initialized, false);
});

function activeGrant() {
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

function approvalSnapshot(overrides = {}) {
  const snapshot = {
    schemaVersion:'agent.army/publisher-connector-approvals/v1',
    source:'paperclip',
    snapshotId:'paperclip:publisher-approvals:ajun-test',
    capturedAt:'2026-07-30T03:59:00.000Z',
    approvals:[{
      status:'approved',
      approvalRef:'paperclip:connector-approval:douyin-official',
      platform:'douyin',
      connectorKind:'douyin_official_api',
      expiresAt:'2026-08-06T00:00:00.000Z',
    }],
  };
  return {
    ...snapshot,
    ...structuredClone(overrides),
    approvals:structuredClone(overrides.approvals || snapshot.approvals),
  };
}

function overridablePublisher({
  authorizePublisherRequest = async (input) => ({
    ...input,
    authorized:true,
    replayed:false,
  }),
} = {}) {
  return new LazyProductionPublisher({
    workspaceRoot:'/tmp/ajun-overridable-publisher-workspace',
    ledgerPath:'/tmp/ajun-overridable-publisher-ledger.json',
    clock:() => new Date(NOW),
    paperclipAccess:{
      authorizePublisherRequest,
      getPublisherConnectorApprovalSnapshot:async () => approvalSnapshot(),
      resolvePublisherCredentialReference:async () => ({}),
      verifyPublisherAccountIdentity:async () => ({ verified:true }),
      assertPublisherCampaignBudget:async () => ({ allowed:true }),
      recordPublisherConnectorAttempt:async () => ({ reportRef:'paperclip:test' }),
      assertPublisherMetricRecoveryAllowed:async (input) => ({
        ...input,
        authorized:true,
      }),
    },
    connectorDependencies:{},
    paperclipControl:{
      assertPublishAllowed:async () => ({ grantStatus:'active' }),
      pauseCampaignAndDisableCron:async () => ({ grantStatus:'paused' }),
      assertMetricRecoveryAllowed:async (input) => ({
        ...input,
        authorized:true,
      }),
    },
  });
}

async function lazyPublisherFixture(context, {
  getSnapshot,
  clock = () => new Date(NOW),
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-m5-approval-cache-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const workspaceRoot = path.join(root, 'content-growth-artifacts');
  await fs.mkdir(workspaceRoot, { recursive:true });
  const calls = {
    snapshot:0,
    secret:0,
    identity:0,
    budget:0,
    cost:0,
    http:0,
    campaign:0,
    pause:0,
  };
  const publisher = new LazyProductionPublisher({
    workspaceRoot,
    ledgerPath:path.join(root, 'publisher-ledger.json'),
    clock,
    paperclipAccess:{
      async authorizePublisherRequest(input) {
        return { ...input, authorized:true, replayed:false };
      },
      async getPublisherConnectorApprovalSnapshot() {
        calls.snapshot += 1;
        return getSnapshot();
      },
      async resolvePublisherCredentialReference() {
        calls.secret += 1;
        throw new Error('批准快照测试不得读取Secret');
      },
      async verifyPublisherAccountIdentity() {
        calls.identity += 1;
        throw new Error('批准快照测试不得核验平台身份');
      },
      async assertPublisherCampaignBudget() {
        calls.budget += 1;
        throw new Error('批准快照测试不得读取预算');
      },
      async recordPublisherConnectorAttempt() {
        calls.cost += 1;
        throw new Error('批准快照测试不得上报费用');
      },
      async assertPublisherMetricRecoveryAllowed() {
        throw new Error('批准快照测试不得核验恢复审批');
      },
    },
    connectorDependencies:{
      douyinOfficialApi:{
        async httpRequest() {
          calls.http += 1;
          throw new Error('批准快照测试不得调用HTTP');
        },
      },
    },
    paperclipControl:{
      async assertPublishAllowed() {
        calls.campaign += 1;
        throw new Error('批准快照测试不得读取Campaign');
      },
      async pauseCampaignAndDisableCron() {
        calls.pause += 1;
        throw new Error('批准快照测试不得暂停Campaign');
      },
    },
  });
  return { publisher, calls };
}

function assertNoExternalPublisherCalls(calls) {
  assert.deepEqual(
    {
      secret:calls.secret,
      identity:calls.identity,
      budget:calls.budget,
      cost:calls.cost,
      http:calls.http,
      campaign:calls.campaign,
      pause:calls.pause,
    },
    {
      secret:0,
      identity:0,
      budget:0,
      cost:0,
      http:0,
      campaign:0,
      pause:0,
    },
  );
}

function campaignService(campaignGrant) {
  return {
    getRawCase:async () => ({
      id:CAMPAIGN_ID,
      stageKey:'campaign_active',
      fields:{ campaignGrant:structuredClone(campaignGrant) },
    }),
    getDailyRoutineTrigger:async () => ({ enabled:true }),
    control:async () => undefined,
  };
}

function authorizationContext(authorizationId) {
  return {
    action:'publisher.publish',
    runId:RUN_ID,
    issueId:ISSUE_ID,
    campaignId:CAMPAIGN_ID,
    agentId:AGENT_ID,
    authorizationId,
  };
}

function publishRequest(checksum, grant) {
  return {
    campaignId:CAMPAIGN_ID,
    grant:structuredClone(grant),
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'A君可信 production 发布',
    body:'本测试只调用本地 stub，不访问真实平台。',
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
    idempotencyKey:`${CAMPAIGN_ID}:douyin:content-v1:2026-07-30`,
  };
}
