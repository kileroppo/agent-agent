const DEFAULT_THRESHOLDS: any = Object.freeze({
    minCacheHitRatio: 0.6,
    minCacheInputTokens: 10000,
    maxApiCalls: 500,
    apiCallsSpikeRatio: 2,
    apiCallsSpikeMinimum: 50,
    maxReasoningOutputRatio: 0.7,
    minReasoningOutputTokens: 10000,
    maxKnownCostUsd: 5,
});
export function evaluateHermesCostPolicy(view: any, { thresholds = {}, baseline = null }: any = {}): any {
    const sourceStatus: any = normalizeSourceStatus(view?.status);
    const totals: any = view?.totals || {};
    const tokens: any = totals.tokens || {};
    const cost: any = totals.cost || {};
    const missInputTokens: any = nonNegativeInteger(tokens.input) + nonNegativeInteger(tokens.cacheWrite);
    const cachedInputTokens: any = nonNegativeInteger(tokens.cacheRead);
    const outputTokens: any = nonNegativeInteger(tokens.output);
    const reasoningTokens: any = nonNegativeInteger(tokens.reasoning);
    const apiCalls: any = nonNegativeInteger(totals.apiCalls);
    const cacheEligibleTokens: any = missInputTokens + cachedInputTokens;
    const cacheHitRatio: any = cacheEligibleTokens > 0 ? ratio(cachedInputTokens, cacheEligibleTokens) : null;
    const reasoningOutputRatio: any = outputTokens > 0 ? ratio(reasoningTokens, outputTokens) : null;
    const unknownCostEntryCount: any = nonNegativeInteger(cost.unknownEntryCount);
    const knownCostEntryCount: any = ['actualEntryCount', 'estimatedEntryCount', 'includedEntryCount']
        .reduce((sum: any, field: any): any => sum + nonNegativeInteger(cost[field]), 0);
    const costStatus: any = costCoverageStatus({ sourceStatus, unknownCostEntryCount, knownCostEntryCount });
    const knownCostUsd: any = costStatus === 'unknown' ? null : nonNegativeNumber(cost.knownUsd);
    const providerReconciliation: any = normalizeProviderReconciliation(view?.providerReconciliation);
    const metrics: Record<string, any> = {
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
        providerReconciliationStatus: providerReconciliation.status,
        untrackedApiCalls: providerReconciliation.untrackedApiCalls,
        untrackedTokens: providerReconciliation.untrackedTokens,
    };
    const policy: any = normalizeThresholds(thresholds);
    const baselineApiCalls: any = optionalNonNegativeInteger(baseline?.totals?.apiCalls ?? baseline?.metrics?.apiCalls ?? baseline?.apiCalls);
    const apiCallIncrease: any = baselineApiCalls === null ? null : apiCalls - baselineApiCalls;
    const apiCallGrowthRatio: any = baselineApiCalls > 0 ? ratio(apiCalls, baselineApiCalls) : null;
    const comparison: Record<string, any> = { baselineApiCalls, apiCallIncrease, apiCallGrowthRatio };
    const alerts: any[] = [];
    if (sourceStatus === 'unavailable') {
        alerts.push({
            code: 'usage_unavailable',
            severity: 'warning',
            metric: 'ledgerStatus',
            value: 'unavailable',
            threshold: 'ready',
            message: 'Hermes 用量账本不可用；调用、Token 和费用均不可确认。',
        });
    }
    else if (sourceStatus === 'partial') {
        const unavailableProfileCount: any = Array.isArray(view?.unavailableProfiles) ? view.unavailableProfiles.length : 0;
        alerts.push({
            code: 'usage_partial',
            severity: 'attention',
            metric: 'unavailableProfileCount',
            value: unavailableProfileCount,
            threshold: 0,
            message: `Hermes 用量账本数据不完整${unavailableProfileCount ? `，${unavailableProfileCount} 个 Profile 不可读` : ''}；已知金额不代表完整费用。`,
        });
    }
    if (providerReconciliation.status === 'not_configured') {
        alerts.push({
            code: 'provider_total_not_reconciled',
            severity: 'attention',
            metric: 'providerReconciliationStatus',
            value: 'not_configured',
            threshold: 'matched',
            message: '当前只统计受管 Hermes 岗位，不包含 StepFun 全账号和其他客户端；局部 0 次不能解释为账号 0 次。',
        });
    }
    else if (providerReconciliation.status === 'gap') {
        alerts.push({
            code: 'provider_usage_gap',
            severity: 'warning',
            metric: 'untrackedApiCalls',
            value: providerReconciliation.untrackedApiCalls,
            threshold: 0,
            message: `Provider 总账比受管账本多 ${providerReconciliation.untrackedApiCalls} 次调用、${providerReconciliation.untrackedTokens} Token；这些消耗尚未归属，必须先查密钥和调用入口。`,
        });
    }
    else if (providerReconciliation.status === 'invalid' || providerReconciliation.status === 'mismatch') {
        alerts.push({
            code: 'provider_reconciliation_invalid',
            severity: 'warning',
            metric: 'providerReconciliationStatus',
            value: providerReconciliation.status,
            threshold: 'matched',
            message: 'Provider 总账与受管账本的时间窗或统计口径不一致，不能据此下成本结论。',
        });
    }
    if (cacheEligibleTokens >= policy.minCacheInputTokens
        && cacheHitRatio !== null
        && cacheHitRatio < policy.minCacheHitRatio) {
        alerts.push({
            code: 'low_cache_hit_ratio',
            severity: 'warning',
            metric: 'cacheHitRatio',
            value: cacheHitRatio,
            threshold: policy.minCacheHitRatio,
            message: `缓存命中率 ${percent(cacheHitRatio)}，低于 ${percent(policy.minCacheHitRatio)}；先检查 Prompt 前缀是否稳定。`,
        });
    }
    if (apiCalls > policy.maxApiCalls) {
        alerts.push({
            code: 'high_api_calls',
            severity: 'warning',
            metric: 'apiCalls',
            value: apiCalls,
            threshold: policy.maxApiCalls,
            message: `当前观察窗调用 ${apiCalls} 次，超过上限 ${policy.maxApiCalls} 次；先定位高频岗位或重复任务。`,
        });
    }
    if (apiCallGrowthRatio !== null
        && apiCallGrowthRatio >= policy.apiCallsSpikeRatio
        && apiCallIncrease >= policy.apiCallsSpikeMinimum) {
        alerts.push({
            code: 'api_calls_spike',
            severity: 'warning',
            metric: 'apiCallGrowthRatio',
            value: apiCallGrowthRatio,
            threshold: policy.apiCallsSpikeRatio,
            message: `调用较上一观察窗增至 ${apiCallGrowthRatio.toFixed(1)} 倍，净增 ${apiCallIncrease} 次；检查是否出现重复唤醒。`,
        });
    }
    if (outputTokens >= policy.minReasoningOutputTokens
        && reasoningOutputRatio !== null
        && reasoningOutputRatio > policy.maxReasoningOutputRatio) {
        alerts.push({
            code: 'high_reasoning_output_ratio',
            severity: 'attention',
            metric: 'reasoningOutputRatio',
            value: reasoningOutputRatio,
            threshold: policy.maxReasoningOutputRatio,
            message: `推理 Token 占输出 ${percent(reasoningOutputRatio)}，高于 ${percent(policy.maxReasoningOutputRatio)}；简单判断和固定通知应关闭 thinking。`,
        });
    }
    if (knownCostUsd !== null && knownCostUsd > policy.maxKnownCostUsd) {
        alerts.push({
            code: 'known_cost_high',
            severity: 'warning',
            metric: 'knownCostUsd',
            value: knownCostUsd,
            threshold: policy.maxKnownCostUsd,
            message: `当前观察窗已知费用 ${usd(knownCostUsd)}，超过上限 ${usd(policy.maxKnownCostUsd)}；先核对高频岗位和高输出任务。`,
        });
    }
    if (unknownCostEntryCount > 0) {
        alerts.push({
            code: 'cost_unknown',
            severity: 'attention',
            metric: 'unknownCostEntryCount',
            value: unknownCostEntryCount,
            threshold: 0,
            message: `${unknownCostEntryCount} 条用量的费用未知；不能按 0 元处理，需等待 Provider 账单或可靠估算。`,
        });
    }
    const status: any = deriveStatus(alerts, sourceStatus);
    return {
        schemaVersion: 'agent.army/hermes-cost-health/v1',
        status,
        period: view?.period || null,
        metrics,
        comparison,
        thresholds: policy,
        alerts,
        operatorMessage: operatorMessage({ status, metrics, alerts }),
    };
}
function normalizeThresholds(value: any): any {
    const input: any = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        minCacheHitRatio: boundedRatio(input.minCacheHitRatio, DEFAULT_THRESHOLDS.minCacheHitRatio),
        minCacheInputTokens: nonNegativeIntegerOr(input.minCacheInputTokens, DEFAULT_THRESHOLDS.minCacheInputTokens),
        maxApiCalls: nonNegativeIntegerOr(input.maxApiCalls, DEFAULT_THRESHOLDS.maxApiCalls),
        apiCallsSpikeRatio: numberAtLeast(input.apiCallsSpikeRatio, 1, DEFAULT_THRESHOLDS.apiCallsSpikeRatio),
        apiCallsSpikeMinimum: nonNegativeIntegerOr(input.apiCallsSpikeMinimum, DEFAULT_THRESHOLDS.apiCallsSpikeMinimum),
        maxReasoningOutputRatio: boundedRatio(input.maxReasoningOutputRatio, DEFAULT_THRESHOLDS.maxReasoningOutputRatio),
        minReasoningOutputTokens: nonNegativeIntegerOr(input.minReasoningOutputTokens, DEFAULT_THRESHOLDS.minReasoningOutputTokens),
        maxKnownCostUsd: numberAtLeast(input.maxKnownCostUsd, 0, DEFAULT_THRESHOLDS.maxKnownCostUsd),
    };
}
function nonNegativeInteger(value: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function nonNegativeNumber(value: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}
function optionalNonNegativeInteger(value: any): any {
    if (value === undefined || value === null || value === '')
        return null;
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function nonNegativeIntegerOr(value: any, fallback: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
function boundedRatio(value: any, fallback: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}
function numberAtLeast(value: any, minimum: any, fallback: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) && number >= minimum ? number : fallback;
}
function ratio(numerator: any, denominator: any): any {
    return Math.round((numerator / denominator) * 1000000) / 1000000;
}
function percent(value: any): any {
    return value === null ? '未知' : `${(value * 100).toFixed(1)}%`;
}
function usd(value: any): any {
    return value === null ? '未知' : `$${value.toFixed(4)}`;
}
function deriveStatus(alerts: any, sourceStatus: any): any {
    if (sourceStatus === 'unavailable')
        return 'unavailable';
    return alerts.some((alert: any): any => alert.severity === 'warning')
        ? 'warning'
        : alerts.length ? 'attention' : 'healthy';
}
function operatorMessage({ status, metrics, alerts }: any): any {
    if (status === 'unavailable')
        return '模型成本不可确认：Hermes 用量账本不可用。';
    if (status === 'healthy') {
        return `模型成本正常：${metrics.apiCalls} 次调用，缓存命中 ${percent(metrics.cacheHitRatio)}，已知费用 ${usd(metrics.knownCostUsd)}。`;
    }
    const labels: any = alerts.map((alert: any): any => {
        if (alert.code === 'low_cache_hit_ratio')
            return `缓存命中偏低（${percent(alert.value)}）`;
        if (alert.code === 'high_api_calls')
            return `调用过高（${alert.value} 次）`;
        if (alert.code === 'api_calls_spike')
            return `较上一观察窗增至 ${alert.value.toFixed(1)} 倍`;
        if (alert.code === 'high_reasoning_output_ratio')
            return `推理输出占比偏高（${percent(alert.value)}）`;
        if (alert.code === 'known_cost_high')
            return `已知费用过高（${usd(alert.value)}）`;
        if (alert.code === 'cost_unknown')
            return `费用未知（${alert.value} 条）`;
        if (alert.code === 'usage_partial')
            return '账本数据不完整';
        if (alert.code === 'provider_total_not_reconciled')
            return '尚未核对 Provider 总账';
        if (alert.code === 'provider_usage_gap')
            return `发现 ${alert.value} 次账外调用`;
        if (alert.code === 'provider_reconciliation_invalid')
            return 'Provider 核对口径不一致';
        return alert.message;
    });
    return `模型成本需关注：${labels.join('；')}。`;
}

function normalizeProviderReconciliation(value: any): any {
    const status: any = String(value?.status || 'not_configured').trim();
    return {
        status: ['not_configured', 'matched', 'gap', 'mismatch', 'invalid'].includes(status) ? status : 'invalid',
        untrackedApiCalls: nonNegativeInteger(value?.untrackedApiCalls),
        untrackedTokens: nonNegativeInteger(value?.untrackedTokens),
    };
}
function normalizeSourceStatus(value: any): any {
    const status: any = String(value || '').trim().toLowerCase();
    return ['ready', 'partial', 'unavailable'].includes(status) ? status : 'unavailable';
}
function costCoverageStatus({ sourceStatus, unknownCostEntryCount, knownCostEntryCount }: any): any {
    if (sourceStatus === 'unavailable')
        return 'unknown';
    if (unknownCostEntryCount > 0 || sourceStatus === 'partial') {
        return knownCostEntryCount > 0 ? 'partial' : 'unknown';
    }
    return knownCostEntryCount > 0 ? 'known' : 'unknown';
}
