const DEFAULT_THRESHOLDS = Object.freeze({
  minCacheHitRatio:0.6,
  minCacheInputTokens:10_000,
  maxApiCalls:500,
  apiCallsSpikeRatio:2,
  apiCallsSpikeMinimum:50,
  maxReasoningOutputRatio:0.7,
  minReasoningOutputTokens:10_000,
  maxKnownCostUsd:5,
});

export function evaluateHermesCostPolicy(view, { thresholds = {}, baseline = null } = {}) {
  const sourceStatus = normalizeSourceStatus(view?.status);
  const totals = view?.totals || {};
  const tokens = totals.tokens || {};
  const cost = totals.cost || {};
  const missInputTokens = nonNegativeInteger(tokens.input) + nonNegativeInteger(tokens.cacheWrite);
  const cachedInputTokens = nonNegativeInteger(tokens.cacheRead);
  const outputTokens = nonNegativeInteger(tokens.output);
  const reasoningTokens = nonNegativeInteger(tokens.reasoning);
  const apiCalls = nonNegativeInteger(totals.apiCalls);
  const cacheEligibleTokens = missInputTokens + cachedInputTokens;
  const cacheHitRatio = cacheEligibleTokens > 0 ? ratio(cachedInputTokens, cacheEligibleTokens) : null;
  const reasoningOutputRatio = outputTokens > 0 ? ratio(reasoningTokens, outputTokens) : null;
  const unknownCostEntryCount = nonNegativeInteger(cost.unknownEntryCount);
  const knownCostEntryCount = ['actualEntryCount', 'estimatedEntryCount', 'includedEntryCount']
    .reduce((sum, field) => sum + nonNegativeInteger(cost[field]), 0);
  const costStatus = costCoverageStatus({ sourceStatus, unknownCostEntryCount, knownCostEntryCount });
  const knownCostUsd = costStatus === 'unknown' ? null : nonNegativeNumber(cost.knownUsd);
  const metrics = {
    cacheHitRatio,
    apiCalls,
    missInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    reasoningOutputRatio,
    knownCostUsd,
    costStatus,
    unknownCostEntryCount,
  };
  const policy = normalizeThresholds(thresholds);
  const baselineApiCalls = optionalNonNegativeInteger(
    baseline?.totals?.apiCalls ?? baseline?.metrics?.apiCalls ?? baseline?.apiCalls,
  );
  const apiCallIncrease = baselineApiCalls === null ? null : apiCalls - baselineApiCalls;
  const apiCallGrowthRatio = baselineApiCalls > 0 ? ratio(apiCalls, baselineApiCalls) : null;
  const comparison = { baselineApiCalls, apiCallIncrease, apiCallGrowthRatio };
  const alerts = [];
  if (sourceStatus === 'unavailable') {
    alerts.push({
      code:'usage_unavailable',
      severity:'warning',
      metric:'ledgerStatus',
      value:'unavailable',
      threshold:'ready',
      message:'Hermes 用量账本不可用；调用、Token 和费用均不可确认。',
    });
  } else if (sourceStatus === 'partial') {
    const unavailableProfileCount = Array.isArray(view?.unavailableProfiles) ? view.unavailableProfiles.length : 0;
    alerts.push({
      code:'usage_partial',
      severity:'attention',
      metric:'unavailableProfileCount',
      value:unavailableProfileCount,
      threshold:0,
      message:`Hermes 用量账本数据不完整${unavailableProfileCount ? `，${unavailableProfileCount} 个 Profile 不可读` : ''}；已知金额不代表完整费用。`,
    });
  }
  if (cacheEligibleTokens >= policy.minCacheInputTokens
    && cacheHitRatio !== null
    && cacheHitRatio < policy.minCacheHitRatio) {
    alerts.push({
      code:'low_cache_hit_ratio',
      severity:'warning',
      metric:'cacheHitRatio',
      value:cacheHitRatio,
      threshold:policy.minCacheHitRatio,
      message:`缓存命中率 ${percent(cacheHitRatio)}，低于 ${percent(policy.minCacheHitRatio)}；先检查 Prompt 前缀是否稳定。`,
    });
  }
  if (apiCalls > policy.maxApiCalls) {
    alerts.push({
      code:'high_api_calls',
      severity:'warning',
      metric:'apiCalls',
      value:apiCalls,
      threshold:policy.maxApiCalls,
      message:`当前观察窗调用 ${apiCalls} 次，超过上限 ${policy.maxApiCalls} 次；先定位高频岗位或重复任务。`,
    });
  }
  if (apiCallGrowthRatio !== null
    && apiCallGrowthRatio >= policy.apiCallsSpikeRatio
    && apiCallIncrease >= policy.apiCallsSpikeMinimum) {
    alerts.push({
      code:'api_calls_spike',
      severity:'warning',
      metric:'apiCallGrowthRatio',
      value:apiCallGrowthRatio,
      threshold:policy.apiCallsSpikeRatio,
      message:`调用较上一观察窗增至 ${apiCallGrowthRatio.toFixed(1)} 倍，净增 ${apiCallIncrease} 次；检查是否出现重复唤醒。`,
    });
  }
  if (outputTokens >= policy.minReasoningOutputTokens
    && reasoningOutputRatio !== null
    && reasoningOutputRatio > policy.maxReasoningOutputRatio) {
    alerts.push({
      code:'high_reasoning_output_ratio',
      severity:'attention',
      metric:'reasoningOutputRatio',
      value:reasoningOutputRatio,
      threshold:policy.maxReasoningOutputRatio,
      message:`推理 Token 占输出 ${percent(reasoningOutputRatio)}，高于 ${percent(policy.maxReasoningOutputRatio)}；简单判断和固定通知应关闭 thinking。`,
    });
  }
  if (knownCostUsd !== null && knownCostUsd > policy.maxKnownCostUsd) {
    alerts.push({
      code:'known_cost_high',
      severity:'warning',
      metric:'knownCostUsd',
      value:knownCostUsd,
      threshold:policy.maxKnownCostUsd,
      message:`当前观察窗已知费用 ${usd(knownCostUsd)}，超过上限 ${usd(policy.maxKnownCostUsd)}；先核对高频岗位和高输出任务。`,
    });
  }
  if (unknownCostEntryCount > 0) {
    alerts.push({
      code:'cost_unknown',
      severity:'attention',
      metric:'unknownCostEntryCount',
      value:unknownCostEntryCount,
      threshold:0,
      message:`${unknownCostEntryCount} 条用量的费用未知；不能按 0 元处理，需等待 Provider 账单或可靠估算。`,
    });
  }
  const status = deriveStatus(alerts, sourceStatus);

  return {
    schemaVersion:'agent.army/hermes-cost-health/v1',
    status,
    period:view?.period || null,
    metrics,
    comparison,
    thresholds:policy,
    alerts,
    operatorMessage:operatorMessage({ status, metrics, alerts }),
  };
}

