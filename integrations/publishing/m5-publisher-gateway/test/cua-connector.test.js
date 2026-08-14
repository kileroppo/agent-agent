import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUA_PLATFORM_ORIGINS,
  CUA_PUBLISH_ACTIONS,
  CUA_RUNNER_SCHEMA,
  CuaPlatformConnector,
  buildPlatformCuaSessionPolicy
} from '../src/index.ts';

const PUBLISHED_AT = '2026-07-30T04:00:00.000Z';

function runnerContract(overrides = {}) {
  return {
    schemaVersion:CUA_RUNNER_SCHEMA,
    profileMode:'isolated_named',
    profileName:'m5-platform-test',
    selectorTrust:'approved_bundle',
    accountIdentityVerification:'page_identity_sha256',
    allowedActions:[...CUA_PUBLISH_ACTIONS],
    arbitraryDesktop:false,
    ...overrides,
  };
}

class FakeCuaRunner {
  constructor({ observations = [], contract = runnerContract() } = {}) {
    this.contract = contract;
    this.observations = [...observations];
    this.beginCalls = [];
    this.performCalls = [];
    this.endCalls = [];
  }

  async beginSession(input) {
    this.beginCalls.push(structuredClone(input));
    return {
      sessionId:'cua-session-1',
      observation:{
        kind:'ok',
        pageState:'ready',
        origin:input.origin,
      },
    };
  }

  async perform(input) {
    this.performCalls.push(input);
    if (this.observations.length) return this.observations.shift();
    if (input.action === 'read_result') {
      return {
        kind:'ok',
        pageState:'published',
        origin:input.expectedOrigin,
        externalContentId:'content-123',
        evidence:`${input.expectedOrigin}/content/content-123`,
        evidenceSnapshotHash:`sha256:${'b'.repeat(64)}`,
        selectorBundleVersion:'1.0.0',
        observedAt:PUBLISHED_AT,
        accountIdentityVerified:true,
        publishedAt:PUBLISHED_AT,
      };
    }
    return {
      kind:'ok',
      pageState:input.action === 'submit_publish' ? 'submitted' : 'editing',
      origin:input.expectedOrigin,
    };
  }

  async endSession(input) {
    this.endCalls.push(structuredClone(input));
  }
}

function publishRequest(platform) {
  return {
    platform,
    accountRef:`account:${platform}:test`,
    title:'AI Agent实战',
    body:'受控 CUA runner 契约测试',
    tags:['AI Agent', '自动化'],
    verifiedMedia:{
      relativePath:`${platform}.mp4`,
      checksum:`sha256:${'a'.repeat(64)}`,
      bytes:1024,
      immutableLease:true,
    },
    mediaLease:{
      createReadStream() {
        throw new Error('纯契约测试不应读取真实媒体。');
      },
    },
  };
}

for (const platform of ['douyin', 'xiaohongshu']) {
  test(`${platform} 只按固定六步操作精确官方 origin 和独立 profile`, async () => {
    const runner = new FakeCuaRunner();
    const connector = new CuaPlatformConnector({ platform, runner, enabled:true });
    const input = publishRequest(platform);

    const result = await connector.publish(input);

    assert.deepEqual(runner.beginCalls, [{
      platform,
      origin:CUA_PLATFORM_ORIGINS[platform],
      accountRef:`account:${platform}:test`,
      profile:{ mode:'isolated_named', name:'m5-platform-test' },
      allowedActions:[...CUA_PUBLISH_ACTIONS],
    }]);
    assert.deepEqual(
      runner.performCalls.map((call) => call.action),
      [...CUA_PUBLISH_ACTIONS],
    );
    assert.equal(runner.performCalls[0].input.mediaLease, input.mediaLease);
    assert.equal(Object.hasOwn(runner.performCalls[0].input, 'mediaPath'), false);
    assert.deepEqual(runner.performCalls[1].input, { text:input.title });
    assert.deepEqual(runner.performCalls[2].input, { text:input.body });
    assert.deepEqual(runner.performCalls[3].input, { tags:input.tags });
    assert.deepEqual(runner.performCalls[5].input, { expectedTitle:input.title });
    assert.equal(runner.endCalls.length, 1);
    assert.deepEqual(result, {
      state:'published',
      externalContentId:'content-123',
      evidence:`${CUA_PLATFORM_ORIGINS[platform]}/content/content-123`,
      evidenceSnapshotHash:`sha256:${'b'.repeat(64)}`,
      selectorBundleVersion:'1.0.0',
      observedAt:PUBLISHED_AT,
      accountIdentityVerified:true,
      accountRef:input.accountRef,
      publishedAt:PUBLISHED_AT,
    });
  });
}

test('CUA connector 默认关闭且不接触 runner', async () => {
  const runner = new FakeCuaRunner();
  const connector = new CuaPlatformConnector({ platform:'douyin', runner });

  await assert.rejects(
    connector.publish(publishRequest('douyin')),
    { code:'cua_connector_disabled' },
  );
  assert.equal(runner.beginCalls.length, 0);
});

test('runner 契约多开放任意动作时拒绝构造', () => {
  const runner = new FakeCuaRunner({
    contract:runnerContract({
      allowedActions:[...CUA_PUBLISH_ACTIONS, 'comment'],
    }),
  });
  assert.throws(
    () => new CuaPlatformConnector({ platform:'douyin', runner, enabled:true }),
    { code:'cua_runner_contract_mismatch' },
  );
});

