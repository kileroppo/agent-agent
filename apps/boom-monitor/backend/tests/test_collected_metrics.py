import unittest

from boom_monitor.collected_metrics import build_score_comparison, build_collected_score, build_v2_score, bundle_to_record


def bundle(platform='xiaohongshu', history_count=6):
    return {
        'schemaVersion': 'agent.army/boom-metrics-bundle/v1',
        'status': 'collected' if history_count >= 5 else 'insufficient_history',
        'platform': platform,
        'sourceUrl': 'https://example.com/target',
        'observedAt': '2026-08-05T12:00:00Z',
        'creator': {'id': 'creator-1', 'name': '作者', 'followerCount': 1_000},
        'currentWork': {
            'id': 'target', 'title': '当前作品', 'sourceUrl': 'https://example.com/target',
            'likes': 500, 'favorites': 100, 'plays': None,
        },
        'historyWorks': [
            {'id': f'history-{index}', 'likes': 100, 'favorites': 20, 'plays': None}
            for index in range(history_count)
        ],
        'historyOrder': 'creator_feed_desc',
        'sampleCount': history_count,
    }


class CollectedMetricsTests(unittest.TestCase):
    def test_comparison_promotes_v2_to_official_and_keeps_v1_for_rollback(self):
        value = bundle()
        value['creator']['followerCount'] = 2_147
        value['currentWork'].update({'likes': 93, 'favorites': 34, 'shares': 24, 'comments': 7})
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 8, 'favorites': 2, 'shares': 0, 'comments': 0}
            for index in range(12)
        ]

        result = build_score_comparison(value)

        self.assertEqual(result['official_score']['version'], 'v2')
        self.assertEqual(result['official_score']['grade'], 'T1')
        self.assertEqual(result['official_score']['controls_dispatch'], True)
        self.assertEqual(result['legacy_score']['version'], 'legacy-v1')
        self.assertEqual(result['legacy_score']['grade'], 'N0')
        self.assertEqual(result['legacy_score']['controls_dispatch'], False)
        self.assertEqual(result['legacy_score']['official_grade'], 'T1')

    def test_v2_promotes_small_absolute_boom_to_official_t1(self):
        value = bundle()
        value['creator']['followerCount'] = 2_147
        value['currentWork'].update({'likes': 93, 'favorites': 34, 'shares': 24, 'comments': 7})
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 8, 'favorites': 2, 'shares': 0, 'comments': 0}
            for index in range(12)
        ]
        value['sampleCount'] = 12

        score = build_v2_score(value)

        self.assertEqual(score['version'], 'v2')
        self.assertEqual(score['grade'], 'T1')
        self.assertEqual(score['absolute_interactions'], 127)
        self.assertEqual(score['signals']['quality']['passed'], True)
        self.assertEqual(score['controls_dispatch'], True)

    def test_shadow_v2_caps_tiny_absolute_activity_at_t1_and_explains_the_cap(self):
        value = bundle()
        value['creator']['followerCount'] = 300
        value['currentWork'].update({'likes': 30, 'favorites': 15, 'shares': 8, 'comments': 4})
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 1, 'favorites': 1, 'shares': 0, 'comments': 0}
            for index in range(6)
        ]
        value['sampleCount'] = 6

        shadow = build_v2_score(value)

        self.assertEqual(shadow['grade'], 'T1')
        self.assertEqual(shadow['grade_cap'], 'T1')
        self.assertEqual(shadow['grade_cap_reason'], 'low_absolute_volume')

    def test_v2_recommends_full_analysis_for_an_official_t3(self):
        value = bundle()
        value['creator']['followerCount'] = 200_000
        value['currentWork'].update({'likes': 20_000, 'favorites': 5_000, 'shares': 1_000, 'comments': 500})
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 1_000, 'favorites': 500, 'shares': 20, 'comments': 20}
            for index in range(8)
        ]
        value['sampleCount'] = 8

        shadow = build_v2_score(value)

        self.assertEqual(shadow['grade'], 'T3')
        self.assertEqual(shadow['recommended_analysis_depth'], 'full')
        self.assertEqual(shadow['controls_dispatch'], True)

    def test_shadow_v2_accepts_quality_that_is_strong_relative_to_the_creator_history(self):
        value = bundle()
        value['creator']['followerCount'] = 10_000
        value['currentWork'].update({'likes': 1_000, 'favorites': 100, 'shares': 10, 'comments': 20})
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 100, 'favorites': 2, 'shares': 1, 'comments': 2}
            for index in range(8)
        ]
        value['sampleCount'] = 8

        shadow = build_v2_score(value)

        self.assertEqual(shadow['grade'], 'T2')
        self.assertEqual(shadow['signals']['quality']['passed'], True)
        self.assertEqual(shadow['signals']['quality']['favorite_rate_vs_history'], 5.0)

    def test_shadow_v2_keeps_its_first_valid_baseline_frozen(self):
        value = bundle()
        value['historyWorks'] = [
            {'id': f'history-{index}', 'likes': 1_000, 'favorites': 200}
            for index in range(6)
        ]
        frozen = {
            'version': 'shadow-v2',
            'baseline_version': 'url-history-shadow-v2',
            'baseline_metric': 100,
            'sample_count': 6,
            'follower_snapshot': 2_000,
            'baseline_at': '2026-08-01T00:00:00Z',
            'signals': {
                'quality': {
                    'history_medians': {
                        'favorite_rate': 0.02,
                        'share_rate': None,
                        'comment_rate': None,
                    },
                },
            },
        }

        shadow = build_v2_score(value, frozen_score=frozen)

        self.assertEqual(shadow['baseline_metric'], 100)
        self.assertEqual(shadow['sample_count'], 6)
        self.assertEqual(shadow['follower_snapshot'], 2_000)
        self.assertEqual(shadow['baseline_at'], '2026-08-01T00:00:00Z')
        self.assertEqual(shadow['signals']['quality']['favorite_rate_vs_history'], 10.0)

    def test_scores_explicit_ordered_history_without_fake_publish_dates(self):
        value = bundle()
        record = bundle_to_record(value)
        score = build_collected_score(value)

        self.assertEqual(record['publish_at'], '')
        self.assertIsNone(record['plays'])
        self.assertEqual(record['metadata']['history_order'], 'creator_feed_desc')
        self.assertEqual(score['r_value'], 5.0)
        self.assertEqual(score['m_value'], 0.5)
        self.assertEqual(score['grade'], 'T2')
        self.assertEqual(score['sample_count'], 6)
        self.assertEqual(score['baseline_version'], 'url-history-v1')

    def test_insufficient_history_remains_n0(self):
        score = build_collected_score(bundle(history_count=4))
        self.assertEqual(score['grade'], 'N0')
        self.assertIsNone(score['baseline_metric'])
        self.assertEqual(score['sample_count'], 4)

    def test_existing_valid_baseline_stays_frozen_when_history_changes(self):
        value = bundle()
        frozen = {
            'baseline_version': 'url-history-v1',
            'baseline_metric': 100,
            'baseline_sample_count': 5,
            'follower_snapshot': 20_000,
            'baseline_at': '2026-08-01T00:00:00Z',
        }
        score = build_collected_score(value, frozen_score=frozen)
        self.assertEqual(score['baseline_metric'], 100)
        self.assertEqual(score['sample_count'], 5)
        self.assertEqual(score['follower_snapshot'], 20_000)
        self.assertEqual(score['baseline_at'], '2026-08-01T00:00:00Z')

    def test_unavailable_metrics_are_not_silently_converted_to_zero(self):
        value = bundle()
        value['status'] = 'metrics_unavailable'
        value['currentWork']['likes'] = None
        with self.assertRaisesRegex(ValueError, '当前作品指标不可用'):
            build_collected_score(value)


if __name__ == '__main__':
    unittest.main()
