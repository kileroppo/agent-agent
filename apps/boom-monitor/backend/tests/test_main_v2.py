import json
import tempfile
import unittest
from pathlib import Path

from boom_monitor import main
from boom_monitor.db import DB


def collected_bundle():
    return {
        'schemaVersion': 'agent.army/boom-metrics-bundle/v1',
        'status': 'collected',
        'platform': 'xiaohongshu',
        'sourceUrl': 'https://example.com/target',
        'observedAt': '2026-08-06T12:00:00Z',
        'creator': {'id': 'creator-1', 'name': '作者', 'followerCount': 2_147},
        'currentWork': {
            'id': 'target',
            'title': '当前作品',
            'sourceUrl': 'https://example.com/target',
            'likes': 93,
            'favorites': 34,
            'shares': 24,
            'comments': 7,
            'plays': None,
        },
        'historyWorks': [
            {'id': f'history-{index}', 'likes': 8, 'favorites': 2, 'shares': 0, 'comments': 0}
            for index in range(12)
        ],
        'historyOrder': 'creator_feed_desc',
        'sampleCount': 12,
    }


class V2TakeoverApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_store = main.store
        self.original_config = main.ANALYSIS_AUTO_CONFIG
        main.store = DB(str(Path(self.temp.name) / 'boom.sqlite'))
        main.ANALYSIS_AUTO_CONFIG = {'enabled': True, 'grades': ['T1', 'T2', 'T3']}

    def tearDown(self):
        main.store = self.original_store
        main.ANALYSIS_AUTO_CONFIG = self.original_config
        self.temp.cleanup()

    def test_v2_is_the_persisted_score_and_the_dispatch_queue_source(self):
        result = main.ingest_metrics_bundle(collected_bundle())

        self.assertEqual(result['score']['version'], 'v2')
        self.assertEqual(result['score']['grade'], 'T1')
        self.assertEqual(result['legacy_score']['grade'], 'N0')

        persisted = main.store.get_score(result['work_id'])
        self.assertEqual(persisted['score_version'], 'v2')
        self.assertEqual(persisted['grade'], 'T1')

        queued = main.store.next_dispatch_batch(20)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0]['tier'], 'T1')
        snapshot = json.loads(queued[0]['score_snapshot_json'])
        self.assertEqual(snapshot['grade'], 'T1')
        self.assertEqual(snapshot['scoreVersion'], 'v2')
        self.assertEqual(snapshot['signals']['quality']['passed'], True)
        self.assertEqual(snapshot['absoluteInteractions'], 127)

    def test_v2_cancels_a_stale_pending_queue_when_the_official_grade_is_not_enabled(self):
        first = main.ingest_metrics_bundle(collected_bundle())
        self.assertEqual(main.store.list_analysis_queue(20)[0]['status'], 'queued')

        main.ANALYSIS_AUTO_CONFIG = {'enabled': True, 'grades': ['T2', 'T3']}
        second = main.ingest_metrics_bundle(collected_bundle())

        self.assertEqual(first['score']['grade'], 'T1')
        self.assertEqual(second['score']['grade'], 'T1')
        self.assertEqual(main.store.list_analysis_queue(20)[0]['status'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
