from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional


class DB:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA journal_mode = WAL;')
        con.execute('PRAGMA foreign_keys = ON;')
        return con

    @contextmanager
    def connection(self):
        con = self._connect()
        try:
            yield con
            con.commit()
        finally:
            con.close()

    def init_db(self) -> None:
        with self.connection() as con:
            con.executescript(
                '''
                CREATE TABLE IF NOT EXISTS creators (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    creator_id TEXT NOT NULL,
                    creator_name TEXT,
                    follower_count INTEGER DEFAULT 0,
                    follower_snapshot_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(platform, creator_id)
                );

                CREATE TABLE IF NOT EXISTS works (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    creator_id INTEGER NOT NULL,
                    platform TEXT NOT NULL,
                    work_id TEXT NOT NULL,
                    creator_work_id TEXT,
                    title TEXT,
                    publish_at TEXT,
                    likes INTEGER DEFAULT 0,
                    favorites INTEGER DEFAULT 0,
                    plays INTEGER DEFAULT 0,
                    cover_url TEXT,
                    source_url TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(platform, work_id),
                    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS score_baselines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    creator_id INTEGER NOT NULL,
                    platform TEXT NOT NULL,
                    metric_baseline REAL NOT NULL,
                    sample_count INTEGER NOT NULL,
                    follower_snapshot INTEGER NOT NULL,
                    baseline_at TEXT NOT NULL,
                    UNIQUE(platform, creator_id),
                    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS scores (
                    work_id INTEGER PRIMARY KEY,
                    r_value REAL NOT NULL,
                    m_value REAL NOT NULL,
                    grade TEXT NOT NULL,
                    tier TEXT NOT NULL,
                    baseline_metric REAL,
                    baseline_sample_count INTEGER DEFAULT 0,
                    follower_snapshot INTEGER DEFAULT 0,
                    baseline_at TEXT,
                    baseline_version TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS shadow_scores (
                    work_id INTEGER NOT NULL,
                    version TEXT NOT NULL,
                    grade TEXT NOT NULL,
                    score_json TEXT NOT NULL,
                    observed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (work_id, version),
                    FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS scan_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_type TEXT NOT NULL,
                    creator_ref TEXT,
                    status TEXT NOT NULL DEFAULT 'queued',
                    payload_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    attempt_count INTEGER DEFAULT 0,
                    error_message TEXT
                );

                CREATE TABLE IF NOT EXISTS analysis_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    work_id INTEGER NOT NULL,
                    tier TEXT NOT NULL,
                    priority INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    l1_status TEXT,
                    l1_result_json TEXT,
                    score_snapshot_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    analysis_depth TEXT NOT NULL DEFAULT 'fast',
                    army_task_id TEXT,
                    dispatch_attempt_count INTEGER NOT NULL DEFAULT 0,
                    dispatch_error TEXT,
                    dispatch_result_json TEXT,
                    dispatched_at TEXT,
                    UNIQUE(work_id),
                    FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS transcripts (
                    work_id INTEGER PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'queued',
                    provider TEXT,
                    transcript_text TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(work_id) REFERENCES works(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_works_creator_platform ON works(creator_id, platform, publish_at DESC);
                CREATE INDEX IF NOT EXISTS idx_scores_grade ON scores(grade, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_shadow_scores_version_grade ON shadow_scores(version, grade, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status, created_at ASC);
                CREATE INDEX IF NOT EXISTS idx_analysis_status ON analysis_queue(status, priority DESC, created_at ASC);
                '''
            )
            self._ensure_column(con, 'analysis_queue', 'analysis_depth', "TEXT NOT NULL DEFAULT 'fast'")
            self._ensure_column(con, 'analysis_queue', 'army_task_id', 'TEXT')
            self._ensure_column(con, 'analysis_queue', 'dispatch_attempt_count', 'INTEGER NOT NULL DEFAULT 0')
            self._ensure_column(con, 'analysis_queue', 'dispatch_error', 'TEXT')
            self._ensure_column(con, 'analysis_queue', 'dispatch_result_json', 'TEXT')
            self._ensure_column(con, 'analysis_queue', 'dispatched_at', 'TEXT')
            self._ensure_column(con, 'scores', 'baseline_version', 'TEXT')

    @staticmethod
    def _ensure_column(con: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        columns = {row['name'] for row in con.execute(f'PRAGMA table_info({table})').fetchall()}
        if column not in columns:
            con.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')

    def normalize_json(self, value: Optional[Any]) -> str:
        if value is None:
            return '{}'
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def now(self) -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()

    def row_dict(self, row: Optional[sqlite3.Row]) -> Optional[dict]:
        if row is None:
            return None
        return dict(row)

    def upsert_creator(self, platform: str, creator_id: str, creator_name: Optional[str], follower_count: int) -> int:
        with self.connection() as con:
            now = self.now()
            con.execute(
                '''
                INSERT INTO creators(platform, creator_id, creator_name, follower_count, follower_snapshot_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(platform, creator_id) DO UPDATE SET
                  creator_name=excluded.creator_name,
                  follower_count=excluded.follower_count,
                  follower_snapshot_at=excluded.follower_snapshot_at,
                  updated_at=excluded.updated_at
                ''',
                (platform, creator_id, creator_name or '', int(follower_count or 0), now, now, now)
            )
            row = con.execute(
                'SELECT id FROM creators WHERE platform=? AND creator_id=?',
                (platform, creator_id)
            ).fetchone()
            return int(row['id'])

    def upsert_work(self, creator_db_id: int, platform: str, work: dict) -> tuple[int, bool]:
        work_id = str(work.get('work_id') or '').strip()
        if not work_id:
            raise ValueError('work_id 必须提供')
        payload = {
            'likes': int(work.get('likes') or 0),
            'favorites': int(work.get('favorites') or 0),
            'plays': None if 'plays' in work and work.get('plays') is None else int(work.get('plays') or 0),
            'title': str(work.get('title') or '').strip(),
            'publish_at': str(work.get('publish_at') or '').strip(),
            'cover_url': str(work.get('cover_url') or '').strip(),
            'source_url': str(work.get('source_url') or '').strip(),
            'creator_work_id': str(work.get('creator_work_id') or '').strip(),
            'metadata_json': self.normalize_json(work.get('metadata') or {}),
        }
        now = self.now()
        with self.connection() as con:
            cur = con.execute(
                '''
                INSERT INTO works(
                    creator_id, platform, work_id, creator_work_id, title, publish_at, likes, favorites,
                    plays, cover_url, source_url, metadata_json, updated_at, created_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(platform, work_id) DO UPDATE SET
                  creator_id=excluded.creator_id,
                  creator_work_id=excluded.creator_work_id,
                  title=excluded.title,
                  publish_at=excluded.publish_at,
                  likes=excluded.likes,
                  favorites=excluded.favorites,
                  plays=excluded.plays,
                  cover_url=excluded.cover_url,
                  source_url=excluded.source_url,
                  metadata_json=excluded.metadata_json,
                  updated_at=excluded.updated_at
                ''',
                (
                    creator_db_id, platform, work_id, payload['creator_work_id'], payload['title'], payload['publish_at'],
                    payload['likes'], payload['favorites'], payload['plays'], payload['cover_url'], payload['source_url'],
                    payload['metadata_json'], now, now
                )
            )
            row = con.execute('SELECT id FROM works WHERE creator_id=? AND platform=? AND work_id=?', (creator_db_id, platform, work_id)).fetchone()
            db_work_id = int(row['id'])
            con.execute(
                '''
                INSERT INTO scores(work_id, r_value, m_value, grade, tier, baseline_metric, baseline_sample_count, follower_snapshot, baseline_at, baseline_version, created_at, updated_at)
                VALUES(?, 0, 0, 'N0', 'low', NULL, 0, 0, NULL, NULL, ?, ?)
                ON CONFLICT(work_id) DO NOTHING
                ''',
                (db_work_id, now, now)
            )
            return db_work_id, cur.rowcount > 0

    def get_work(self, work_id: int) -> Optional[dict]:
        with self.connection() as con:
            row = con.execute(
                '''
                SELECT w.*, c.platform as creator_platform, c.creator_id as creator_external_id, c.creator_name, c.follower_count
                FROM works w
                JOIN creators c ON c.id = w.creator_id
                WHERE w.id = ?
                ''',
                (work_id,)
            ).fetchone()
            return self.row_dict(row)

    def list_creator_work_ids(self, creator_db_id: int, platform: str, exclude_work_id: int, limit: int = 20) -> List[int]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT id FROM works
                WHERE creator_id=? AND platform=? AND id<>?
                ORDER BY COALESCE(NULLIF(publish_at, ''), '1970-01-01') DESC, id DESC
                LIMIT ?
                ''',
                (creator_db_id, platform, int(exclude_work_id), int(limit))
            ).fetchall()
            return [int(r['id']) for r in rows]

    def get_work_metrics(self, work_id: int) -> Optional[dict]:
        with self.connection() as con:
            row = con.execute(
                '''
                SELECT w.id, w.platform, w.likes, w.favorites, c.follower_count
                FROM works w
                JOIN creators c ON c.id = w.creator_id
                WHERE w.id=?
                ''',
                (work_id,)
            ).fetchone()
            return self.row_dict(row)

    def get_score(self, work_id: int) -> Optional[dict]:
        with self.connection() as con:
            row = con.execute('SELECT * FROM scores WHERE work_id=?', (int(work_id),)).fetchone()
            return self.row_dict(row)

    def get_shadow_score(self, work_id: int, version: str = 'shadow-v2') -> Optional[dict]:
        with self.connection() as con:
            row = con.execute(
                'SELECT score_json FROM shadow_scores WHERE work_id=? AND version=?',
                (int(work_id), str(version)),
            ).fetchone()
            if row is None:
                return None
            value = json.loads(row['score_json'])
            return value if isinstance(value, dict) else None

    def list_shadow_scores(self, version: str = 'shadow-v2', limit: int = 100) -> List[dict]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT ss.work_id, ss.version, ss.grade AS shadow_grade, ss.score_json, ss.observed_at,
                       s.grade AS official_grade, w.platform, w.work_id AS external_work_id,
                       w.title, w.source_url
                FROM shadow_scores ss
                JOIN works w ON w.id = ss.work_id
                LEFT JOIN scores s ON s.work_id = ss.work_id
                WHERE ss.version=?
                ORDER BY ss.updated_at DESC
                LIMIT ?
                ''',
                (str(version), max(1, min(int(limit), 500))),
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                value = json.loads(item.pop('score_json'))
                item['shadow_score'] = value if isinstance(value, dict) else None
                result.append(item)
            return result

    def history_metrics(self, creator_db_id: int, platform: str, exclude_work_id: int, limit: int = 20) -> List[float]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT historical.likes, historical.favorites, historical.platform
                FROM works AS historical
                JOIN works AS current ON current.id=?
                WHERE historical.creator_id=? AND historical.platform=? AND historical.id<>current.id
                  AND (
                    COALESCE(NULLIF(historical.publish_at, ''), '1970-01-01') < COALESCE(NULLIF(current.publish_at, ''), '1970-01-01')
                    OR (
                      COALESCE(NULLIF(historical.publish_at, ''), '1970-01-01') = COALESCE(NULLIF(current.publish_at, ''), '1970-01-01')
                      AND historical.id < current.id
                    )
                  )
                ORDER BY COALESCE(NULLIF(historical.publish_at, ''), '1970-01-01') DESC, historical.id DESC
                LIMIT ?
                ''',
                (int(exclude_work_id), creator_db_id, platform, int(limit))
            ).fetchall()
            metrics = []
            for row in rows:
                metrics.append(platform_metric(row['platform'], int(row['likes'] or 0), int(row['favorites'] or 0)))
            return metrics

    def get_baseline(self, creator_db_id: int, platform: str) -> Optional[dict]:
        with self.connection() as con:
            row = con.execute(
                'SELECT * FROM score_baselines WHERE creator_id=? AND platform=?',
                (creator_db_id, platform)
            ).fetchone()
            return self.row_dict(row)

    def set_baseline(self, creator_db_id: int, platform: str, metric: float, sample_count: int, follower_count: int) -> dict:
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                INSERT INTO score_baselines(creator_id, platform, metric_baseline, sample_count, follower_snapshot, baseline_at)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(platform, creator_id) DO UPDATE SET
                  metric_baseline=excluded.metric_baseline,
                  sample_count=excluded.sample_count,
                  follower_snapshot=excluded.follower_snapshot,
                  baseline_at=excluded.baseline_at
                ''',
                (creator_db_id, platform, float(metric), int(sample_count), int(follower_count), now)
            )
            return {
                'metric_baseline': metric,
                'sample_count': sample_count,
                'follower_snapshot': follower_count,
                'baseline_at': now,
            }

    def upsert_score(self, work_db_id: int, score: Dict[str, object]) -> None:
        with self.connection() as con:
            now = self.now()
            con.execute(
                '''
                INSERT INTO scores(work_id, r_value, m_value, grade, tier, baseline_metric, baseline_sample_count, follower_snapshot, baseline_at, baseline_version, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(work_id) DO UPDATE SET
                  r_value=excluded.r_value,
                  m_value=excluded.m_value,
                  grade=excluded.grade,
                  tier=excluded.tier,
                  baseline_metric=excluded.baseline_metric,
                  baseline_sample_count=excluded.baseline_sample_count,
                  follower_snapshot=excluded.follower_snapshot,
                  baseline_at=excluded.baseline_at,
                  baseline_version=excluded.baseline_version,
                  updated_at=excluded.updated_at
                ''',
                (
                    work_db_id,
                    float(score['r_value']),
                    float(score['m_value']),
                    str(score['grade']),
                    str(score['tier']),
                    None if score.get('baseline_metric') is None else float(score['baseline_metric']),
                    int(score['sample_count']),
                    int(score.get('follower_snapshot', 0)),
                    score.get('baseline_at'),
                    score.get('baseline_version'),
                    now,
                    now,
                )
            )

    def upsert_shadow_score(self, work_db_id: int, score: Dict[str, object]) -> None:
        version = str(score.get('version') or '').strip()
        grade = str(score.get('grade') or '').strip()
        if not version or not grade:
            raise ValueError('影子评分缺少版本或等级。')
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                INSERT INTO shadow_scores(work_id, version, grade, score_json, observed_at, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(work_id, version) DO UPDATE SET
                  grade=excluded.grade,
                  score_json=excluded.score_json,
                  observed_at=excluded.observed_at,
                  updated_at=excluded.updated_at
                ''',
                (
                    int(work_db_id),
                    version,
                    grade,
                    self.normalize_json(score),
                    score.get('observed_at'),
                    now,
                    now,
                ),
            )

    def get_work_detail(self, work_id: int) -> Optional[dict]:
        with self.connection() as con:
            row = con.execute(
                '''
                SELECT
                    w.*, c.platform AS creator_platform, c.creator_id AS creator_external_id, c.creator_name, c.follower_count,
                    s.r_value, s.m_value, s.grade, s.tier, s.baseline_metric, s.baseline_sample_count, s.follower_snapshot,
                    s.baseline_at AS score_baseline_at, aq.tier AS queue_tier, aq.status AS analysis_status,
                    t.status AS transcript_status, t.provider, t.transcript_text
                FROM works w
                JOIN creators c ON c.id = w.creator_id
                LEFT JOIN scores s ON s.work_id = w.id
                LEFT JOIN analysis_queue aq ON aq.work_id = w.id
                LEFT JOIN transcripts t ON t.work_id = w.id
                WHERE w.id = ?
                ''',
                (int(work_id),)
            ).fetchone()
            return self.row_dict(row)

    def queue_scan_job(self, source_type: str, creator_ref: Optional[str], payload: Optional[dict] = None) -> int:
        with self.connection() as con:
            now = self.now()
            payload_json = self.normalize_json(payload)
            cur = con.execute(
                'INSERT INTO scan_jobs(source_type, creator_ref, payload_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?)',
                (source_type, creator_ref, payload_json, now, now)
            )
            return int(cur.lastrowid)

    def take_next_scan_job(self) -> Optional[dict]:
        with self._lock:
            with self.connection() as con:
                row = con.execute(
                    'SELECT * FROM scan_jobs WHERE status="queued" ORDER BY created_at ASC LIMIT 1'
                ).fetchone()
                if not row:
                    return None
                now = self.now()
                con.execute(
                    'UPDATE scan_jobs SET status="running", started_at=?, updated_at=?, attempt_count=attempt_count+1 WHERE id=?',
                    (now, now, int(row['id']))
                )
                return self.row_dict(row)

    def finish_scan_job(self, job_id: int, status: str, error_message: Optional[str] = None) -> None:
        now = self.now()
        with self.connection() as con:
            con.execute(
                'UPDATE scan_jobs SET status=?, finished_at=?, updated_at=?, error_message=? WHERE id=?',
                (status, now, now, error_message, int(job_id))
            )

    def upsert_analysis_queue(self, work_id: int, grade: str, score_snapshot: Optional[dict] = None, analysis_depth: str = 'fast') -> None:
        priority = {'T3': 100, 'T2': 50, 'T1': 10}.get(grade, 0)
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                INSERT INTO analysis_queue(work_id, tier, priority, status, created_at, updated_at, score_snapshot_json, analysis_depth)
                VALUES(?, ?, ?, 'queued', ?, ?, ?, ?)
                ON CONFLICT(work_id) DO UPDATE SET
                  tier=excluded.tier,
                  priority=excluded.priority,
                  status=CASE
                    WHEN analysis_queue.status IN ('dispatched', 'dispatching') THEN analysis_queue.status
                    ELSE 'queued' END,
                  score_snapshot_json=excluded.score_snapshot_json,
                  analysis_depth=excluded.analysis_depth,
                  dispatch_error=CASE WHEN analysis_queue.status IN ('dispatched', 'dispatching') THEN analysis_queue.dispatch_error ELSE NULL END,
                  updated_at=excluded.updated_at
                ''',
                (int(work_id), str(grade), int(priority), now, now, self.normalize_json(score_snapshot or {}), 'full' if analysis_depth == 'full' else 'fast')
            )

    def next_dispatch_batch(self, limit: int = 20) -> List[dict]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT aq.*, w.title, w.work_id AS external_work_id, w.source_url, w.platform,
                       w.likes, w.favorites, w.plays, w.publish_at,
                       c.creator_id AS creator_external_id, c.creator_name, c.follower_count,
                       s.r_value, s.m_value, s.grade, s.tier, s.baseline_metric,
                       s.baseline_sample_count, s.follower_snapshot, s.baseline_at
                FROM analysis_queue aq
                JOIN works w ON w.id=aq.work_id
                JOIN creators c ON c.id=w.creator_id
                JOIN scores s ON s.work_id=aq.work_id
                WHERE aq.status='queued'
                ORDER BY aq.priority DESC, aq.created_at ASC
                LIMIT ?
                ''',
                (int(limit),)
            ).fetchall()
            return [self.row_dict(row) for row in rows]

    def count_dispatched_since(self, since_iso: str) -> int:
        with self.connection() as con:
            row = con.execute(
                '''
                SELECT COUNT(*) AS total
                FROM analysis_queue
                WHERE status='dispatched'
                  AND dispatched_at IS NOT NULL
                  AND dispatched_at >= ?
                ''',
                (str(since_iso),)
            ).fetchone()
            return int(row['total'] if row else 0)

    def begin_dispatch(self, queue_id: int) -> bool:
        now = self.now()
        with self.connection() as con:
            cur = con.execute(
                '''
                UPDATE analysis_queue
                SET status='dispatching', started_at=?, updated_at=?, dispatch_attempt_count=dispatch_attempt_count+1, dispatch_error=NULL
                WHERE id=? AND status='queued'
                ''',
                (now, now, int(queue_id))
            )
            return cur.rowcount > 0

    def finish_dispatch(self, queue_id: int, status: str, *, task_id: Optional[str] = None,
                        result: Optional[dict] = None, error: Optional[str] = None) -> None:
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                UPDATE analysis_queue
                SET status=?, army_task_id=?, dispatch_result_json=?, dispatch_error=?,
                    updated_at=?, finished_at=?, dispatched_at=?
                WHERE id=?
                ''',
                (
                    status,
                    task_id,
                    self.normalize_json(result or {}),
                    error,
                    now,
                    now,
                    now if status == 'dispatched' else None,
                    int(queue_id),
                )
            )

    def get_setting(self, key: str) -> Optional[Any]:
        with self.connection() as con:
            row = con.execute('SELECT value_json FROM app_settings WHERE key=?', (str(key),)).fetchone()
            if not row:
                return None
            try:
                return json.loads(row['value_json'])
            except (TypeError, json.JSONDecodeError):
                return None

    def set_setting(self, key: str, value: Any) -> None:
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                INSERT INTO app_settings(key, value_json, updated_at) VALUES(?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
                ''',
                (str(key), self.normalize_json(value), now)
            )

    def next_l1_batch(self, limit: int = 20) -> List[dict]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT aq.id, aq.work_id, w.title, w.source_url, w.platform, s.r_value, s.m_value, s.grade, s.tier
                FROM analysis_queue aq
                JOIN scores s ON s.work_id = aq.work_id
                JOIN works w ON w.id = aq.work_id
                WHERE aq.status='queued'
                ORDER BY aq.priority DESC, aq.created_at ASC
                LIMIT ?
                ''',
                (int(limit),)
            ).fetchall()
            return [self.row_dict(r) for r in rows]

    def begin_l1(self, queue_id: int) -> bool:
        now = self.now()
        with self.connection() as con:
            cur = con.execute(
                "UPDATE analysis_queue SET status='working', started_at=?, l1_status='running', updated_at=? WHERE id=? AND status='queued'",
                (now, now, int(queue_id))
            )
            return cur.rowcount > 0

    def finish_l1(self, queue_id: int, status: str, result: Dict[str, object]) -> None:
        now = self.now()
        with self.connection() as con:
            con.execute(
                '''
                UPDATE analysis_queue
                SET status=?, l1_status=?, l1_result_json=?, updated_at=?, finished_at=?
                WHERE id=?
                ''',
                (status, status, json.dumps(result, ensure_ascii=False), now, now, int(queue_id))
            )

    def list_works_with_scores(self, grade: str | None = None, platform: str | None = None, creator_id: str | None = None, limit: int = 50) -> List[dict]:
        conditions = ['1=1']
        params: List[object] = []
        if grade:
            conditions.append('s.grade=?')
            params.append(grade)
        if platform:
            conditions.append('w.platform=?')
            params.append(platform)
        if creator_id:
            conditions.append('c.creator_id=?')
            params.append(creator_id)

        where = ' AND '.join(conditions)
        query = f'''
            SELECT w.id, w.platform, c.creator_id AS creator_external_id, c.creator_name, w.work_id, w.title, w.publish_at,
                   w.likes, w.favorites, w.plays, s.grade, s.r_value, s.m_value, s.tier, s.updated_at AS scored_at,
                   aq.status AS analysis_status
            FROM works w
            JOIN creators c ON c.id = w.creator_id
            LEFT JOIN scores s ON s.work_id = w.id
            LEFT JOIN analysis_queue aq ON aq.work_id = w.id
            WHERE {where}
            ORDER BY COALESCE(s.updated_at, w.updated_at) DESC
            LIMIT ?
        '''
        params.append(int(limit))
        with self.connection() as con:
            rows = con.execute(query, params).fetchall()
            return [self.row_dict(r) for r in rows]

    def dashboard_summary(self) -> dict:
        with self.connection() as con:
            total_works = con.execute('SELECT COUNT(1) AS c FROM works').fetchone()['c']
            total_creators = con.execute('SELECT COUNT(1) AS c FROM creators').fetchone()['c']
            t3 = con.execute("SELECT COUNT(1) AS c FROM scores WHERE grade='T3'").fetchone()['c']
            t2 = con.execute("SELECT COUNT(1) AS c FROM scores WHERE grade='T2'").fetchone()['c']
            t1 = con.execute("SELECT COUNT(1) AS c FROM scores WHERE grade='T1'").fetchone()['c']
            queued_jobs = con.execute("SELECT COUNT(1) AS c FROM scan_jobs WHERE status IN ('queued','running')").fetchone()['c']
            return {
                'totals': {'creators': total_creators, 'works': total_works},
                'boom': {'T3': t3, 'T2': t2, 'T1': t1},
                'scan_jobs': queued_jobs,
            }

    def list_scan_jobs(self, limit: int = 20) -> List[dict]:
        with self.connection() as con:
            rows = con.execute(
                'SELECT * FROM scan_jobs ORDER BY created_at DESC LIMIT ?', (int(limit),)
            ).fetchall()
            return [self.row_dict(r) for r in rows]

    def list_analysis_queue(self, limit: int = 200) -> List[dict]:
        with self.connection() as con:
            rows = con.execute(
                '''
                SELECT aq.id, aq.work_id, aq.tier, aq.priority, aq.status, aq.l1_status, aq.created_at, aq.updated_at,
                       w.title, w.platform, s.grade, s.r_value, s.m_value,
                       aq.analysis_depth, aq.army_task_id, aq.dispatch_attempt_count, aq.dispatch_error, aq.dispatched_at
                FROM analysis_queue aq
                JOIN scores s ON s.work_id = aq.work_id
                JOIN works w ON w.id = aq.work_id
                ORDER BY aq.priority DESC, aq.created_at ASC
                LIMIT ?
                ''',
                (int(limit),)
            ).fetchall()
            return [self.row_dict(r) for r in rows]


def platform_metric(platform: str, likes: int, favorites: int) -> float:
    if platform == 'xiaohongshu':
        return float(int(likes) + int(favorites))
    return float(int(likes))
