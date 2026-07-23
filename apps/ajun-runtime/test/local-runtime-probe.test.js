import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRuntimeProbe } from '../src/local-runtime-probe.js';

function response(body, ok = true) { return { ok, async json() { return body; } }; }

test('运维官的本机巡检读取真实运行概览和小D健康状态', async () => {
  const probe = new LocalRuntimeProbe({ fetchImpl: async (url) => {
    if (url.endsWith('/api/overview')) return response({ agents:[{}, {}], tasks:[{}], taskFocus:{ inProgress:1, paused:1, waitingApproval:1, waitingTest:2 } });
    if (url.endsWith('/api/health')) return response({ ok:true });
    throw new Error(`unexpected ${url}`);
  } });
  const components = await probe.check();
  assert.deepEqual(components.map((item) => item.status), ['healthy', 'healthy']);
  assert.match(components[0].detail, /2 名员工/);
  assert.match(components[0].detail, /1 项处理中/);
  assert.match(components[0].detail, /3 项等待确认或测试/);
});

test('本机服务暂时不可用时，巡检如实标记异常而不尝试危险恢复', async () => {
  const probe = new LocalRuntimeProbe({ fetchImpl: async () => { throw new Error('offline'); } });
  const components = await probe.check();
  assert.deepEqual(components.map((item) => item.status), ['degraded', 'degraded']);
  assert.match(components[0].detail, /未尝试重置/);
  assert.match(components[1].detail, /不会自动发起外部动作/);
});

test('巡检拒绝把外部地址当成本机服务读取', () => {
  assert.throws(() => new LocalRuntimeProbe({ ajunUrl:'https://example.com' }), /本机服务/);
});
