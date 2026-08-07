export const METRICS_SCHEMA_VERSION = 'agent.army/boom-metrics-bundle/v1';
export const V2_SCORE_VERSION = 'v2';
export const LEGACY_SHADOW_SCORE_VERSION = 'shadow-v2';

const DEFAULT_THRESHOLDS = { high:0.04, mid:0.08, mid_small:0.15, low:0.3 };

export function platformCoreMetric(platform, likes, favorites) {
  return platform === 'xiaohongshu' ? integer(likes) + integer(favorites) : integer(likes);
}

export function tierKeyFromFollowers(followers) {
  const value = integer(followers);
  if (value >= 1_000_000) return 'high';
  if (value >= 100_000) return 'mid';
  if (value >= 10_000) return 'mid_small';
  return 'low';
}

export function mThresholdByFollowers(followers, thresholds = DEFAULT_THRESHOLDS) {
  return Number(thresholds[tierKeyFromFollowers(followers)]);
}

export function evaluateGrade(rValue, mValue, followers, config = {}) {
  const followerCount = integer(followers);
  if (followerCount <= 0) return 'N0';
  const t3RatioMin = config.t3RatioMin ?? 8;
  const t2RatioMin = config.t2RatioMin ?? 3;
  const t1RatioMin = config.t1RatioMin ?? 2;
  const threshold = mThresholdByFollowers(followerCount, config.tierThresholds ?? DEFAULT_THRESHOLDS);
  if (rValue >= t3RatioMin && mValue >= threshold) return 'T3';
  if (rValue >= t2RatioMin && rValue < t3RatioMin && mValue >= threshold) return 'T2';
  if (rValue >= t1RatioMin && mValue >= threshold * 0.9) return 'T1';
  return 'N0';
}

export function scoreWork(currentMetric, followers, historyMetrics, options = {}) {
  const minimum = options.minHistorySamples ?? 5;
  const values = historyMetrics.map((value) => Math.max(0, Number(value)));
  const followerCount = integer(followers);
  const mNumerator = options.mMetric == null ? Number(currentMetric) : Math.max(0, Number(options.mMetric));
  if (values.length < minimum || followerCount <= 0) {
    return {
      r_value:0,
      m_value:followerCount <= 0 ? 0 : mNumerator / followerCount,
      grade:'N0',
      tier:tierKeyFromFollowers(followerCount),
      baseline_metric:null,
      sample_count:values.length,
    };
  }
  const baseline = median(values);
  const rValue = baseline > 0 ? Number(currentMetric) / baseline : 0;
  const mValue = mNumerator / followerCount;
  return {
    r_value:pythonRound(rValue, 4),
    m_value:pythonRound(mValue, 4),
    grade:evaluateGrade(rValue, mValue, followerCount, options),
    tier:tierKeyFromFollowers(followerCount),
    baseline_metric:pythonRound(baseline, 4),
    sample_count:values.length,
  };
}

