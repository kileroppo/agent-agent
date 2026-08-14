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
  CuaPlatformConnector,
  DouyinOfficialApiConnector,
  XHS_OWN_METRICS_CUA_ACTIONS,
  XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
  createPublisherRuntime,
  publishIdempotencyKey,
  selectorBundleChecksum,
} from '../src/index.ts';
import {
  actualCost,
  deterministicCostReporter,
} from '../test-support/cost-reporter.js';
import {
  recordingAccountIdentityVerifier,
} from '../test-support/account-identity-verifier.js';

const NOW = new Date('2026-07-30T04:00:00.000Z');

function runtimeGrant() {
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
  };
}

function paperclipControl(canonicalGrant = runtimeGrant()) {
  return {
    assertPublishAllowed:async ({ campaignId }) => ({
      campaignId,
      grantStatus:'active',
      currentStage:'campaign_active',
      canonicalGrant:structuredClone(canonicalGrant),
    }),
    pauseCampaignAndDisableCron:async ({ campaignId }) => ({
      campaignId,
      grantStatus:'paused',
      cronStatus:'disabled',
      controlEventId:'fake-control-event',
    }),
  };
}

function inactiveCuaRunner() {
  let beginCalls = 0;
  return {
    contract:{
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode:'isolated_named',
      profileName:'m5-xiaohongshu-test',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      allowedActions:[...CUA_PUBLISH_ACTIONS],
      arbitraryDesktop:false,
    },
    beginSession:async () => {
      beginCalls += 1;
      throw new Error('构造时不应启动 CUA session');
    },
    perform:async () => {
      throw new Error('构造时不应执行 CUA 动作');
    },
    endSession:async () => {},
    get beginCalls() {
      return beginCalls;
    },
  };
}

test('Publisher Runtime 默认关闭并拒绝任何真实模式', () => {
  assert.equal(createPublisherRuntime(), null);
  assert.equal(createPublisherRuntime({ mode:'disabled' }), null);
  assert.throws(() => createPublisherRuntime({
    mode:'real',
    productionEnabled:false,
    workspaceRoot:'/tmp/m5-publisher',
    ledgerPath:'/tmp/m5-publisher-ledger.json',
  }), { code:'real_gateway_disabled' });
});

test('显式生产开关只解除第一层关闭，缺少 Paperclip control 仍失败关闭', () => {
  assert.throws(() => createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:'/tmp/m5-publisher',
    ledgerPath:'/tmp/m5-publisher-ledger.json',
  }), { code:'paperclip_control_required' });
});

test('受批准抖音官方 connector 可选构造入口不在启动时读取凭据或调用HTTP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-real-runtime-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  let credentialCalls = 0;
  let httpCalls = 0;
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date(NOW),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-official',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{
          credentialResolver:async () => {
            credentialCalls += 1;
            throw new Error('构造时不应读取凭据');
          },
          httpRequest:async () => {
            httpCalls += 1;
            throw new Error('构造时不应调用HTTP');
          },
        },
      },
    },
  });

  assert.equal(runtime.mode, 'real');
  assert.ok(runtime.connectors.douyin instanceof DouyinOfficialApiConnector);
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
});

test('受批准小红书 CUA connector 可选构造入口不在启动时创建 session', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-cua-runtime-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const runner = inactiveCuaRunner();
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
    approvedConnectorMap:{
      xiaohongshu:{
        kind:'cua',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:xiaohongshu-cua',
          platform:'xiaohongshu',
          connectorKind:'cua',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{ runner },
      },
    },
  });

  assert.equal(runtime.mode, 'real');
  assert.ok(runtime.connectors.xiaohongshu instanceof CuaPlatformConnector);
  assert.equal(runner.beginCalls, 0);
});

test('direct real Runtime 拒绝小红书发布与指标复用同一命名 Profile', () => {
  const fixture = xhsRuntimeIsolationFixture();
  fixture.profileLease.profileName = fixture.publishRunner.contract.profileName;
  fixture.metricRunner.contract.profileName = fixture.profileLease.profileName;

  assert.throws(
    () => createPublisherRuntime(fixture.options()),
    { code:'publisher_cua_capability_isolation_required' },
  );
  assert.equal(fixture.publishRunner.beginCalls, 0);
  assert.equal(fixture.metricRunner.beginCalls, 0);
});

