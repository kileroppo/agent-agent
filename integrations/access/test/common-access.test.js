import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStore } from '../connection-store.js';
import { ConnectionBroker } from '../connection-broker.js';
import { ContentAcquisitionCenter } from '../content-acquisition-center.js';
import { OperationsEventStore } from '../operations-event-store.js';
import { browserSessionArgs, YtDlpGeneralMediaAdapter } from '../yt-dlp-general-media-adapter.js';
import { MediaCrawlerProAdapter } from '../mediacrawler-pro-adapter.js';
import { BilibiliNativeSubtitleAdapter } from '../bilibili-native-subtitle-adapter.js';

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-access-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const connectionStore = new ConnectionStore(root);
  const operations = new OperationsEventStore(root);
  await Promise.all([connectionStore.init(), operations.init()]);
  return { root, connectionStore, operations, broker: new ConnectionBroker({ connectionStore }) };
}

function browserConnection() {
  return {
    provider: 'youtube', accountAlias: '测试账号', browser: 'chrome',
    grantedOperations: ['read_media_metadata', 'read_media_subtitles', 'download_authorized_media'],
    dataScope: ['content:read'], allowedAgentIds: ['xiaod']
  };
}

test('拒绝登记浏览器会话而不是读取浏览器数据', async (t) => {
  const { root, connectionStore } = await sandbox(t);
  await assert.rejects(
    connectionStore.createBrowserSessionConnection(browserConnection()),
    /不能建立浏览器会话账号连接/
  );
  const saved = await fs.readdir(root);
  assert.equal(saved.includes('connections.json'), false);
});

test('broker refuses a legacy browser connection before any adapter can read browser data', async (t) => {
  const { connectionStore, broker } = await sandbox(t);
  const connection = { connectionId:'legacy-browser', provider:'youtube', credentialKind:'browser_session', browser:'chrome', status:'active', allowedAgentIds:['xiaod'], grantedOperations:['read_media_subtitles'], dataScope:['content:read'] };
  connectionStore.connections.set(connection.connectionId, connection);
  const denied = await broker.authorize({
    connectionId: connection.connectionId, provider: 'youtube', operations: ['read_media_subtitles'], requestingAgentId: 'xiaod'
  });
  assert.equal(denied.code, 'browser_session_forbidden');
  assert.match(denied.safeMessage, /不能读取浏览器 Cookie/);
});

