from __future__ import annotations

import json
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ArmyDispatchError(RuntimeError):
    pass


class ArmyAdapter:
    def __init__(self, base_url: str, bearer_token: str = '', timeout_seconds: int = 15):
        self.base_url = str(base_url or '').rstrip('/')
        self.bearer_token = str(bearer_token or '').strip()
        self.timeout_seconds = max(1, int(timeout_seconds))

    def collect_metrics(self, source_url: str, connection_id: Optional[str] = None, history_limit: int = 20) -> dict:
        if not self.base_url:
            raise ArmyDispatchError('A君地址未配置。')
        source_url = str(source_url or '').strip()
        if not source_url.startswith(('http://', 'https://')):
            raise ArmyDispatchError('请输入完整的 HTTP(S) 作品链接。')
        body = {
            'url': source_url,
            'historyLimit': max(5, min(int(history_limit or 20), 20)),
        }
        if connection_id:
            body['connectionId'] = str(connection_id).strip()
        payload = self._post_json(
            '/api/integrations/boom-monitor/metrics',
            body,
            timeout_seconds=max(60, self.timeout_seconds),
            action_name='指标读取',
        )
        metrics = payload.get('metrics') if isinstance(payload, dict) else None
        if not isinstance(metrics, dict) or metrics.get('schemaVersion') != 'agent.army/boom-metrics-bundle/v1':
            raise ArmyDispatchError('A君未返回有效指标包。')
        return metrics

    def dispatch_boom_signal(self, signal: Dict[str, Any]) -> dict:
        if not self.base_url:
            raise ArmyDispatchError('A君地址未配置。')
        source_url = str(signal.get('sourceUrl') or '').strip()
        if not source_url.startswith(('http://', 'https://')):
            raise ArmyDispatchError('作品缺少可供小D读取的 HTTP(S) 来源链接。')

        payload = self._post_json(
            '/api/integrations/boom-monitor/dispatch',
            signal,
            timeout_seconds=self.timeout_seconds,
            action_name='爆款任务派发',
        )
        mission = payload.get('mission') if isinstance(payload, dict) else None
        if not isinstance(mission, dict) or not mission.get('taskId'):
            raise ArmyDispatchError('A君未返回可追踪的军团总任务。')
        return payload

    def _post_json(self, path: str, body_value: Dict[str, Any], *, timeout_seconds: int, action_name: str) -> dict:
        body = json.dumps(body_value, ensure_ascii=False).encode('utf-8')
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
        if self.bearer_token:
            headers['Authorization'] = f'Bearer {self.bearer_token}'
        request = Request(
            f'{self.base_url}{path}',
            data=body,
            headers=headers,
            method='POST',
        )
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode('utf-8') or '{}')
        except HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')[:500]
            raise ArmyDispatchError(f'A君拒绝{action_name}（HTTP {exc.code}）：{detail}') from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise ArmyDispatchError(f'A君暂时不可达：{exc}') from exc
        except json.JSONDecodeError as exc:
            raise ArmyDispatchError('A君返回了无法解析的响应。') from exc
        return payload