test('direct real Runtime 拒绝小红书发布与指标复用同一 runner 对象', () => {
  const fixture = xhsRuntimeIsolationFixture();

  assert.throws(
    () => createPublisherRuntime(fixture.options({
      metricRunner:fixture.publishRunner,
    })),
    { code:'publisher_cua_capability_isolation_required' },
  );
  assert.equal(fixture.publishRunner.beginCalls, 0);
});

test('抖音官方Runtime缺少Paperclip账号核验器时构造失败且不读取凭据或HTTP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-identity-required-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  let credentialCalls = 0;
  let httpCalls = 0;
  assert.throws(() => createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-identity-required',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{
          credentialResolver:async () => {
            credentialCalls += 1;
            return { accessToken:'never', openId:'never' };
          },
          httpRequest:async () => {
            httpCalls += 1;
            return {};
          },
        },
      },
    },
  }), { code:'publisher_account_identity_verifier_required' });
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
});

test('真实 connector 缺少 Paperclip 批准引用或批准过期时拒绝构造', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-expired-approval-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const base = {
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    clock:() => new Date(NOW),
  };
  const options = {
    credentialResolver:async () => ({ accessToken:'test', openId:'test' }),
    httpRequest:async () => ({ status:500, body:{} }),
  };

  assert.throws(() => createPublisherRuntime({
    ...base,
    approvedConnectorMap:{
      douyin:{ kind:'douyin_official_api', options },
    },
  }), { code:'real_connector_approval_invalid' });
  assert.throws(() => createPublisherRuntime({
    ...base,
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:expired',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt:'2026-07-29T00:00:00.000Z',
        },
        options,
      },
    },
  }), { code:'real_connector_approval_invalid' });
});

test('长驻 Runtime 的 publish 批准到期后在凭据、HTTP 和 CUA 前失败关闭', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-publish-approval-expiry-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const douyinMedia = Buffer.from('expired-approval-douyin-media');
  const xhsMedia = Buffer.from('expired-approval-xhs-media');
  await fs.writeFile(path.join(root, 'douyin.mp4'), douyinMedia);
  await fs.writeFile(path.join(root, 'xiaohongshu.mp4'), xhsMedia);
  const douyinChecksum =
    `sha256:${crypto.createHash('sha256').update(douyinMedia).digest('hex')}`;
  const xhsChecksum =
    `sha256:${crypto.createHash('sha256').update(xhsMedia).digest('hex')}`;
  let current = new Date('2026-07-30T04:00:00.000Z');
  let credentialCalls = 0;
  let httpCalls = 0;
  const cuaCalls = { begin:0, perform:0, end:0 };
  const runner = {
    contract:{
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode:'isolated_named',
      profileName:'m5-xiaohongshu-expired-approval',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      allowedActions:[...CUA_PUBLISH_ACTIONS],
      arbitraryDesktop:false,
    },
    beginSession:async () => {
      cuaCalls.begin += 1;
      throw new Error('到期批准不应启动 CUA session');
    },
    perform:async () => {
      cuaCalls.perform += 1;
      throw new Error('到期批准不应执行 CUA 动作');
    },
    endSession:async () => {
      cuaCalls.end += 1;
    },
  };
  const expiresAt = '2026-07-30T05:00:00.000Z';
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date(current),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-expiring',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt,
        },
        options:{
          credentialResolver:async () => {
            credentialCalls += 1;
            return { accessToken:'must-not-read', openId:'must-not-read' };
          },
          httpRequest:async () => {
            httpCalls += 1;
            throw new Error('到期批准不应调用 HTTP');
          },
        },
      },
      xiaohongshu:{
        kind:'cua',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:xhs-expiring',
          platform:'xiaohongshu',
          connectorKind:'cua',
          expiresAt,
        },
        options:{ runner },
      },
    },
  });
  current = new Date(expiresAt);
  const makeRequest = ({
    platform,
    contentVersionId,
    contentChecksum,
    mediaPath,
  }) => {
    const input = {
      campaignId:'campaign-m5-expired-publish-approval',
      grant:runtimeGrant(),
      platform,
      contentVersionId,
      contentChecksum,
      scheduledDate:'2026-07-30',
      mediaPath,
      title:'到期批准必须失败关闭',
      body:'不得接触任何真实 connector 依赖。',
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
    input.idempotencyKey = publishIdempotencyKey(input);
    return input;
  };

  await assert.rejects(
    runtime.publish(makeRequest({
      platform:'douyin',
      contentVersionId:'content-expired-douyin',
      contentChecksum:douyinChecksum,
      mediaPath:'douyin.mp4',
    })),
    { code:'real_connector_approval_invalid' },
  );
  await assert.rejects(
    runtime.publish(makeRequest({
      platform:'xiaohongshu',
      contentVersionId:'content-expired-xhs',
      contentChecksum:xhsChecksum,
      mediaPath:'xiaohongshu.mp4',
    })),
    { code:'real_connector_approval_invalid' },
  );
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
  assert.deepEqual(cuaCalls, { begin:0, perform:0, end:0 });
  assert.deepEqual((await runtime.repository.read()).attempts, {});
});

