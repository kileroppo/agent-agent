export const METRICS_SCHEMA_VERSION: any = 'agent.army/boom-metrics-bundle/v1';
export const V2_SCORE_VERSION: any = 'v2';
const DEFAULT_THRESHOLDS: Record<string, any> = { high: 0.04, mid: 0.08, mid_small: 0.15, low: 0.3 };
export function platformCoreMetric(platform: any, likes: any, favorites: any): any {
    return platform === 'xiaohongshu' ? integer(likes) + integer(favorites) : integer(likes);
}
export function tierKeyFromFollowers(followers: any): any {
    const value: any = integer(followers);
    if (value >= 1000000)
        return 'high';
    if (value >= 100000)
        return 'mid';
    if (value >= 10000)
        return 'mid_small';
    return 'low';
}
export function mThresholdByFollowers(followers: any, thresholds: any = DEFAULT_THRESHOLDS): any {
    return Number(thresholds[tierKeyFromFollowers(followers)]);
}
export function buildV2Score(bundle: any, frozenScore: any = null): any {
    validateBundle(bundle);
    const creator: any = bundle.creator ?? {};
    const current: any = bundle.currentWork ?? {};
    const platform: any = String(bundle.platform ?? '');
    const currentFollowers: any = exactInt(creator.followerCount, '作者粉丝数');
    const likes: any = exactInt(current.likes, '当前作品点赞数');
    const favorites: any = optionalExactInt(current.favorites);
    if (platform === 'xiaohongshu' && favorites == null)
        throw new Error('当前作品收藏数不可用。');
    const currentMetric: any = platformCoreMetric(platform, likes, favorites ?? 0);
    const historyMetrics: any[] = [];
    const historyFavoriteRates: any[] = [];
    const historyShareRates: any[] = [];
    const historyCommentRates: any[] = [];
    for (const work of bundle.historyWorks ?? []) {
        const historyLikes: any = optionalExactInt(work?.likes);
        const historyFavorites: any = optionalExactInt(work?.favorites);
        if (historyLikes == null || (platform === 'xiaohongshu' && historyFavorites == null))
            continue;
        historyMetrics.push(platformCoreMetric(platform, historyLikes, historyFavorites ?? 0));
        if (historyLikes > 0) {
            if (historyFavorites != null)
                historyFavoriteRates.push(historyFavorites / historyLikes);
            const shares: any = optionalExactInt(work?.shares);
            const comments: any = optionalExactInt(work?.comments);
            if (shares != null)
                historyShareRates.push(shares / historyLikes);
            if (comments != null)
                historyCommentRates.push(comments / historyLikes);
        }
    }
    const frozenValid: any = Boolean(frozenScore
        && frozenScore.version === V2_SCORE_VERSION
        && frozenScore.baseline_version === 'url-history-v2'
        && frozenScore.baseline_metric != null);
    const baseline: any = frozenValid ? Number(frozenScore.baseline_metric) : (historyMetrics.length ? median(historyMetrics) : 0);
    const sampleCount: any = frozenValid ? integer(frozenScore.sample_count) : historyMetrics.length;
    const followers: any = frozenValid ? integer(frozenScore.follower_snapshot || currentFollowers) : currentFollowers;
    const baselineAt: any = frozenValid
        ? frozenScore.baseline_at
        : (baseline > 0 && sampleCount >= 5 ? String(bundle.observedAt ?? '') : null);
    if (sampleCount < 5 || followers <= 0 || baseline <= 0) {
        return {
            version: V2_SCORE_VERSION, grade: 'N0', status: 'insufficient_history', controls_dispatch: true,
            r_value: 0, m_value: followers <= 0 ? 0 : likes / followers,
            tier: tierKeyFromFollowers(followers), baseline_metric: null, sample_count: sampleCount,
            follower_snapshot: followers, baseline_at: null, baseline_version: null,
            time_basis: 'cumulative_unknown_age',
        };
    }
    const rValue: any = currentMetric / baseline;
    const mValue: any = likes / followers;
    const mThreshold: any = mThresholdByFollowers(followers);
    const favoriteRate: any = likes > 0 && favorites != null ? favorites / likes : null;
    const shares: any = optionalExactInt(current.shares);
    const comments: any = optionalExactInt(current.comments);
    const shareRate: any = likes > 0 && shares != null ? shares / likes : null;
    const commentRate: any = likes > 0 && comments != null ? comments / likes : null;
    const frozenMedians: any = frozenValid ? frozenScore?.signals?.quality?.history_medians : null;
    const historyMedians: any = isPlainObject(frozenMedians) ? frozenMedians : {
        favorite_rate: historyRateMedian(historyFavoriteRates),
        share_rate: historyRateMedian(historyShareRates),
        comment_rate: historyRateMedian(historyCommentRates),
    };
    const favoriteVsHistory: any = relativeRate(favoriteRate, historyMedians.favorite_rate);
    const shareVsHistory: any = relativeRate(shareRate, historyMedians.share_rate);
    const commentVsHistory: any = relativeRate(commentRate, historyMedians.comment_rate);
    const reasons: any[] = [];
    if (platform === 'xiaohongshu' && favoriteRate != null && favoriteRate >= 0.2)
        reasons.push('favorite_rate_floor');
    if (shareRate != null && shareRate >= (platform === 'xiaohongshu' ? 0.05 : 0.02))
        reasons.push('share_rate_floor');
    if (commentRate != null && commentRate >= 0.03)
        reasons.push('comment_rate_floor');
    if (platform === 'xiaohongshu' && favoriteVsHistory != null && favoriteVsHistory >= 1.5)
        reasons.push('favorite_rate_vs_history');
    if (shareVsHistory != null && shareVsHistory >= 1.5)
        reasons.push('share_rate_vs_history');
    if (commentVsHistory != null && commentVsHistory >= 1.5)
        reasons.push('comment_rate_vs_history');
    const qualityPassed: any = reasons.length > 0;
    const absoluteFloors: any = platform === 'xiaohongshu'
        ? { T1: 100, T2: 500, T3: 5000 }
        : { T1: 500, T2: 3000, T3: 10000 };
    let grade: any = 'N0';
    if (rValue >= 8 && (mValue >= mThreshold || currentMetric >= absoluteFloors.T3) && qualityPassed)
        grade = 'T3';
    else if (rValue >= 3 && (mValue >= mThreshold || currentMetric >= absoluteFloors.T2) && qualityPassed)
        grade = 'T2';
    else if (rValue >= 2 && (mValue >= mThreshold * 0.9 || currentMetric >= absoluteFloors.T1 || qualityPassed))
        grade = 'T1';
    const result: Record<string, any> = {
        version: V2_SCORE_VERSION, grade, status: 'evaluated', controls_dispatch: true,
        recommended_analysis_depth: grade === 'T3' ? 'full' : ['T1', 'T2'].includes(grade) ? 'fast' : null,
        r_value: pythonRound(rValue, 4), m_value: pythonRound(mValue, 4), tier: tierKeyFromFollowers(followers),
        absolute_interactions: currentMetric, baseline_metric: pythonRound(baseline, 4), sample_count: sampleCount,
        follower_snapshot: followers, baseline_at: baselineAt, baseline_version: 'url-history-v2',
        time_basis: 'cumulative_unknown_age',
        signals: {
            relative: { passed: rValue >= 2, value: pythonRound(rValue, 4) },
            reach: { m_value: pythonRound(mValue, 4), m_threshold: mThreshold, absolute_floors: absoluteFloors },
            quality: {
                passed: qualityPassed,
                favorite_rate: favoriteRate == null ? null : pythonRound(favoriteRate, 4),
                share_rate: shareRate == null ? null : pythonRound(shareRate, 4),
                comment_rate: commentRate == null ? null : pythonRound(commentRate, 4),
                favorite_rate_vs_history: favoriteVsHistory,
                share_rate_vs_history: shareVsHistory,
                comment_rate_vs_history: commentVsHistory,
                history_medians: historyMedians,
                reasons,
            },
        },
    };
    if (currentMetric < absoluteFloors.T1) {
        if (['T2', 'T3'].includes(result.grade))
            result.grade = 'T1';
        result.grade_cap = 'T1';
        result.grade_cap_reason = 'low_absolute_volume';
    }
    return result;
}
export function bundleToRecord(bundle: any): any {
    validateBundle(bundle);
    const creator: any = bundle.creator ?? {};
    const current: any = bundle.currentWork ?? {};
    const platform: any = String(bundle.platform ?? '').trim();
    const favorites: any = optionalExactInt(current.favorites);
    if (platform === 'xiaohongshu' && favorites == null)
        throw new Error('当前作品收藏数不可用。');
    return {
        platform,
        creator_id: String(creator.id ?? '').trim(),
        creator_name: String(creator.name ?? '').trim(),
        follower_count: exactInt(creator.followerCount, '作者粉丝数'),
        work_id: String(current.id ?? '').trim(),
        title: String(current.title ?? '').trim(),
        likes: exactInt(current.likes, '当前作品点赞数'),
        favorites: favorites ?? 0,
        plays: optionalExactInt(current.plays),
        source_url: String(current.sourceUrl ?? bundle.sourceUrl ?? '').trim(),
        publish_at: optionalIsoDate(current.publishedAt),
        metadata: {
            metrics_schema: METRICS_SCHEMA_VERSION,
            metrics_status: String(bundle.status ?? ''),
            observed_at: String(bundle.observedAt ?? ''),
            history_order: String(bundle.historyOrder ?? ''),
            history_sample_count: integer(bundle.sampleCount),
            history_works: bundle.historyWorks ?? [],
            publish_time_source: String(current.publishTimeSource ?? '').trim() || null,
        },
    };
}
function optionalIsoDate(value: any): string {
    if (typeof value !== 'string' || !value.trim())
        return '';
    const timestamp: any = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}
