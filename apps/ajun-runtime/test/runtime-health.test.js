import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsoleHealthTruth, buildRuntimeHealth, reliabilityForCurrentRuntime } from '../src/runtime-health.ts';
import { TaskOverview } from '../src/task-overview.ts';

test('可选能力 disabled 或 limited 不会把核心健康误判为 degraded', () => {
  const health = buildRuntimeHealth({
    checkedAt:'2026-08-17T00:00:00.000Z',
    core:[
      { id:'runtime', status:'healthy' },
      { id:'paperclip', status:'ready' },
    ],
    optional:[
      { id:'m5', status:'disabled', detail:'按需开启' },
      { id:'boom-monitor', status:'limited', detail:'自动扫描关闭' },
      { id:'publisher', status:'unavailable', detail:'未启动' },
    ],
    summary:{ employeeCount:17 },
  });

  assert.equal(health.status, 'healthy');
  assert.equal(health.core.status, 'healthy');
  assert.deepEqual(health.optional.components.map((item) => item.status), ['disabled', 'limited', 'unavailable']);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) < 10 * 1024);
});

test('核心治理连接故障会明确降级，同时不回显底层异常', async () => {
  const overview = new TaskOverview({
    registry:{ list:async () => [{ agentId:'operator' }] },
    store:{},
    governance:{ async health() { throw new Error('secret token in transport'); } },
    skillExecutionRegistry:{},
  });

  const health = await overview.health({ optionalModules:[{ id:'m5', status:'disabled' }] });

  assert.equal(health.status, 'degraded');
  assert.equal(health.core.status, 'unavailable');
  assert.equal(health.core.components.find((item) => item.id === 'paperclip').status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(health), /secret token/);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) < 10 * 1024);
});

test('运行台把存活、可靠性和业务债务分层，缺少可靠性观测不能冒充绿色', () => {
  const truth = buildConsoleHealthTruth({
    checkedAt:'2026-08-17T00:00:00.000Z',
    runtimeHealth:buildRuntimeHealth({ core:[{ id:'runtime', status:'healthy' }, { id:'paperclip', status:'healthy' }] }),
    taskFocus:{ reviewBacklog:3, verificationBacklog:3, unresolvedFailures:2, ownerActionable:0 },
  });

  assert.equal(truth.coreOnline.status, 'online');
  assert.equal(truth.reliability.status, 'unknown');
  assert.equal(truth.businessDebt.status, 'needs_attention');
  assert.equal(truth.businessDebt.unresolvedFailures, 2);
  assert.match(truth.reliability.detail, /不能据此显示为稳定/);
});

test('稳定性观测必须和当前 git/release 身份完全一致，旧版本不得染绿首页', () => {
  const current = { gitHead:'source-a', releaseHash:'release-a' };
  const matching = reliabilityForCurrentRuntime({
    status:'healthy', observedAt:'2026-08-17T01:00:00.000Z', runtimeIdentity:current,
  }, current);
  const stale = reliabilityForCurrentRuntime({
    status:'healthy', runtimeIdentity:{ gitHead:'source-a', releaseHash:'release-old' },
  }, current);
  const missing = reliabilityForCurrentRuntime({ status:'healthy', runtimeIdentity:{ gitHead:'source-a' } }, current);

  assert.equal(matching.status, 'healthy');
  assert.equal(stale.status, 'unknown');
  assert.equal(missing.status, 'unknown');
});

test('并发轻量探针复用同一轮 Paperclip 健康探测，不读取任务账本', async () => {
  let governanceCalls = 0;
  let release;
  const overview = new TaskOverview({
    registry:{ list:async () => { throw new Error('health 不应读取员工注册表'); } },
    store:{}, skillExecutionRegistry:{},
    governance:{ health:async () => {
      governanceCalls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { status:'ready', version:'test' };
    } },
  });

  const first = overview.health();
  const second = overview.health();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(governanceCalls, 1);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 'healthy');
  assert.equal(two.status, 'healthy');
});
