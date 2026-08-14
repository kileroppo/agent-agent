import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateHermesCostPolicy } from '../src/hermes-cost-policy.ts';

function usageView(overrides = {}) {
  return {
    status:'ready',
    period:{ since:'2026-08-08T00:00:00.000Z', until:'2026-08-09T00:00:00.000Z' },
    totals:{
      entryCount:2,
      apiCalls:100,
      tokens:{ input:400_000, output:50_000, cacheRead:1_600_000, cacheWrite:0, reasoning:20_000 },
      cost:{
        knownUsd:0.5,
        actualEntryCount:1,
        estimatedEntryCount:1,
        includedEntryCount:0,
        unknownEntryCount:0,
      },
    },
    ...overrides,
  };
}

test('从 Hermes 账本汇总缓存、调用、推理和已知费用，并给出简洁健康文案', () => {
  const result = evaluateHermesCostPolicy(usageView());

  assert.equal(result.schemaVersion, 'agent.army/hermes-cost-health/v1');
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.metrics, {
    cacheHitRatio:0.8,
    apiCalls:100,
    missInputTokens:400_000,
    cachedInputTokens:1_600_000,
    outputTokens:50_000,
    reasoningTokens:20_000,
    reasoningOutputRatio:0.4,
    knownCostUsd:0.5,
    costStatus:'known',
    unknownCostEntryCount:0,
  });
  assert.deepEqual(result.alerts, []);
  assert.match(result.operatorMessage, /100 次调用/);
  assert.match(result.operatorMessage, /缓存命中 80\.0%/);
  assert.match(result.operatorMessage, /已知费用 \$0\.5000/);
});

