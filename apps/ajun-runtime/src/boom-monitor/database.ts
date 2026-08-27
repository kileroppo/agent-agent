import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class BoomMonitorDatabase {
    connection: any;
    dbPath: any;
    constructor(dbPath: any) {
        this.dbPath = dbPath;
        mkdirSync(path.dirname(dbPath), { recursive: true });
        this.connection = new DatabaseSync(dbPath);
        this.connection.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
        this.init();
        chmodSync(dbPath, 0o600);
    }
    close(): any { this.connection.close(); }
    now(): any { return new Date().toISOString(); }
    init(): any {
        this.connection.exec(`
      CREATE TABLE IF NOT EXISTS creators (
        id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, creator_id TEXT NOT NULL,
        creator_name TEXT, follower_count INTEGER DEFAULT 0, follower_snapshot_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(platform, creator_id)
      );
      CREATE TABLE IF NOT EXISTS works (
        id INTEGER PRIMARY KEY AUTOINCREMENT, creator_id INTEGER NOT NULL, platform TEXT NOT NULL,
        work_id TEXT NOT NULL, creator_work_id TEXT, title TEXT, publish_at TEXT,
        likes INTEGER DEFAULT 0, favorites INTEGER DEFAULT 0, plays INTEGER DEFAULT 0,
        cover_url TEXT, source_url TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(platform, work_id),
        FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS score_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT, creator_id INTEGER NOT NULL, platform TEXT NOT NULL,
        metric_baseline REAL NOT NULL, sample_count INTEGER NOT NULL, follower_snapshot INTEGER NOT NULL,
        baseline_at TEXT NOT NULL, UNIQUE(platform, creator_id),
        FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS scores (
        work_id INTEGER PRIMARY KEY, score_version TEXT NOT NULL DEFAULT 'v2',
        r_value REAL NOT NULL, m_value REAL NOT NULL, grade TEXT NOT NULL, tier TEXT NOT NULL,
        baseline_metric REAL, baseline_sample_count INTEGER DEFAULT 0, follower_snapshot INTEGER DEFAULT 0,
        baseline_at TEXT, baseline_version TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS shadow_scores (
        work_id INTEGER NOT NULL, version TEXT NOT NULL, grade TEXT NOT NULL, score_json TEXT NOT NULL,
        observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (work_id, version), FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS scan_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, creator_ref TEXT,
        status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, attempt_count INTEGER DEFAULT 0,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS analysis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, tier TEXT NOT NULL,
        priority INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', l1_status TEXT,
        l1_result_json TEXT, score_snapshot_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, analysis_depth TEXT NOT NULL DEFAULT 'fast', army_task_id TEXT,
        dispatch_attempt_count INTEGER NOT NULL DEFAULT 0, dispatch_error TEXT,
        dispatch_result_json TEXT, dispatched_at TEXT, mission_status TEXT, mission_stage TEXT,
        mission_updated_at TEXT, last_reconciled_at TEXT, UNIQUE(work_id),
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        work_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', provider TEXT,
        transcript_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(work_id) REFERENCES works(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_works_creator_platform ON works(creator_id, platform, publish_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scores_grade ON scores(grade, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shadow_scores_version_grade ON shadow_scores(version, grade, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_analysis_status ON analysis_queue(status, priority DESC, created_at ASC);
    `);
        this.ensureColumn('analysis_queue', 'analysis_depth', "TEXT NOT NULL DEFAULT 'fast'");
        this.ensureColumn('analysis_queue', 'army_task_id', 'TEXT');
        this.ensureColumn('analysis_queue', 'dispatch_attempt_count', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureColumn('analysis_queue', 'dispatch_error', 'TEXT');
        this.ensureColumn('analysis_queue', 'dispatch_result_json', 'TEXT');
        this.ensureColumn('analysis_queue', 'dispatched_at', 'TEXT');
        this.ensureColumn('analysis_queue', 'mission_status', 'TEXT');
        this.ensureColumn('analysis_queue', 'mission_stage', 'TEXT');
        this.ensureColumn('analysis_queue', 'mission_updated_at', 'TEXT');
        this.ensureColumn('analysis_queue', 'last_reconciled_at', 'TEXT');
        this.ensureColumn('scores', 'baseline_version', 'TEXT');
        this.ensureColumn('scores', 'score_version', "TEXT NOT NULL DEFAULT 'v2'");
        this.invalidateObsoleteScores();
    }
    ensureColumn(table: any, column: any, definition: any): any {
        const columns: any = new Set(this.connection.prepare(`PRAGMA table_info(${table})`).all().map((row: any): any => row.name));
        if (!columns.has(column))
            this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    invalidateObsoleteScores(): any {
        this.connection.exec(`
          DELETE FROM shadow_scores WHERE version <> 'v2';
          UPDATE scores SET score_version='v2', r_value=0, m_value=0, grade='N0', tier='low',
            baseline_metric=NULL, baseline_sample_count=0, follower_snapshot=0,
            baseline_at=NULL, baseline_version=NULL, updated_at=updated_at
          WHERE score_version <> 'v2';
        `);
    }
    upsertCreator(platform: any, creatorId: any, creatorName: any, followerCount: any): any {
        const now: any = this.now();
        this.connection.prepare(`
      INSERT INTO creators(platform,creator_id,creator_name,follower_count,follower_snapshot_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(platform,creator_id) DO UPDATE SET
      creator_name=excluded.creator_name,follower_count=excluded.follower_count,
      follower_snapshot_at=excluded.follower_snapshot_at,updated_at=excluded.updated_at
    `).run(platform, creatorId, creatorName ?? '', integer(followerCount), now, now, now);
        return Number(this.connection.prepare('SELECT id FROM creators WHERE platform=? AND creator_id=?').get(platform, creatorId).id);
    }
    upsertWork(creatorDbId: any, platform: any, work: any): any {
        const workId: any = String(work.work_id ?? '').trim();
        if (!workId)
            throw new Error('work_id 必须提供');
        const existing: any = this.connection.prepare('SELECT id FROM works WHERE platform=? AND work_id=?').get(platform, workId);
        const plays: any = Object.hasOwn(work, 'plays') && work.plays == null ? null : integer(work.plays);
        const now: any = this.now();
        this.connection.prepare(`
      INSERT INTO works(creator_id,platform,work_id,creator_work_id,title,publish_at,likes,favorites,plays,cover_url,source_url,metadata_json,updated_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,work_id) DO UPDATE SET
      creator_id=excluded.creator_id,creator_work_id=excluded.creator_work_id,title=excluded.title,
      publish_at=excluded.publish_at,likes=excluded.likes,favorites=excluded.favorites,plays=excluded.plays,
      cover_url=excluded.cover_url,source_url=excluded.source_url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
    `).run(creatorDbId, platform, workId, String(work.creator_work_id ?? '').trim(), String(work.title ?? '').trim(), String(work.publish_at ?? '').trim(), integer(work.likes), integer(work.favorites), plays, String(work.cover_url ?? '').trim(), String(work.source_url ?? '').trim(), normalizeJson(work.metadata ?? {}), now, now);
        const dbWorkId: any = Number(this.connection.prepare('SELECT id FROM works WHERE platform=? AND work_id=?').get(platform, workId).id);
        this.connection.prepare(`
      INSERT INTO scores(work_id,score_version,r_value,m_value,grade,tier,baseline_metric,baseline_sample_count,follower_snapshot,baseline_at,baseline_version,created_at,updated_at)
      VALUES(?,'v2',0,0,'N0','low',NULL,0,0,NULL,NULL,?,?) ON CONFLICT(work_id) DO NOTHING
    `).run(dbWorkId, now, now);
        return [dbWorkId, !existing];
    }
    getWork(workId: any): any {
        return row(this.connection.prepare(`
      SELECT w.*,c.platform AS creator_platform,c.creator_id AS creator_external_id,c.creator_name,c.follower_count
      FROM works w JOIN creators c ON c.id=w.creator_id WHERE w.id=?
    `).get(integer(workId)));
    }
    historyMetrics(creatorDbId: any, platform: any, excludeWorkId: any, limit: any = 20): any {
        return this.connection.prepare(`
      SELECT historical.likes,historical.favorites,historical.platform FROM works historical
      JOIN works current ON current.id=?
      WHERE historical.creator_id=? AND historical.platform=? AND historical.id<>current.id AND (
        COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') < COALESCE(NULLIF(current.publish_at,''),'1970-01-01') OR (
          COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') = COALESCE(NULLIF(current.publish_at,''),'1970-01-01')
          AND historical.id < current.id))
      ORDER BY COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') DESC,historical.id DESC LIMIT ?
    `).all(excludeWorkId, creatorDbId, platform, limit).map((item: any): any => (item.platform === 'xiaohongshu' ? integer(item.likes) + integer(item.favorites) : integer(item.likes)));
    }
    historyWorks(creatorDbId: any, platform: any, excludeWorkId: any, limit: any = 20): any {
        return this.connection.prepare(`
      SELECT historical.work_id AS id,historical.likes,historical.favorites,historical.plays
      FROM works historical JOIN works current ON current.id=?
      WHERE historical.creator_id=? AND historical.platform=? AND historical.id<>current.id AND (
        COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') < COALESCE(NULLIF(current.publish_at,''),'1970-01-01') OR (
          COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') = COALESCE(NULLIF(current.publish_at,''),'1970-01-01')
          AND historical.id < current.id))
      ORDER BY COALESCE(NULLIF(historical.publish_at,''),'1970-01-01') DESC,historical.id DESC LIMIT ?
    `).all(excludeWorkId, creatorDbId, platform, limit).map((item: any): any => ({
            id: String(item.id ?? ''), likes: integer(item.likes), favorites: integer(item.favorites), plays: item.plays == null ? null : integer(item.plays),
        }));
    }
    getScore(workId: any): any { return row(this.connection.prepare('SELECT * FROM scores WHERE work_id=?').get(integer(workId))); }
    upsertScore(workId: any, score: any): any {
        const now: any = this.now();
        this.connection.prepare(`
      INSERT INTO scores(work_id,score_version,r_value,m_value,grade,tier,baseline_metric,baseline_sample_count,follower_snapshot,baseline_at,baseline_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET
      score_version=excluded.score_version,r_value=excluded.r_value,m_value=excluded.m_value,grade=excluded.grade,
      tier=excluded.tier,baseline_metric=excluded.baseline_metric,baseline_sample_count=excluded.baseline_sample_count,
      follower_snapshot=excluded.follower_snapshot,baseline_at=excluded.baseline_at,
      baseline_version=excluded.baseline_version,updated_at=excluded.updated_at
    `).run(workId, String(score.version ?? score.score_version ?? 'v2'), Number(score.r_value), Number(score.m_value), String(score.grade), String(score.tier), score.baseline_metric == null ? null : Number(score.baseline_metric), integer(score.sample_count ?? score.baseline_sample_count), integer(score.follower_snapshot), score.baseline_at ?? null, score.baseline_version ?? null, now, now);
    }
    upsertShadowScore(workId: any, score: any): any {
        const version: any = String(score.version ?? '').trim();
        const grade: any = String(score.grade ?? '').trim();
        if (!version || !grade)
            throw new Error('影子评分缺少版本或等级。');
        const now: any = this.now();
        this.connection.prepare(`
      INSERT INTO shadow_scores(work_id,version,grade,score_json,observed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(work_id,version) DO UPDATE SET grade=excluded.grade,
      score_json=excluded.score_json,observed_at=excluded.observed_at,updated_at=excluded.updated_at
    `).run(workId, version, grade, normalizeJson(score), score.observed_at ?? null, now, now);
    }
    getShadowScore(workId: any, version: any = 'v2'): any {
        const value: any = this.connection.prepare('SELECT score_json FROM shadow_scores WHERE work_id=? AND version=?').get(integer(workId), version);
        return value ? parseJson(value.score_json, null) : null;
    }
    listShadowScores(version: any = 'v2', limit: any = 100): any {
        return this.connection.prepare(`
      SELECT ss.work_id,ss.version,ss.grade AS shadow_grade,ss.score_json,ss.observed_at,
      s.grade AS official_grade,w.platform,w.work_id AS external_work_id,w.title,w.source_url
      FROM shadow_scores ss JOIN works w ON w.id=ss.work_id LEFT JOIN scores s ON s.work_id=ss.work_id
      WHERE ss.version=? ORDER BY ss.updated_at DESC LIMIT ?
    `).all(version, clamp(limit, 1, 500)).map((value: any): any => {
            const item: any = row(value);
            const scoreJson: any = item.score_json;
            delete item.score_json;
            return { ...item, shadow_score: parseJson(scoreJson, null) };
        });
    }
    getWorkDetail(workId: any): any {
        return row(this.connection.prepare(`
      SELECT w.*,c.platform AS creator_platform,c.creator_id AS creator_external_id,c.creator_name,c.follower_count,
      s.score_version,s.r_value,s.m_value,s.grade,s.tier,s.baseline_metric,s.baseline_sample_count,s.follower_snapshot,
      s.baseline_at AS score_baseline_at,aq.tier AS queue_tier,aq.status AS analysis_status,
      t.status AS transcript_status,t.provider,t.transcript_text
      FROM works w JOIN creators c ON c.id=w.creator_id LEFT JOIN scores s ON s.work_id=w.id
      LEFT JOIN analysis_queue aq ON aq.work_id=w.id LEFT JOIN transcripts t ON t.work_id=w.id WHERE w.id=?
    `).get(integer(workId)));
    }
    queueScanJob(sourceType: any, creatorRef: any = null, payload: any = null): any {
        const now: any = this.now();
        const result: any = this.connection.prepare('INSERT INTO scan_jobs(source_type,creator_ref,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)')
            .run(sourceType, creatorRef, normalizeJson(payload), now, now);
        return Number(result.lastInsertRowid);
    }
    takeNextScanJob(): any {
        this.connection.exec('BEGIN IMMEDIATE');
        try {
            const item: any = row(this.connection.prepare("SELECT * FROM scan_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get());
            if (!item) {
                this.connection.exec('COMMIT');
                return null;
            }
            const now: any = this.now();
            this.connection.prepare("UPDATE scan_jobs SET status='running',started_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=?")
                .run(now, now, item.id);
            this.connection.exec('COMMIT');
            return item;
        }
        catch (error: any) {
            this.connection.exec('ROLLBACK');
            throw error;
        }
    }
    finishScanJob(jobId: any, status: any, errorMessage: any = null): any {
        const now: any = this.now();
        this.connection.prepare('UPDATE scan_jobs SET status=?,finished_at=?,updated_at=?,error_message=? WHERE id=?')
            .run(status, now, now, errorMessage, jobId);
    }
    upsertAnalysisQueue(workId: any, grade: any, scoreSnapshot: any = {}, analysisDepth: any = 'fast', customPriority: any = null): any {
        const priority: any = customPriority != null ? Number(customPriority) : (({ T3: 100, T2: 50, T1: 10 } as any)[grade] ?? 0);
        const now: any = this.now();
        this.connection.prepare(`
      INSERT INTO analysis_queue(work_id,tier,priority,status,created_at,updated_at,score_snapshot_json,analysis_depth)
      VALUES(?,?,?,'queued',?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET tier=excluded.tier,priority=excluded.priority,
      status=CASE WHEN analysis_queue.army_task_id IS NOT NULL THEN analysis_queue.status ELSE 'queued' END,
      score_snapshot_json=excluded.score_snapshot_json,analysis_depth=excluded.analysis_depth,
      dispatch_error=CASE WHEN analysis_queue.army_task_id IS NOT NULL THEN analysis_queue.dispatch_error ELSE NULL END,
      updated_at=excluded.updated_at
    `).run(workId, grade, priority, now, now, normalizeJson(scoreSnapshot), analysisDepth === 'full' ? 'full' : 'fast');
    }
    cancelPendingAnalysis(workId: any, reason: any): any {
        const result: any = this.connection.prepare(`
      UPDATE analysis_queue SET status='cancelled',dispatch_error=?,updated_at=?
      WHERE work_id=? AND status IN ('queued','waiting_source','dispatch_failed')
    `).run(String(reason), this.now(), workId);
        return result.changes > 0;
    }
    cancelIneligibleQueuedAnalysis(reason: any): any {
        const result: any = this.connection.prepare(`
      UPDATE analysis_queue SET status='cancelled',dispatch_error=?,updated_at=?
      WHERE status IN ('queued','waiting_source','dispatch_failed')
        AND priority < 100
        AND NOT EXISTS (
          SELECT 1 FROM scores s
          WHERE s.work_id=analysis_queue.work_id AND s.grade IN ('T1','T2','T3')
        )
    `).run(String(reason), this.now());
        return Number(result.changes);
    }
    nextDispatchBatch(limit: any = 20, workId: any = null): any {
        const where: any = workId == null ? "aq.status='queued'" : "aq.status='queued' AND aq.work_id=?";
        const allowCondition: any = workId != null ? '1=1' : "(s.grade IN ('T1','T2','T3') OR aq.priority >= 100)";
        const statement: any = this.connection.prepare(`
      SELECT aq.*,w.title,w.work_id AS external_work_id,w.source_url,w.platform,w.likes,w.favorites,w.plays,w.publish_at,
      c.creator_id AS creator_external_id,c.creator_name,c.follower_count,
      s.score_version,s.r_value,s.m_value,s.grade,s.tier,s.baseline_metric,s.baseline_sample_count,s.follower_snapshot,s.baseline_at
      FROM analysis_queue aq JOIN works w ON w.id=aq.work_id JOIN creators c ON c.id=w.creator_id JOIN scores s ON s.work_id=aq.work_id
      WHERE ${where} AND ${allowCondition} ORDER BY aq.priority DESC,aq.created_at ASC LIMIT ?
    `);
        return (workId == null ? statement.all(integer(limit)) : statement.all(integer(workId), 1)).map(row);
    }
    countDispatchedSince(sinceIso: any): any {
        return Number(this.connection.prepare(`SELECT COUNT(*) AS total FROM analysis_queue
      WHERE army_task_id IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_at>=?`).get(sinceIso).total);
    }
    beginDispatch(queueId: any): any {
        const now: any = this.now();
        const result: any = this.connection.prepare(`UPDATE analysis_queue SET status='dispatching',started_at=?,updated_at=?,
      dispatch_attempt_count=dispatch_attempt_count+1,dispatch_error=NULL WHERE id=? AND status='queued'`)
            .run(now, now, queueId);
        return result.changes > 0;
    }
    finishDispatch(queueId: any, status: any, { taskId = null, result = {}, error = null }: any = {}): any {
        const now: any = this.now();
        this.connection.prepare(`UPDATE analysis_queue SET status=?,army_task_id=?,dispatch_result_json=?,dispatch_error=?,
      updated_at=?,finished_at=?,dispatched_at=?,mission_status=?,mission_stage=?,mission_updated_at=?,last_reconciled_at=? WHERE id=?`)
            .run(status, taskId, normalizeJson(result), error, now, status === 'submitted' ? null : now,
            taskId ? now : null, taskId ? 'accepted' : null, taskId ? 'mission_accepted' : null,
            taskId ? now : null, taskId ? now : null, queueId);
    }
    syncAnalysisMission(queueId: any, projection: any): any {
        const now: any = this.now();
        const terminal: any = ['completed', 'failed', 'cancelled'].includes(String(projection.status));
        this.connection.prepare(`UPDATE analysis_queue SET status=?,mission_status=?,mission_stage=?,mission_updated_at=?,
      dispatch_error=?,last_reconciled_at=?,updated_at=?,finished_at=CASE WHEN ? THEN COALESCE(finished_at,?) ELSE NULL END WHERE id=?`)
            .run(String(projection.status), String(projection.missionStatus || ''), String(projection.missionStage || ''),
            projection.missionUpdatedAt || null, projection.error || null, now, now, terminal ? 1 : 0, now, queueId);
    }
    getSetting(key: any): any {
        const result: any = this.connection.prepare('SELECT value_json FROM app_settings WHERE key=?').get(String(key));
        return result ? parseJson(result.value_json, null) : null;
    }
    setSetting(key: any, value: any): any {
        this.connection.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
            .run(String(key), normalizeJson(value), this.now());
    }
    setAnalysisSettings(analysisAuto: any, analysisDailyLimit: any): any {
        const statement: any = this.connection.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
        this.connection.exec('BEGIN IMMEDIATE');
        try {
            const now: any = this.now();
            statement.run('analysis_auto', normalizeJson(analysisAuto), now);
            statement.run('analysis_daily_limit', normalizeJson(analysisDailyLimit), now);
            this.connection.exec('COMMIT');
        }
        catch (error: any) {
            this.connection.exec('ROLLBACK');
            throw error;
        }
    }
    listWorksWithScores({ grade = null, platform = null, creatorId = null, limit = 50 }: any = {}): any {
        const conditions: any[] = ['1=1'];
        const parameters: any[] = [];
        if (grade) {
            conditions.push('s.grade=?');
            parameters.push(grade);
        }
        if (platform) {
            conditions.push('w.platform=?');
            parameters.push(platform);
        }
        if (creatorId) {
            conditions.push('c.creator_id=?');
            parameters.push(creatorId);
        }
        parameters.push(clamp(limit, 1, 500));
        return this.connection.prepare(`
      SELECT w.id,w.platform,c.creator_id AS creator_external_id,c.creator_name,w.work_id,w.title,w.publish_at,
      w.likes,w.favorites,w.plays,s.score_version,s.grade,s.r_value,s.m_value,s.tier,s.baseline_metric,s.updated_at AS scored_at,
      aq.status AS analysis_status,aq.army_task_id FROM works w JOIN creators c ON c.id=w.creator_id
      LEFT JOIN scores s ON s.work_id=w.id LEFT JOIN analysis_queue aq ON aq.work_id=w.id
      WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(s.updated_at,w.updated_at) DESC LIMIT ?
    `).all(...parameters).map(row);
    }
    dashboardSummary(): any {
        const scalar: any = (sql: any): any => Number(this.connection.prepare(sql).get().count);
        return {
            totals: { creators: scalar('SELECT COUNT(*) AS count FROM creators'), works: scalar('SELECT COUNT(*) AS count FROM works') },
            boom: {
                T3: scalar("SELECT COUNT(*) AS count FROM scores WHERE grade='T3'"),
                T2: scalar("SELECT COUNT(*) AS count FROM scores WHERE grade='T2'"),
                T1: scalar("SELECT COUNT(*) AS count FROM scores WHERE grade='T1'"),
            },
            scan_jobs: scalar("SELECT COUNT(*) AS count FROM scan_jobs WHERE status IN ('queued','running')"),
        };
    }
    listScanJobs(limit: any = 20): any { return this.connection.prepare('SELECT * FROM scan_jobs ORDER BY created_at DESC LIMIT ?').all(integer(limit)).map(row); }
    listAnalysisQueue(limit: any = 200): any {
        return this.connection.prepare(`
      SELECT aq.id,aq.work_id,aq.tier,aq.priority,aq.status,aq.l1_status,aq.created_at,aq.updated_at,
      w.title,w.platform,s.grade,s.r_value,s.m_value,aq.analysis_depth,aq.army_task_id,
      aq.dispatch_attempt_count,aq.dispatch_error,aq.dispatched_at,aq.mission_status,aq.mission_stage,
      aq.mission_updated_at,aq.last_reconciled_at
      FROM analysis_queue aq JOIN scores s ON s.work_id=aq.work_id JOIN works w ON w.id=aq.work_id
      ORDER BY aq.priority DESC,aq.created_at ASC LIMIT ?
    `).all(integer(limit)).map(row);
    }
}
function normalizeJson(value: any): any { return JSON.stringify(value ?? {}); }
function parseJson(value: any, fallback: any): any {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function row(value: any): any { return value == null ? null : { ...value }; }
function integer(value: any): any { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0; }
function clamp(value: any, minimum: any, maximum: any): any { return Math.max(minimum, Math.min(integer(value), maximum)); }
