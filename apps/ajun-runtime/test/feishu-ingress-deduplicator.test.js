import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuIngressDeduplicator } from '../src/feishu-ingress-deduplicator.ts';

test('FeishuIngressDeduplicator 正常获取租约并在释放前阻止并发重复请求', () => {
  let now = 1000000;
  const dedup = new FeishuIngressDeduplicator({
    defaultLeaseTtlMs: 4000,
    defaultRetentionMs: 30000,
    now: () => now,
  });

  // 1. 首次请求获得租约
  const res1 = dedup.acquireLease('event_msg_101', { now });
  assert.equal(res1.allowed, true);
  assert.ok(res1.leaseToken);

  // 2. 毫秒级并发重复请求被拒绝 (in_flight)
  const res2 = dedup.acquireLease('event_msg_101', { now: now + 50 });
  assert.equal(res2.allowed, false);
  assert.equal(res2.reason, 'in_flight');

  // 3. 标记处理完成 -> 释放租约并记录已处理
  dedup.markProcessed('event_msg_101', { token: res1.leaseToken, now: now + 500 });
  assert.equal(dedup.isProcessed('event_msg_101', now + 600), true);

  // 4. 处理完成后在保留窗口内再次请求被拒绝 (recently_processed)
  const res3 = dedup.acquireLease('event_msg_101', { now: now + 1000 });
  assert.equal(res3.allowed, false);
  assert.equal(res3.reason, 'recently_processed');

  // 5. 超过保留窗口后允许重新接受
  now += 35000;
  const res4 = dedup.acquireLease('event_msg_101', { now });
  assert.equal(res4.allowed, true);
});

test('FeishuIngressDeduplicator 租约超时未释放时自动过期自愈', () => {
  let now = 1000000;
  const dedup = new FeishuIngressDeduplicator({
    defaultLeaseTtlMs: 2000,
    now: () => now,
  });

  const res1 = dedup.acquireLease('btn_click_202', { now });
  assert.equal(res1.allowed, true);

  // 1 秒内被拦截
  assert.equal(dedup.acquireLease('btn_click_202', { now: now + 1000 }).allowed, false);

  // 2.5 秒后（超出 TTL）旧租约自动失效，允许新请求进入
  now += 2500;
  const res2 = dedup.acquireLease('btn_click_202', { now });
  assert.equal(res2.allowed, true);
});
