from __future__ import annotations

import csv
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import threading

from . import db as db_module
from .army_adapter import ArmyAdapter, ArmyDispatchError
from .collected_metrics import build_collected_score, bundle_to_record
from .scorer import (
    platform_core_metric,
    evaluate_grade,
    score_work,
    tier_key_from_followers,
)


ENV = os.environ
DATA_DIR = Path(ENV.get('BOOM_DATA_DIR', '/app/data'))
DB_PATH = ENV.get('BOOM_DB_PATH', str(DATA_DIR / 'boom-monitor.sqlite'))
IMPORT_DIR = Path(ENV.get('BOOM_IMPORT_DIR', str(DATA_DIR / 'import')))
WORKER_SCAN_INTERVAL_SECONDS = int(ENV.get('BOOM_WORKER_SCAN_INTERVAL_SECONDS', '6'))
WORKER_ANALYSIS_INTERVAL_SECONDS = int(ENV.get('BOOM_WORKER_ANALYSIS_INTERVAL_SECONDS', ENV.get('BOOM_WORKER_L1_INTERVAL_SECONDS', '15')))
ANALYSIS_BATCH_LIMIT = int(ENV.get('BOOM_ANALYSIS_BATCH_LIMIT', ENV.get('BOOM_L1_DAILY_LIMIT', '20')))
ANALYSIS_DAILY_LIMIT = max(0, int(ENV.get('BOOM_ANALYSIS_DAILY_LIMIT', '5')))
AUTO_ANALYSIS_GRADES_ENV = ENV.get('BOOM_ANALYSIS_AUTO_GRADES', 'T2,T3')
AUTO_ANALYSIS_ENABLED_ENV = ENV.get('BOOM_ANALYSIS_AUTO_ENABLED', 'false')
ARMY_BASE_URL = ENV.get('BOOM_ARMY_BASE_URL', 'http://127.0.0.1:4321')
ARMY_BEARER_TOKEN = ENV.get('BOOM_ARMY_BEARER_TOKEN', '')


def _parse_bool(value: str, default: bool = False) -> bool:
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'} if str(value).strip() else default


def _parse_grades(raw: str) -> List[str]:
    return [g.strip().upper() for g in str(raw or '').split(',') if g.strip()]


def _default_analysis_config() -> dict:
    grades = _parse_grades(AUTO_ANALYSIS_GRADES_ENV)
    if not grades:
        grades = ['T2', 'T3']
    return {
        'enabled': _parse_bool(AUTO_ANALYSIS_ENABLED_ENV, True),
        'grades': sorted(set(grades)),
    }


ANALYSIS_AUTO_CONFIG = _default_analysis_config()
ANALYSIS_AUTO_CONFIG_LOCK = threading.Lock()

IMPORT_DIR.mkdir(parents=True, exist_ok=True)
(DATA_DIR / 'imported').mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

store = db_module.DB(DB_PATH)
persisted_analysis_config = store.get_setting('analysis_auto')
if isinstance(persisted_analysis_config, dict):
    persisted_grades = _parse_grades(','.join(persisted_analysis_config.get('grades', [])))
    if persisted_grades:
        ANALYSIS_AUTO_CONFIG = {
            'enabled': bool(persisted_analysis_config.get('enabled', False)),
            'grades': sorted(set(persisted_grades)),
        }
else:
    store.set_setting('analysis_auto', ANALYSIS_AUTO_CONFIG)
army_adapter = ArmyAdapter(ARMY_BASE_URL, ARMY_BEARER_TOKEN)
scan_lock = __import__('threading').Lock()
l1_lock = __import__('threading').Lock()

app = FastAPI(title='Boom Monitor')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


class ImportPayload(BaseModel):
    source_type: str = 'manual'
    creator: Optional[str] = None
    creator_name: Optional[str] = None
    platform: str = 'douyin'
    follower_count: int = 0
    works: Optional[List[dict]] = None
    payload: Optional[Any] = None


class SettingsPayload(BaseModel):
    analysis_auto_enabled: Optional[bool] = None
    analysis_auto_grades: Optional[str] = None


