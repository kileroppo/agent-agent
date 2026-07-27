import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessConnectionError, AccessConnectionService } from '../src/access-connection-service.js';

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
    'grantedOperations', 'dataScope', 'expiresAt', 'lastHealthAt', 'hasCredentialReference'
  ]);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('小D连接服务暂时不可用时返回可展示降级状态', async () => {
  const service = new AccessConnectionService({ fetchImpl:async () => { throw new Error('offline'); } });
  assert.deepEqual(await service.list(), {
    status:'unavailable',
    message:'小D账号连接状态暂时不可用。',
    connections:[]
  });
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