export function buildV2Score(bundle, frozenScore = null) {
  validateBundle(bundle);
  const creator = bundle.creator ?? {};
  const current = bundle.currentWork ?? {};
  const platform = String(bundle.platform ?? '');
  const currentFollowers = exactInt(creator.followerCount, '作者粉丝数');
  const likes = exactInt(current.likes, '当前作品点赞数');
  const favorites = optionalExactInt(current.favorites);
  if (platform === 'xiaohongshu' && favorites == null) throw new Error('当前作品收藏数不可用。');
  const currentMetric = platformCoreMetric(platform, likes, favorites ?? 0);
  const historyMetrics = [];
  const historyFavoriteRates = [];
  const historyShareRates = [];
  const historyCommentRates = [];
  for (const work of bundle.historyWorks ?? []) {
    const historyLikes = optionalExactInt(work?.likes);
    const historyFavorites = optionalExactInt(work?.favorites);
    if (historyLikes == null || (platform === 'xiaohongshu' && historyFavorites == null)) continue;
    historyMetrics.push(platformCoreMetric(platform, historyLikes, historyFavorites ?? 0));
    if (historyLikes > 0) {
      if (historyFavorites != null) historyFavoriteRates.push(historyFavorites / historyLikes);
      const shares = optionalExactInt(work?.shares);
      const comments = optionalExactInt(work?.comments);
      if (shares != null) historyShareRates.push(shares / historyLikes);
      if (comments != null) historyCommentRates.push(comments / historyLikes);
    }
  }
  const frozenValid = Boolean(
    frozenScore
    && [V2_SCORE_VERSION, LEGACY_SHADOW_SCORE_VERSION].includes(frozenScore.version)
    && ['url-history-v2', 'url-history-shadow-v2'].includes(frozenScore.baseline_version)
    && frozenScore.baseline_metric != null
  );
  const baseline = frozenValid ? Number(frozenScore.baseline_metric) : (historyMetrics.length ? median(historyMetrics) : 0);
  const sampleCount = frozenValid ? integer(frozenScore.sample_count) : historyMetrics.length;
  const followers = frozenValid ? integer(frozenScore.follower_snapshot || currentFollowers) : currentFollowers;
  const baselineAt = frozenValid
    ? frozenScore.baseline_at
    : (baseline > 0 && sampleCount >= 5 ? String(bundle.observedAt ?? '') : null);
  if (sampleCount < 5 || followers <= 0 || baseline <= 0) {
    return {
      version:V2_SCORE_VERSION, grade:'N0', status:'insufficient_history', controls_dispatch:true,
      r_value:0, m_value:followers <= 0 ? 0 : likes / followers,
      tier:tierKeyFromFollowers(followers), baseline_metric:null, sample_count:sampleCount,
      follower_snapshot:followers, baseline_at:null, baseline_version:null,
      time_basis:'cumulative_unknown_age',
    };
  }
  const rValue = currentMetric / baseline;
  const mValue = likes / followers;
  const mThreshold = mThresholdByFollowers(followers);
  const favoriteRate = likes > 0 && favorites != null ? favorites / likes : null;
  const shares = optionalExactInt(current.shares);
  const comments = optionalExactInt(current.comments);
  const shareRate = likes > 0 && shares != null ? shares / likes : null;
  const commentRate = likes > 0 && comments != null ? comments / likes : null;
  const frozenMedians = frozenValid ? frozenScore?.signals?.quality?.history_medians : null;
  const historyMedians = isPlainObject(frozenMedians) ? frozenMedians : {
    favorite_rate:historyRateMedian(historyFavoriteRates),
    share_rate:historyRateMedian(historyShareRates),
    comment_rate:historyRateMedian(historyCommentRates),
  };
  const favoriteVsHistory = relativeRate(favoriteRate, historyMedians.favorite_rate);
  const shareVsHistory = relativeRate(shareRate, historyMedians.share_rate);
  const commentVsHistory = relativeRate(commentRate, historyMedians.comment_rate);
  const reasons = [];
  if (platform === 'xiaohongshu' && favoriteRate != null && favoriteRate >= 0.2) reasons.push('favorite_rate_floor');
  if (shareRate != null && shareRate >= (platform === 'xiaohongshu' ? 0.05 : 0.02)) reasons.push('share_rate_floor');
  if (commentRate != null && commentRate >= 0.03) reasons.push('comment_rate_floor');
  if (platform === 'xiaohongshu' && favoriteVsHistory != null && favoriteVsHistory >= 1.5) reasons.push('favorite_rate_vs_history');
  if (shareVsHistory != null && shareVsHistory >= 1.5) reasons.push('share_rate_vs_history');
  if (commentVsHistory != null && commentVsHistory >= 1.5) reasons.push('comment_rate_vs_history');
  const qualityPassed = reasons.length > 0;
  const absoluteFloors = platform === 'xiaohongshu'
    ? { T1:100, T2:500, T3:5_000 }
    : { T1:500, T2:3_000, T3:10_000 };
  let grade = 'N0';
  if (rValue >= 8 && (mValue >= mThreshold || currentMetric >= absoluteFloors.T3) && qualityPassed) grade = 'T3';
  else if (rValue >= 3 && (mValue >= mThreshold || currentMetric >= absoluteFloors.T2) && qualityPassed) grade = 'T2';
  else if (rValue >= 2 && (mValue >= mThreshold * 0.9 || currentMetric >= absoluteFloors.T1 || qualityPassed)) grade = 'T1';
  const result = {
    version:V2_SCORE_VERSION, grade, status:'evaluated', controls_dispatch:true,
    recommended_analysis_depth:grade === 'T3' ? 'full' : ['T1', 'T2'].includes(grade) ? 'fast' : null,
    r_value:pythonRound(rValue, 4), m_value:pythonRound(mValue, 4), tier:tierKeyFromFollowers(followers),
    absolute_interactions:currentMetric, baseline_metric:pythonRound(baseline, 4), sample_count:sampleCount,
    follower_snapshot:followers, baseline_at:baselineAt, baseline_version:'url-history-v2',
    time_basis:'cumulative_unknown_age',
    signals:{
      relative:{ passed:rValue >= 2, value:pythonRound(rValue, 4) },
      reach:{ m_value:pythonRound(mValue, 4), m_threshold:mThreshold, absolute_floors:absoluteFloors },
      quality:{
        passed:qualityPassed,
        favorite_rate:favoriteRate == null ? null : pythonRound(favoriteRate, 4),
        share_rate:shareRate == null ? null : pythonRound(shareRate, 4),
        comment_rate:commentRate == null ? null : pythonRound(commentRate, 4),
        favorite_rate_vs_history:favoriteVsHistory,
        share_rate_vs_history:shareVsHistory,
        comment_rate_vs_history:commentVsHistory,
        history_medians:historyMedians,
        reasons,
      },
    },
  };
  if (currentMetric < absoluteFloors.T1) {
    if (['T2', 'T3'].includes(result.grade)) result.grade = 'T1';
    result.grade_cap = 'T1';
    result.grade_cap_reason = 'low_absolute_volume';
  }
  return result;
}

