import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStore } from '../connection-store.js';
import { ConnectionBroker } from '../connection-broker.js';
import { ContentAcquisitionCenter } from '../content-acquisition-center.js';
import { OperationsEventStore } from '../operations-event-store.js';
import { browserSessionArgs } from '../yt-dlp-general-media-adapter.js';
import { MediaCrawlerProAdapter } from '../mediacrawler-pro-adapter.js';

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

test('browser session connection stores only an opaque credential reference and never returns it', async (t) => {
  const { root, connectionStore } = await sandbox(t);
  const connection = await connectionStore.createBrowserSessionConnection(browserConnection());
  assert.equal(connection.status, 'active');
  assert.equal(connection.credentialRef, undefined);
  assert.equal(connection.hasCredentialReference, true);
  const saved = await fs.readFile(path.join(root, 'connections.json'), 'utf8');
  assert.doesNotMatch(saved, /cookie|token|password/i);
  await assert.rejects(
    connectionStore.createBrowserSessionConnection({ ...browserConnection(), cookie: 'forbidden' }),
    /不得包含 Cookie/
  );
});

test('broker grants only an active connection scoped to the expected agent and operation', async (t) => {
  const { connectionStore, broker } = await sandbox(t);
  const connection = await connectionStore.createBrowserSessionConnection(browserConnection());
  const granted = await broker.authorize({
    connectionId: connection.connectionId, provider: 'youtube', operations: ['read_media_subtitles'], requestingAgentId: 'xiaod'
  });
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.connectionUse.operations, ['read_media_subtitles']);
  assert.equal(granted.connectionUse.credentialRef, undefined);
  const denied = await broker.authorize({
    connectionId: connection.connectionId, provider: 'youtube', operations: ['read_content_comments'], requestingAgentId: 'xiaod'
  });
  assert.equal(denied.code, 'operation_not_granted');
  await connectionStore.revoke(connection.connectionId);
  const revoked = await broker.authorize({
    connectionId: connection.connectionId, provider: 'youtube', operations: ['read_media_subtitles'], requestingAgentId: 'xiaod'
  });
  assert.equal(revoked.code, 'connection_unavailable');
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

test('browser adapter arguments contain only a browser selector, never raw credential material', () => {
  assert.deepEqual(browserSessionArgs({ credentialKind: 'browser_session', browser: 'chrome' }), ['--cookies-from-browser', 'chrome']);
  assert.throws(() => browserSessionArgs({ credentialKind: 'cookie', browser: 'chrome' }), /不受当前媒体适配器支持/);
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

function jsonResponse(payload) {
  return { ok: true, json: async () => payload };
}
