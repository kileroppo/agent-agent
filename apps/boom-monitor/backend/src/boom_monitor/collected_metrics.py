from __future__ import annotations

from typing import Any, Dict, Optional

from .scorer import evaluate_grade, platform_core_metric, score_work, tier_key_from_followers


SCHEMA_VERSION = 'agent.army/boom-metrics-bundle/v1'


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