test('content center prefers specialized, records safe fallback, and returns a normalized package', async (t) => {
  const { broker, operations } = await sandbox(t);
  const calls = [];
  const specialized = {
    id: 'deep-source', versionRef: 'test', capabilities: ['basic_content'], accessMode: 'public', priorityClass: 'specialized', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'example',
    acquire: async () => { calls.push('specialized'); throw new Error('service unavailable'); }
  };
  const general = {
    id: 'general-source', versionRef: 'test', capabilities: ['basic_content'], accessMode: 'public', priorityClass: 'general', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'example',
    acquire: async () => { calls.push('general'); return { providedCapabilities: ['basic_content'], contentItems: { basic_content: { title: 'ok' } } }; }
  };
  const center = new ContentAcquisitionCenter({ adapters: [general, specialized], connectionBroker: broker, operations });
  const result = await center.fetch({ taskId: 'task-1', source: 'https://example.com/watch?private=ignored', requestedCapabilities: ['basic_content'], requestingAgentId: 'xiaod' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['specialized', 'general']);
  assert.equal(result.contentPackage.acquisitionPath, 'general');
  assert.equal(result.contentPackage.sourceRef, 'https://example.com/watch');
  assert.equal(operations.list().some((event) => event.eventType === 'fallback_used'), true);
});

test('公开视频站临时限流时，任务会说明真实原因而不是泛泛说通道不可用', async (t) => {
  const { broker, operations } = await sandbox(t);
  const adapter = {
    id: 'limited-video-source', versionRef: 'test', capabilities: ['subtitles'], accessMode: 'public', priorityClass: 'general', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'youtube',
    acquire: async () => { throw Object.assign(new Error('temporary rate limit'), { code: 'source_rate_limited' }); }
  };
  const center = new ContentAcquisitionCenter({ adapters: [adapter], connectionBroker: broker, operations });
  const result = await center.fetch({ taskId: 'task-rate-limit', source: 'https://youtube.com/watch?v=example', requestedCapabilities: ['subtitles'], requestingAgentId: 'xiaod' });
  assert.equal(result.code, 'source_rate_limited');
  assert.match(result.safeMessage, /临时限制/);
  assert.equal(result.recommendedAction, 'retry');
  assert.equal(result.category, 'retryable');
});

test('content center refuses a missing required connection without calling the adapter', async (t) => {
  const { broker, operations } = await sandbox(t);
  let called = false;
  const adapter = {
    id: 'authorized-source', versionRef: 'test', capabilities: ['subtitles'], accessMode: 'authorized', priorityClass: 'general', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'youtube',
    acquire: async () => { called = true; return { providedCapabilities: ['subtitles'] }; }
  };
  const center = new ContentAcquisitionCenter({ adapters: [adapter], connectionBroker: broker, operations });
  const result = await center.fetch({ taskId: 'task-2', source: 'https://youtube.com/watch?v=abc', requestedCapabilities: ['subtitles'], requestingAgentId: 'xiaod' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'connection_required');
  assert.equal(called, false);
  assert.equal(operations.list()[0].safeMessage.includes('Cookie'), false);
});

test('general public fallback is still allowed when a specialized connection belongs to another provider', async (t) => {
  const { connectionStore, broker, operations } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider: 'xhs', accountAlias: '我的小红书', clientId: 'local_xhs_account_1',
    grantedOperations: ['read_media_metadata'], dataScope: ['content:read'], allowedAgentIds: ['xiaod']
  });
  const specialized = {
    id: 'specialized', versionRef: 'test', capabilities: ['basic_content'], accessMode: 'authorized', priorityClass: 'specialized', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'xhs', acquire: async () => { throw new Error('temporary service issue'); }
  };
  const general = {
    id: 'general', versionRef: 'test', capabilities: ['basic_content'], accessMode: 'either', priorityClass: 'general', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'public_media', acquire: async ({ connectionUse }) => ({ providedCapabilities: ['basic_content'], contentItems: { basic_content: { connectionUse } } })
  };
  const center = new ContentAcquisitionCenter({ adapters: [specialized, general], connectionBroker: broker, operations });
  const result = await center.fetch({ taskId: 'task-3', source: 'https://example.com/thing', requestedCapabilities: ['basic_content'], connectionId: connection.connectionId, requestingAgentId: 'xiaod' });
  assert.equal(result.ok, true);
  assert.equal(result.contentPackage.acquisitionPath, 'general');
});

test('an adapter requests only permissions for capabilities it can actually provide', async (t) => {
  const { connectionStore, broker, operations } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider: 'dy', accountAlias: '我的抖音', clientId: 'local_dy_account_1',
    grantedOperations: ['read_media_metadata', 'download_authorized_media'], dataScope: ['content:read'], allowedAgentIds: ['xiaod']
  });
  const adapter = {
    id: 'deep-media', versionRef: 'test', capabilities: ['basic_content', 'media'], accessMode: 'authorized', priorityClass: 'specialized', healthStatus: 'healthy',
    matches: () => true, providerFor: () => 'dy', acquire: async () => ({ providedCapabilities: ['basic_content', 'media'], contentItems: { basic_content: {}, media: [{}] } })
  };
  const center = new ContentAcquisitionCenter({ adapters: [adapter], connectionBroker: broker, operations });
  const result = await center.fetch({ taskId: 'task-4', source: 'https://www.douyin.com/video/1', requestedCapabilities: ['basic_content', 'subtitles', 'media'], connectionId: connection.connectionId, requestingAgentId: 'xiaod' });
  assert.equal(result.ok, true);
});

