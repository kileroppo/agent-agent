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

test('控制面只返回登记服务并拒绝任意服务动作', async () => {
  const requests = [];
  const client = new LocalAiCapabilityClient({
    fetchImpl:async (url, options = {}) => {
      requests.push([url, options.method || 'GET']);
      return {
        ok:true,
        async json() {
          return {
            status:'ready',
            services:[
              { id:'qwen35', name:'Qwen', node:'mac', endpoint:'127.0.0.1:18081', mode:'on_demand', state:'stopped', actions:['start', 'shell'] },
              { id:'qwen36-candidate', name:'Qwen candidate', node:'mac', endpoint:'127.0.0.1:18080', mode:'disabled', state:'stopped', actions:['start', 'stop'] },
              { id:'unknown-daemon', name:'hidden', state:'running', actions:['stop'] },
            ],
            routing:[],
          };
        },
      };
    },
  });
  const overview = await client.controlOverview();
  assert.equal(overview.services.length, 2);
  assert.deepEqual(overview.services[0].actions, ['start']);
  assert.deepEqual(overview.services[1].actions, ['start', 'stop']);
  await assert.rejects(() => client.controlService('unknown-daemon', 'stop'), (error) => error.code === 'local_ai_service_action_not_allowed');
  await client.controlService('qwen35', 'start');
  assert.equal(requests.some(([url, method]) => url.endsWith('/v1/control/services/qwen35/start') && method === 'POST'), true);
});

test('A君可独立管理控制网关且网关离线时仍保留重新启动入口', async () => {
  const actions = [];
  let running = false;
  const client = new LocalAiCapabilityClient({
    fetchImpl:async () => {
      if (!running) throw new Error('offline');
      return {
        ok:true,
        async json() {
          return { status:'ready', services:[{ id:'gateway', name:'gateway', node:'mac', mode:'always_on', state:'running', actions:[] }], routing:[] };
        },
      };
    },
    gatewayControl:async (action) => {
      actions.push(action);
      running = action !== 'stop';
    },
  });
  const offline = await client.controlOverview();
  assert.equal(offline.services[0].id, 'gateway');
  assert.equal(offline.services[0].state, 'stopped');
  assert.deepEqual(offline.services[0].actions, ['start', 'restart']);
  await client.controlService('gateway', 'start');
  assert.deepEqual(actions, ['start']);
});

test('服务策略拒绝会保留网关的 409 而不是伪装成服务崩溃', async () => {
  const client = new LocalAiCapabilityClient({
    fetchImpl:async () => ({
      ok:false,
      status:409,
      async json() {
        return { detail:{ code:'service_disabled', message:'候选已禁用。' } };
      },
    }),
  });
  await assert.rejects(
    () => client.controlService('qwen36-candidate', 'start'),
    (error) => error.code === 'service_disabled' && error.httpStatus === 409,
  );
});
