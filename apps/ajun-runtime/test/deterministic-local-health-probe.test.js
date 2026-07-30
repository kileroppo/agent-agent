import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicLocalHealthProbe } from '../src/deterministic-local-health-probe.js';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test('只读取固定的127.0.0.1端口和登记路径并返回结构化证据', async () => {
  const requests = [];
  const probe = new DeterministicLocalHealthProbe({
    fetchImpl:async (url, options) => {
      requests.push({ url, options });
      if (url === 'http://127.0.0.1:4321/api/overview') {
        return response({ agents:[{}, {}], tasks:[{}], taskFocus:{ inProgress:1, waitingApproval:1 } });
      }
      if (url === 'http://127.0.0.1:4318/api/health') return response({ ok:true });
      throw new Error(`unexpected target: ${url}`);
    },
    now:() => new Date('2026-07-30T02:00:00.000Z')
  });

  const observations = await probe.check();

  assert.deepEqual(requests.map((item) => item.url), [
    'http://127.0.0.1:4321/api/overview',
    'http://127.0.0.1:4318/api/health'
  ]);
  assert.equal(requests.every((item) => item.options.method === 'GET'), true);
  assert.equal(requests.every((item) => item.options.redirect === 'error'), true);
  assert.deepEqual(observations.map((item) => item.status), ['healthy', 'healthy']);
  assert.equal(observations[0].schemaVersion, 'agent.army/local-health-observation/v1');
  assert.deepEqual(observations[0].target, {
    targetId:'ajun-runtime',
    transport:'http',
    host:'127.0.0.1',
    port:4321,
    path:'/api/overview',
    method:'GET',
    contract:'ajun-overview/v1'
  });
  assert.equal(observations[0].evidence.contractSatisfied, true);
  assert.equal(observations[0].recovery.action, 'none');
  assert.equal(observations[0].recovery.automaticActionAuthorized, false);
});

test('未登记目标无法变成任意本机请求', async () => {
  let calls = 0;
  const probe = new DeterministicLocalHealthProbe({ fetchImpl:async () => { calls += 1; } });

  await assert.rejects(() => probe.checkOne('http://127.0.0.1:9999/private'), /拒绝未登记目标/);
  await assert.rejects(() => probe.checkOne('paperclip'), /拒绝未登记目标/);
  assert.equal(calls, 0);
  assert.deepEqual(probe.registeredChecks().map((item) => `${item.host}:${item.port}${item.path}`), [
    '127.0.0.1:4321/api/overview',
    '127.0.0.1:4318/api/health'
  ]);
});

test('超时、HTTP错误和响应契约错误只给安全恢复建议', async (t) => {
  const cases = [
    {
      name:'HTTP错误',
      fetchImpl:async () => response({}, { ok:false, status:503 }),
      expected:'health_http_error'
    },
    {
      name:'响应契约错误',
      fetchImpl:async () => response({ ok:false }),
      expected:'invalid_health_contract'
    },
    {
      name:'无法连接',
      fetchImpl:async () => { throw new Error('connection refused with secret detail'); },
      expected:'health_unreachable'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const probe = new DeterministicLocalHealthProbe({ fetchImpl:item.fetchImpl });
      const observation = await probe.checkOne('xiaod');
      assert.equal(observation.status, 'degraded');
      assert.equal(observation.evidence.errorCode, item.expected);
      assert.equal(observation.recovery.action, 'verify_registered_service');
      assert.equal(observation.recovery.automaticActionAuthorized, false);
      assert.match(observation.recovery.recommendation, /禁止执行任意命令/);
      assert.doesNotMatch(JSON.stringify(observation), /secret detail/);
    });
  }
});

test('不允许通过异常超时配置扩大巡检边界', () => {
  assert.throws(() => new DeterministicLocalHealthProbe({ timeoutMs:99 }), /100 到 10000/);
  assert.throws(() => new DeterministicLocalHealthProbe({ timeoutMs:10_001 }), /100 到 10000/);
});
