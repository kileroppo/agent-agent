from __future__ import annotations

from dataclasses import dataclass
from statistics import median
from typing import Dict, Iterable, List


@dataclass(frozen=True)
class ScoreConfig:
    t2_ratio_min: float = 3.0
    t1_ratio_min: float = 2.0
    t3_ratio_min: float = 8.0
    min_history_samples: int = 5
    tier_thresholds: Dict[str, float] | None = None

    @property
    def default_thresholds(self) -> Dict[str, float]:
        return {
            "high": 0.04,
            "mid": 0.08,
            "mid_small": 0.15,
            "low": 0.30,
        }


def platform_core_metric(platform: str, likes: int, favorites: int) -> int:
    if platform == 'xiaohongshu':
        return int(likes) + int(favorites)
    return int(likes)


def tier_key_from_followers(followers: int) -> str:
    followers = int(followers or 0)
    if followers >= 1_000_000:
        return 'high'
    if followers >= 100_000:
        return 'mid'
    if followers >= 10_000:
        return 'mid_small'
    return 'low'


def m_threshold_by_followers(followers: int, config: ScoreConfig | None = None) -> float:
    cfg = config or ScoreConfig()
    cfg_map = cfg.tier_thresholds or cfg.default_thresholds
    return float(cfg_map[tier_key_from_followers(followers)])


def evaluate_grade(r_value: float, m_value: float, followers: int, config: ScoreConfig | None = None) -> str:
    config = config or ScoreConfig()
    if followers <= 0:
        return 'N0'

    m_threshold = m_threshold_by_followers(followers, config)
    m_t1_threshold = m_threshold * 0.9

    if r_value >= config.t3_ratio_min and m_value >= m_threshold:
        return 'T3'
    if r_value >= config.t2_ratio_min and r_value < config.t3_ratio_min and m_value >= m_threshold:
        return 'T2'
    if r_value >= config.t1_ratio_min and m_value >= m_t1_threshold:
        return 'T1'
    return 'N0'


def _median(values: Iterable[float]) -> float:
    vals = [max(0.0, float(v)) for v in values]
    if not vals:
        return 0.0
    return median(vals)


def score_work(
    current_metric: int,
    followers: int,
    history_metrics: List[float],
    config: ScoreConfig | None = None,
    *,
    m_metric: int | float | None = None,
) -> Dict[str, object]:
    config = config or ScoreConfig()
    current_metric = float(current_metric)
    m_numerator = current_metric if m_metric is None else max(0.0, float(m_metric))
    followers = int(followers or 0)

    if len(history_metrics) < config.min_history_samples or followers <= 0:
        return {
            'r_value': 0.0,
            'm_value': 0.0 if followers <= 0 else m_numerator / followers,
            'grade': 'N0',
            'tier': tier_key_from_followers(followers),
            'baseline_metric': None,
            'sample_count': len(history_metrics),
        }

    baseline = _median(history_metrics)
    r_value = current_metric / baseline if baseline > 0 else 0.0
    m_value = m_numerator / followers if followers > 0 else 0.0
    grade = evaluate_grade(r_value, m_value, followers, config)

    return {
        'r_value': round(r_value, 4),
        'm_value': round(m_value, 4),
        'grade': grade,
        'tier': tier_key_from_followers(followers),
        'baseline_metric': round(baseline, 4),
        'sample_count': len(history_metrics),
    }