test('publish TOCTOU：首次批准检查通过但 connector 调用前过期时阻断 attempt', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-approval-toctou-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const expiresAt = '2026-07-30T05:00:00.000Z';
  let current = new Date('2026-07-30T04:59:59.999Z');
  let artifactAcquireCalls = 0;
  let artifactReleaseCalls = 0;
  let connectorCalls = 0;
  let credentialCalls = 0;
  let httpCalls = 0;
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date(current),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-toctou',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt,
        },
        options:{
          credentialResolver:async () => {
            credentialCalls += 1;
            return { accessToken:'must-not-read', openId:'must-not-read' };
          },
          httpRequest:async () => {
            httpCalls += 1;
            throw new Error('过期批准不应调用 HTTP');
          },
        },
      },
    },
  });
  runtime.gateway.artifactVerifier = {
    acquire:async (relativePath, checksum) => {
      artifactAcquireCalls += 1;
      current = new Date(expiresAt);
      return {
        relativePath,
        checksum,
        bytes:1,
        immutableLease:true,
        createReadStream:() => {
          throw new Error('过期批准不应读取媒体');
        },
        release:async () => {
          artifactReleaseCalls += 1;
        },
      };
    },
  };
  const originalPublish = runtime.connectors.douyin.publish.bind(runtime.connectors.douyin);
  runtime.connectors.douyin.publish = async (request) => {
    connectorCalls += 1;
    return originalPublish(request);
  };
  const request = {
    campaignId:'campaign-m5-publish-approval-toctou',
    grant:runtimeGrant(),
    platform:'douyin',
    contentVersionId:'content-publish-approval-toctou',
    contentChecksum:`sha256:${'a'.repeat(64)}`,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'批准边界回归',
    body:'首次检查通过，真实调用前到期必须失败关闭。',
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

  await assert.rejects(runtime.publish(request), {
    code:'real_connector_approval_invalid',
  });
  assert.equal(artifactAcquireCalls, 1);
  assert.equal(artifactReleaseCalls, 1);
  assert.equal(connectorCalls, 0);
  assert.equal(credentialCalls, 0);
  assert.equal(httpCalls, 0);
  const state = await runtime.repository.read();
  assert.equal(state.attempts[request.idempotencyKey].state, 'blocked');
  assert.equal(
    state.attempts[request.idempotencyKey].stopReason,
    'real_connector_approval_invalid',
  );
});

test('显式 fake Runtime 缺少 Paperclip 控制适配器时失败关闭', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-runtime-control-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  assert.throws(() => createPublisherRuntime({
    mode:'fake',
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
  }), { code:'paperclip_control_required' });
});

test('fake Runtime 拒绝携带任何真实 approvedConnectorMap', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-mixed-runtime-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  assert.throws(() => createPublisherRuntime({
    mode:'fake',
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter:deterministicCostReporter(),
    approvedConnectorMap:{
      douyin:{ kind:'douyin_official_api' },
    },
  }), { code:'publisher_connector_mode_mismatch' });
});

