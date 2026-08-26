import assert from 'node:assert/strict';
import test from 'node:test';
import { PublisherAccountQuotaGovernor } from '../src/publisher-account-quota-governor.ts';

test('PublisherAccountQuotaGovernor 正确扣减单日发稿配额并在超限时熔断拦截', () => {
  let now = 1700000000000;
  const governor = new PublisherAccountQuotaGovernor({
    customLimits: {
      wechat: { dailyPublishLimit: 2, hourlyMetricsLimit: 50 },
    },
    now: () => now,
  });

  // 1. 第一次发稿 -> 允许 (剩余 1)
  const res1 = governor.checkAndConsume('wechat', 'gh_acc_01', 'publish', now);
  assert.equal(res1.allowed, true);
  assert.equal(res1.remaining, 1);
  assert.equal(res1.limit, 2);

  // 2. 第二次发稿 -> 允许 (剩余 0)
  const res2 = governor.checkAndConsume('wechat', 'gh_acc_01', 'publish', now + 3600_000);
  assert.equal(res2.allowed, true);
  assert.equal(res2.remaining, 0);

  // 3. 第三次发稿 -> 超出限制，拦截熔断
  const res3 = governor.checkAndConsume('wechat', 'gh_acc_01', 'publish', now + 7200_000);
  assert.equal(res3.allowed, false);
  assert.equal(res3.remaining, 0);
  assert.ok(res3.reason.includes('已达单日发稿上限'));

  // 4. 25 小时后滑动窗口重置 -> 恢复配额
  now += 25 * 3600_000;
  const res4 = governor.checkAndConsume('wechat', 'gh_acc_01', 'publish', now);
  assert.equal(res4.allowed, true);
});
