import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  CUA_PROFILE_LEASE_SCHEMA,
  CUA_SELECTOR_BUNDLE_SCHEMA,
  selectorBundleChecksum,
} from '../src/cua-trust-contracts.ts';
import {
  XHS_OWN_METRICS_CUA_ACTIONS,
  XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
  XhsOwnMetricsCuaConnector,
} from '../src/xhs-own-metrics-cua-connector.ts';

const NOW = new Date('2026-07-30T10:00:00.000Z');
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_REF = 'account:xhs:primary';
const CONTENT_ID = 'note-owned-1';
const IDENTITY_HASH = `sha256:${'b'.repeat(64)}`;

test('独立五步只读 runner 输出直接进入既有本人指标规范化契约', async () => {
  const runner = fakeRunner();
  const connector = connectorFixture({ runner });
  const result = await connector.collect(collectionFixture());

  assert.deepEqual(runner.actions, [...XHS_OWN_METRICS_CUA_ACTIONS]);
  assert.equal(runner.beginInputs.length, 1);
  assert.deepEqual(runner.beginInputs[0].allowedActions, [
    'navigate',
    'read',
    'filter',
    'open_detail',
    'read_metrics',
  ]);
  assert.deepEqual(runner.beginInputs[0].profile, {
    mode:'isolated_named',
    name:'xhs-metrics-primary',
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
  });
  assert.equal(runner.beginInputs[0].accountRef, ACCOUNT_REF);
  assert.equal(runner.beginInputs[0].externalContentId, CONTENT_ID);
  assert.equal(runner.beginInputs[0].readOnly, true);
  assert.equal(runner.endInputs.length, 1);
  assert.equal(runner.endInputs[0].readOnly, true);
  assert.deepEqual(result.metrics, {
    views:1234,
    likes:56,
    saves:7,
    comments:0,
  });
  assert.equal(result.accountRef, ACCOUNT_REF);
  assert.equal(result.externalContentId, CONTENT_ID);
  assert.equal(result.source.kind, 'official_creator_ui');
  assert.equal(result.source.origin, 'https://pro.xiaohongshu.com');
  assert.equal(Object.isFrozen(result), true);
});

test('runner 契约与发布六步完全隔离，额外、缺失或发布动作都拒绝', () => {
  for (const allowedActions of [
    ['navigate', 'read', 'filter', 'open_detail'],
    [...XHS_OWN_METRICS_CUA_ACTIONS, 'submit_publish'],
    ['navigate', 'read', 'filter', 'open_detail', 'submit_publish'],
  ]) {
    assert.throws(
      () => connectorFixture({
        runner:fakeRunner({
          contract:{ allowedActions },
        }),
      }),
      { code:'xhs_metrics_cua_runner_contract_mismatch' },
    );
  }
});

test('批准 selector、未过期 Profile lease、accountRef、origin 和内容 ID 缺一即在会话前拒绝', async () => {
  const cases = [
    {
      mutate({ selectorBundle }) {
        selectorBundle.approval.status = 'pending';
      },
      code:'xhs_metrics_cua_selector_invalid',
    },
    {
      mutate({ selectorBundle }) {
        selectorBundle.origin = 'https://www.xiaohongshu.com';
        resign(selectorBundle);
      },
      code:'xhs_metrics_cua_selector_invalid',
    },
    {
      mutate({ profileLease }) {
        profileLease.expiresAt = '2026-07-30T09:59:59.999Z';
      },
      code:'cua_profile_lease_invalid',
    },
    {
      mutate({ profileLease }) {
        profileLease.identityClaim.value = 'not-a-hash';
      },
      code:'cua_profile_lease_invalid',
    },
  ];
  for (const item of cases) {
    const fixtures = trustFixtures();
    item.mutate(fixtures);
    const runner = fakeRunner();
    assert.throws(
      () => connectorFixture({ runner, ...fixtures }),
      { code:item.code },
    );
    assert.equal(runner.beginInputs.length, 0);
  }

  const runner = fakeRunner();
  const connector = connectorFixture({ runner });
  const request = collectionFixture();
  request.trustedReceipt.accountRef = 'account:xhs:other';
  await assert.rejects(
    connector.collect(request),
    { code:'cua_profile_lease_invalid' },
  );
  assert.equal(runner.beginInputs.length, 0);

  const invalidContent = collectionFixture();
  invalidContent.trustedReceipt.externalContentId = '';
  await assert.rejects(
    connector.collect(invalidContent),
    { code:'xhs_metrics_cua_request_invalid' },
  );
});

