import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  CUA_PLATFORM_ORIGINS,
  CUA_PROFILE_LEASE_SCHEMA,
  CUA_PUBLISH_ACTIONS,
  CUA_SELECTOR_BUNDLE_SCHEMA,
  CuaDriverPublisherRunner,
  CuaPlatformConnector,
  parseBrowserPrepareResult,
  selectorBundleChecksum,
} from '../src/index.js';

const PUBLISHED_AT = '2026-07-30T08:00:00.000Z';

test('CuaDriver 0.14.1 browser_prepare 先保留结构化 refusal，再解析 prepared_pid', () => {
  assert.throws(
    () => parseBrowserPrepareResult({
      status:'refused',
      refusal:{
        code:'browser_consent_required',
        message:'browser preparation approval token is malformed or expired',
      },
    }),
    {
      code:'browser_consent_required',
      message:'browser preparation approval token is malformed or expired',
    },
  );
  assert.equal(parseBrowserPrepareResult({
    status:'ok',
    prepared_pid:43210,
    side_effects:['launched_isolated_browser'],
  }), 43210);
  assert.equal(parseBrowserPrepareResult({
    content:[{
      type:'text',
      text:JSON.stringify({
        status:'ok',
        attachment:{ prepared_pid:43211 },
      }),
    }],
  }), 43211);
  assert.throws(
    () => parseBrowserPrepareResult({ status:'ok' }),
    { code:'prepared_browser_pid_missing' },
  );
});

class FakeBridge {
  constructor({ initialText = '创作中心 账号: douyin-test-user' } = {}) {
    this.text = initialText;
    this.url = `${CUA_PLATFORM_ORIGINS.douyin}/creator`;
    this.calls = [];
    this.closed = [];
    this.recordedUpload = null;
    this.title = '';
  }

  async open(input) {
    this.calls.push({ action:'open', input });
    return { id:'bridge-1', origin:input.origin };
  }

  async snapshot(session) {
    this.calls.push({ action:'snapshot' });
    return {
      url:this.url,
      text:this.text,
    };
  }

  async upload(session, selector, file) {
    this.recordedUpload = {
      selector,
      file,
      bytes:await fs.readFile(file),
      mode:(await fs.stat(file)).mode & 0o777,
    };
    this.calls.push({ action:'upload_media' });
    return this.snapshot(session);
  }

  async type(session, selector, text) {
    this.calls.push({ action:selector.action, text });
    if (selector.action === 'set_title') this.title = text;
    return this.snapshot(session);
  }

  async click(session) {
    this.calls.push({ action:'submit_publish' });
    this.text = `发布成功 dy-content-a1b2c3 ${this.title}`;
    this.url = `${session.origin}/content/dy-content-a1b2c3`;
    return this.snapshot(session);
  }

  async close(session) {
    this.closed.push(session.id);
  }
}

class DelayedResultBridge extends FakeBridge {
  constructor({ publishOnPoll = 3 } = {}) {
    super();
    this.publishOnPoll = publishOnPoll;
    this.pollsAfterSubmit = 0;
    this.submitted = false;
  }

  async snapshot(session) {
    if (this.submitted) {
      this.pollsAfterSubmit += 1;
      this.text = this.pollsAfterSubmit >= this.publishOnPoll
        ? `发布成功 dy-content-delayed ${this.title}`
        : '发布处理中';
      if (this.pollsAfterSubmit >= this.publishOnPoll) {
        this.url = `${session.origin}/content/dy-content-delayed`;
      }
    }
    return super.snapshot(session);
  }

  async click(session) {
    this.calls.push({ action:'submit_publish' });
    this.submitted = true;
    this.text = '发布处理中';
    return this.snapshot(session);
  }
}

function selectorMap(platform = 'douyin') {
  const origin = CUA_PLATFORM_ORIGINS[platform];
  return {
    platform,
    origin,
    path:'/creator',
    identity:{
      accountTextPattern:'账号:\\s*([A-Za-z0-9_-]+)',
    },
    actions:{
      upload_media:{ label:'上传视频', action:'upload_media' },
      set_title:{ label:'标题', action:'set_title' },
      set_body:{ label:'正文', action:'set_body' },
      set_tags:{ label:'标签', action:'set_tags' },
      submit_publish:{ label:'发布', action:'submit_publish' },
    },
    result:{
      successText:'发布成功',
      contentIdPattern:'dy-content-[a-z0-9]+',
      evidencePathPrefix:'/content/',
    },
  };
}