class UrlCollectPayload(BaseModel):
    url: str
    connection_id: Optional[str] = None
    history_limit: int = 20


def now_local_iso() -> str:
    return datetime.now().astimezone().isoformat()


def get_analysis_budget() -> dict:
    day_start = datetime.now(ZoneInfo('Asia/Shanghai')).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc)
    dispatched_today = store.count_dispatched_since(day_start.isoformat())
    return {
        'daily_limit': ANALYSIS_DAILY_LIMIT,
        'dispatched_today': dispatched_today,
        'remaining_today': max(0, ANALYSIS_DAILY_LIMIT - dispatched_today),
    }


def get_analysis_auto_config() -> dict:
    with ANALYSIS_AUTO_CONFIG_LOCK:
        return {
            'enabled': bool(ANALYSIS_AUTO_CONFIG['enabled']),
            'grades': list(ANALYSIS_AUTO_CONFIG['grades']),
        }


def should_auto_enqueue_grade(grade: str) -> bool:
    cfg = get_analysis_auto_config()
    if not cfg['enabled']:
        return False
    return str(grade).strip().upper() in set(cfg['grades'])


def _normalize_records(raw: Any, default_platform: str = 'douyin', default_creator: Optional[str] = None,
                      default_creator_name: Optional[str] = None, default_followers: int = 0) -> List[dict]:
    records: List[dict] = []
    if raw is None:
        return records

    if isinstance(raw, dict):
        if 'work' in raw and isinstance(raw['work'], dict):
            raw = {
                'platform': raw.get('platform', default_platform),
                'creator_id': raw.get('creator_id', default_creator or ''),
                'creator_name': raw.get('creator_name', default_creator_name or ''),
                'follower_count': raw.get('follower_count', default_followers) or 0,
                **(raw.get('work') or {}),
            }
        if 'works' in raw and isinstance(raw['works'], list):
            works = raw.get('works')
            platform = str(raw.get('platform', default_platform))
            creator = str(raw.get('creator_id', default_creator or '')).strip()
            creator_name = str(raw.get('creator_name', default_creator_name or '')).strip()
            followers = int(raw.get('follower_count', default_followers) or 0)
            for item in works:
                if not isinstance(item, dict):
                    continue
                row = {
                    'platform': platform,
                    'creator_id': creator,
                    'creator_name': creator_name,
                    'follower_count': followers,
                    **item,
                }
                records.append(row)
            return records
        if 'work_id' in raw or 'work' in raw:
            records.append({
                'platform': str(raw.get('platform', default_platform)),
                'creator_id': str(raw.get('creator_id', default_creator or '')), 
                'creator_name': str(raw.get('creator_name', default_creator_name or '')), 
                'follower_count': int(raw.get('follower_count', default_followers) or 0),
                **raw,
            })
            return records
        # unknown object shape, treat as single record
        record = {
            'platform': str(raw.get('platform', default_platform)),
            'creator_id': str(raw.get('creator_id', default_creator or '')),
            'creator_name': str(raw.get('creator_name', default_creator_name or '')),
            'follower_count': int(raw.get('follower_count', default_followers) or 0),
            **raw,
        }
        if 'work_id' in record:
            records.append(record)
        return records

    if isinstance(raw, list):
        for item in raw:
            records.extend(_normalize_records(item, default_platform, default_creator, default_creator_name, default_followers))
        return records

    return records


