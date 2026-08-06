import tempfile
import unittest
from pathlib import Path

from boom_monitor.db import DB
from boom_monitor.scorer import evaluate_grade, score_work


class ScorerTests(unittest.TestCase):
    def test_t2_covers_values_between_five_and_eight(self):
        self.assertEqual(evaluate_grade(6.0, 0.10, 100_000), 'T2')

    def test_m_can_use_likes_while_r_uses_combined_metric(self):
        score = score_work(400, 1_000, [100, 100, 100, 100, 100], m_metric=100)
        self.assertEqual(score['r_value'], 4.0)
        self.assertEqual(score['m_value'], 0.1)

    def test_insufficient_history_never_grades_as_boom(self):
        score = score_work(10_000, 1_000, [10, 10, 10, 10], m_metric=10_000)
        self.assertEqual(score['grade'], 'N0')
        self.assertIsNone(score['baseline_metric'])


class DBTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = DB(str(Path(self.temp.name) / 'boom.sqlite'))
        self.creator = self.db.upsert_creator('douyin', 'creator-1', '作者', 100_000)

    def tearDown(self):
        self.temp.cleanup()

    def add_work(self, work_id, published_at, likes):
        return self.db.upsert_work(self.creator, 'douyin', {
            'work_id': work_id,
            'publish_at': published_at,
            'likes': likes,
        })[0]

    def test_history_only_uses_works_published_before_current_work(self):
        self.add_work('older', '2026-01-01T00:00:00Z', 10)
        current = self.add_work('current', '2026-01-02T00:00:00Z', 20)
        self.add_work('future', '2026-01-03T00:00:00Z', 999)
        self.assertEqual(self.db.history_metrics(self.creator, 'douyin', current), [10])

    def test_settings_survive_new_db_instance(self):
        self.db.set_setting('analysis_auto', {'enabled': True, 'grades': ['T2']})
        reopened = DB(str(Path(self.temp.name) / 'boom.sqlite'))
        self.assertEqual(reopened.get_setting('analysis_auto'), {'enabled': True, 'grades': ['T2']})

    def test_explicitly_unknown_play_count_stays_unknown(self):
        work_id = self.db.upsert_work(self.creator, 'douyin', {
            'work_id': 'unknown-plays',
            'publish_at': '',
            'likes': 10,
            'plays': None,
        })[0]
        self.assertIsNone(self.db.get_work(work_id)['plays'])

    def test_versioned_shadow_score_is_persisted_without_replacing_the_dispatch_score(self):
        work_id = self.add_work('shadowed', '2026-01-02T00:00:00Z', 100)
        shadow = {
            'version': 'shadow-v2',
            'grade': 'T2',
            'controls_dispatch': False,
            'signals': {'quality': {'passed': True}},
        }

        self.db.upsert_shadow_score(work_id, shadow)

        self.assertEqual(self.db.get_shadow_score(work_id), shadow)
        self.assertEqual(self.db.get_score(work_id)['grade'], 'N0')

        observations = self.db.list_shadow_scores()
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]['official_grade'], 'N0')
        self.assertEqual(observations[0]['shadow_score'], shadow)


if __name__ == '__main__':
    unittest.main()
