import assert from 'node:assert/strict';
import test from 'node:test';
import { readProductMaturityRuntimeBoundary } from '../src/runtime/product-maturity-runtime-boundary.ts';

test('产品成熟度运行边界只读汇总发布器、活动与每日触发器状态', async () => {
  const calls = [];
  const result = await readProductMaturityRuntimeBoundary({
    campaigns:async () => ({
      async list() { calls.push('campaigns.list'); return [{ status:'draft' }, { status:'paused' }]; },
      async getDailyRoutineTrigger() { calls.push('campaigns.getDailyRoutineTrigger'); return { enabled:false }; },
    }),
    publisher:{ async getSafetyStatus() { calls.push('publisher.getSafetyStatus'); return { active:false }; } },
  });
  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...result, revision:undefined }, {
    schemaVersion:'agent.army/product-maturity-runtime-boundary/v1',
    revision:undefined,
    publisher:{ disabled:true },
    campaigns:{ activeCount:0 },
    cron:{ disabled:true },
  });
  assert.deepEqual(calls.sort(), [
    'campaigns.getDailyRoutineTrigger',
    'campaigns.list',
    'publisher.getSafetyStatus',
  ]);
});

test('产品成熟度运行边界如实报告活动中、发布器启用或 Cron 启用', async () => {
  const result = await readProductMaturityRuntimeBoundary({
    campaigns:async () => ({
      list:async () => [{ status:'active' }, { status:'draft' }, { status:'active' }],
      getDailyRoutineTrigger:async () => ({ enabled:true }),
    }),
    publisher:{ getSafetyStatus:async () => ({ active:true }) },
  });
  assert.equal(result.publisher.disabled, false);
  assert.equal(result.campaigns.activeCount, 2);
  assert.equal(result.cron.disabled, false);
});

for (const [name, input] of [
  ['缺少发布器', { campaigns:async () => ({ list:async () => [], getDailyRoutineTrigger:async () => ({ enabled:false }) }) }],
  ['活动列表未知', { campaigns:async () => ({ list:async () => null, getDailyRoutineTrigger:async () => ({ enabled:false }) }), publisher:{ getSafetyStatus:async () => ({ active:false }) } }],
  ['Cron 状态未知', { campaigns:async () => ({ list:async () => [], getDailyRoutineTrigger:async () => ({}) }), publisher:{ getSafetyStatus:async () => ({ active:false }) } }],
  ['发布器状态未知', { campaigns:async () => ({ list:async () => [], getDailyRoutineTrigger:async () => ({ enabled:false }) }), publisher:{ getSafetyStatus:async () => ({}) } }],
]) test(`产品成熟度运行边界${name}时 fail closed`, async () => {
  await assert.rejects(() => readProductMaturityRuntimeBoundary(input), /缺少|未知/);
});