for (const reason of [
  'captcha',
  'identity_verification',
  'account_switch',
  'risk_control',
  'platform_violation',
  'unknown_page',
]) {
  test(`${reason} 首次出现即硬停并结束 session`, async () => {
    const origin = CUA_PLATFORM_ORIGINS.douyin;
    const runner = new FakeCuaRunner({
      observations:[{ kind:'stop', reason, origin }],
    });
    const connector = new CuaPlatformConnector({
      platform:'douyin',
      runner,
      enabled:true,
    });

    const result = await connector.publish(publishRequest('douyin'));

    assert.deepEqual(result, {
      state:'stopped',
      stopReason:reason,
      evidence:`${origin}/`,
    });
    assert.equal(runner.performCalls.length, 1);
    assert.equal(runner.endCalls.length, 1);
  });
}

test('origin 漂移或 runner 返回未知状态一律按 unknown_page 硬停', async () => {
  const runner = new FakeCuaRunner({
    observations:[{
      kind:'ok',
      pageState:'editing',
      origin:'https://evil.example',
    }],
  });
  const connector = new CuaPlatformConnector({
    platform:'xiaohongshu',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest('xiaohongshu'));

  assert.equal(result.state, 'stopped');
  assert.equal(result.stopReason, 'unknown_page');
  assert.equal(runner.performCalls.length, 1);
});

test('只返回成功文案和内容ID、缺少账号与结果页证据时不得记为发布成功', async () => {
  const origin = CUA_PLATFORM_ORIGINS.douyin;
  const runner = new FakeCuaRunner({
    observations:[
      { kind:'ok', pageState:'editing', origin },
      { kind:'ok', pageState:'editing', origin },
      { kind:'ok', pageState:'editing', origin },
      { kind:'ok', pageState:'editing', origin },
      { kind:'ok', pageState:'submitted', origin },
      {
        kind:'ok',
        pageState:'published',
        origin,
        externalContentId:'content-weak',
        evidence:`${origin}/content/content-weak`,
        publishedAt:PUBLISHED_AT,
      },
    ],
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest('douyin'));

  assert.deepEqual(result, {
    state:'stopped',
    stopReason:'unknown_page',
    evidence:`${origin}/`,
  });
  assert.equal(runner.performCalls.length, CUA_PUBLISH_ACTIONS.length);
  assert.equal(runner.endCalls.length, 1);
});

test('强发布回执任一身份、哈希、版本、时间或来源字段无效都不得记为成功', async () => {
  for (const [field, value] of [
    ['externalContentId', ''],
    ['accountIdentityVerified', false],
    ['evidenceSnapshotHash', 'sha256:invalid'],
    ['selectorBundleVersion', 'latest'],
    ['observedAt', 'not-a-timestamp'],
    ['publishedAt', 'not-a-timestamp'],
    ['evidence', 'https://evil.example/content/content-123'],
  ]) {
    const origin = CUA_PLATFORM_ORIGINS.douyin;
    const finalObservation = {
      kind:'ok',
      pageState:'published',
      origin,
      externalContentId:'content-123',
      evidence:`${origin}/content/content-123`,
      evidenceSnapshotHash:`sha256:${'b'.repeat(64)}`,
      selectorBundleVersion:'1.0.0',
      observedAt:PUBLISHED_AT,
      accountIdentityVerified:true,
      publishedAt:PUBLISHED_AT,
      [field]:value,
    };
    const runner = new FakeCuaRunner({
      observations:[
        { kind:'ok', pageState:'editing', origin },
        { kind:'ok', pageState:'editing', origin },
        { kind:'ok', pageState:'editing', origin },
        { kind:'ok', pageState:'editing', origin },
        { kind:'ok', pageState:'submitted', origin },
        finalObservation,
      ],
    });
    const connector = new CuaPlatformConnector({
      platform:'douyin',
      runner,
      enabled:true,
    });

    const result = await connector.publish(publishRequest('douyin'));

    assert.deepEqual(result, {
      state:'stopped',
      stopReason:'unknown_page',
      evidence:`${origin}/`,
    }, field);
    assert.equal(runner.performCalls.length, CUA_PUBLISH_ACTIONS.length, field);
    assert.equal(runner.endCalls.length, 1, field);
  }
});

test('平台 policy 复用 bounded 工具集，只允许精确官方 origin 和隔离 profile', () => {
  for (const platform of ['douyin', 'xiaohongshu']) {
    const policy = buildPlatformCuaSessionPolicy({
      platform,
      readableDirectory:'/tmp/m5-cua-upload',
    });
    assert.match(policy, /mode: bounded/);
    assert.match(policy, /kind: isolated/);
    assert.match(
      policy,
      new RegExp(CUA_PLATFORM_ORIGINS[platform].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const other = platform === 'douyin' ? 'creator.xiaohongshu.com' : 'creator.douyin.com';
    assert.doesNotMatch(policy, new RegExp(other.replaceAll('.', '\\.')));
    assert.match(policy, /display: false/);
    assert.match(policy, /write: \[\]/);
  }
  assert.throws(
    () => buildPlatformCuaSessionPolicy({
      platform:'unknown',
      readableDirectory:'/tmp/m5-cua-upload',
    }),
    { code:'unsupported_cua_platform' },
  );
});