test('metric selector 使用精确 schema，Secret-like 或任意额外字段在会话前 fail closed', () => {
  const cases = [
    (selectorMap) => {
      selectorMap.cookie = 'SENTINEL_NOT_A_REAL_SECRET';
    },
    (selectorMap) => {
      selectorMap.identity.accessToken = 'SENTINEL_NOT_A_REAL_SECRET';
    },
    (selectorMap) => {
      selectorMap.actions.read.authorization = 'SENTINEL_NOT_A_REAL_SECRET';
    },
    (selectorMap) => {
      selectorMap.unapprovedMetadata = 'not-secret-but-not-approved';
    },
    (selectorMap) => {
      selectorMap.metrics.payload = 'SENTINEL_NOT_A_REAL_SECRET';
    },
  ];

  for (const mutate of cases) {
    const fixtures = trustFixtures();
    mutate(fixtures.selectorBundle.selectorMap);
    resign(fixtures.selectorBundle);
    const runner = fakeRunner();

    assert.throws(
      () => connectorFixture({ runner, ...fixtures }),
      { code:'xhs_metrics_cua_selector_invalid' },
    );
    assert.equal(runner.beginInputs.length, 0);
  }
});

test('captcha、login、risk、account switch 和 unknown page 均硬停且关闭会话', async () => {
  for (const reason of [
    'captcha',
    'login',
    'login_required',
    'risk',
    'risk_control',
    'account_switch',
    'unknown_page',
  ]) {
    const runner = fakeRunner({ stopAt:'filter', stopReason:reason });
    const connector = connectorFixture({ runner });
    await assert.rejects(
      connector.collect(collectionFixture()),
      (error) => (
        error.code === `xhs_metrics_cua_stopped_${reason}`
        && error.stopReason === reason
        && error.hardStop === true
      ),
      reason,
    );
    assert.equal(runner.endInputs.length, 1);
  }
});

test('页面账号身份、内容 ID、selector 或 origin 漂移都不能生成 MetricSnapshot', async () => {
  for (const mutation of [
    (observation) => {
      observation.identityClaim.value = `sha256:${'c'.repeat(64)}`;
    },
    (observation) => {
      observation.externalContentId = 'note-other';
    },
    (observation) => {
      observation.selectorBundleVersion = '1.0.1';
    },
    (observation) => {
      observation.origin = 'https://creator.xiaohongshu.com';
    },
  ]) {
    const runner = fakeRunner({ finalMutation:mutation });
    const connector = connectorFixture({ runner });
    await assert.rejects(
      connector.collect(collectionFixture()),
      (error) => error.hardStop === true,
    );
    assert.equal(runner.endInputs.length, 1);
  }
});

test('叶模块不实现浏览器 bridge、网络、文件或进程能力，也不包含发布动作', async () => {
  const source = await fs.readFile(
    new URL('../src/xhs-own-metrics-cua-connector.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /node:(?:child_process|fs|http|https|net)|fetch\s*\(|cua-driver|browser_/,
  );
  assert.doesNotMatch(
    source,
    /upload_media|set_title|set_body|set_tags|submit_publish|read_result/,
  );
  assert.doesNotMatch(source, /from '\.\/cua-connector\.ts'/);
});

function connectorFixture({
  runner = fakeRunner(),
  selectorBundle,
  profileLease,
} = {}) {
  const fixtures = trustFixtures();
  return new XhsOwnMetricsCuaConnector({
    runner,
    selectorBundle:selectorBundle ?? fixtures.selectorBundle,
    profileLease:profileLease ?? fixtures.profileLease,
    enabled:true,
    clock:() => new Date(NOW),
  });
}

function trustFixtures() {
  const selectorBundle = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.0.0',
    platform:'xiaohongshu',
    origin:'https://pro.xiaohongshu.com',
    selectorMap:{
      path:'/creator/content',
      identity:{
        accountTextPattern:'^owner-account$',
        contentIdPattern:'^note-[a-z0-9-]+$',
      },
      actions:{
        navigate:{ label:'打开本人内容列表' },
        read:{ label:'读取页面账号身份' },
        filter:{ label:'按平台内容ID筛选' },
        open_detail:{ label:'打开本人笔记详情' },
        read_metrics:{ label:'读取四项精确指标' },
      },
      metrics:['views', 'likes', 'saves', 'comments'],
    },
  };
  selectorBundle.approval = {
    source:'paperclip',
    status:'approved',
    approvalRef:'paperclip:xhs-own-metrics-selector-v1',
    platform:'xiaohongshu',
    bundleVersion:'1.0.0',
    selectorChecksum:selectorBundleChecksum(selectorBundle),
    expiresAt:'2026-08-06T16:00:00.000Z',
  };
  const profileLease = {
    schemaVersion:CUA_PROFILE_LEASE_SCHEMA,
    source:'paperclip',
    status:'approved',
    leaseRef:'paperclip:xhs-own-metrics-profile-v1',
    platform:'xiaohongshu',
    accountRef:ACCOUNT_REF,
    profileName:'xhs-metrics-primary',
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
    expiresAt:'2026-08-06T16:00:00.000Z',
  };
  return { selectorBundle, profileLease };
}

