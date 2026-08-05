import unittest

from boom_monitor.collected_metrics import build_collected_score, bundle_to_record


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