test('显式 fake Runtime 使用真实文件和文件账本提供回执及显式指标快照', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-runtime-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('controlled-fake-video');
  await fs.writeFile(path.join(root, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  let current = new Date(NOW);
  const runtime = createPublisherRuntime({
    mode:'fake',
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    clock:() => new Date(current),
    paperclipControl:paperclipControl(),
  });
  const request = {
    campaignId:'campaign-m5-runtime',
    grant:runtimeGrant(),
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'本地 fake 发布',
    body:'不会访问真实平台。',
    reviewReport:{
      status:'passed',
      checks:{ facts:true, privacy:true, rights:true, media:true, claims:true, grantScope:true, duplicate:true },
    },
  };
  request.idempotencyKey = publishIdempotencyKey(request);

  const published = await runtime.publish(request);
  current = new Date(Date.parse(published.receipt.publishedAt) + 72 * 3_600_000);
  await runtime.collectMetricSnapshot({
    campaignId:published.receipt.campaignId,
    receiptId:published.receipt.receiptId,
    collectionKey:`${published.receipt.receiptId}:72h`,
    collectedAt:new Date(Date.parse(published.receipt.publishedAt) + 72 * 3_600_000).toISOString(),
  });
  const receipt = await runtime.getReceipt(published.receipt.receiptId);

  assert.equal(receipt.connectorMode, 'fake');
  assert.match(receipt.externalContentId, /^fake-douyin-/);
  assert.equal(receipt.metricSnapshots.length, 1);
});

test('Runtime 暴露受控 reconcileMetricInvocation 并原样委托 Gateway，不给 standalone 增加路由', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-runtime-reconcile-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const runtime = createPublisherRuntime({
    mode:'fake',
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
  });
  const calls = [];
  runtime.gateway.reconcileMetricInvocation = async (input) => {
    calls.push(structuredClone(input));
    return { replayed:false, recovery:{ state:'failed' } };
  };
  const input = {
    campaignId:'campaign-runtime-reconcile',
    receiptId:'55555555-5555-4555-8555-555555555555',
    collectionKey:'55555555-5555-4555-8555-555555555555:2h',
    conclusion:'no_external_effect',
    authorizationId:'paperclip:authorization:runtime-reconcile',
    evidenceRef:'paperclip:work-product:runtime-reconcile',
  };

  const result = await runtime.reconcileMetricInvocation(input);

  assert.deepEqual(calls, [input]);
  assert.equal(result.recovery.state, 'failed');
});

test('生产 Runtime 通过本地注入传输写入准确的官方 connectorMode', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-real-receipt-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('controlled-real-contract-video');
  await fs.writeFile(path.join(root, 'douyin.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const operations = [];
  const costReporter = deterministicCostReporter();
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter,
    accountIdentityVerifier:recordingAccountIdentityVerifier(),
    clock:() => new Date(NOW),
    approvedConnectorMap:{
      douyin:{
        kind:'douyin_official_api',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:douyin-official',
          platform:'douyin',
          connectorKind:'douyin_official_api',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{
          credentialResolver:async () => ({
            accessToken:'test-token-not-from-env',
            openId:'test-open-id',
          }),
          httpRequest:async (input) => {
            operations.push(input.operation);
            if (input.operation === 'upload_video') {
              return {
                status:200,
                actualCost:actualCost(input.operation),
                body:{ data:{ error_code:0, video:{ video_id:'video-1' } } },
              };
            }
            if (input.operation === 'create_video') {
              return {
                status:200,
                actualCost:actualCost(input.operation),
                body:{ data:{ error_code:0, item_id:'item-1', video_id:'video-1' } },
              };
            }
            return {
              status:200,
              actualCost:actualCost(input.operation),
              body:{
                data:{
                  error_code:0,
                  list:[{
                    item_id:'item-1',
                    video_id:'video-1',
                    share_url:'https://www.douyin.com/video/video-1',
                    create_time:1785379200,
                  }],
                },
              },
            };
          },
        },
      },
    },
  });
  const input = {
    campaignId:'campaign-m5-real-runtime',
    grant:runtimeGrant(),
    platform:'douyin',
    contentVersionId:'content-v-real-1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'douyin.mp4',
    title:'本地生产接线契约',
    body:'HTTP 传输完全由测试注入，不访问真实平台。',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
      checks:{ facts:true, privacy:true, rights:true, media:true, claims:true, grantScope:true, duplicate:true },
    },
  };
  input.idempotencyKey = publishIdempotencyKey(input);

  const result = await runtime.publish(input);

  assert.deepEqual(operations, [
    'upload_video',
    'create_video',
    'query_video_basic_info',
  ]);
  assert.equal(result.receipt.connectorMode, 'real:douyin_official_api');
  assert.equal(result.receipt.externalContentId, 'item-1');
  assert.deepEqual(costReporter.reportCalls.map((item) => ({
    connectorMode:item.connectorMode,
    operation:item.operation,
    providerRequestId:item.providerRequestId,
    receiptRef:item.receiptRef,
    amountUsd:item.amountUsd,
  })), [
    {
      connectorMode:'real:douyin_official_api',
      operation:'upload_video',
      providerRequestId:'douyin-request-upload_video',
      receiptRef:null,
      amountUsd:0.01,
    },
    {
      connectorMode:'real:douyin_official_api',
      operation:'create_video',
      providerRequestId:'douyin-request-create_video',
      receiptRef:null,
      amountUsd:0.01,
    },
    {
      connectorMode:'real:douyin_official_api',
      operation:'query_video_basic_info',
      providerRequestId:'douyin-request-query_video_basic_info',
      receiptRef:null,
      amountUsd:0.01,
    },
  ]);
  const state = await runtime.repository.read();
  assert.equal(Object.keys(state.costRecords).length, 3);
  assert.ok(Object.values(state.costRecords).every((item) => item.state === 'reported'));
});