function selectorBundle(platform = 'douyin') {
  const selector = selectorMap(platform);
  const document = {
    schemaVersion:CUA_SELECTOR_BUNDLE_SCHEMA,
    bundleVersion:'1.0.0',
    platform,
    origin:selector.origin,
    selectorMap:{
      path:selector.path,
      identity:selector.identity,
      actions:selector.actions,
      result:selector.result,
    },
  };
  return {
    ...document,
    approval:{
      source:'paperclip',
      status:'approved',
      approvalRef:`paperclip:cua-selector:${platform}-v1`,
      platform,
      bundleVersion:'1.0.0',
      selectorChecksum:selectorBundleChecksum(document),
      expiresAt:'2026-08-06T00:00:00.000Z',
    },
  };
}

function profileLease(platform = 'douyin') {
  return {
    schemaVersion:CUA_PROFILE_LEASE_SCHEMA,
    source:'paperclip',
    status:'approved',
    leaseRef:`paperclip:cua-profile-lease:${platform}-test`,
    platform,
    accountRef:`account:${platform}:test`,
    profileName:`m5-${platform}-test`,
    identityClaim:{
      kind:'page_identity_sha256',
      value:`sha256:${crypto.createHash('sha256').update(`${platform}-test-user`).digest('hex')}`,
    },
    expiresAt:'2026-08-06T00:00:00.000Z',
  };
}

