import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { BoomMonitorDatabase } from './database.ts';
import { buildScoreComparison, bundleToRecord, evaluateGrade, platformCoreMetric, pythonRound, scoreWork, tierKeyFromFollowers, } from './scoring.ts';
const VALID_ANALYSIS_GRADES: any = new Set(['T1', 'T2', 'T3']);
export function createBoomMonitorService(options: any = {}): any {
    return new BoomMonitorService(options);
}
export class BoomMonitorService {
    analysisAuto: any;
    analysisDailyLimit: any;
    analysisRunning: any;
    backupDir: any;
    backupRunning: any;
    clock: any;
    collectMetricsCallback: any;
    dataDir: any;
    db: any;
    dispatchBoomSignalCallback: any;
    importDir: any;
    importedDir: any;
    intervals: any;
    lastBackupError: any;
    lastScheduled: any;
    scanRunning: any;
    startupBackupPromise: any;
    timers: any;
    constructor({ dbPath, dataDir = path.dirname(dbPath), collectMetrics = null, dispatchBoomSignal = null, analysisDailyLimit = 5, scanIntervalMs = 6000, analysisIntervalMs = 15000, scheduleIntervalMs = 30000, backupIntervalMs = 60 * 60 * 1000, now = (): any => new Date(), }: any = {}) {
        if (!dbPath)
            throw new Error('Boom Monitor dbPath 必须提供。');
        this.dataDir = dataDir;
        this.importDir = path.join(dataDir, 'import');
        this.importedDir = path.join(dataDir, 'imported');
        this.backupDir = path.join(dataDir, 'backups');
        mkdirSync(this.importDir, { recursive: true });
        mkdirSync(this.importedDir, { recursive: true });
        mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
        chmodSync(this.backupDir, 0o700);
        this.db = new BoomMonitorDatabase(dbPath);
        this.collectMetricsCallback = collectMetrics;
        this.dispatchBoomSignalCallback = dispatchBoomSignal;
        this.intervals = { scanIntervalMs, analysisIntervalMs, scheduleIntervalMs, backupIntervalMs };
        this.clock = now;
        this.timers = [];
        this.scanRunning = false;
        this.analysisRunning = false;
        this.backupRunning = false;
        this.startupBackupPromise = null;
        this.lastScheduled = new Set();
        const persistedAuto: any = this.db.getSetting('analysis_auto');
        this.analysisAuto = normalizeAutoConfig(persistedAuto ?? { enabled: false, grades: ['T2', 'T3'] });
        if (JSON.stringify(persistedAuto) !== JSON.stringify(this.analysisAuto)) {
            this.db.setSetting('analysis_auto', this.analysisAuto);
        }
        const persistedLimit: any = this.db.getSetting('analysis_daily_limit');
        this.analysisDailyLimit = normalizeDailyLimit(persistedLimit ?? analysisDailyLimit);
        if (persistedLimit == null)
            this.db.setSetting('analysis_daily_limit', this.analysisDailyLimit);
    }
    close(): any { this.stop(); this.db.close(); }
    start(): any {
        if (this.timers.length)
            return this;
        const scanTimer: any = setInterval((): any => { void this.tickScan(); }, this.intervals.scanIntervalMs);
        const analysisTimer: any = setInterval((): any => { void this.tickAnalysis(); }, this.intervals.analysisIntervalMs);
        const scheduleTimer: any = setInterval((): any => { this.tickSchedules(); }, this.intervals.scheduleIntervalMs);
        const backupTimer: any = setInterval((): any => {
            void this.tickBackup().catch((error: any): any => { this.lastBackupError = String(error?.message || error); });
        }, this.intervals.backupIntervalMs);
        for (const timer of [scanTimer, analysisTimer, scheduleTimer, backupTimer])
            timer.unref?.();
        this.timers.push(scanTimer, analysisTimer, scheduleTimer, backupTimer);
        this.tickSchedules();
        this.startupBackupPromise = this.tickBackup().catch((error: any): any => {
            this.lastBackupError = String(error?.message || error);
            return { status: 'failed' };
        });
        return this;
    }
    stop(): any {
        for (const timer of this.timers)
            clearInterval(timer);
        this.timers = [];
        return this;
    }
    tickSchedules(at: any = this.clock()): any {
        const parts: any = chinaParts(at);
        const schedules: any[] = [
            ['douyin', 20, 0],
            ['xiaohongshu', 20, 10],
            ['youtube', 20, 20],
        ];
        const day: any = `${parts.year}-${parts.month}-${parts.day}`;
        for (const [platform, hour, minute] of schedules) {
            const key: any = `${day}:${platform}`;
            if (parts.hour === hour && parts.minute === minute && !this.lastScheduled.has(key)) {
                this.enqueueScan(platform);
                this.lastScheduled.add(key);
            }
        }
        for (const key of this.lastScheduled)
            if (!key.startsWith(day))
                this.lastScheduled.delete(key);
    }
    async createBackup({ force = false, at = this.clock() }: any = {}): Promise<any> {
        if (this.backupRunning)
            return { status: 'busy' };
        const day: any = chinaDayKey(at);
        const backups: any = this.listBackupFiles();
        const lastBackup: any = this.db.getSetting('last_backup');
        if (!force && lastBackup?.day === day && backups.some((item: any): any => item.path === lastBackup.path)) {
            return { status: 'current', path: lastBackup.path, day };
        }
        this.backupRunning = true;
        const finalPath: any = this.nextBackupPath(at);
        const partialPath: any = `${finalPath}.partial`;
        try {
            await sqliteBackup(this.db.connection, partialPath);
            chmodSync(partialPath, 0o600);
            renameSync(partialPath, finalPath);
            chmodSync(finalPath, 0o600);
            this.rotateBackups(14);
            this.db.setSetting('last_backup', { day, path: finalPath, created_at: at.toISOString() });
            return { status: 'created', path: finalPath, day };
        }
        catch (error: any) {
            if (existsSync(partialPath))
                unlinkSync(partialPath);
            throw error;
        }
        finally {
            this.backupRunning = false;
        }
    }
    async tickBackup(): Promise<any> {
        try {
            return await this.createBackup();
        }
        catch (error: any) {
            return { status: 'failed', error: String(error?.message ?? error) };
        }
    }
    listBackupFiles(): any {
        return readdirSync(this.backupDir)
            .filter((name: any): any => /^boom-monitor-\d{8}T\d{9}Z(?:-\d{3})?\.sqlite$/.test(name))
            .sort()
            .map((name: any): any => ({ name, path: path.join(this.backupDir, name) }));
    }
    nextBackupPath(at: any): any {
        const stamp: any = backupTimestamp(at);
        const base: any = `boom-monitor-${stamp}`;
        let candidate: any = path.join(this.backupDir, `${base}.sqlite`);
        let suffix: any = 0;
        while (existsSync(candidate) || existsSync(`${candidate}.partial`)) {
            suffix += 1;
            candidate = path.join(this.backupDir, `${base}-${String(suffix).padStart(3, '0')}.sqlite`);
        }
        return candidate;
    }
    rotateBackups(retain: any = 14): any {
        const backups: any = this.listBackupFiles();
        for (const expired of backups.slice(0, Math.max(0, backups.length - retain)))
            unlinkSync(expired.path);
    }
    getAnalysisBudget(): any {
        const since: any = chinaDayStartIso(this.clock());
        const dispatchedToday: any = this.db.countDispatchedSince(since);
        return {
            daily_limit: this.analysisDailyLimit,
            dispatched_today: dispatchedToday,
            remaining_today: Math.max(0, this.analysisDailyLimit - dispatchedToday),
        };
    }
    getSettings(): any {
        return {
            analysis_auto: { ...this.analysisAuto, grades: [...this.analysisAuto.grades], daily_limit: this.analysisDailyLimit },
            analysis_budget: this.getAnalysisBudget(),
        };
    }
    updateSettings(input: any = {}): any {
        const nextAuto: Record<string, any> = { enabled: this.analysisAuto.enabled, grades: [...this.analysisAuto.grades] };
        if (input.analysis_auto_enabled != null) {
            if (typeof input.analysis_auto_enabled !== 'boolean')
                throw new Error('analysis_auto_enabled 必须是布尔值');
            nextAuto.enabled = input.analysis_auto_enabled;
        }
        if (input.analysis_auto_grades != null) {
            const grades: any = parseGrades(input.analysis_auto_grades);
            if (!grades.length)
                throw new Error('analysis_auto_grades 不能为空');
            nextAuto.grades = grades;
        }
        const dailyLimit: any = input.analysis_daily_limit ?? input.daily_limit;
        const nextLimit: any = dailyLimit == null ? this.analysisDailyLimit : normalizeDailyLimit(dailyLimit);
        this.db.setAnalysisSettings(nextAuto, nextLimit);
        this.analysisAuto = nextAuto;
        this.analysisDailyLimit = nextLimit;
        return { ok: true, ...this.getSettings() };
    }
    shouldAutoEnqueue(grade: any): any {
        const normalized: any = String(grade).toUpperCase();
        return VALID_ANALYSIS_GRADES.has(normalized)
            && this.analysisAuto.enabled
            && this.analysisAuto.grades.includes(normalized);
    }
    ingestMetricsBundle(bundle: any): any {
        if (bundle?.status === 'metrics_unavailable') {
            return {
                status: 'metrics_unavailable', message: '内容可继续做普通拆解，但当前没有可靠爆款分级依据。',
                metrics: bundle, score: null, legacy_score: null,
            };
        }
        const record: any = bundleToRecord(bundle);
        const creatorId: any = this.db.upsertCreator(record.platform, record.creator_id, record.creator_name, record.follower_count);
        const [workId] = this.db.upsertWork(creatorId, record.platform, record);
        const persisted: any = this.db.getScore(workId) ?? {};
        const frozenLegacy: any = persisted.baseline_version === 'url-history-v1'
            ? persisted : this.db.getShadowScore(workId, 'legacy-v1');
        let frozenV2: any = this.db.getShadowScore(workId, 'v2') ?? this.db.getShadowScore(workId, 'shadow-v2');
        if (!frozenV2 && ['url-history-v2', 'url-history-shadow-v2'].includes(persisted.baseline_version)) {
            frozenV2 = { ...persisted, version: persisted.score_version || 'v2', sample_count: persisted.baseline_sample_count };
        }
        const comparison: any = buildScoreComparison(bundle, frozenLegacy, frozenV2);
        const score: any = comparison.official_score;
        const legacyScore: any = comparison.legacy_score;
        this.db.upsertScore(workId, score);
        this.db.upsertShadowScore(workId, score);
        this.db.upsertShadowScore(workId, legacyScore);
        const work: any = this.db.getWork(workId);
        if (this.shouldAutoEnqueue(score.grade)) {
            this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
        }
        else if (this.analysisAuto.enabled || !VALID_ANALYSIS_GRADES.has(String(score.grade).toUpperCase())) {
            this.db.cancelPendingAnalysis(workId, '正式 v2 等级未命中当前自动派发范围');
        }
        return {
            status: bundle.status || 'collected', work_id: workId, score, legacy_score: legacyScore, metrics: bundle,
            message: score.grade === 'N0' && score.baseline_metric == null
                ? '历史样本不足，保持 N0，不自动拆解。' : '指标已读取；正式 v2 已完成评分并决定派发。',
        };
    }
    async collectUrl(input: any = {}): Promise<any> {
        if (typeof this.collectMetricsCallback !== 'function')
            throw new BoomIntegrationUnavailableError('指标读取能力未注入。');
        const sourceUrl: any = extractFirstHttpUrl(String(input.url ?? ''));
        assertConcreteBoomWorkUrl(sourceUrl);
        const metrics: any = await this.collectMetricsCallback({
            url: sourceUrl,
            connectionId: input.connection_id ?? input.connectionId ?? null,
            historyLimit: clamp(input.history_limit ?? input.historyLimit ?? 20, 5, 20),
        });
        if (!metrics || metrics.schemaVersion !== 'agent.army/boom-metrics-bundle/v1')
            throw new Error('A君未返回有效指标包。');
        return this.ingestMetricsBundle(metrics);
    }
    importRecords(payload: any = {}): any {
        let items: any = payload.works;
        if ((!items || !items.length) && payload.payload != null)
            items = payload.payload;
        if (items == null)
            throw new Error('未提供可写入数据');
        const normalized: any = normalizeRecords({
            platform: payload.platform ?? 'douyin', creator_id: payload.creator ?? '', creator_name: payload.creator_name ?? '',
            follower_count: payload.follower_count ?? 0, works: items,
        });
        if (!normalized.length)
            throw new Error('导入数据为空');
        const jobId: any = this.db.queueScanJob('manual', null, { mode: 'manual', items: normalized });
        return { job_id: jobId, count: normalized.length };
    }
    loadImportPayloads(): any {
        const records: any[] = [];
        for (const fileName of readdirSync(this.importDir).sort()) {
            const extension: any = path.extname(fileName).toLowerCase();
            if (!['.json', '.csv'].includes(extension))
                continue;
            const sourcePath: any = path.join(this.importDir, fileName);
            const raw: any = readFileSync(sourcePath, 'utf8');
            const parsed: any = extension === '.json' ? normalizeRecords(JSON.parse(raw)) : normalizeRecords(parseCsv(raw));
            records.push(...parsed.map((item: any): any => ({ ...item, __source_file: sourcePath })));
            renameSync(sourcePath, path.join(this.importedDir, `${fileName}.done`));
        }
        return records;
    }
    enqueueScan(platform: any = null): any {
        return this.db.queueScanJob('local_import', platform, { mode: 'scheduled', platform, created_at: this.clock().toISOString() });
    }
    processScanJob(job: any): any {
        const payload: any = parseJson(job.payload_json, {});
        const platformFilter: any = String(job.creator_ref ?? '').trim() || null;
        let items: any = payload.mode === 'manual' && payload.items
            ? normalizeRecords(payload.items, payload.platform ?? 'douyin')
            : this.loadImportPayloads();
        if (platformFilter)
            items = items.filter((item: any): any => String(item.platform ?? '') === platformFilter);
        if (!items.length)
            return { status: 'empty', scored: 0, total: 0 };
        const imported: any[] = [];
        for (const raw of items) {
            const creatorExternalId: any = String(raw.creator_id ?? '').trim();
            const platform: any = String(raw.platform ?? 'douyin').trim();
            if (!creatorExternalId)
                continue;
            const creatorId: any = this.db.upsertCreator(platform, creatorExternalId, String(raw.creator_name ?? '').trim(), integer(raw.follower_count));
            const [workId] = this.db.upsertWork(creatorId, platform, {
                ...raw,
                title: String(raw.title ?? '').trim(),
                publish_at: raw.publish_at == null ? this.clock().toISOString() : String(raw.publish_at),
                likes: integer(raw.likes), favorites: integer(raw.favorites),
                plays: Object.hasOwn(raw, 'plays') && raw.plays == null ? null : integer(raw.plays),
            });
            imported.push(workId);
        }
        const scored: any = imported.map((workId: any): any => this.scoreAndQueueOne(workId));
        return { status: 'ok', scored: scored.length, total: items.length, items: scored };
    }
    scoreAndQueueOne(workId: any): any {
        const work: any = this.db.getWork(workId);
        if (!work)
            throw new Error('作品不存在。');
        const metric: any = platformCoreMetric(work.platform, work.likes, work.favorites);
        const history: any = this.db.historyMetrics(work.creator_id, work.platform, workId);
        const frozen: any = this.db.getScore(workId);
        let score: any;
        if (frozen?.baseline_version === 'work-history-v1' && frozen.baseline_metric != null) {
            const followers: any = integer(frozen.follower_snapshot || work.follower_count);
            const rValue: any = metric / Number(frozen.baseline_metric);
            const mValue: any = followers > 0 ? integer(work.likes) / followers : 0;
            score = {
                version: 'legacy-v1', r_value: pythonRound(rValue, 4), m_value: pythonRound(mValue, 4),
                grade: evaluateGrade(rValue, mValue, followers), tier: tierKeyFromFollowers(followers),
                baseline_metric: Number(frozen.baseline_metric), sample_count: integer(frozen.baseline_sample_count),
                follower_snapshot: followers, baseline_at: frozen.baseline_at, baseline_version: 'work-history-v1',
            };
        }
        else {
            score = scoreWork(metric, work.follower_count, history, { mMetric: work.likes });
            Object.assign(score, {
                version: 'legacy-v1', follower_snapshot: integer(work.follower_count),
                baseline_at: score.baseline_metric == null ? null : this.clock().toISOString(),
                baseline_version: score.baseline_metric == null ? null : 'work-history-v1',
            });
        }
        this.db.upsertScore(workId, score);
        if (this.shouldAutoEnqueue(score.grade)) {
            this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
        }
        else if (!VALID_ANALYSIS_GRADES.has(String(score.grade).toUpperCase())) {
            this.db.cancelPendingAnalysis(workId, '当前等级不允许派发');
        }
        return { work_id: workId, work: work.work_id, score };
    }
    async runScanWorker(): Promise<any> {
        if (this.scanRunning)
            return { status: 'busy' };
        this.scanRunning = true;
        const job: any = this.db.takeNextScanJob();
        if (!job) {
            this.scanRunning = false;
            return { status: 'idle' };
        }
        try {
            const result: any = this.processScanJob(job);
            this.db.finishScanJob(job.id, 'completed');
            return result;
        }
        catch (error: any) {
            this.db.finishScanJob(job.id, 'failed', error.message);
            throw error;
        }
        finally {
            this.scanRunning = false;
        }
    }
    async runAnalysisWorker({ manual = false, workId = null }: any = {}): Promise<any> {
        if (this.analysisRunning)
            return { status: 'busy', processed: 0 };
        if (!manual && !this.analysisAuto.enabled)
            return { status: 'disabled', processed: 0 };
        const budget: any = this.getAnalysisBudget();
        if (budget.remaining_today <= 0)
            return { status: 'daily_limit', processed: 0, budget };
        this.db.cancelIneligibleQueuedAnalysis('当前正式评分等级不允许派发');
        const rows: any = manual && workId != null
            ? this.db.nextDispatchBatch(1, workId)
            : this.db.nextDispatchBatch(Math.min(20, budget.remaining_today));
        if (!rows.length)
            return { status: 'idle', processed: 0, budget };
        if (typeof this.dispatchBoomSignalCallback !== 'function') {
            return { status: 'external_dispatch_disabled', processed: 0, queued: rows.length, budget };
        }
        this.analysisRunning = true;
        let processed: any = 0;
        try {
            for (const item of rows) {
                if (!this.db.beginDispatch(item.id))
                    continue;
                try {
                    const snapshot: any = parseJson(item.score_snapshot_json, {});
                    snapshot.depth = item.analysis_depth === 'full' ? 'full' : 'fast';
                    const result: any = await this.dispatchBoomSignalCallback(snapshot);
                    const taskId: any = String(result?.mission?.taskId ?? result?.taskId ?? '');
                    if (!taskId)
                        throw new Error('A君未返回可追踪的军团总任务。');
                    this.db.finishDispatch(item.id, 'dispatched', { taskId, result });
                    processed += 1;
                }
                catch (error: any) {
                    const waitingSource: any = String(error.message).includes('缺少可供小D读取');
                    this.db.finishDispatch(item.id, waitingSource ? 'waiting_source' : 'dispatch_failed', { error: String(error.message) });
                }
            }
            return { status: 'ok', processed, budget: this.getAnalysisBudget() };
        }
        finally {
            this.analysisRunning = false;
        }
    }
    async tickScan(): Promise<any> {
        try {
            return await this.runScanWorker();
        }
        catch {
            return { status: 'failed' };
        }
    }
    async tickAnalysis(): Promise<any> {
        try {
            return await this.runAnalysisWorker({ manual: false });
        }
        catch {
            return { status: 'failed' };
        }
    }
    dashboard(): any { return this.db.dashboardSummary(); }
    listWorks(filters: any = {}): any { return { works: this.db.listWorksWithScores(filters) }; }
    listVersionedScores(version: any = 'v2', limit: any = 100): any {
        return { version, controls_dispatch: version === 'v2', items: this.db.listShadowScores(version, limit) };
    }
    getWork(workId: any): any {
        const work: any = this.db.getWorkDetail(workId);
        if (!work)
            return null;
        return {
            work,
            score_details: this.db.getShadowScore(workId, 'v2') ?? this.db.getShadowScore(workId, 'shadow-v2'),
            legacy_score: this.db.getShadowScore(workId, 'legacy-v1'),
        };
    }
    listScanJobs(limit: any = 20): any { return { jobs: this.db.listScanJobs(limit) }; }
    listAnalysis(limit: any = 200): any { return { items: this.db.listAnalysisQueue(limit) }; }
    enqueueWorkAnalysis(workId: any): any {
        const work: any = this.db.getWorkDetail(workId);
        if (!work)
            return null;
        if (!['T1', 'T2', 'T3'].includes(String(work.grade))) {
            throw new Error('作品必须达到 T1、T2 或 T3 才能派发。');
        }
        const score: Record<string, any> = {
            score_version: work.score_version, grade: work.grade ?? 'N0', tier: work.tier,
            r_value: work.r_value, m_value: work.m_value, baseline_metric: work.baseline_metric,
            sample_count: work.baseline_sample_count, follower_snapshot: work.follower_snapshot,
            baseline_at: work.score_baseline_at,
        };
        this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
        return { status: 'ok', work_id: workId, grade: score.grade };
    }
}
export class BoomIntegrationUnavailableError extends Error {
}
export function buildBoomSignal(work: any, score: any): any {
    const sourceUrl: any = String(work?.source_url ?? '').trim();
    return {
        schemaVersion: 'boom-signal/v1', workRef: `${work?.platform}:${work?.work_id}`,
        workId: String(work?.work_id ?? ''), title: String(work?.title ?? ''), platform: String(work?.platform ?? ''),
        creatorRef: String(work?.creator_external_id ?? ''), creatorName: String(work?.creator_name ?? ''), sourceUrl,
        observedAt: new Date().toISOString(), evidenceKind: 'platform_observed',
        sourceRef: sourceUrl || `boom-monitor:work:${work?.id}`,
        scoreVersion: String(score?.version ?? score?.score_version ?? 'legacy-v1'), grade: String(score?.grade ?? 'N0'),
        tier: String(score?.tier ?? 'low'), rValue: Number(score?.r_value ?? 0), mValue: Number(score?.m_value ?? 0),
        absoluteInteractions: score?.absolute_interactions ?? null, signals: score?.signals ?? {},
        observedMetrics: {
            likes: integer(work?.likes), favorites: integer(work?.favorites),
            plays: work?.plays == null ? null : integer(work.plays),
            followers: integer(score?.follower_snapshot || work?.follower_count),
        },
        baseline: {
            metricMedian: score?.baseline_metric ?? null, sampleCount: integer(score?.sample_count),
            followerSnapshot: integer(score?.follower_snapshot), frozenAt: score?.baseline_at ?? null, historyWindow: 20,
        },
        formulas: {
            R: 'platform_core_metric / frozen_history_median', M: 'likes / frozen_follower_snapshot',
            grade: 'v2: R + reach(M or absolute interactions) + favorite/share/comment quality',
        },
        baselineVersion: score?.baseline_version ?? null,
    };
}
export function normalizeRecords(raw: any, defaultPlatform: any = 'douyin', defaultCreator: any = '', defaultCreatorName: any = '', defaultFollowers: any = 0): any {
    if (raw == null)
        return [];
    if (Array.isArray(raw))
        return raw.flatMap((item: any): any => normalizeRecords(item, defaultPlatform, defaultCreator, defaultCreatorName, defaultFollowers));
    if (typeof raw !== 'object')
        return [];
    if (raw.work && typeof raw.work === 'object') {
        return normalizeRecords({
            platform: raw.platform ?? defaultPlatform, creator_id: raw.creator_id ?? defaultCreator,
            creator_name: raw.creator_name ?? defaultCreatorName, follower_count: raw.follower_count ?? defaultFollowers,
            ...raw.work,
        }, defaultPlatform, defaultCreator, defaultCreatorName, defaultFollowers);
    }
    if (Array.isArray(raw.works)) {
        const context: Record<string, any> = {
            platform: String(raw.platform ?? defaultPlatform), creator_id: String(raw.creator_id ?? defaultCreator).trim(),
            creator_name: String(raw.creator_name ?? defaultCreatorName).trim(), follower_count: integer(raw.follower_count ?? defaultFollowers),
        };
        return raw.works.filter((item: any): any => item && typeof item === 'object').map((item: any): any => ({ ...context, ...item }));
    }
    const record: Record<string, any> = {
        platform: String(raw.platform ?? defaultPlatform), creator_id: String(raw.creator_id ?? defaultCreator),
        creator_name: String(raw.creator_name ?? defaultCreatorName), follower_count: integer(raw.follower_count ?? defaultFollowers),
        ...raw,
    };
    return Object.hasOwn(record, 'work_id') ? [record] : [];
}
function normalizeAutoConfig(value: any): any {
    const { valid, invalid } = normalizeGradeItems(value?.grades ?? ['T2', 'T3']);
    return {
        enabled: value?.enabled === true && invalid.length === 0 && valid.length > 0,
        grades: valid.length ? valid : ['T2', 'T3'],
    };
}
function parseGrades(value: any, { strict = true }: any = {}): any {
    const { valid, invalid } = normalizeGradeItems(value);
    if (strict && invalid.length)
        throw new Error('analysis_auto_grades 只允许 T1、T2、T3');
    return valid;
}
function normalizeGradeItems(value: any): any {
    const items: any = Array.isArray(value) ? value : String(value ?? '').split(',');
    const normalized: any[] = [...new Set(items.map((item: any): any => String(item).trim().toUpperCase()).filter(Boolean))];
    return {
        valid: normalized.filter((grade: any): any => VALID_ANALYSIS_GRADES.has(grade)).sort(),
        invalid: normalized.filter((grade: any): any => !VALID_ANALYSIS_GRADES.has(grade)),
    };
}
function normalizeDailyLimit(value: any): any {
    const parsed: any = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000)
        throw new Error('analysis_daily_limit 必须是 0 到 1000 的整数');
    return parsed;
}
function parseCsv(raw: any): any {
    const lines: any = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line: any): any => line.trim());
    if (!lines.length)
        return [];
    const headers: any = csvLine(lines[0]);
    return lines.slice(1).map((line: any): any => Object.fromEntries(headers.map((header: any, index: any): any => [header, csvLine(line)[index] ?? ''])));
}
function csvLine(line: any): any {
    const values: any[] = [];
    let value: any = '';
    let quoted: any = false;
    for (let index: any = 0; index < line.length; index += 1) {
        const character: any = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') {
            value += '"';
            index += 1;
        }
        else if (character === '"')
            quoted = !quoted;
        else if (character === ',' && !quoted) {
            values.push(value);
            value = '';
        }
        else
            value += character;
    }
    values.push(value);
    return values;
}
function chinaParts(date: any): any {
    const formatter: any = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    return Object.fromEntries(formatter.formatToParts(date).filter((part: any): any => part.type !== 'literal').map((part: any): any => [part.type, Number(part.value)]));
}
function chinaDayStartIso(date: any): any {
    const parts: any = chinaParts(date);
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000).toISOString();
}
function chinaDayKey(date: any): any {
    const parts: any = chinaParts(date);
    return [parts.year, parts.month, parts.day].map((value: any, index: any): any => (index === 0 ? String(value) : String(value).padStart(2, '0'))).join('-');
}
function backupTimestamp(date: any): any {
    return date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}
