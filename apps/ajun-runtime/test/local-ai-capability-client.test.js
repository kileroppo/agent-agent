import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAiCapabilityClient } from '../src/local-ai-capability-client.js';

test('本机 AI 客户端拒绝非回环地址和 URL 内嵌凭据', () => {
  assert.throws(() => new LocalAiCapabilityClient({ baseUrl:'https://example.com' }), (error) => error.code === 'local_ai_gateway_not_loopback');
  assert.throws(() => new LocalAiCapabilityClient({ baseUrl:'http://user:secret@127.0.0.1:18082' }), (error) => error.code === 'local_ai_gateway_not_loopback');
});

test('健康状态只返回登记能力和脱敏台式机状态', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl:async () => ({
      ok:true,
      async json() {
        return {
          status:'healthy',
          node:'m1-max-primary',
          desktopEnhancement:{ configured:true, healthy:false, baseUrl:'http://secret-node' },
          capabilities:[
            { capability:'text.generate', configured:true, healthy:true, e2eVerified:true, provider:'local-qwen35', failure:{ message:'private' } },
            { capability:'unknown.debug', configured:true, healthy:true, e2eVerified:true, provider:'debug' },
          ],
        };
      },
    }),
  });
  const result = await client.health();
  assert.equal(result.status, 'healthy');
  assert.equal(result.readyCount, 1);
  assert.deepEqual(result.desktopEnhancement, { configured:true, healthy:false });
  assert.equal(result.capabilities.some((item) => item.capability === 'unknown.debug'), false);
  assert.equal(JSON.stringify(result).includes('secret-node'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('调用只允许登记能力并保留跨设备显式批准字段', async () => {
  const bodies = [];
  const client = new LocalAiCapabilityClient({
    fetchImpl:async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok:true, async json() { return { requestId:'one', result:{ text:'ok' } }; } };
    },
  });
  await assert.rejects(() => client.invoke({ capability:'shell.execute' }), (error) => error.code === 'local_ai_capability_not_allowed');
  await client.invoke({ capability:'text.generate', input:{ prompt:'hi' }, requestId:'one', approved:true });
  assert.equal(bodies[0].approved, true);
  assert.equal(bodies[0].request_id, 'one');
});