function mediaFixture(value = 'verified media') {
  const bytes = Buffer.from(value);
  return {
    verifiedMedia:{
      relativePath:'douyin.mp4',
      checksum:`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      bytes:bytes.length,
      immutableLease:true,
    },
    mediaLease:{
      immutableLease:true,
      createReadStream() {
        return Readable.from([bytes]);
      },
    },
  };
}

function publishRequest(overrides = {}) {
  return {
    accountRef:'account:douyin:test',
    title:'AI Agent 实战',
    body:'只在受控 runner 中验证。',
    tags:['#AI-Agent', '#受控发布'],
    ...mediaFixture(),
    ...overrides,
  };
}

test('真实 CuaDriver runner 默认关闭', async () => {
  const runner = new CuaDriverPublisherRunner();
  await assert.rejects(
    runner.beginSession({
      platform:'douyin',
      origin:CUA_PLATFORM_ORIGINS.douyin,
      profile:{ mode:'isolated_new' },
      allowedActions:[...CUA_PUBLISH_ACTIONS],
    }),
    { code:'cua_runner_disabled' },
  );
});

test('runner 只执行固定六步、复制并复核媒体 lease，结束后清理私有目录', async () => {
  const bridge = new FakeBridge();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-cua-runner-test-'));
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
    temporaryRoot:root,
    clock:() => new Date(PUBLISHED_AT),
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  try {
    const result = await connector.publish(publishRequest());
    assert.equal(result.state, 'published');
    assert.equal(result.externalContentId, 'dy-content-a1b2c3');
    assert.equal(result.evidence, 'https://creator.douyin.com/content/dy-content-a1b2c3');
    assert.equal(result.accountRef, 'account:douyin:test');
    assert.equal(result.publishedAt, PUBLISHED_AT);
    assert.equal(result.observedAt, PUBLISHED_AT);
    assert.equal(result.selectorBundleVersion, '1.0.0');
    assert.equal(result.accountIdentityVerified, true);
    assert.match(result.evidenceSnapshotHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(bridge.recordedUpload.bytes.toString(), 'verified media');
    assert.equal(bridge.recordedUpload.mode, 0o400);
    assert.deepEqual(
      bridge.calls.filter((call) => CUA_PUBLISH_ACTIONS.includes(call.action))
        .map((call) => call.action),
      [...CUA_PUBLISH_ACTIONS.slice(0, -1)],
    );
    assert.deepEqual(bridge.closed, ['bridge-1']);
    await assert.rejects(fs.stat(bridge.recordedUpload.file), { code:'ENOENT' });
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('媒体哈希或字节数漂移时在上传前硬失败并清理 session', async () => {
  const bridge = new FakeBridge();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-cua-runner-test-'));
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
    temporaryRoot:root,
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });
  const request = publishRequest();
  request.verifiedMedia.bytes += 1;

  try {
    await assert.rejects(
      connector.publish(request),
      { code:'cua_media_verification_failed' },
    );
    assert.equal(bridge.recordedUpload, null);
    assert.deepEqual(bridge.closed, ['bridge-1']);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('验证码首次出现即停止，不执行上传或表单动作', async () => {
  const bridge = new FakeBridge({ initialText:'请先完成验证码 CAPTCHA' });
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest());
  assert.equal(result.state, 'stopped');
  assert.equal(result.stopReason, 'captcha');
  assert.equal(bridge.recordedUpload, null);
  assert.deepEqual(bridge.closed, ['bridge-1']);
});

test('页面登录账号与 Profile lease 哈希不一致时在上传前停止', async () => {
  const bridge = new FakeBridge({ initialText:'创作中心 账号: another-user' });
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest());

  assert.equal(result.state, 'stopped');
  assert.equal(result.stopReason, 'account_switch');
  assert.equal(bridge.recordedUpload, null);
  assert.deepEqual(bridge.closed, ['bridge-1']);
});

test('缺少经审计 selector map 或动作乱序均拒绝', async () => {
  const bridge = new FakeBridge();
  const withoutMap = new CuaDriverPublisherRunner({ enabled:true, bridge });
  await assert.rejects(
    withoutMap.beginSession({
      platform:'xiaohongshu',
      origin:CUA_PLATFORM_ORIGINS.xiaohongshu,
      profile:{ mode:'isolated_new' },
      allowedActions:[...CUA_PUBLISH_ACTIONS],
    }),
    { code:'cua_selector_map_missing' },
  );

  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorMaps:{ douyin:selectorMap() },
    profileLease:profileLease(),
    bridge,
    clock:() => new Date(PUBLISHED_AT),
  });
  const session = await runner.beginSession({
    platform:'douyin',
    accountRef:'account:douyin:test',
    origin:CUA_PLATFORM_ORIGINS.douyin,
    profile:{ mode:'isolated_named', name:'m5-douyin-test' },
    allowedActions:[...CUA_PUBLISH_ACTIONS],
  });
  try {
    await assert.rejects(
      runner.perform({
        sessionId:session.sessionId,
        platform:'douyin',
        expectedOrigin:CUA_PLATFORM_ORIGINS.douyin,
        action:'submit_publish',
        input:{},
      }),
      { code:'cua_action_sequence_invalid' },
    );
  } finally {
    await runner.endSession({ sessionId:session.sessionId });
  }
});

test('提交后只读有界轮询等待平台回执，不会二次点击发布', async () => {
  const bridge = new DelayedResultBridge({ publishOnPoll:4 });
  const sleeps = [];
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
    clock:() => new Date(PUBLISHED_AT),
    resultPollAttempts:5,
    resultPollIntervalMs:10,
    sleep:async (milliseconds) => sleeps.push(milliseconds),
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest());

  assert.equal(result.state, 'published');
  assert.equal(result.externalContentId, 'dy-content-delayed');
  assert.equal(
    bridge.calls.filter((call) => call.action === 'submit_publish').length,
    1,
  );
  assert.ok(bridge.pollsAfterSubmit >= 4);
  assert.ok(sleeps.length <= 4);
  assert.ok(sleeps.every((value) => value === 10));
});

test('回执在有界轮询内未出现时按 unknown_page 停止且不重发', async () => {
  const bridge = new DelayedResultBridge({ publishOnPoll:99 });
  const runner = new CuaDriverPublisherRunner({
    enabled:true,
    selectorBundles:{ douyin:selectorBundle() },
    profileLease:profileLease(),
    bridge,
    resultPollAttempts:3,
    resultPollIntervalMs:0,
  });
  const connector = new CuaPlatformConnector({
    platform:'douyin',
    runner,
    enabled:true,
  });

  const result = await connector.publish(publishRequest());

  assert.equal(result.state, 'stopped');
  assert.equal(result.stopReason, 'unknown_page');
  assert.equal(
    bridge.calls.filter((call) => call.action === 'submit_publish').length,
    1,
  );
  assert.ok(bridge.pollsAfterSubmit <= 5);
});
