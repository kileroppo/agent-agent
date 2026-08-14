import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesModelSetupError, HermesModelSetupService } from '../src/hermes-model-setup-service.ts';

function profileStat() { return { isDirectory:() => true }; }
function response(payload, ok = true) { return { ok, async json() { return payload; } }; }

test('为任意已登记独立员工打开明确 Profile 的 Hermes 官方授权页，不返回凭据', async () => {
  const service = new HermesModelSetupService({
    profileRoot:'/tmp/hermes-test/profiles',
    stat:async () => profileStat(),
    resolveProfile:async (agentId) => ['intel-researcher', 'operator'].includes(agentId) ? agentId : null,
    fetchImpl:async () => response({ version:'0.19.0', profiles:['intel-researcher', 'operator'] })
  });
  const result = await service.open('intel-researcher');
  assert.equal(result.url, 'http://127.0.0.1:9119/env?profile=intel-researcher');
  assert.equal(result.modelUrl, 'http://127.0.0.1:9119/models?profile=intel-researcher');
  assert.equal(JSON.stringify(result).includes('token'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal((await service.open('operator')).agentId, 'operator');
  await assert.rejects(() => service.open('unknown'), HermesModelSetupError);
});

test('授权页未运行时复用 Hermes dashboard 并固定在本机回环地址', async () => {
  const calls = [];
  let probes = 0;
  const child = { on() {}, unref() { calls.push({ unref:true }); } };
  const service = new HermesModelSetupService({
    command:'/opt/hermes',
    profileRoot:'/tmp/hermes-test/profiles',
    stat:async () => profileStat(),
    resolveProfile:async (agentId) => agentId === 'office-assistant' ? agentId : null,
    fetchImpl:async () => {
      probes += 1;
      if (probes < 2) throw new Error('offline');
      return response({ version:'0.19.0', profiles:['office-assistant'] });
    },
    spawnProcess:(command, args, options) => { calls.push({ command, args, options }); return child; },
    sleep:async () => {},
    startupAttempts:2
  });
  const result = await service.open('office-assistant');
  assert.equal(result.status, 'ready_for_authorization');
  assert.equal(calls[0].command, '/opt/hermes');
  assert.deepEqual(calls[0].args, ['dashboard', '--host', '127.0.0.1', '--port', '9119', '--no-open', '--skip-build']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.env.HERMES_HOME, '/tmp/hermes-test');
});

test('授权端口被其他服务占用、Profile 缺失或非回环地址时失败关闭', async () => {
  const occupied = new HermesModelSetupService({
    profileRoot:'/tmp/hermes-test/profiles',
    stat:async () => profileStat(),
    resolveProfile:async (agentId) => agentId,
    fetchImpl:async () => response({ service:'other' })
  });
  await assert.rejects(() => occupied.open('intel-researcher'), /端口已被其他本机服务占用/);

  const missing = new HermesModelSetupService({
    profileRoot:'/tmp/hermes-test/profiles',
    stat:async () => { throw new Error('missing'); },
    resolveProfile:async (agentId) => agentId,
    fetchImpl:async () => response({ version:'0.19.0', profiles:['intel-researcher'] })
  });
  await assert.rejects(() => missing.open('intel-researcher'), /Profile 尚未建立/);

  assert.throws(() => new HermesModelSetupService({ dashboardOrigin:'http://0.0.0.0:9119' }), /本机回环地址/);
  assert.throws(() => new HermesModelSetupService({ dashboardOrigin:'https://127.0.0.1:9119' }), /本机回环地址/);
});