function normalizeThresholds(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    minCacheHitRatio:boundedRatio(input.minCacheHitRatio, DEFAULT_THRESHOLDS.minCacheHitRatio),
    minCacheInputTokens:nonNegativeIntegerOr(input.minCacheInputTokens, DEFAULT_THRESHOLDS.minCacheInputTokens),
    maxApiCalls:nonNegativeIntegerOr(input.maxApiCalls, DEFAULT_THRESHOLDS.maxApiCalls),
    apiCallsSpikeRatio:numberAtLeast(input.apiCallsSpikeRatio, 1, DEFAULT_THRESHOLDS.apiCallsSpikeRatio),
    apiCallsSpikeMinimum:nonNegativeIntegerOr(input.apiCallsSpikeMinimum, DEFAULT_THRESHOLDS.apiCallsSpikeMinimum),
    maxReasoningOutputRatio:boundedRatio(input.maxReasoningOutputRatio, DEFAULT_THRESHOLDS.maxReasoningOutputRatio),
    minReasoningOutputTokens:nonNegativeIntegerOr(input.minReasoningOutputTokens, DEFAULT_THRESHOLDS.minReasoningOutputTokens),
    maxKnownCostUsd:numberAtLeast(input.maxKnownCostUsd, 0, DEFAULT_THRESHOLDS.maxKnownCostUsd),
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nonNegativeIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function boundedRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function numberAtLeast(value, minimum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function ratio(numerator, denominator) {
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function percent(value) {
  return value === null ? '未知' : `${(value * 100).toFixed(1)}%`;
}

function usd(value) {
  return value === null ? '未知' : `$${value.toFixed(4)}`;
}

function deriveStatus(alerts, sourceStatus) {
  if (sourceStatus === 'unavailable') return 'unavailable';
  return alerts.some((alert) => alert.severity === 'warning')
    ? 'warning'
    : alerts.length ? 'attention' : 'healthy';
}

function operatorMessage({ status, metrics, alerts }) {
  if (status === 'unavailable') return '模型成本不可确认：Hermes 用量账本不可用。';
  if (status === 'healthy') {
    return `模型成本正常：${metrics.apiCalls} 次调用，缓存命中 ${percent(metrics.cacheHitRatio)}，已知费用 ${usd(metrics.knownCostUsd)}。`;
  }
  const labels = alerts.map((alert) => {
    if (alert.code === 'low_cache_hit_ratio') return `缓存命中偏低（${percent(alert.value)}）`;
    if (alert.code === 'high_api_calls') return `调用过高（${alert.value} 次）`;
    if (alert.code === 'api_calls_spike') return `较上一观察窗增至 ${alert.value.toFixed(1)} 倍`;
    if (alert.code === 'high_reasoning_output_ratio') return `推理输出占比偏高（${percent(alert.value)}）`;
    if (alert.code === 'known_cost_high') return `已知费用过高（${usd(alert.value)}）`;
    if (alert.code === 'cost_unknown') return `费用未知（${alert.value} 条）`;
    if (alert.code === 'usage_partial') return '账本数据不完整';
    return alert.message;
  });
  return `模型成本需关注：${labels.join('；')}。`;
}

function normalizeSourceStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['ready', 'partial', 'unavailable'].includes(status) ? status : 'unavailable';
}

function costCoverageStatus({ sourceStatus, unknownCostEntryCount, knownCostEntryCount }) {
  if (sourceStatus === 'unavailable') return 'unknown';
  if (unknownCostEntryCount > 0 || sourceStatus === 'partial') {
    return knownCostEntryCount > 0 ? 'partial' : 'unknown';
  }
  return knownCostEntryCount > 0 ? 'known' : 'unknown';
}