test('生产 Runtime 通过本地假 runner 写入准确的 CUA connectorMode', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-publisher-real-cua-receipt-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const media = Buffer.from('controlled-cua-contract-video');
  await fs.writeFile(path.join(root, 'xiaohongshu.mp4'), media);
  const checksum = `sha256:${crypto.createHash('sha256').update(media).digest('hex')}`;
  const costReporter = deterministicCostReporter();
  const runner = {
    contract:{
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode:'isolated_named',
      profileName:'m5-xiaohongshu-test',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      allowedActions:[...CUA_PUBLISH_ACTIONS],
      arbitraryDesktop:false,
    },
    beginSession:async ({ origin }) => ({
      sessionId:'runtime-cua-session',
      observation:{ kind:'ok', pageState:'ready', origin },
    }),
    perform:async ({ action, expectedOrigin }) => {
      if (action === 'read_result') {
        return {
          kind:'ok',
          pageState:'published',
          origin:expectedOrigin,
          externalContentId:'xhs-content-1',
          evidence:`${expectedOrigin}/content/xhs-content-1`,
          evidenceSnapshotHash:`sha256:${'c'.repeat(64)}`,
          selectorBundleVersion:'1.0.0',
          observedAt:NOW.toISOString(),
          accountIdentityVerified:true,
          publishedAt:NOW.toISOString(),
        };
      }
      return {
        kind:'ok',
        pageState:action === 'submit_publish' ? 'submitted' : 'editing',
        origin:expectedOrigin,
      };
    },
    endSession:async () => {},
  };
  const runtime = createPublisherRuntime({
    mode:'real',
    productionEnabled:true,
    workspaceRoot:root,
    ledgerPath:path.join(root, 'ledger.json'),
    paperclipControl:paperclipControl(),
    costReporter,
    clock:() => new Date(NOW),
    approvedConnectorMap:{
      xiaohongshu:{
        kind:'cua',
        approval:{
          status:'approved',
          approvalRef:'paperclip:connector-approval:xiaohongshu-cua',
          platform:'xiaohongshu',
          connectorKind:'cua',
          expiresAt:'2026-08-06T00:00:00.000Z',
        },
        options:{ runner },
      },
    },
  });
  const input = {
    campaignId:'campaign-m5-real-cua-runtime',
    grant:runtimeGrant(),
    platform:'xiaohongshu',
    contentVersionId:'content-v-cua-1',
    contentChecksum:checksum,
    scheduledDate:'2026-07-30',
    mediaPath:'xiaohongshu.mp4',
    title:'本地 CUA 接线契约',
    body:'runner 完全由测试注入，不启动浏览器。',
    tags:['AI Agent'],
    reviewReport:{
      status:'passed',
      checks:{ facts:true, privacy:true, rights:true, media:true, claims:true, grantScope:true, duplicate:true },
    },
  };
  input.idempotencyKey = publishIdempotencyKey(input);

  const result = await runtime.publish(input);

  assert.equal(result.receipt.connectorMode, 'real:xiaohongshu_cua');
  assert.equal(result.receipt.externalContentId, 'xhs-content-1');
  assert.deepEqual(result.receipt.evidenceObservation, {
    evidenceSnapshotHash:`sha256:${'c'.repeat(64)}`,
    selectorBundleVersion:'1.0.0',
    observedAt:NOW.toISOString(),
    accountIdentityVerified:true,
  });
  assert.equal(costReporter.reportCalls.length, 1);
  assert.deepEqual({
    connectorMode:costReporter.reportCalls[0].connectorMode,
    operation:costReporter.reportCalls[0].operation,
    providerRequestId:costReporter.reportCalls[0].providerRequestId,
    receiptRef:costReporter.reportCalls[0].receiptRef,
    amountUsd:costReporter.reportCalls[0].amountUsd,
  }, {
    connectorMode:'real:xiaohongshu_cua',
    operation:'publish',
    providerRequestId:null,
    receiptRef:input.idempotencyKey,
    amountUsd:0,
  });
});

