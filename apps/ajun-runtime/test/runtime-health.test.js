import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConsoleHealthTruth,
  buildRuntimeHealth,
  reliabilityForCurrentRuntime,
  RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS,
  RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS,
} from '../src/runtime-health.ts';
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
  const current = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const checkedAt = '2026-08-18T00:00:00.000Z';
  const matching = reliabilityForCurrentRuntime({
    status:'healthy', observedAt:checkedAt, runtimeIdentity:current,
  }, current, { checkedAt });
  const stale = reliabilityForCurrentRuntime({
    status:'healthy', observedAt:checkedAt, runtimeIdentity:{ gitHead:current.gitHead, releaseHash:'c'.repeat(64) },
  }, current, { checkedAt });
  const missing = reliabilityForCurrentRuntime({ status:'healthy', observedAt:checkedAt, runtimeIdentity:{ gitHead:current.gitHead } }, current, { checkedAt });

  assert.equal(matching.status, 'healthy');
  assert.equal(stale.status, 'unknown');
  assert.equal(missing.status, 'unknown');
});

test('当前与快照身份都必须同时带有合法 gitHead 和 releaseHash', () => {
  const checkedAt = '2026-08-18T00:00:00.000Z';
  const current = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const healthySnapshot = { status:'healthy', observedAt:checkedAt, runtimeIdentity:current };

  assert.equal(reliabilityForCurrentRuntime(healthySnapshot, { gitHead:current.gitHead }, { checkedAt }).status, 'unknown');
  assert.equal(reliabilityForCurrentRuntime(healthySnapshot, { releaseHash:current.releaseHash }, { checkedAt }).status, 'unknown');
  assert.equal(reliabilityForCurrentRuntime({
    ...healthySnapshot,
    runtimeIdentity:{ gitHead:current.gitHead, releaseHash:'not-a-release-hash' },
  }, current, { checkedAt }).status, 'unknown');
  assert.equal(reliabilityForCurrentRuntime({
    ...healthySnapshot,
    runtimeIdentity:{ gitHead:current.gitHead, releaseHash:'c'.repeat(64) },
  }, current, { checkedAt }).status, 'unknown');
});

test('完成稳定性结论保留 24 小时，旧 schema 没有 heartbeat 时仍兼容', () => {
  const current = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const checkedAt = Date.parse('2026-08-18T00:00:00.000Z');
  const atMaxAge = new Date(checkedAt - RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS).toISOString();
  const justStale = new Date(checkedAt - RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS - 1).toISOString();

  assert.equal(reliabilityForCurrentRuntime({ status:'healthy', observedAt:atMaxAge, runtimeIdentity:current }, current, { checkedAt }).status, 'healthy');
  const stale = reliabilityForCurrentRuntime({ status:'degraded', observedAt:justStale, runtimeIdentity:current }, current, { checkedAt });
  assert.equal(stale.status, 'unknown');
  assert.match(stale.detail, /超过 24 小时/);
});

test('进行中的同身份 72 小时观测以 heartbeat 延续结论，停测超过两个周期加余量即 unknown', () => {
  const current = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const checkedAt = Date.parse('2026-08-18T00:10:00.000Z');
  const oldConclusion = new Date(checkedAt - RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS - 1).toISOString();
  const activeProgress = new Date(checkedAt - 119_000).toISOString(); // interval=30s: 2*30s + 60s = 120s
  const stoppedProgress = new Date(checkedAt - 121_000).toISOString();
  const active = {
    status:'healthy', observedAt:oldConclusion, runtimeIdentity:current,
    progressObservedAt:activeProgress, progressIntervalSeconds:30,
  };

  assert.equal(reliabilityForCurrentRuntime(active, current, { checkedAt }).status, 'healthy');
  const stopped = reliabilityForCurrentRuntime({ ...active, progressObservedAt:stoppedProgress }, current, { checkedAt });
  assert.equal(stopped.status, 'unknown');
  assert.match(stopped.detail, /推进已停止/);
});

test('同身份未来或无时间的稳定性快照 fail-closed，五分钟内时钟偏差仍可采信', () => {
  const current = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const checkedAt = Date.parse('2026-08-18T00:00:00.000Z');
  const withinSkew = new Date(checkedAt + RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS).toISOString();
  const future = new Date(checkedAt + RUNTIME_RELIABILITY_MAX_FUTURE_SKEW_MS + 1).toISOString();

  assert.equal(reliabilityForCurrentRuntime({ status:'healthy', observedAt:withinSkew, runtimeIdentity:current }, current, { checkedAt }).status, 'healthy');
  assert.equal(reliabilityForCurrentRuntime({ status:'healthy', observedAt:future, runtimeIdentity:current }, current, { checkedAt }).status, 'unknown');
  assert.equal(reliabilityForCurrentRuntime({
    status:'healthy', observedAt:new Date(checkedAt - RUNTIME_RELIABILITY_COMPLETION_MAX_AGE_MS - 1).toISOString(), runtimeIdentity:current,
    progressObservedAt:future, progressIntervalSeconds:30,
  }, current, { checkedAt }).status, 'unknown');
  assert.equal(reliabilityForCurrentRuntime({ status:'healthy', observedAt:null, runtimeIdentity:current }, current, { checkedAt }).status, 'unknown');
});

test('核心探测为空或非法时不能被 every 空集合误判为健康', () => {
  const absent = buildRuntimeHealth();
  const invalid = buildRuntimeHealth({ core:'not-an-array' });
  const malformed = buildRuntimeHealth({ core:[null] });

  assert.equal(absent.status, 'degraded');
  assert.equal(absent.core.status, 'unknown');
  assert.equal(invalid.status, 'degraded');
  assert.equal(invalid.core.status, 'unknown');
  assert.equal(malformed.status, 'degraded');
  assert.equal(malformed.core.status, 'unavailable');
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