export function bundleToRecord(bundle) {
  validateBundle(bundle);
  const creator = bundle.creator ?? {};
  const current = bundle.currentWork ?? {};
  const platform = String(bundle.platform ?? '').trim();
  const favorites = optionalExactInt(current.favorites);
  if (platform === 'xiaohongshu' && favorites == null) throw new Error('当前作品收藏数不可用。');
  return {
    platform,
    creator_id:String(creator.id ?? '').trim(),
    creator_name:String(creator.name ?? '').trim(),
    follower_count:exactInt(creator.followerCount, '作者粉丝数'),
    work_id:String(current.id ?? '').trim(),
    title:String(current.title ?? '').trim(),
    likes:exactInt(current.likes, '当前作品点赞数'),
    favorites:favorites ?? 0,
    plays:optionalExactInt(current.plays),
    source_url:String(current.sourceUrl ?? bundle.sourceUrl ?? '').trim(),
    publish_at:'',
    metadata:{
      metrics_schema:METRICS_SCHEMA_VERSION,
      metrics_status:String(bundle.status ?? ''),
      observed_at:String(bundle.observedAt ?? ''),
      history_order:String(bundle.historyOrder ?? ''),
      history_sample_count:integer(bundle.sampleCount),
      history_works:bundle.historyWorks ?? [],
    },
  };
}

