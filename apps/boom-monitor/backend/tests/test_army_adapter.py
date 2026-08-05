import json
import unittest
from unittest.mock import patch

from boom_monitor.army_adapter import ArmyAdapter, ArmyDispatchError


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload, ensure_ascii=False).encode('utf-8')


class ArmyMetricsAdapterTests(unittest.TestCase):
    def test_collect_metrics_uses_existing_authenticated_ajun_bridge(self):
        adapter = ArmyAdapter('http://host.docker.internal:4321', 'shared-token')
        expected = {'schemaVersion': 'agent.army/boom-metrics-bundle/v1', 'status': 'collected'}

        def fake_open(request, timeout):
            self.assertEqual(request.full_url, 'http://host.docker.internal:4321/api/integrations/boom-monitor/metrics')
            self.assertEqual(request.headers['Authorization'], 'Bearer shared-token')
            self.assertEqual(timeout, 60)
            self.assertEqual(json.loads(request.data), {
                'url': 'https://www.douyin.com/video/target',
                'historyLimit': 20,
            })
            return FakeResponse({'metrics': expected})

        with patch('boom_monitor.army_adapter.urlopen', fake_open):
            self.assertEqual(adapter.collect_metrics('https://www.douyin.com/video/target'), expected)

    def test_collect_metrics_rejects_an_invalid_bundle(self):
        adapter = ArmyAdapter('http://127.0.0.1:4321')
        with patch('boom_monitor.army_adapter.urlopen', lambda *_args, **_kwargs: FakeResponse({'metrics': {}})):
            with self.assertRaisesRegex(ArmyDispatchError, '有效指标包'):
                adapter.collect_metrics('https://www.douyin.com/video/target')


if __name__ == '__main__':
    unittest.main()
