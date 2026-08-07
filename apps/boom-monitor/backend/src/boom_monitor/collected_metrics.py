from __future__ import annotations

from statistics import median
from typing import Any, Dict, Optional

from .scorer import evaluate_grade, m_threshold_by_followers, platform_core_metric, score_work, tier_key_from_followers


SCHEMA_VERSION = 'agent.army/boom-metrics-bundle/v1'
V2_SCORE_VERSION = 'v2'
LEGACY_SHADOW_SCORE_VERSION = 'shadow-v2'


def build_v2_score(bundle: Dict[str, Any], frozen_score: Optional[dict] = None) -> dict:
    _validate_bundle(bundle)
    creator = bundle.get('creator') or {}
    current = bundle.get('currentWork') or {}
    platform = str(bundle.get('platform') or '')
    current_followers = _exact_int(creator.get('followerCount'), '作者粉丝数')
    likes = _exact_int(current.get('likes'), '当前作品点赞数')
    favorites = _optional_exact_int(current.get('favorites'))
    if platform == 'xiaohongshu' and favorites is None:
        raise ValueError('当前作品收藏数不可用。')
    current_metric = platform_core_metric(platform, likes, favorites or 0)
    history_metrics = []
    history_favorite_rates = []
    history_share_rates = []
    history_comment_rates = []
    for work in bundle.get('historyWorks') or []:
        history_likes = _optional_exact_int(work.get('likes'))
        history_favorites = _optional_exact_int(work.get('favorites'))
        if history_likes is None or (platform == 'xiaohongshu' and history_favorites is None):
            continue
        history_metrics.append(platform_core_metric(platform, history_likes, history_favorites or 0))
        if history_likes > 0:
            if history_favorites is not None:
                history_favorite_rates.append(history_favorites / history_likes)
            history_shares = _optional_exact_int(work.get('shares'))
            history_comments = _optional_exact_int(work.get('comments'))
            if history_shares is not None:
                history_share_rates.append(history_shares / history_likes)
            if history_comments is not None:
                history_comment_rates.append(history_comments / history_likes)

    frozen_baseline_valid = bool(
        frozen_score
        and frozen_score.get('version') in {V2_SCORE_VERSION, LEGACY_SHADOW_SCORE_VERSION}
        and frozen_score.get('baseline_version') in {'url-history-v2', 'url-history-shadow-v2'}
        and frozen_score.get('baseline_metric') is not None
    )
    if frozen_baseline_valid:
        baseline = float(frozen_score['baseline_metric'])
        sample_count = int(frozen_score.get('sample_count') or 0)
        followers = int(frozen_score.get('follower_snapshot') or current_followers)
        baseline_at = frozen_score.get('baseline_at')
    else:
        baseline = float(median(history_metrics)) if history_metrics else 0.0
        sample_count = len(history_metrics)
        followers = current_followers
        baseline_at = str(bundle.get('observedAt') or '') if baseline > 0 and sample_count >= 5 else None
    if sample_count < 5 or followers <= 0 or baseline <= 0:
        return {
            'version': V2_SCORE_VERSION,
            'grade': 'N0',
            'status': 'insufficient_history',
            'controls_dispatch': True,
            'r_value': 0.0,
            'm_value': 0.0 if followers <= 0 else likes / followers,
            'tier': tier_key_from_followers(followers),
            'baseline_metric': None,
            'sample_count': sample_count,
            'follower_snapshot': followers,
            'baseline_at': None,
            'baseline_version': None,
            'time_basis': 'cumulative_unknown_age',
        }

    r_value = current_metric / baseline
    m_value = likes / followers
    m_threshold = m_threshold_by_followers(followers)
    favorite_rate = (favorites / likes) if likes > 0 and favorites is not None else None
    shares = _optional_exact_int(current.get('shares'))
    share_rate = (shares / likes) if likes > 0 and shares is not None else None
    comments = _optional_exact_int(current.get('comments'))
    comment_rate = (comments / likes) if likes > 0 and comments is not None else None
    frozen_quality = (frozen_score or {}).get('signals', {}).get('quality', {}) if frozen_baseline_valid else {}
    frozen_history_medians = frozen_quality.get('history_medians')
    if isinstance(frozen_history_medians, dict):
        history_quality_medians = frozen_history_medians
    else:
        history_quality_medians = {
            'favorite_rate': _history_rate_median(history_favorite_rates),
            'share_rate': _history_rate_median(history_share_rates),
            'comment_rate': _history_rate_median(history_comment_rates),
        }
    favorite_rate_vs_history = _relative_rate(favorite_rate, history_quality_medians.get('favorite_rate'))
    share_rate_vs_history = _relative_rate(share_rate, history_quality_medians.get('share_rate'))
    comment_rate_vs_history = _relative_rate(comment_rate, history_quality_medians.get('comment_rate'))
    quality_reasons = []
    if platform == 'xiaohongshu' and favorite_rate is not None and favorite_rate >= 0.20:
        quality_reasons.append('favorite_rate_floor')
    if share_rate is not None and share_rate >= (0.05 if platform == 'xiaohongshu' else 0.02):
        quality_reasons.append('share_rate_floor')
    if comment_rate is not None and comment_rate >= 0.03:
        quality_reasons.append('comment_rate_floor')
    if platform == 'xiaohongshu' and favorite_rate_vs_history is not None and favorite_rate_vs_history >= 1.5:
        quality_reasons.append('favorite_rate_vs_history')
    if share_rate_vs_history is not None and share_rate_vs_history >= 1.5:
        quality_reasons.append('share_rate_vs_history')
    if comment_rate_vs_history is not None and comment_rate_vs_history >= 1.5:
        quality_reasons.append('comment_rate_vs_history')
    quality_passed = bool(quality_reasons)
    absolute_floors = {
        'xiaohongshu': {'T1': 100, 'T2': 500, 'T3': 5_000},
        'douyin': {'T1': 500, 'T2': 3_000, 'T3': 10_000},
    }[platform]
    t3_reach = m_value >= m_threshold or current_metric >= absolute_floors['T3']
    t2_reach = m_value >= m_threshold or current_metric >= absolute_floors['T2']
    t1_evidence = m_value >= m_threshold * 0.9 or current_metric >= absolute_floors['T1'] or quality_passed
    if r_value >= 8 and t3_reach and quality_passed:
        grade = 'T3'
    elif r_value >= 3 and t2_reach and quality_passed:
        grade = 'T2'
    elif r_value >= 2 and t1_evidence:
        grade = 'T1'
    else:
        grade = 'N0'
    grade_cap = None
    grade_cap_reason = None
    if current_metric < absolute_floors['T1'] and grade in {'T2', 'T3'}:
        grade = 'T1'
    if current_metric < absolute_floors['T1']:
        grade_cap = 'T1'
        grade_cap_reason = 'low_absolute_volume'
    result = {
        'version': V2_SCORE_VERSION,
        'grade': grade,
        'status': 'evaluated',
        'controls_dispatch': True,
        'recommended_analysis_depth': 'full' if grade == 'T3' else 'fast' if grade in {'T1', 'T2'} else None,
        'r_value': round(r_value, 4),
        'm_value': round(m_value, 4),
        'tier': tier_key_from_followers(followers),
        'absolute_interactions': current_metric,
        'baseline_metric': round(baseline, 4),
        'sample_count': sample_count,
        'follower_snapshot': followers,
        'baseline_at': baseline_at,
        'baseline_version': 'url-history-v2',
        'time_basis': 'cumulative_unknown_age',
        'signals': {
            'relative': {'passed': r_value >= 2, 'value': round(r_value, 4)},
            'reach': {
                'm_value': round(m_value, 4),
                'm_threshold': m_threshold,
                'absolute_floors': absolute_floors,
            },
            'quality': {
                'passed': quality_passed,
                'favorite_rate': None if favorite_rate is None else round(favorite_rate, 4),
                'share_rate': None if share_rate is None else round(share_rate, 4),
                'comment_rate': None if comment_rate is None else round(comment_rate, 4),
                'favorite_rate_vs_history': favorite_rate_vs_history,
                'share_rate_vs_history': share_rate_vs_history,
                'comment_rate_vs_history': comment_rate_vs_history,
                'history_medians': history_quality_medians,
                'reasons': quality_reasons,
            },
        },
    }
    if grade_cap:
        result['grade_cap'] = grade_cap
        result['grade_cap_reason'] = grade_cap_reason
    return result