export function buildCollectedScore(bundle, frozenScore = null) {
  validateBundle(bundle);
  if (bundle.status === 'metrics_unavailable') throw new Error('当前作品指标不可用，不能生成爆款分级。');
  const record = bundleToRecord(bundle);
  const currentMetric = platformCoreMetric(record.platform, record.likes, record.favorites);
  const historyMetrics = [];
  for (const work of bundle.historyWorks ?? []) {
    const likes = optionalExactInt(work?.likes);
    const favorites = optionalExactInt(work?.favorites);
    if (likes == null || (record.platform === 'xiaohongshu' && favorites == null)) continue;
    historyMetrics.push(platformCoreMetric(record.platform, likes, favorites ?? 0));
  }
  if (frozenScore?.baseline_version === 'url-history-v1' && frozenScore.baseline_metric != null) {
    const baseline = Number(frozenScore.baseline_metric);
    const followers = integer(frozenScore.follower_snapshot || record.follower_count);
    const rValue = baseline > 0 ? currentMetric / baseline : 0;
    const mValue = followers > 0 ? record.likes / followers : 0;
    return {
      r_value:pythonRound(rValue, 4), m_value:pythonRound(mValue, 4), grade:evaluateGrade(rValue, mValue, followers),
      tier:tierKeyFromFollowers(followers), baseline_metric:baseline,
      sample_count:integer(frozenScore.baseline_sample_count), follower_snapshot:followers,
      baseline_at:frozenScore.baseline_at, baseline_version:'url-history-v1',
    };
  }
  const score = scoreWork(currentMetric, record.follower_count, historyMetrics.slice(0, 20), { mMetric:record.likes });
  return {
    ...score,
    follower_snapshot:record.follower_count,
    baseline_at:score.baseline_metric != null ? String(bundle.observedAt ?? '') : null,
    baseline_version:score.baseline_metric != null ? 'url-history-v1' : null,
  };
}

export function buildScoreComparison(bundle, frozenLegacyScore = null, frozenV2Score = null) {
  const legacy = buildCollectedScore(bundle, frozenLegacyScore);
  const official = buildV2Score(bundle, frozenV2Score);
  official.legacy_grade = legacy.grade;
  official.differs_from_legacy = official.grade !== legacy.grade;
  official.observed_at = String(bundle.observedAt ?? '');
  Object.assign(legacy, {
    version:'legacy-v1', controls_dispatch:false, official_grade:official.grade,
    differs_from_official:legacy.grade !== official.grade, observed_at:String(bundle.observedAt ?? ''),
  });
  return { official_score:official, legacy_score:legacy };
}

export function validateBundle(bundle) {
  if (!isPlainObject(bundle) || bundle.schemaVersion !== METRICS_SCHEMA_VERSION) throw new Error('指标包版本不受支持。');
  if (!['douyin', 'xiaohongshu'].includes(bundle.platform)) throw new Error('指标包平台不受支持。');
  if (!isPlainObject(bundle.currentWork) || !String(bundle.currentWork.id ?? '').trim()) throw new Error('指标包缺少当前作品标识。');
  if (!isPlainObject(bundle.creator) || !String(bundle.creator.id ?? '').trim()) throw new Error('指标包缺少作者标识。');
}

function historyRateMedian(values) { return values.length < 5 ? null : pythonRound(median(values), 6); }
function relativeRate(current, historical) { return current == null || historical == null || historical <= 0 ? null : pythonRound(current / historical, 4); }
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function exactInt(value, label) {
  const parsed = optionalExactInt(value);
  if (parsed == null) throw new Error(`${label}不可用。`);
  return parsed;
}
function optionalExactInt(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function integer(value) { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0; }
export function pythonRound(value, digits = 0) {
  if (!Number.isFinite(value) || !Number.isInteger(digits)) return value;
  if (value === 0) return value;

  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(value), false);
  const encoded = bits.getBigUint64(0, false);
  const exponentBits = Number((encoded >> 52n) & 0x7ffn);
  const fraction = encoded & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : (1n << 52n) + fraction;
  const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;

  let numerator = significand;
  let denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);
  const decimalScale = 10n ** BigInt(Math.abs(digits));
  if (digits >= 0) numerator *= decimalScale;
  else denominator *= decimalScale;

  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const comparison = remainder * 2n - denominator;
  if (comparison > 0n || (comparison === 0n && rounded % 2n !== 0n)) rounded += 1n;

  const magnitude = digits >= 0
    ? Number(rounded) / (10 ** digits)
    : Number(rounded) * (10 ** -digits);
  return value < 0 ? -magnitude : magnitude;
}
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