test('缓存样本达到阈值且命中率偏低时生成结构化告警，并接受注入阈值', () => {
  const result = evaluateHermesCostPolicy(usageView({
    totals:{
      entryCount:1,
      apiCalls:10,
      tokens:{ input:300, output:20, cacheRead:100, cacheWrite:0, reasoning:5 },
      cost:{ knownUsd:0.01, actualEntryCount:1, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
    },
  }), { thresholds:{ minCacheInputTokens:100, minCacheHitRatio:0.7 } });

  assert.equal(result.status, 'warning');
  assert.equal(result.thresholds.minCacheHitRatio, 0.7);
  assert.deepEqual(result.alerts, [{
    code:'low_cache_hit_ratio',
    severity:'warning',
    metric:'cacheHitRatio',
    value:0.25,
    threshold:0.7,
    message:'缓存命中率 25.0%，低于 70.0%；先检查 Prompt 前缀是否稳定。',
  }]);
  assert.match(result.operatorMessage, /缓存命中偏低（25\.0%）/);
});

test('调用次数超过上限且相对上一观察窗突增时分别告警', () => {
  const result = evaluateHermesCostPolicy(usageView({
    totals:{
      entryCount:1,
      apiCalls:150,
      tokens:{ input:1_000, output:100, cacheRead:9_000, cacheWrite:0, reasoning:20 },
      cost:{ knownUsd:0.1, actualEntryCount:1, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
    },
  }), {
    thresholds:{ maxApiCalls:100, apiCallsSpikeRatio:2, apiCallsSpikeMinimum:20 },
    baseline:{ apiCalls:50 },
  });

  assert.equal(result.status, 'warning');
  assert.deepEqual(result.comparison, { baselineApiCalls:50, apiCallIncrease:100, apiCallGrowthRatio:3 });
  assert.deepEqual(result.alerts.map((alert) => [alert.code, alert.value, alert.threshold]), [
    ['high_api_calls', 150, 100],
    ['api_calls_spike', 3, 2],
  ]);
  assert.match(result.operatorMessage, /调用过高（150 次）/);
  assert.match(result.operatorMessage, /较上一观察窗增至 3\.0 倍/);
});

test('推理 Token 占输出比例过高时提示关闭简单任务的深度思考', () => {
  const result = evaluateHermesCostPolicy(usageView({
    totals:{
      entryCount:1,
      apiCalls:20,
      tokens:{ input:1_000, output:1_000, cacheRead:9_000, cacheWrite:0, reasoning:800 },
      cost:{ knownUsd:0.1, actualEntryCount:1, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
    },
  }), { thresholds:{ maxReasoningOutputRatio:0.6, minReasoningOutputTokens:100 } });

  assert.equal(result.status, 'attention');
  assert.deepEqual(result.alerts, [{
    code:'high_reasoning_output_ratio',
    severity:'attention',
    metric:'reasoningOutputRatio',
    value:0.8,
    threshold:0.6,
    message:'推理 Token 占输出 80.0%，高于 60.0%；简单判断和固定通知应关闭 thinking。',
  }]);
  assert.match(result.operatorMessage, /推理输出占比偏高（80\.0%）/);
});

test('费用未回填时保持 unknown 和 null，不把未知费用当作零', () => {
  const result = evaluateHermesCostPolicy(usageView({
    totals:{
      entryCount:1,
      apiCalls:1,
      tokens:{ input:100, output:20, cacheRead:900, cacheWrite:0, reasoning:0 },
      cost:{ knownUsd:0, actualEntryCount:0, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:1 },
    },
  }));

  assert.equal(result.status, 'attention');
  assert.equal(result.metrics.costStatus, 'unknown');
  assert.equal(result.metrics.knownCostUsd, null);
  assert.deepEqual(result.alerts, [{
    code:'cost_unknown',
    severity:'attention',
    metric:'unknownCostEntryCount',
    value:1,
    threshold:0,
    message:'1 条用量的费用未知；不能按 0 元处理，需等待 Provider 账单或可靠估算。',
  }]);
  assert.match(result.operatorMessage, /费用未知（1 条）/);
});

test('已知费用超过观察窗上限时生成费用告警', () => {
  const result = evaluateHermesCostPolicy(usageView(), { thresholds:{ maxKnownCostUsd:0.25 } });

  assert.equal(result.status, 'warning');
  assert.deepEqual(result.alerts, [{
    code:'known_cost_high',
    severity:'warning',
    metric:'knownCostUsd',
    value:0.5,
    threshold:0.25,
    message:'当前观察窗已知费用 $0.5000，超过上限 $0.2500；先核对高频岗位和高输出任务。',
  }]);
  assert.match(result.operatorMessage, /已知费用过高（\$0\.5000）/);
});

test('账本不可用时不输出零费用健康结论', () => {
  const result = evaluateHermesCostPolicy({
    status:'unavailable',
    period:null,
    totals:{
      entryCount:0,
      apiCalls:0,
      tokens:{ input:0, output:0, cacheRead:0, cacheWrite:0, reasoning:0 },
      cost:{ knownUsd:0, actualEntryCount:0, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
    },
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.metrics.knownCostUsd, null);
  assert.equal(result.metrics.costStatus, 'unknown');
  assert.equal(result.alerts[0].code, 'usage_unavailable');
  assert.match(result.operatorMessage, /模型成本不可确认/);
  assert.doesNotMatch(result.operatorMessage, /\$0\.0000/);
});

test('缓存写入属于未命中输入，命中率按完整 Prompt Token 口径计算', () => {
  const result = evaluateHermesCostPolicy(usageView({
    totals:{
      entryCount:1,
      apiCalls:1,
      tokens:{ input:200, output:20, cacheRead:700, cacheWrite:100, reasoning:0 },
      cost:{ knownUsd:0.01, actualEntryCount:1, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
    },
  }));

  assert.equal(result.metrics.cachedInputTokens, 700);
  assert.equal(result.metrics.missInputTokens, 300);
  assert.equal(result.metrics.cacheHitRatio, 0.7);
});

test('非法阈值不会放宽成本门禁，自动回退到保守默认值', () => {
  const result = evaluateHermesCostPolicy(usageView(), { thresholds:{
    minCacheHitRatio:2,
    minCacheInputTokens:-1,
    maxApiCalls:'many',
    apiCallsSpikeRatio:0.5,
    apiCallsSpikeMinimum:-10,
    maxReasoningOutputRatio:-1,
    minReasoningOutputTokens:'many',
    maxKnownCostUsd:-1,
  } });

  assert.deepEqual(result.thresholds, {
    minCacheHitRatio:0.6,
    minCacheInputTokens:10_000,
    maxApiCalls:500,
    apiCallsSpikeRatio:2,
    apiCallsSpikeMinimum:50,
    maxReasoningOutputRatio:0.7,
    minReasoningOutputTokens:10_000,
    maxKnownCostUsd:5,
  });
});

test('部分 Profile 不可读时保留已知金额，但健康状态标记为数据不完整', () => {
  const result = evaluateHermesCostPolicy({
    ...usageView(),
    status:'partial',
    unavailableProfiles:['operator'],
  });

  assert.equal(result.status, 'attention');
  assert.equal(result.metrics.costStatus, 'partial');
  assert.equal(result.metrics.knownCostUsd, 0.5);
  assert.equal(result.alerts[0].code, 'usage_partial');
  assert.match(result.operatorMessage, /账本数据不完整/);
});
