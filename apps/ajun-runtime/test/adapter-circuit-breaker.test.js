import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterCircuitBreaker } from '../src/adapter-circuit-breaker.ts';

test('AdapterCircuitBreaker 正常调用保持 CLOSED 状态', async () => {
  const cb = new AdapterCircuitBreaker({ failureThreshold: 3 });
  const res = await cb.execute(async () => 'primary_ok');
  assert.equal(res, 'primary_ok');
  assert.equal(cb.getState(), 'CLOSED');
});

test('AdapterCircuitBreaker 连续失败触发 OPEN 并秒级路由至 Plan B', async () => {
  let now = 1000000;
  const cb = new AdapterCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 30000,
    now: () => now,
  });

  let primaryAttempts = 0;
  let fallbackAttempts = 0;

  const runCall = () =>
    cb.execute(
      async () => {
        primaryAttempts += 1;
        throw new Error('503 Service Unavailable');
      },
      async (err) => {
        fallbackAttempts += 1;
        return 'fallback_plan_b_ok';
      }
    );

  // 第一次调用失败 -> 回退到 Plan B
  const res1 = await runCall();
  assert.equal(res1, 'fallback_plan_b_ok');
  assert.equal(primaryAttempts, 1);
  assert.equal(fallbackAttempts, 1);
  assert.equal(cb.getState(), 'CLOSED');

  // 第二次调用失败 -> 触发熔断 (OPEN)
  const res2 = await runCall();
  assert.equal(res2, 'fallback_plan_b_ok');
  assert.equal(primaryAttempts, 2);
  assert.equal(cb.getState(), 'OPEN');

  // 第三次调用（OPEN 状态） -> 根本不尝试主调用（零超时等待），直接进 Plan B
  const res3 = await runCall();
  assert.equal(res3, 'fallback_plan_b_ok');
  assert.equal(primaryAttempts, 2); // 保持为 2，未调用 primary
  assert.equal(fallbackAttempts, 3);
});

test('AdapterCircuitBreaker 冷却后 HALF_OPEN 探测成功恢复 CLOSED', async () => {
  let now = 1000000;
  const cb = new AdapterCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 20000,
    now: () => now,
  });

  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), 'OPEN');

  // 冷却 25 秒
  now += 25000;
  assert.equal(cb.getState(), 'HALF_OPEN');

  // 半开状态下探测成功 -> 恢复 CLOSED
  const res = await cb.execute(async () => 'probe_success');
  assert.equal(res, 'probe_success');
  assert.equal(cb.getState(), 'CLOSED');
});