def _parse_csv(path: Path) -> List[dict]:
    try:
        with path.open('r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            return _normalize_records([r for r in reader])
    except Exception as exc:
        raise ValueError(f'CSV 解析失败: {exc}')


def _parse_json(path: Path) -> List[dict]:
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise ValueError(f'JSON 解析失败: {exc}')
    return _normalize_records(payload)


def load_import_payloads() -> List[dict]:
    records: List[dict] = []
    for file_path in sorted(IMPORT_DIR.glob('*.json')):
        parsed = _parse_json(file_path)
        for row in parsed:
            row = dict(row)
            row['__source_file'] = str(file_path)
            records.append(row)
        shutil.move(str(file_path), str(DATA_DIR / 'imported' / (file_path.name + '.done')))
    for file_path in sorted(IMPORT_DIR.glob('*.csv')):
        parsed = _parse_csv(file_path)
        for row in parsed:
            row = dict(row)
            row['__source_file'] = str(file_path)
            records.append(row)
        shutil.move(str(file_path), str(DATA_DIR / 'imported' / (file_path.name + '.done')))
    return records


def _score_and_queue_one(work_db_id: int) -> Dict[str, Any]:
    work = store.get_work(work_db_id)
    if not work:
        raise ValueError('作品不存在。')

    platform = str(work['platform'])
    creator_db_id = int(work['creator_id'])
    followers_current = int(work['follower_count'] or 0)
    likes = int(work['likes'] or 0)
    favorites = int(work['favorites'] or 0)
    metric = platform_core_metric(platform, likes, favorites)

    history = store.history_metrics(creator_db_id, platform, work_db_id)
    frozen_score = store.get_score(work_db_id)

    baseline_metric: Optional[float] = None
    baseline_sample_count = 0
    baseline_follower_snapshot = followers_current
    baseline_at: Optional[str] = None

    if frozen_score and frozen_score.get('baseline_version') == 'work-history-v1' and frozen_score.get('baseline_metric') is not None:
        baseline_metric = float(frozen_score['baseline_metric'])
        baseline_sample_count = int(frozen_score['baseline_sample_count'] or 0)
        baseline_follower_snapshot = int(frozen_score['follower_snapshot'] or followers_current)
        baseline_at = frozen_score['baseline_at']
    elif history:
        base = score_work(metric, followers_current, history, m_metric=likes)
        baseline_metric = base.get('baseline_metric')
        if baseline_metric:
            baseline_sample_count = int(base['sample_count'])
            baseline_follower_snapshot = followers_current
            baseline_at = now_local_iso()

    if baseline_metric:
        r_value = metric / baseline_metric if baseline_metric > 0 else 0.0
        m_value = likes / baseline_follower_snapshot if baseline_follower_snapshot > 0 else 0.0
        score = {
            'r_value': round(r_value, 4),
            'm_value': round(m_value, 4),
            'grade': evaluate_grade(r_value, m_value, baseline_follower_snapshot),
            'tier': tier_key_from_followers(baseline_follower_snapshot),
            'baseline_metric': baseline_metric,
            'sample_count': baseline_sample_count,
            'follower_snapshot': baseline_follower_snapshot,
            'baseline_at': baseline_at,
            'baseline_version': 'work-history-v1',
        }
    else:
        score = score_work(metric, followers_current, history, m_metric=likes)
        score['baseline_version'] = 'work-history-v1' if score.get('baseline_metric') is not None else None

    store.upsert_score(work_db_id, {
        **score,
        'baseline_metric': score.get('baseline_metric'),
        'sample_count': score.get('sample_count', 0)
    })

    grade = str(score['grade'])
    if should_auto_enqueue_grade(grade):
        store.upsert_analysis_queue(
            work_db_id,
            grade,
            _boom_signal(work, score),
            'full' if grade == 'T3' else 'fast',
        )

    return {
        'work_id': work_db_id,
        'work': work['work_id'],
        'score': score,
    }


def ingest_metrics_bundle(bundle: Dict[str, Any]) -> Dict[str, Any]:
    if bundle.get('status') == 'metrics_unavailable':
        return {
            'status': 'metrics_unavailable',
            'message': '视频可继续做普通内容拆解，但当前没有可靠爆款分级依据。',
            'metrics': bundle,
            'score': None,
        }
    record = bundle_to_record(bundle)
    creator_db_id = store.upsert_creator(
        record['platform'],
        record['creator_id'],
        record['creator_name'],
        record['follower_count'],
    )
    work_db_id, _ = store.upsert_work(creator_db_id, record['platform'], record)
    frozen_score = store.get_score(work_db_id)
    score = build_collected_score(bundle, frozen_score=frozen_score)
    store.upsert_score(work_db_id, score)
    work = store.get_work(work_db_id)
    if should_auto_enqueue_grade(str(score['grade'])):
        store.upsert_analysis_queue(
            work_db_id,
            str(score['grade']),
            _boom_signal(work, score),
            'full' if score['grade'] == 'T3' else 'fast',
        )
    return {
        'status': bundle.get('status') or 'collected',
        'work_id': work_db_id,
        'score': score,
        'metrics': bundle,
        'message': '历史样本不足，保持 N0，不自动拆解。' if score['grade'] == 'N0' and score.get('baseline_metric') is None else '指标已读取并完成评分。',
    }


def _boom_signal(work: dict, score: dict) -> dict:
    source_url = str(work.get('source_url') or '').strip()
    return {
        'schemaVersion': 'boom-signal/v1',
        'workRef': f"{work.get('platform')}:{work.get('work_id')}",
        'workId': str(work.get('work_id') or ''),
        'title': str(work.get('title') or ''),
        'platform': str(work.get('platform') or ''),
        'creatorRef': str(work.get('creator_external_id') or ''),
        'creatorName': str(work.get('creator_name') or ''),
        'sourceUrl': source_url,
        'observedAt': now_local_iso(),
        'evidenceKind': 'platform_observed',
        'sourceRef': source_url or f"boom-monitor:work:{work.get('id')}",
        'grade': str(score.get('grade') or 'N0'),
        'tier': str(score.get('tier') or 'low'),
        'rValue': float(score.get('r_value') or 0),
        'mValue': float(score.get('m_value') or 0),
        'observedMetrics': {
            'likes': int(work.get('likes') or 0),
            'favorites': int(work.get('favorites') or 0),
            'plays': None if work.get('plays') is None else int(work.get('plays') or 0),
            'followers': int(score.get('follower_snapshot') or work.get('follower_count') or 0),
        },
        'baseline': {
            'metricMedian': score.get('baseline_metric'),
            'sampleCount': int(score.get('sample_count') or 0),
            'followerSnapshot': int(score.get('follower_snapshot') or 0),
            'frozenAt': score.get('baseline_at'),
            'historyWindow': 20,
        },
        'formulas': {
            'R': 'platform_core_metric / frozen_history_median',
            'M': 'likes / frozen_follower_snapshot',
        },
        'baselineVersion': score.get('baseline_version'),
    }


def process_scan_job(job: Dict[str, Any]) -> Dict[str, Any]:
    payload = json.loads(job['payload_json'] or '{}') if job.get('payload_json') else {}
    platform_filter = (job.get('creator_ref') or '').strip() or None

    items = []
    if payload.get('mode') == 'manual' and payload.get('items'):
        items.extend(_normalize_records(payload['items'], default_platform=payload.get('platform', 'douyin')))
    else:
        items.extend(load_import_payloads())

    if platform_filter:
        items = [i for i in items if str(i.get('platform', '')) == platform_filter]

    if not items:
        return {
            'status': 'empty',
            'scored': 0,
            'total': 0,
        }

    imported_work_ids = []
    for raw in items:
        creator_id = str(raw.get('creator_id', '')).strip()
        platform = str(raw.get('platform', 'douyin')).strip()
        if not creator_id:
            continue

        creator_name = str(raw.get('creator_name', '').strip()) if raw.get('creator_name') is not None else ''
        follower_count = int(raw.get('follower_count', 0) or 0)
        creator_db_id = store.upsert_creator(platform, creator_id, creator_name, follower_count)

        work_payload = dict(raw)
        work_payload.setdefault('title', str(raw.get('title', '').strip()))
        work_payload.setdefault('publish_at', now_local_iso())
        work_payload.setdefault('likes', int(raw.get('likes', 0) or 0))
        work_payload.setdefault('favorites', int(raw.get('favorites', 0) or 0))
        work_payload.setdefault('plays', int(raw.get('plays', 0) or 0))

        work_db_id, _ = store.upsert_work(creator_db_id, platform, work_payload)
        imported_work_ids.append(work_db_id)

    scored = [_score_and_queue_one(work_db_id) for work_db_id in imported_work_ids]

    return {
        'status': 'ok',
        'scored': len(scored),
        'total': len(items),
        'items': scored,
    }


def run_scan_worker() -> Dict[str, Any]:
    with scan_lock:
        job = store.take_next_scan_job()
        if not job:
            return {'status': 'idle'}

        try:
            result = process_scan_job(job)
            store.finish_scan_job(int(job['id']), 'completed', None)
            return result
        except Exception as exc:
            store.finish_scan_job(int(job['id']), 'failed', str(exc))
            raise


def run_analysis_worker() -> Dict[str, Any]:
    with l1_lock:
        if not get_analysis_auto_config()['enabled']:
            return {'status': 'disabled', 'processed': 0}
        budget = get_analysis_budget()
        if budget['remaining_today'] <= 0:
            return {'status': 'daily_limit', 'processed': 0, 'budget': budget}
        total = 0
        rows = store.next_dispatch_batch(limit=min(ANALYSIS_BATCH_LIMIT, budget['remaining_today']))
        if not rows:
            return {'status': 'idle', 'processed': 0, 'budget': budget}
        for row in rows:
            qid = int(row['id'])
            if not store.begin_dispatch(qid):
                continue
            try:
                snapshot = json.loads(row.get('score_snapshot_json') or '{}')
                if not snapshot:
                    snapshot = _boom_signal(row, row)
                snapshot['depth'] = 'full' if row.get('analysis_depth') == 'full' else 'fast'
                result = army_adapter.dispatch_boom_signal(snapshot)
                mission_id = str(result.get('mission', {}).get('taskId') or '')
                store.finish_dispatch(qid, 'dispatched', task_id=mission_id, result=result)
                total += 1
            except ArmyDispatchError as exc:
                missing_source = '缺少可供小D读取' in str(exc)
                store.finish_dispatch(qid, 'waiting_source' if missing_source else 'dispatch_failed', error=str(exc))
            except Exception as exc:
                store.finish_dispatch(qid, 'dispatch_failed', error=f'派发处理失败：{exc}')
        return {'status': 'ok', 'processed': total, 'budget': get_analysis_budget()}


def enqueue_scan(platform: Optional[str] = None) -> int:
    return store.queue_scan_job('local_import', platform, {'mode': 'scheduled', 'platform': platform, 'created_at': now_local_iso()})


@app.get('/api/health')
def health() -> dict:
    return {
        'ok': True,
        'time': now_local_iso(),
        'status': 'running',
    }


@app.get('/api/dashboard')
def dashboard() -> dict:
    data = store.dashboard_summary()
    return data


@app.get('/api/works')
def list_works(grade: Optional[str] = None, platform: Optional[str] = None, creator_id: Optional[str] = None, limit: int = 100):
    return {
        'works': store.list_works_with_scores(grade, platform, creator_id, max(1, min(int(limit), 500))),
    }


@app.get('/api/works/{work_id}')
def get_work(work_id: int):
    row = store.get_work_detail(int(work_id))
    if not row:
        raise HTTPException(status_code=404, detail='找不到作品')
    return {'work': row}


@app.get('/api/scan/jobs')
def list_jobs(limit: int = 20):
    return {'jobs': store.list_scan_jobs(int(limit))}


@app.post('/api/scan/run')
def run_scan():
    jid = store.queue_scan_job('manual', None, {'mode': 'manual'})
    return {'job_id': jid, 'message': '已入队'}


@app.post('/api/scan/enqueue/{platform}')
def enqueue_platform(platform: str):
    jid = enqueue_scan(platform)
    return {'job_id': jid, 'platform': platform}


@app.post('/api/import')
def import_records(payload: ImportPayload):
    payload_dict = payload.dict()
    items = payload_dict.get('works')
    if not items and payload_dict.get('payload'):
        items = payload_dict.get('payload')
    elif not items and payload_dict.get('payload') is None:
        raise HTTPException(status_code=422, detail='未提供可写入数据')

    normalized = _normalize_records(
        {
            'platform': payload_dict.get('platform', 'douyin'),
            'creator_id': payload_dict.get('creator') or '',
            'creator_name': payload_dict.get('creator_name'),
            'follower_count': payload_dict.get('follower_count', 0),
            'works': items,
        }
    )
    if not normalized:
        raise HTTPException(status_code=422, detail='导入数据为空')

    job_id = store.queue_scan_job('manual', None, {'mode': 'manual', 'items': normalized})
    return {'job_id': job_id, 'count': len(normalized)}


@app.post('/api/collect/url')
def collect_url_metrics(payload: UrlCollectPayload):
    try:
        bundle = army_adapter.collect_metrics(
            payload.url,
            connection_id=payload.connection_id,
            history_limit=payload.history_limit,
        )
        return ingest_metrics_bundle(bundle)
    except ArmyDispatchError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post('/api/analysis/run')
def run_analysis():
    return run_analysis_worker()


@app.get('/api/analysis')
def list_analysis():
    return {'items': store.list_analysis_queue(200)}


@app.get('/api/settings')
def get_settings():
    return {'analysis_auto': get_analysis_auto_config(), 'analysis_budget': get_analysis_budget()}


@app.post('/api/settings')
def update_settings(payload: SettingsPayload):
    with ANALYSIS_AUTO_CONFIG_LOCK:
        if payload.analysis_auto_enabled is not None:
            ANALYSIS_AUTO_CONFIG['enabled'] = bool(payload.analysis_auto_enabled)

        if payload.analysis_auto_grades is not None:
            grades = _parse_grades(payload.analysis_auto_grades)
            if not grades:
                raise HTTPException(status_code=422, detail='analysis_auto_grades 不能为空')
            ANALYSIS_AUTO_CONFIG['grades'] = sorted(set(grades))

    persisted = get_analysis_auto_config()
    store.set_setting('analysis_auto', persisted)
    return {'ok': True, 'analysis_auto': persisted, 'analysis_budget': get_analysis_budget()}


@app.post('/api/analysis/process')
def process_analysis(limit: int = 20):
    return run_analysis_worker()


@app.post('/api/analysis/queue/{work_id}')
def enqueue_work_analysis(work_id: int):
    row = store.get_work_detail(int(work_id))
    if not row:
        raise HTTPException(status_code=404, detail='作品不存在')
    grade = str(row.get('grade') or 'N0')
    score = {
        'grade': grade,
        'tier': row.get('tier'),
        'r_value': row.get('r_value'),
        'm_value': row.get('m_value'),
        'baseline_metric': row.get('baseline_metric'),
        'sample_count': row.get('baseline_sample_count'),
        'follower_snapshot': row.get('follower_snapshot'),
        'baseline_at': row.get('baseline_at'),
    }
    store.upsert_analysis_queue(int(work_id), grade, _boom_signal(row, score), 'full' if grade == 'T3' else 'fast')
    return {'status': 'ok', 'work_id': int(work_id), 'grade': grade}


def tick_scan():
    try:
        run_scan_worker()
    except Exception:
        return


def tick_l1():
    try:
        run_analysis_worker()
    except Exception:
        return


scheduler = BackgroundScheduler(timezone='Asia/Shanghai')
scheduler.add_job(enqueue_scan, 'cron', args=['douyin'], hour=20, minute=0, id='schedule_douyin', replace_existing=True)
scheduler.add_job(enqueue_scan, 'cron', args=['xiaohongshu'], hour=20, minute=10, id='schedule_xiaohongshu', replace_existing=True)
scheduler.add_job(enqueue_scan, 'cron', args=['youtube'], hour=20, minute=20, id='schedule_youtube', replace_existing=True)
scheduler.add_job(tick_scan, 'interval', seconds=WORKER_SCAN_INTERVAL_SECONDS, id='scan_worker', coalesce=True, max_instances=1)
scheduler.add_job(tick_l1, 'interval', seconds=WORKER_ANALYSIS_INTERVAL_SECONDS, id='analysis_dispatch_worker', coalesce=True, max_instances=1)


@app.on_event('startup')
def startup_event() -> None:
    scheduler.start()


@app.on_event('shutdown')
def shutdown_event() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


@app.exception_handler(Exception)
def handle_exception(request, exc):
    return JSONResponse(status_code=500, content={'error': str(exc)})


if __name__ == '__main__':
    uvicorn.run('boom_monitor.main:app', host='0.0.0.0', port=int(ENV.get('BOOM_PORT', '8000')))