test('媒体适配器拒绝从浏览器读取 Cookie', () => {
  assert.throws(() => browserSessionArgs({ credentialKind: 'browser_session', browser: 'chrome' }), (error) => error.code === 'browser_session_forbidden');
  assert.throws(() => browserSessionArgs({ credentialKind: 'cookie', browser: 'chrome' }), /不受当前媒体适配器支持/);
});

test('公开视频先只请求常用中英文字幕，避免为所有翻译版本重复请求', async (t) => {
  const { root } = await sandbox(t);
  let subtitleArgs = null;
  const adapter = new YtDlpGeneralMediaAdapter({
    runCommand: async (_command, args) => {
      if (args.includes('--dump-single-json')) return JSON.stringify({ title:'公开视频标题', description:'说明', uploader:'作者', duration:60, webpage_url:'https://www.youtube.com/watch?v=example' });
      if (args.includes('--write-subs')) {
        subtitleArgs = args;
        const template = args[args.indexOf('-o') + 1];
        await fs.writeFile(path.join(path.dirname(template), 'subtitle.zh-Hans.vtt'), 'WEBVTT');
        return '';
      }
      throw new Error('不应下载音频');
    }
  });
  const acquired = await adapter.acquire({
    source: 'https://www.youtube.com/watch?v=example', requestedCapabilities: ['basic_content', 'subtitles', 'media'], workspace: root
  });
  assert.deepEqual(subtitleArgs.slice(subtitleArgs.indexOf('--sub-langs') + 1, subtitleArgs.indexOf('--sub-langs') + 2), ['zh-Hans,zh-Hant,en']);
  assert.deepEqual(acquired.providedCapabilities, ['basic_content', 'subtitles']);
});

test('视觉分析通过内容获取中心单独取得视频，不重复请求字幕或误取纯音频', async (t) => {
  const { root } = await sandbox(t);
  const calls = [];
  const adapter = new YtDlpGeneralMediaAdapter({
    runCommand:async (_command, args) => {
      calls.push(args);
      if (args.includes('--dump-single-json')) return JSON.stringify({
        title:'真实原标题',
        description:'说明',
        uploader:'真实作者',
        duration:90,
        webpage_url:'https://www.youtube.com/watch?v=visual'
      });
      if (args.includes('bv*[height<=720]/b[height<=720]/bv*/b')) {
        const template = args[args.indexOf('-o') + 1];
        await fs.writeFile(path.join(path.dirname(template), 'source-video.mp4'), 'video');
        return '';
      }
      throw new Error(`不应调用：${args.join(' ')}`);
    }
  });
  const result = await adapter.acquire({
    source:'https://www.youtube.com/watch?v=visual',
    requestedCapabilities:['media'],
    runtimeRequirement:'visual_analysis',
    workspace:root
  });
  assert.equal(result.runtime.kind, 'video');
  assert.equal(result.contentItems.basic_content.title, '真实原标题');
  assert.equal(result.contentItems.basic_content.author, '真实作者');
  assert.equal(calls.some((args) => args.includes('--write-subs')), false);
  assert.equal(calls.some((args) => args.includes('--audio-format')), false);
});

