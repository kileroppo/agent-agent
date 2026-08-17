import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillingUsageCache } from '../public/billing-usage-cache.js';

test('账本只在需要时读取，有效期内复用缓存', async () => {
  let calls = 0;
  let now = 1_000;
  const cache = createBillingUsageCache({
    now: () => now,
    ttlMs: 100,
    load: async () => ({ billing:{ status:'ready', version:++calls } }),
  });
  assert.equal(cache.peek(), null);
  assert.equal((await cache.read()).version, 1);
  assert.equal((await cache.read()).version, 1);
  assert.equal(calls, 1);
  now += 101;
  assert.equal((await cache.read()).version, 2);
  assert.equal(calls, 2);
});

test('并发刷新合并为一次请求，也可用指定范围替换缓存', async () => {
  let resolveLoad;
  let calls = 0;
  const cache = createBillingUsageCache({
    load: () => {
      calls += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
  });
  const first = cache.read({ force:true });
  const second = cache.read({ force:true });
  assert.equal(calls, 1);
  resolveLoad({ billing:{ status:'ready' } });
  assert.equal(await first, await second);
  cache.replace({ status:'partial' });
  assert.equal(cache.peek().status, 'partial');
});