test('Runtime 源码没有进程内轮询器', async () => {
  const source = await fs.readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval|clearInterval|metricTimer|collectDueMetrics/);
});

function xhsRuntimeIsolationFixture() {
  const publishRunner = inactiveCuaRunner();
  const profileLease = {
    schemaVersion:CUA_PROFILE_LEASE_SCHEMA,
    source:'paperclip',
    status:'approved',
    leaseRef:'paperclip:runtime-isolation:metric-profile',
    platform:'xiaohongshu',
    accountRef:'account:xhs:runtime-isolation',
    profileName:'m5-xiaohongshu-metrics-test',
    identityClaim:{
      kind:'page_identity_sha256',
      value:`sha256:${'a'.repeat(64)}`,
    },
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
  const selectorBundle = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.0.0',
    platform:'xiaohongshu',
    origin:'https://pro.xiaohongshu.com',
    selectorMap:{
      path:'/creator/content',
      identity:{
        accountTextPattern:'^runtime-isolation$',
        contentIdPattern:'^content-[a-z]+$',
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
    approvalRef:'paperclip:runtime-isolation:metric-selector',
    platform:'xiaohongshu',
    bundleVersion:selectorBundle.bundleVersion,
    selectorChecksum:selectorBundleChecksum(selectorBundle),
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
  let metricBeginCalls = 0;
  const metricRunner = {
    contract:{
      schemaVersion:XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
      readOnly:true,
      arbitraryDesktop:false,
      profileMode:'isolated_named',
      profileName:profileLease.profileName,
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      origin:selectorBundle.origin,
      allowedActions:[...XHS_OWN_METRICS_CUA_ACTIONS],
    },
    beginSession:async () => {
      metricBeginCalls += 1;
      throw new Error('构造时不应启动指标 session');
    },
    perform:async () => {
      throw new Error('构造时不应执行指标动作');
    },
    endSession:async () => {},
    get beginCalls() {
      return metricBeginCalls;
    },
  };
  return {
    publishRunner,
    metricRunner,
    profileLease,
    options({ metricRunner:metricRunnerOverride = metricRunner } = {}) {
      return {
        mode:'real',
        productionEnabled:true,
        workspaceRoot:'/tmp/m5-runtime-profile-isolation',
        ledgerPath:'/tmp/m5-runtime-profile-isolation-ledger.json',
        paperclipControl:paperclipControl(),
        costReporter:deterministicCostReporter(),
        clock:() => new Date(NOW),
        approvedConnectorMap:{
          xiaohongshu:{
            kind:'cua',
            approval:{
              status:'approved',
              approvalRef:'paperclip:runtime-isolation:publish',
              platform:'xiaohongshu',
              connectorKind:'cua',
              expiresAt:'2026-08-06T00:00:00.000Z',
            },
            options:{ runner:publishRunner },
          },
        },
        approvedMetricConnectorMap:{
          xiaohongshu:{
            kind:'xhs_own_metrics_cua',
            approval:{
              status:'approved',
              approvalRef:'paperclip:runtime-isolation:metrics',
              platform:'xiaohongshu',
              capability:'read_own_metrics',
              connectorKind:'xhs_own_metrics_cua',
              expiresAt:'2026-08-06T00:00:00.000Z',
            },
            options:{
              runner:metricRunnerOverride,
              selectorBundle,
              profileLease,
            },
          },
        },
      };
    },
  };
}
