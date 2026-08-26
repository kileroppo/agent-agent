import assert from 'node:assert/strict';
import test from 'node:test';
import { BoomSignalDedupGovernor } from '../boom-signal-dedup-governor.ts';

test('BoomSignalDedupGovernor 首次捕获放行并抑制同态重复', () => {
  let now = 1000000;
  const governor = new BoomSignalDedupGovernor({
    retentionWindowMs: 24 * 3600_000,
    surgeThresholdRatio: 0.3,
    now: () => now,
  });

  const signal1 = {
    workRef: 'douyin:718293849102',
    sourceUrl: 'https://www.douyin.com/video/718293849102',
    grade: 'T1',
    likes: 10000,
  };

  // 1. 首次捕获 -> 放行
  const eval1 = governor.evaluate(signal1, now);
  assert.equal(eval1.action, 'dispatch_new');
  governor.record(signal1, { missionId: 'm-100', now });

  // 2. 10 分钟后再次扫描到同作品，点赞仅从 10000 变为 10500 (+5%) -> 抑制重复
  const eval2 = governor.evaluate({ ...signal1, likes: 10500 }, now + 600000);
  assert.equal(eval2.action, 'suppress_duplicate');
  assert.ok(eval2.reason.includes('直接复用历史成果'));

  // 3. 2 小时后点赞爆发至 18000 (+80%) -> 触发二次深度复盘
  const eval3 = governor.evaluate({ ...signal1, likes: 18000 }, now + 7200000);
  assert.equal(eval3.action, 'dispatch_significant_surge');
  assert.ok(eval3.reason.includes('显著二次爆发'));
});