function resign(selectorBundle) {
  selectorBundle.approval.selectorChecksum =
    selectorBundleChecksum(selectorBundle);
}

function collectionFixture() {
  return {
    trustedReceipt:{
      receiptId:RECEIPT_ID,
      platform:'xiaohongshu',
      accountRef:ACCOUNT_REF,
      externalContentId:CONTENT_ID,
      contentVersionId:'content-v1',
    },
    checkpoint:'2h',
    collectionKey:`${RECEIPT_ID}:2h`,
    collectedAt:'2026-07-30T10:00:00.000Z',
  };
}

function fakeRunner({
  contract = {},
  stopAt = null,
  stopReason = null,
  finalMutation = null,
} = {}) {
  const runner = {
    contract:{
      schemaVersion:XHS_OWN_METRICS_CUA_RUNNER_SCHEMA,
      readOnly:true,
      arbitraryDesktop:false,
      profileMode:'isolated_named',
      profileName:'xhs-metrics-primary',
      selectorTrust:'approved_bundle',
      accountIdentityVerification:'page_identity_sha256',
      origin:'https://pro.xiaohongshu.com',
      allowedActions:[...XHS_OWN_METRICS_CUA_ACTIONS],
      ...contract,
    },
    beginInputs:[],
    performInputs:[],
    endInputs:[],
    actions:[],
    async beginSession(input) {
      this.beginInputs.push(structuredClone(input));
      return {
        sessionId:'xhs-metrics-session-1',
        observation:baseObservation('ready'),
      };
    },
    async perform(input) {
      this.performInputs.push(structuredClone(input));
      this.actions.push(input.action);
      if (input.action === stopAt) {
        return {
          kind:'stop',
          origin:'https://pro.xiaohongshu.com',
          reason:stopReason,
        };
      }
      const observation = observationFor(input.action);
      if (input.action === 'read_metrics' && finalMutation) {
        finalMutation(observation);
      }
      return observation;
    },
    async endSession(input) {
      this.endInputs.push(structuredClone(input));
    },
  };
  return runner;
}

function observationFor(action) {
  if (action === 'navigate') return baseObservation('content_list');
  if (action === 'read') {
    return {
      ...baseObservation('account_verified'),
      accountRef:ACCOUNT_REF,
      identityClaim:{
        kind:'page_identity_sha256',
        value:IDENTITY_HASH,
      },
    };
  }
  if (action === 'filter') {
    return {
      ...baseObservation('content_filtered'),
      accountRef:ACCOUNT_REF,
      externalContentId:CONTENT_ID,
    };
  }
  if (action === 'open_detail') {
    return {
      ...baseObservation('own_note_detail'),
      accountRef:ACCOUNT_REF,
      externalContentId:CONTENT_ID,
    };
  }
  return {
    ...baseObservation('own_note_detail'),
    accountRef:ACCOUNT_REF,
    identityClaim:{
      kind:'page_identity_sha256',
      value:IDENTITY_HASH,
    },
    externalContentId:CONTENT_ID,
    selectorBundleVersion:'1.0.0',
    selectorChecksum:selectorBundleChecksum(trustFixtures().selectorBundle),
    metrics:{
      views:'1,234',
      likes:'56',
      saves:7,
      comments:0,
    },
  };
}

function baseObservation(pageState) {
  return {
    kind:'ok',
    origin:'https://pro.xiaohongshu.com',
    pageState,
    observedAt:'2026-07-30T09:59:58.000Z',
  };
}
