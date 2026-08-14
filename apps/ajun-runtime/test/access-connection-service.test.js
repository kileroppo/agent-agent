import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessConnectionError, AccessConnectionService } from '../src/access-connection-service.ts';

const CONNECTION_ID = '123e4567-e89b-42d3-a456-426614174000';

function response(payload, ok = true) {
  return { ok, async json() { return payload; } };
}

test('账号连接状态只透传安全字段，不返回凭据、CookieBridge 标识或原始 Cookie', async () => {
  const service = new AccessConnectionService({
    fetchImpl:async () => response({ connections:[{
      connectionId:CONNECTION_ID,
      provider:'xhs',
      accountAlias:'内容账号',
      status:'active',
      allowedAgentIds:['xiaod'],
      grantedOperations:['read_media_metadata'],
      dataScope:['content:read'],
      expiresAt:null,
      lastHealthAt:'2026-07-27T08:00:00.000Z',
      isDefault:true,
      lastVerification:{
        status:'succeeded',
        at:'2026-07-27T08:05:00.000Z',
        adapterId:'mediacrawlerpro-specialized-content',
        capabilities:['basic_content'],
        failureCode:null,
        cookie:'hidden'
      },
      hasCredentialReference:true,
      credentialRef:'cookiebridge:xhs:secret',
      cookieBridgeClientId:'private-client',
      cookie:'private-cookie',
      token:'private-token'
    }] })
  });
  const result = await service.list();
  assert.equal(result.status, 'ready');
  assert.equal(result.connections.length, 1);
  assert.deepEqual(Object.keys(result.connections[0]), [
    'connectionId', 'provider', 'accountAlias', 'status', 'allowedAgentIds',
    'grantedOperations', 'dataScope', 'expiresAt', 'lastHealthAt', 'isDefault', 'lastVerification', 'hasCredentialReference'
  ]);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('A君通过本机代理设置默认账号', async () => {
  const calls = [];
  const service = new AccessConnectionService({
    fetchImpl:async (url, options) => {
      calls.push({ url:String(url), options });
      return response({ connection:{
        connectionId:CONNECTION_ID,
        provider:'xhs',
        accountAlias:'工作号',
        status:'active',
        isDefault:true,
        allowedAgentIds:['xiaod'],
        grantedOperations:['read_media_metadata'],
        dataScope:['content:read'],
        hasCredentialReference:true
      } });
    }
  });
  const selected = await service.setDefault(CONNECTION_ID);
  assert.equal(selected.isDefault, true);
  assert.equal(calls[0].url, `http://127.0.0.1:4318/api/connections/${CONNECTION_ID}/default`);
  assert.equal(calls[0].options.method, 'POST');
});

test('小D连接服务暂时不可用时返回可展示降级状态', async () => {
  const service = new AccessConnectionService({ fetchImpl:async () => { throw new Error('offline'); } });
  assert.deepEqual(await service.list(), {
    status:'unavailable',
    message:'小D账号连接状态暂时不可用。',
    connections:[]
  });
});

test('A君只汇总小D脱敏的采集健康状态，不把适配器配置或凭据带到控制台', async () => {
  const service = new AccessConnectionService({
    fetchImpl:async (url) => String(url).endsWith('/api/health')
      ? response({
          ok:true,
          capabilities:{ mediaCrawlerDeep:true, secret:'hidden' },
          commonAccess:{
            contentAcquisitionCenter:true,
            adapters:[
              { id:'mediacrawlerpro-specialized-content', priorityClass:'specialized', healthStatus:'healthy', baseUrl:'http://private' },
              { id:'yt-dlp-general-media', priorityClass:'general', healthStatus:'healthy' }
            ]
          }
        })
      : response({ connections:[] })
  });
  const result = await service.overview();
  assert.deepEqual(result.acquisition, {
    status:'ready',
    mediaCrawlerDeep:true,
    adapters:[
      { id:'mediacrawlerpro-specialized-content', priorityClass:'specialized', healthStatus:'healthy' },
      { id:'yt-dlp-general-media', priorityClass:'general', healthStatus:'healthy' }
    ]
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('撤销连接只调用本机小D安全入口，并拒绝非法标识和非回环地址', async () => {
  const calls = [];
  const service = new AccessConnectionService({
    fetchImpl:async (url, options) => {
      calls.push({ url:String(url), options });
      return response({ connection:{
        connectionId:CONNECTION_ID, provider:'xhs', accountAlias:'内容账号', status:'revoked',
        allowedAgentIds:['xiaod'], grantedOperations:['read_media_metadata'], dataScope:['content:read'],
        hasCredentialReference:true
      } });
    }
  });
  const connection = await service.revoke(CONNECTION_ID);
  assert.equal(connection.status, 'revoked');
  assert.equal(calls[0].url, `http://127.0.0.1:4318/api/connections/${CONNECTION_ID}/revoke`);
  assert.equal(calls[0].options.method, 'POST');
  await assert.rejects(() => service.revoke('../wrong'), AccessConnectionError);
  assert.throws(() => new AccessConnectionService({ baseUrl:'http://0.0.0.0:4318' }), /本机回环地址/);
  assert.throws(() => new AccessConnectionService({ baseUrl:'https://127.0.0.1:4318' }), /本机回环地址/);
});

test('A君只展示已连接的受控账号，并只打开白名单平台登录页', async () => {
  const launched = [];
  const service = new AccessConnectionService({
    browserLauncher:async (url) => launched.push(url),
    fetchImpl:async () => response({ accounts:[
      { clientId:'safe-client', connected:true, platforms:['xhs', 'unknown'], nicknames:{ xhs:'我的账号', unknown:'不应显示' } },
      { clientId:'offline-client', connected:false, platforms:['xhs'], nicknames:{ xhs:'离线账号' } },
      { clientId:'bad client id', connected:true, platforms:['xhs'], nicknames:{} }
    ] })
  });
  const options = await service.loginOptions();
  assert.deepEqual(options.accounts, [{
    clientId:'safe-client', connected:true, platforms:['xhs'], nicknames:{ xhs:'我的账号' }
  }]);
  assert.equal(options.providers.some((provider) => provider.id === 'xhs' && provider.label === '小红书'), true);
  const opened = await service.openLogin('xhs');
  assert.equal(opened.status, 'opened');
  assert.deepEqual(launched, ['https://www.xiaohongshu.com/']);
  await assert.rejects(() => service.openLogin('https://evil.example'), /暂未开放/);
});

test('A君创建、禁用和重新授权连接时固定小D只读权限且不接受原始凭据', async () => {
  const calls = [];
  const service = new AccessConnectionService({
    fetchImpl:async (url, options = {}) => {
      calls.push({ url:String(url), options });
      const status = String(url).endsWith('/disable') ? 'disabled' : 'active';
      return response({ connection:{
        connectionId:CONNECTION_ID, provider:'xhs', accountAlias:'内容账号', status,
        allowedAgentIds:['xiaod'], grantedOperations:['read_media_metadata', 'read_content_images', 'download_authorized_media'],
        dataScope:['content:read'], hasCredentialReference:true
      } });
    }
  });
  await service.create({ provider:'xhs', accountAlias:'内容账号', clientId:'safe-client' });
  const createBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(createBody.allowedAgentIds, ['xiaod']);
  assert.deepEqual(createBody.dataScope, ['content:read']);
  assert.equal(createBody.cookie, undefined);
  await service.disable(CONNECTION_ID);
  await service.reauthorize(CONNECTION_ID, { provider:'xhs', accountAlias:'续期账号', clientId:'safe-client' });
  assert.equal(calls[1].url.endsWith(`/${CONNECTION_ID}/disable`), true);
  assert.equal(calls[2].url.endsWith(`/${CONNECTION_ID}/reauthorize`), true);
  await assert.rejects(
    () => service.create({ provider:'xhs', accountAlias:'错误', clientId:'safe-client', token:'secret' }),
    /不得包含/
  );
});