def build_score_comparison(
    bundle: Dict[str, Any],
    frozen_legacy_score: Optional[dict] = None,
    frozen_v2_score: Optional[dict] = None,
) -> dict:
    legacy_score = build_collected_score(bundle, frozen_score=frozen_legacy_score)
    official_score = build_v2_score(bundle, frozen_score=frozen_v2_score)
    official_score['legacy_grade'] = legacy_score['grade']
    official_score['differs_from_legacy'] = official_score['grade'] != legacy_score['grade']
    official_score['observed_at'] = str(bundle.get('observedAt') or '')
    legacy_score['version'] = 'legacy-v1'
    legacy_score['controls_dispatch'] = False
    legacy_score['official_grade'] = official_score['grade']
    legacy_score['differs_from_official'] = legacy_score['grade'] != official_score['grade']
    legacy_score['observed_at'] = str(bundle.get('observedAt') or '')
    return {
        'official_score': official_score,
        'legacy_score': legacy_score,
    }


# Compatibility for callers from the observation-only rollout.
build_shadow_score = build_v2_score


def _history_rate_median(history_rates: list[float]) -> Optional[float]:
    if len(history_rates) < 5:
        return None
    return round(float(median(history_rates)), 6)


def _relative_rate(current_rate: Optional[float], history_median: Optional[float]) -> Optional[float]:
    if current_rate is None or history_median is None or history_median <= 0:
        return None
    return round(current_rate / history_median, 4)