function parseJson(value: any, fallback: any): any {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function integer(value: any): any { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0; }
function clamp(value: any, minimum: any, maximum: any): any { return Math.max(minimum, Math.min(integer(value), maximum)); }
function extractFirstHttpUrl(value: string): string {
    const matched: RegExpMatchArray | null = String(value).match(/https?:\/\/[^\s<>"'，。！？；、）】》]+/i);
    const sourceUrl: string = String(matched?.[0] || '').replace(/[),.;!]+$/g, '');
    if (!sourceUrl)
        throw new Error('请输入完整的 HTTP(S) 作品链接，或粘贴包含作品链接的分享文案。');
    return sourceUrl;
}
function assertConcreteBoomWorkUrl(sourceUrl: string): void {
    let parsed: URL;
    try {
        parsed = new URL(sourceUrl);
    }
    catch {
        throw new Error('请输入完整的 HTTP(S) 作品链接。');
    }
    const host: string = parsed.hostname.toLowerCase();
    const isDouyin: boolean = host === 'douyin.com' || host.endsWith('.douyin.com')
        || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
    if (!isDouyin)
        return;
    const isShareShortLink: boolean = host === 'v.douyin.com' && /^\/[^/]+\/?$/.test(parsed.pathname);
    const hasWorkPath: boolean = /^\/(?:video|note|share\/(?:video|note))\/[^/]+\/?$/.test(parsed.pathname);
    const hasWorkId: boolean = Boolean(parsed.searchParams.get('aweme_id') || parsed.searchParams.get('modal_id'));
    if (!isShareShortLink && !hasWorkPath && !hasWorkId) {
        throw new Error('必须粘贴具体的抖音作品链接，不能使用推荐首页。请从作品的分享菜单复制链接。');
    }
}