export function validateBundle(bundle: any): any {
    if (!isPlainObject(bundle) || bundle.schemaVersion !== METRICS_SCHEMA_VERSION)
        throw new Error('指标包版本不受支持。');
    if (!['douyin', 'xiaohongshu'].includes(bundle.platform))
        throw new Error('指标包平台不受支持。');
    if (!isPlainObject(bundle.currentWork) || !String(bundle.currentWork.id ?? '').trim())
        throw new Error('指标包缺少当前作品标识。');
    if (!isPlainObject(bundle.creator) || !String(bundle.creator.id ?? '').trim())
        throw new Error('指标包缺少作者标识。');
}
function historyRateMedian(values: any): any { return values.length < 5 ? null : pythonRound(median(values), 6); }
function relativeRate(current: any, historical: any): any { return current == null || historical == null || historical <= 0 ? null : pythonRound(current / historical, 4); }
function median(values: any): any {
    const ordered: any = [...values].sort((a: any, b: any): any => a - b);
    const middle: any = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function exactInt(value: any, label: any): any {
    const parsed: any = optionalExactInt(value);
    if (parsed == null)
        throw new Error(`${label}不可用。`);
    return parsed;
}
function optionalExactInt(value: any): any { return Number.isInteger(value) && value >= 0 ? value : null; }
function integer(value: any): any { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0; }
export function pythonRound(value: any, digits: any = 0): any {
    if (!Number.isFinite(value) || !Number.isInteger(digits))
        return value;
    if (value === 0)
        return value;
    const bits: any = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, Math.abs(value), false);
    const encoded: any = bits.getBigUint64(0, false);
    const exponentBits: any = Number((encoded >> 52n) & 0x7ffn);
    const fraction: any = encoded & ((1n << 52n) - 1n);
    const significand: any = exponentBits === 0 ? fraction : (1n << 52n) + fraction;
    const binaryExponent: any = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    let numerator: any = significand;
    let denominator: any = 1n;
    if (binaryExponent >= 0)
        numerator <<= BigInt(binaryExponent);
    else
        denominator <<= BigInt(-binaryExponent);
    const decimalScale: any = 10n ** BigInt(Math.abs(digits));
    if (digits >= 0)
        numerator *= decimalScale;
    else
        denominator *= decimalScale;
    let rounded: any = numerator / denominator;
    const remainder: any = numerator % denominator;
    const comparison: any = remainder * 2n - denominator;
    if (comparison > 0n || (comparison === 0n && rounded % 2n !== 0n))
        rounded += 1n;
    const magnitude: any = digits >= 0
        ? Number(rounded) / (10 ** digits)
        : Number(rounded) * (10 ** -digits);
    return value < 0 ? -magnitude : magnitude;
}
function isPlainObject(value: any): any { return value !== null && typeof value === 'object' && !Array.isArray(value); }