def bundle_to_record(bundle: Dict[str, Any]) -> dict:
    _validate_bundle(bundle)
    creator = bundle.get('creator') or {}
    current = bundle.get('currentWork') or {}
    platform = str(bundle.get('platform') or '').strip()
    favorites = _optional_exact_int(current.get('favorites'))
    if platform == 'xiaohongshu' and favorites is None:
        raise ValueError('当前作品收藏数不可用。')
    return {
        'platform': platform,
        'creator_id': str(creator.get('id') or '').strip(),
        'creator_name': str(creator.get('name') or '').strip(),
        'follower_count': _exact_int(creator.get('followerCount'), '作者粉丝数'),
        'work_id': str(current.get('id') or '').strip(),
        'title': str(current.get('title') or '').strip(),
        'likes': _exact_int(current.get('likes'), '当前作品点赞数'),
        'favorites': favorites or 0,
        'plays': _optional_exact_int(current.get('plays')),
        'source_url': str(current.get('sourceUrl') or bundle.get('sourceUrl') or '').strip(),
        # MediaCrawlerPro does not expose publish time. Keep it unknown instead
        # of using observedAt as a fabricated publish timestamp.
        'publish_at': '',
        'metadata': {
            'metrics_schema': SCHEMA_VERSION,
            'metrics_status': str(bundle.get('status') or ''),
            'observed_at': str(bundle.get('observedAt') or ''),
            'history_order': str(bundle.get('historyOrder') or ''),
            'history_sample_count': int(bundle.get('sampleCount') or 0),
            'history_works': bundle.get('historyWorks') or [],
        },
    }


def build_collected_score(bundle: Dict[str, Any], frozen_score: Optional[dict] = None) -> dict:
    _validate_bundle(bundle)
    if bundle.get('status') == 'metrics_unavailable':
        raise ValueError('当前作品指标不可用，不能生成爆款分级。')
    record = bundle_to_record(bundle)
    platform = record['platform']
    current_metric = platform_core_metric(platform, record['likes'], record['favorites'])
    history_metrics = []
    for work in bundle.get('historyWorks') or []:
        likes = _optional_exact_int(work.get('likes'))
        favorites = _optional_exact_int(work.get('favorites'))
        if likes is None or (platform == 'xiaohongshu' and favorites is None):
            continue
        history_metrics.append(platform_core_metric(platform, likes, favorites or 0))

    if (
        frozen_score
        and frozen_score.get('baseline_version') == 'url-history-v1'
        and frozen_score.get('baseline_metric') is not None
    ):
        baseline = float(frozen_score['baseline_metric'])
        followers = int(frozen_score.get('follower_snapshot') or record['follower_count'])
        r_value = current_metric / baseline if baseline > 0 else 0.0
        m_value = record['likes'] / followers if followers > 0 else 0.0
        return {
            'r_value': round(r_value, 4),
            'm_value': round(m_value, 4),
            'grade': evaluate_grade(r_value, m_value, followers),
            'tier': tier_key_from_followers(followers),
            'baseline_metric': baseline,
            'sample_count': int(frozen_score.get('baseline_sample_count') or 0),
            'follower_snapshot': followers,
            'baseline_at': frozen_score.get('baseline_at'),
            'baseline_version': 'url-history-v1',
        }

    score = score_work(
        current_metric,
        record['follower_count'],
        history_metrics[:20],
        m_metric=record['likes'],
    )
    score['follower_snapshot'] = record['follower_count']
    score['baseline_at'] = str(bundle.get('observedAt') or '') if score.get('baseline_metric') is not None else None
    score['baseline_version'] = 'url-history-v1' if score.get('baseline_metric') is not None else None
    return score


def _validate_bundle(bundle: Dict[str, Any]) -> None:
    if not isinstance(bundle, dict) or bundle.get('schemaVersion') != SCHEMA_VERSION:
        raise ValueError('指标包版本不受支持。')
    if bundle.get('platform') not in {'douyin', 'xiaohongshu'}:
        raise ValueError('指标包平台不受支持。')
    if not isinstance(bundle.get('currentWork'), dict) or not str(bundle['currentWork'].get('id') or '').strip():
        raise ValueError('指标包缺少当前作品标识。')
    if not isinstance(bundle.get('creator'), dict) or not str(bundle['creator'].get('id') or '').strip():
        raise ValueError('指标包缺少作者标识。')


def _exact_int(value: Any, label: str) -> int:
    parsed = _optional_exact_int(value)
    if parsed is None:
        raise ValueError(f'{label}不可用。')
    return parsed


def _optional_exact_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value