test('B站先读取原生字幕，不下载媒体也不运行 ASR', async (t) => {
  const { root } = await sandbox(t);
  const secret = 'secret_cookie_value';
  const calls = [];
  const adapter = new BilibiliNativeSubtitleAdapter({
    cookieBridgeUrl: 'http://127.0.0.1:8274',
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, options });
      if (target.includes('/api/cookies/bili')) return jsonResponse({ isok: true, data: { cookies: secret } });
      if (target.includes('/x/web-interface/view')) {
        assert.equal(options.headers.Cookie, secret);
        return jsonResponse({ code: 0, data: { title: 'B站测试视频', desc: '说明', duration: 6, cid: 10, pages: [{ cid: 10, duration: 6 }], owner: { name: '作者' } } });
      }
      if (target.includes('/x/player/v2')) {
        assert.equal(options.headers.Cookie, secret);
        return jsonResponse({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/demo.json' }] } } });
      }
      assert.equal(target, 'https://aisubtitle.hdslb.com/demo.json');
      return jsonResponse({ body: [{ from: 1.25, to: 3.5, content: '第一句字幕' }, { from: 3.5, to: 5, content: '第二句字幕' }] });
    }
  });

  const result = await adapter.acquire({
    source: 'https://www.bilibili.com/video/BV1GM796EENj',
    requestedCapabilities: ['basic_content', 'subtitles', 'media'],
    connectionUse: { credentialKind: 'cookie_bridge', cookieBridgeClientId: 'local_bili_account_1' },
    workspace: root
  });

  assert.deepEqual(result.providedCapabilities, ['basic_content', 'subtitles']);
  assert.equal(result.runtime.kind, 'subtitle');
  assert.match(await fs.readFile(result.runtime.path, 'utf8'), /00:00:01.250 --> 00:00:03.500/);
  assert.equal(calls.some(({ target }) => /audio|video_download|yt-dlp/.test(target)), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('非B站视频不会调用B站字幕适配器，而是按来源走通用通道', async (t) => {
  const { root, broker, operations } = await sandbox(t);
  const sources = [
    'https://www.youtube.com/watch?v=example',
    'https://www.douyin.com/video/123456',
    'https://www.xiaohongshu.com/explore/example'
  ];
  let bilibiliCalls = 0;
  const bilibili = new BilibiliNativeSubtitleAdapter({
    fetchImpl: async () => {
      bilibiliCalls += 1;
      throw new Error('非B站来源不应调用B站接口');
    }
  });
  const general = {
    id: 'general-media-by-source',
    versionRef: 'test',
    capabilities: ['basic_content', 'subtitles', 'media'],
    accessMode: 'public',
    priorityClass: 'general',
    healthStatus: 'healthy',
    runtimeRequirements: ['media_transcription'],
    matches: () => true,
    providerFor: (source) => new URL(source).hostname,
    acquire: async ({ source }) => ({
      providedCapabilities: ['media'],
      contentItems: { media: [{ localRef: 'audio.wav', source }] },
      runtime: { kind: 'audio', path: path.join(root, 'audio.wav') }
    })
  };
  const center = new ContentAcquisitionCenter({
    adapters: [bilibili, general],
    connectionBroker: broker,
    operations
  });

  for (const source of sources) {
    assert.equal(bilibili.matches(source), false);
    const result = await center.fetch({
      taskId: `non-bili-${new URL(source).hostname}`,
      source,
      requestedCapabilities: ['basic_content', 'subtitles', 'media'],
      requestingAgentId: 'xiaod',
      workspace: root,
      runtimeRequirement: 'media_transcription'
    });
    assert.equal(result.ok, true);
    assert.equal(result.contentPackage.adapterRef.adapterId, 'general-media-by-source');
  }

  assert.equal(bilibiliCalls, 0);
});

test('B站只有片头推广伪字幕时判为覆盖不足，不冒充完整转录', async (t) => {
  const { root } = await sandbox(t);
  const adapter = new BilibiliNativeSubtitleAdapter({
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('/x/web-interface/view')) {
        return jsonResponse({ code: 0, data: { title: '长视频', duration: 120, cid: 10, pages: [{ cid: 10, duration: 120 }] } });
      }
      if (target.includes('/x/player/v2')) {
        return jsonResponse({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/ad.json' }] } } });
      }
      return jsonResponse({ body: [{ from: 0, to: 9.5, content: '保存头像 扫码查看' }] });
    }
  });

  await assert.rejects(
    adapter.acquire({
      source: 'https://www.bilibili.com/video/BV1GM796EENj',
      requestedCapabilities: ['basic_content', 'subtitles', 'media'],
      workspace: root
    }),
    (error) => error.code === 'capability_not_available' && /覆盖不足|不满足完整转录要求/.test(error.message)
  );
});

test('B站没有原生字幕时跳过缺少授权的深度通道并继续获取音轨', async (t) => {
  const { broker, operations } = await sandbox(t);
  const calls = [];
  const nativeSubtitle = new BilibiliNativeSubtitleAdapter({
    fetchImpl: async (url) => {
      const target = String(url);
      calls.push('native');
      if (target.includes('/x/web-interface/view')) return jsonResponse({ code: 0, data: { title: '无字幕视频', cid: 10, pages: [{ cid: 10 }] } });
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
  });
  const authorizedMedia = {
    id: 'authorized-bili-media', versionRef: 'test', capabilities: ['media'], accessMode: 'authorized', priorityClass: 'specialized', healthStatus: 'healthy',
    runtimeRequirements: ['media_transcription'], matches: () => true, providerFor: () => 'bili',
    acquire: async () => { throw new Error('没有连接时不应调用'); }
  };
  const publicAudio = {
    id: 'public-audio-fallback', versionRef: 'test', capabilities: ['media'], accessMode: 'public', priorityClass: 'general', healthStatus: 'healthy',
    runtimeRequirements: ['media_transcription'], matches: () => true, providerFor: () => 'public_media',
    acquire: async () => {
      calls.push('audio');
      return { providedCapabilities: ['media'], contentItems: { media: [{ localRef: 'audio.wav' }] }, runtime: { kind: 'audio', path: '/tmp/audio.wav' } };
    }
  };
  const center = new ContentAcquisitionCenter({ adapters: [nativeSubtitle, authorizedMedia, publicAudio], connectionBroker: broker, operations });
  const result = await center.fetch({
    taskId: 'bili-no-subtitle',
    source: 'https://www.bilibili.com/video/BV1GM796EENj',
    requestedCapabilities: ['basic_content', 'subtitles', 'media'],
    requestingAgentId: 'xiaod',
    workspace: '/tmp',
    runtimeRequirement: 'media_transcription'
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.kind, 'audio');
  assert.equal(result.contentPackage.adapterRef.adapterId, 'public-audio-fallback');
  assert.equal(calls.includes('audio'), true);
  assert.equal(operations.list().some((event) => event.eventType === 'connection_required'), true);
  assert.equal(operations.list().some((event) => event.eventType === 'fallback_used'), true);
});

test('CookieBridge connection stores an internal account reference without returning its client identifier', async (t) => {
  const { root, connectionStore, broker } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider: 'xhs', accountAlias: '我的小红书', clientId: 'local_xhs_account_1',
    grantedOperations: ['read_media_metadata', 'read_content_images', 'download_authorized_media'],
    dataScope: ['content:read'], allowedAgentIds: ['xiaod']
  });
  assert.equal(connection.credentialKind, 'cookie_bridge');
  assert.equal(connection.clientId, undefined);
  assert.equal(connection.cookieBridgeClientId, undefined);
  assert.equal(connection.isDefault, true);
  const saved = await fs.readFile(path.join(root, 'connections.json'), 'utf8');
  assert.doesNotMatch(saved, /secret_cookie_value/);
  const granted = await broker.authorize({
    connectionId: connection.connectionId, provider: 'xhs', operations: ['read_media_metadata'], requestingAgentId: 'xiaod'
  });
  assert.equal(granted.ok, true);
  assert.equal(granted.connectionUse.cookieBridgeClientId, 'local_xhs_account_1');
  await assert.rejects(
    connectionStore.createCookieBridgeConnection({
      provider: 'xhs', accountAlias: '错误连接', clientId: 'local_xhs_account_2', cookie: 'secret_cookie_value',
      grantedOperations: ['read_media_metadata'], dataScope: ['content:read'], allowedAgentIds: ['xiaod']
    }),
    /不得包含 Cookie/
  );
});

test('同一平台只保留一个默认账号，切换默认不会删除其他连接', async (t) => {
  const { connectionStore } = await sandbox(t);
  const first = await connectionStore.createCookieBridgeConnection({
    provider:'xhs', accountAlias:'工作号', clientId:'local_xhs_work',
    grantedOperations:['read_media_metadata'], dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  const second = await connectionStore.createCookieBridgeConnection({
    provider:'xhs', accountAlias:'测试号', clientId:'local_xhs_test',
    grantedOperations:['read_media_metadata'], dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  assert.equal(first.isDefault, true);
  assert.equal(second.isDefault, false);
  const selected = await connectionStore.setDefault(second.connectionId);
  assert.equal(selected.isDefault, true);
  const active = connectionStore.list().filter((item) => item.provider === 'xhs' && item.status === 'active');
  assert.equal(active.length, 2);
  assert.deepEqual(active.filter((item) => item.isDefault).map((item) => item.accountAlias), ['测试号']);
  await connectionStore.disable(second.connectionId);
  assert.equal(connectionStore.getSafe(second.connectionId).isDefault, false);
});

test('授权适配器真实读取后记录脱敏验证结果和实际账号', async (t) => {
  const { connectionStore, broker, operations } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider:'dy', accountAlias:'抖音工作号', clientId:'local_dy_work',
    grantedOperations:['read_media_metadata'], dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  const adapter = {
    id:'authorized-proof', versionRef:'test', capabilities:['basic_content'], accessMode:'authorized', priorityClass:'specialized', healthStatus:'healthy',
    matches:() => true, providerFor:() => 'dy',
    acquire:async () => ({ providedCapabilities:['basic_content'], contentItems:{ basic_content:{ title:'真实内容' } } })
  };
  const center = new ContentAcquisitionCenter({ adapters:[adapter], connectionBroker:broker, operations });
  const result = await center.fetch({
    taskId:'task-proof',
    source:'https://www.douyin.com/video/1',
    requestedCapabilities:['basic_content'],
    connectionId:connection.connectionId,
    requestingAgentId:'xiaod'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.contentPackage.access, {
    mode:'authorized_read',
    connectionId:connection.connectionId,
    accountAlias:'抖音工作号'
  });
  assert.deepEqual(connectionStore.getSafe(connection.connectionId).lastVerification, {
    status:'succeeded',
    at:connectionStore.getSafe(connection.connectionId).lastVerification.at,
    adapterId:'authorized-proof',
    capabilities:['basic_content'],
    failureCode:null
  });
});

test('授权读取失败后即使公开通道兜底成功，也不把账号标成成功', async (t) => {
  const { connectionStore, broker, operations } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider:'xhs', accountAlias:'小红书工作号', clientId:'local_xhs_work',
    grantedOperations:['read_media_metadata'], dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  const authorized = {
    id:'authorized-failure', versionRef:'test', capabilities:['basic_content'], accessMode:'authorized', priorityClass:'specialized', healthStatus:'healthy',
    matches:() => true, providerFor:() => 'xhs',
    acquire:async () => { throw new Error('temporary service issue'); }
  };
  const publicFallback = {
    id:'public-fallback', versionRef:'test', capabilities:['basic_content'], accessMode:'public', priorityClass:'general', healthStatus:'healthy',
    matches:() => true, providerFor:() => 'public_media',
    acquire:async () => ({ providedCapabilities:['basic_content'], contentItems:{ basic_content:{ title:'公开结果' } } })
  };
  const center = new ContentAcquisitionCenter({ adapters:[authorized, publicFallback], connectionBroker:broker, operations });
  const result = await center.fetch({
    taskId:'task-fallback-proof',
    source:'https://www.xiaohongshu.com/explore/example',
    requestedCapabilities:['basic_content'],
    connectionId:connection.connectionId,
    requestingAgentId:'xiaod'
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentPackage.access.mode, 'public_read');
  assert.equal(connectionStore.getSafe(connection.connectionId).lastVerification.status, 'failed');
  assert.equal(connectionStore.getSafe(connection.connectionId).lastVerification.adapterId, 'authorized-failure');
});

test('CookieBridge connection can be disabled and reauthorized without changing its identity or permissions', async (t) => {
  const { connectionStore, broker } = await sandbox(t);
  const connection = await connectionStore.createCookieBridgeConnection({
    provider:'xhs', accountAlias:'旧连接', clientId:'local_xhs_account_1',
    grantedOperations:['read_media_metadata'], dataScope:['content:read'], allowedAgentIds:['xiaod']
  });
  const disabled = await connectionStore.disable(connection.connectionId);
  assert.equal(disabled.status, 'disabled');
  const denied = await broker.authorize({
    connectionId:connection.connectionId, provider:'xhs', operations:['read_media_metadata'], requestingAgentId:'xiaod'
  });
  assert.equal(denied.code, 'connection_unavailable');
  const renewed = await connectionStore.reauthorizeCookieBridgeConnection(connection.connectionId, {
    provider:'xhs', accountAlias:'续期后的连接', clientId:'local_xhs_account_2'
  });
  assert.equal(renewed.connectionId, connection.connectionId);
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.accountAlias, '续期后的连接');
  assert.deepEqual(renewed.grantedOperations, ['read_media_metadata']);
  assert.equal(renewed.cookieBridgeClientId, undefined);
  const granted = await broker.authorize({
    connectionId:connection.connectionId, provider:'xhs', operations:['read_media_metadata'], requestingAgentId:'xiaod'
  });
  assert.equal(granted.ok, true);
  assert.equal(granted.connectionUse.cookieBridgeClientId, 'local_xhs_account_2');
  await assert.rejects(
    connectionStore.reauthorizeCookieBridgeConnection(connection.connectionId, {
      provider:'dy', accountAlias:'错误平台', clientId:'local_xhs_account_2'
    }),
    /平台与原连接不一致/
  );
});

test('MediaCrawlerPro passes a CookieBridge value only between loopback services and never returns it', async () => {
  const secret = 'secret_cookie_value';
  const calls = [];
  const adapter = new MediaCrawlerProAdapter({
    cookieBridgeUrl: 'http://127.0.0.1:8274', downloadServerUrl: 'http://127.0.0.1:8205',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/api/cookies/xhs')) return jsonResponse({ isok: true, data: { cookies: secret } });
      assert.equal(JSON.parse(options.body).cookies, secret);
      return jsonResponse({ isok: true, data: { content: { title: '测试笔记', desc: '正文', url: 'https://www.xiaohongshu.com/explore/abc', image_urls: ['https://img.example/a.jpg'], video_download_url: 'https://media.example/video.mp4' } } });
    }
  });
  const result = await adapter.acquire({
    source: 'https://www.xiaohongshu.com/explore/abc',
    connectionUse: { credentialKind: 'cookie_bridge', cookieBridgeClientId: 'local_xhs_account_1' }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), ['127.0.0.1', '127.0.0.1']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.providedCapabilities, ['basic_content', 'images', 'media']);
  assert.deepEqual(result.runtime, { kind: 'remote_media', url: 'https://media.example/video.mp4' });
});

test('MediaCrawlerPro 识别小红书当前分享口令短链域名', () => {
  const adapter = new MediaCrawlerProAdapter({
    cookieBridgeUrl: 'http://127.0.0.1:8274',
    downloadServerUrl: 'http://127.0.0.1:8205'
  });
  assert.equal(adapter.matches('http://xhslink.cn/o/3HInBgvjTG'), true);
  assert.equal(adapter.providerFor('http://xhslink.cn/o/3HInBgvjTG'), 'xhs');
});

test('MediaCrawlerPro 为 B站转录优先下载独立音轨而不是无声视频分片', async (t) => {
  const { root } = await sandbox(t);
  const secret = 'secret_cookie_value';
  const requestedUrls = [];
  const adapter = new MediaCrawlerProAdapter({
    cookieBridgeUrl:'http://127.0.0.1:8274',
    downloadServerUrl:'http://127.0.0.1:8205',
    fetchImpl:async (url, options = {}) => {
      requestedUrls.push(String(url));
      if (String(url).includes('/api/cookies/bili')) return jsonResponse({ isok:true, data:{ cookies:secret } });
      if (String(url).includes('/api/v1/content_detail')) {
        assert.equal(JSON.parse(options.body).cookies, secret);
        return jsonResponse({
          isok:true,
          data:{ content:{
            title:'B站测试视频',
            author:{ name:'B站作者' },
            url:'https://www.bilibili.com/video/BV1TEST',
            video_download_url:'https://media.example/video-only.m4s',
            extria_info:{ audio_url:'https://media.example/audio-only.m4s', duration:585 }
          } }
        });
      }
      assert.equal(String(url), 'https://media.example/audio-only.m4s');
      assert.equal(options.headers.Cookie, secret);
      return new Response(Buffer.from('synthetic-audio-stream'));
    }
  });

  const result = await adapter.acquire({
    source:'https://www.bilibili.com/video/BV1TEST',
    connectionUse:{ credentialKind:'cookie_bridge', cookieBridgeClientId:'local_bili_account_1' },
    workspace:root
  });

  assert.equal(requestedUrls.includes('https://media.example/video-only.m4s'), false);
  assert.equal(result.runtime.kind, 'audio');
  assert.equal(path.basename(result.runtime.path), 'authorized-audio.m4a');
  assert.equal((await fs.stat(result.runtime.path)).size > 0, true);
  assert.equal(result.contentItems.basic_content.durationSeconds, 585);
  assert.equal(result.contentItems.basic_content.author, 'B站作者');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('MediaCrawlerPro 为视觉分析返回视频而不是独立音轨', async (t) => {
  const { root } = await sandbox(t);
  const requestedUrls = [];
  const adapter = new MediaCrawlerProAdapter({
    cookieBridgeUrl:'http://127.0.0.1:8274',
    downloadServerUrl:'http://127.0.0.1:8205',
    fetchImpl:async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('/api/cookies/bili')) return jsonResponse({ isok:true, data:{ cookies:'test-cookie' } });
      if (String(url).includes('/api/v1/content_detail')) return jsonResponse({
        isok:true,
        data:{ content:{
          title:'B站视觉样片',
          url:'https://www.bilibili.com/video/BV1VISUAL',
          video_download_url:'https://media.example/video-only.m4s',
          extria_info:{ audio_url:'https://media.example/audio-only.m4s', duration:120 }
        } }
      });
      return new Response(Buffer.from('synthetic-video-stream'));
    }
  });

  const result = await adapter.acquire({
    source:'https://www.bilibili.com/video/BV1VISUAL',
    connectionUse:{ credentialKind:'cookie_bridge', cookieBridgeClientId:'local_bili_account_1' },
    workspace:root,
    runtimeRequirement:'visual_analysis'
  });

  assert.equal(requestedUrls.includes('https://media.example/audio-only.m4s'), false);
  assert.equal(requestedUrls.includes('https://media.example/video-only.m4s'), true);
  assert.equal(result.runtime.kind, 'video');
  assert.equal(path.basename(result.runtime.path), 'authorized-source.mp4');
});

function jsonResponse(payload) {
  return { ok: true, json: async () => payload };
}
