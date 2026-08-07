import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';

import { BoomMonitorDatabase } from './database.js';
import {
  buildScoreComparison,
  bundleToRecord,
  evaluateGrade,
  platformCoreMetric,
  pythonRound,
  scoreWork,
  tierKeyFromFollowers,
} from './scoring.js';

const VALID_ANALYSIS_GRADES = new Set(['T1', 'T2', 'T3']);

export function createBoomMonitorService(options = {}) {
  return new BoomMonitorService(options);
}

export class BoomMonitorService {
  constructor({
    dbPath,
    dataDir = path.dirname(dbPath),
    collectMetrics = null,
    dispatchBoomSignal = null,
    analysisDailyLimit = 5,
    scanIntervalMs = 6_000,
    analysisIntervalMs = 15_000,
    scheduleIntervalMs = 30_000,
    backupIntervalMs = 60 * 60 * 1_000,
    now = () => new Date(),
  } = {}) {
    if (!dbPath) throw new Error('Boom Monitor dbPath 必须提供。');
    this.dataDir = dataDir;
    this.importDir = path.join(dataDir, 'import');
    this.importedDir = path.join(dataDir, 'imported');
    this.backupDir = path.join(dataDir, 'backups');
    mkdirSync(this.importDir, { recursive:true });
    mkdirSync(this.importedDir, { recursive:true });
    mkdirSync(this.backupDir, { recursive:true, mode:0o700 });
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
    const persistedAuto = this.db.getSetting('analysis_auto');
    this.analysisAuto = normalizeAutoConfig(persistedAuto ?? { enabled:false, grades:['T2', 'T3'] });
    if (JSON.stringify(persistedAuto) !== JSON.stringify(this.analysisAuto)) {
      this.db.setSetting('analysis_auto', this.analysisAuto);
    }
    const persistedLimit = this.db.getSetting('analysis_daily_limit');
    this.analysisDailyLimit = normalizeDailyLimit(persistedLimit ?? analysisDailyLimit);
    if (persistedLimit == null) this.db.setSetting('analysis_daily_limit', this.analysisDailyLimit);
  }

  close() { this.stop(); this.db.close(); }

  start() {
    if (this.timers.length) return this;
    const scanTimer = setInterval(() => { void this.tickScan(); }, this.intervals.scanIntervalMs);
    const analysisTimer = setInterval(() => { void this.tickAnalysis(); }, this.intervals.analysisIntervalMs);
    const scheduleTimer = setInterval(() => { this.tickSchedules(); }, this.intervals.scheduleIntervalMs);
    const backupTimer = setInterval(() => {
      void this.tickBackup().catch((error) => { this.lastBackupError = String(error?.message || error); });
    }, this.intervals.backupIntervalMs);
    for (const timer of [scanTimer, analysisTimer, scheduleTimer, backupTimer]) timer.unref?.();
    this.timers.push(scanTimer, analysisTimer, scheduleTimer, backupTimer);
    this.tickSchedules();
    this.startupBackupPromise = this.tickBackup().catch((error) => {
      this.lastBackupError = String(error?.message || error);
      return { status:'failed' };
    });
    return this;
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    return this;
  }

  tickSchedules(at = this.clock()) {
    const parts = chinaParts(at);
    const schedules = [
      ['douyin', 20, 0],
      ['xiaohongshu', 20, 10],
      ['youtube', 20, 20],
    ];
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    for (const [platform, hour, minute] of schedules) {
      const key = `${day}:${platform}`;
      if (parts.hour === hour && parts.minute === minute && !this.lastScheduled.has(key)) {
        this.enqueueScan(platform);
        this.lastScheduled.add(key);
      }
    }
    for (const key of this.lastScheduled) if (!key.startsWith(day)) this.lastScheduled.delete(key);
  }

  async createBackup({ force = false, at = this.clock() } = {}) {
    if (this.backupRunning) return { status:'busy' };
    const day = chinaDayKey(at);
    const backups = this.listBackupFiles();
    const lastBackup = this.db.getSetting('last_backup');
    if (!force && lastBackup?.day === day && backups.some((item) => item.path === lastBackup.path)) {
      return { status:'current', path:lastBackup.path, day };
    }

    this.backupRunning = true;
    const finalPath = this.nextBackupPath(at);
    const partialPath = `${finalPath}.partial`;
    try {
      await sqliteBackup(this.db.connection, partialPath);
      chmodSync(partialPath, 0o600);
      renameSync(partialPath, finalPath);
      chmodSync(finalPath, 0o600);
      this.rotateBackups(14);
      this.db.setSetting('last_backup', { day, path:finalPath, created_at:at.toISOString() });
      return { status:'created', path:finalPath, day };
    } catch (error) {
      if (existsSync(partialPath)) unlinkSync(partialPath);
      throw error;
    } finally {
      this.backupRunning = false;
    }
  }

  async tickBackup() {
    try {
      return await this.createBackup();
    } catch (error) {
      return { status:'failed', error:String(error?.message ?? error) };
    }
  }

  listBackupFiles() {
    return readdirSync(this.backupDir)
      .filter((name) => /^boom-monitor-\d{8}T\d{9}Z(?:-\d{3})?\.sqlite$/.test(name))
      .sort()
      .map((name) => ({ name, path:path.join(this.backupDir, name) }));
  }

  nextBackupPath(at) {
    const stamp = backupTimestamp(at);
    const base = `boom-monitor-${stamp}`;
    let candidate = path.join(this.backupDir, `${base}.sqlite`);
    let suffix = 0;
    while (existsSync(candidate) || existsSync(`${candidate}.partial`)) {
      suffix += 1;
      candidate = path.join(this.backupDir, `${base}-${String(suffix).padStart(3, '0')}.sqlite`);
    }
    return candidate;
  }

  rotateBackups(retain = 14) {
    const backups = this.listBackupFiles();
    for (const expired of backups.slice(0, Math.max(0, backups.length - retain))) unlinkSync(expired.path);
  }

  getAnalysisBudget() {
    const since = chinaDayStartIso(this.clock());
    const dispatchedToday = this.db.countDispatchedSince(since);
    return {
      daily_limit:this.analysisDailyLimit,
      dispatched_today:dispatchedToday,
      remaining_today:Math.max(0, this.analysisDailyLimit - dispatchedToday),
    };
  }

  getSettings() {
    return {
      analysis_auto:{ ...this.analysisAuto, grades:[...this.analysisAuto.grades], daily_limit:this.analysisDailyLimit },
      analysis_budget:this.getAnalysisBudget(),
    };
  }

  updateSettings(input = {}) {
    const nextAuto = { enabled:this.analysisAuto.enabled, grades:[...this.analysisAuto.grades] };
    if (input.analysis_auto_enabled != null) {
      if (typeof input.analysis_auto_enabled !== 'boolean') throw new Error('analysis_auto_enabled 必须是布尔值');
      nextAuto.enabled = input.analysis_auto_enabled;
    }
    if (input.analysis_auto_grades != null) {
      const grades = parseGrades(input.analysis_auto_grades);
      if (!grades.length) throw new Error('analysis_auto_grades 不能为空');
      nextAuto.grades = grades;
    }
    const dailyLimit = input.analysis_daily_limit ?? input.daily_limit;
    const nextLimit = dailyLimit == null ? this.analysisDailyLimit : normalizeDailyLimit(dailyLimit);
    this.db.setAnalysisSettings(nextAuto, nextLimit);
    this.analysisAuto = nextAuto;
    this.analysisDailyLimit = nextLimit;
    return { ok:true, ...this.getSettings() };
  }

  shouldAutoEnqueue(grade) {
    const normalized = String(grade).toUpperCase();
    return VALID_ANALYSIS_GRADES.has(normalized)
      && this.analysisAuto.enabled
      && this.analysisAuto.grades.includes(normalized);
  }

  ingestMetricsBundle(bundle) {
    if (bundle?.status === 'metrics_unavailable') {
      return {
        status:'metrics_unavailable', message:'内容可继续做普通拆解，但当前没有可靠爆款分级依据。',
        metrics:bundle, score:null, legacy_score:null,
      };
    }
    const record = bundleToRecord(bundle);
    const creatorId = this.db.upsertCreator(record.platform, record.creator_id, record.creator_name, record.follower_count);
    const [workId] = this.db.upsertWork(creatorId, record.platform, record);
    const persisted = this.db.getScore(workId) ?? {};
    const frozenLegacy = persisted.baseline_version === 'url-history-v1'
      ? persisted : this.db.getShadowScore(workId, 'legacy-v1');
    let frozenV2 = this.db.getShadowScore(workId, 'v2') ?? this.db.getShadowScore(workId, 'shadow-v2');
    if (!frozenV2 && ['url-history-v2', 'url-history-shadow-v2'].includes(persisted.baseline_version)) {
      frozenV2 = { ...persisted, version:persisted.score_version || 'v2', sample_count:persisted.baseline_sample_count };
    }
    const comparison = buildScoreComparison(bundle, frozenLegacy, frozenV2);
    const score = comparison.official_score;
    const legacyScore = comparison.legacy_score;
    this.db.upsertScore(workId, score);
    this.db.upsertShadowScore(workId, score);
    this.db.upsertShadowScore(workId, legacyScore);
    const work = this.db.getWork(workId);
    if (this.shouldAutoEnqueue(score.grade)) {
      this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
    } else if (this.analysisAuto.enabled || !VALID_ANALYSIS_GRADES.has(String(score.grade).toUpperCase())) {
      this.db.cancelPendingAnalysis(workId, '正式 v2 等级未命中当前自动派发范围');
    }
    return {
      status:bundle.status || 'collected', work_id:workId, score, legacy_score:legacyScore, metrics:bundle,
      message:score.grade === 'N0' && score.baseline_metric == null
        ? '历史样本不足，保持 N0，不自动拆解。' : '指标已读取；正式 v2 已完成评分并决定派发。',
    };
  }

  async collectUrl(input = {}) {
    if (typeof this.collectMetricsCallback !== 'function') throw new BoomIntegrationUnavailableError('指标读取能力未注入。');
    const sourceUrl = String(input.url ?? '').trim();
    if (!/^https?:\/\//.test(sourceUrl)) throw new Error('请输入完整的 HTTP(S) 作品链接。');
    const metrics = await this.collectMetricsCallback({
      url:sourceUrl,
      connectionId:input.connection_id ?? input.connectionId ?? null,
      historyLimit:clamp(input.history_limit ?? input.historyLimit ?? 20, 5, 20),
    });
    if (!metrics || metrics.schemaVersion !== 'agent.army/boom-metrics-bundle/v1') throw new Error('A君未返回有效指标包。');
    return this.ingestMetricsBundle(metrics);
  }

  importRecords(payload = {}) {
    let items = payload.works;
    if ((!items || !items.length) && payload.payload != null) items = payload.payload;
    if (items == null) throw new Error('未提供可写入数据');
    const normalized = normalizeRecords({
      platform:payload.platform ?? 'douyin', creator_id:payload.creator ?? '', creator_name:payload.creator_name ?? '',
      follower_count:payload.follower_count ?? 0, works:items,
    });
    if (!normalized.length) throw new Error('导入数据为空');
    const jobId = this.db.queueScanJob('manual', null, { mode:'manual', items:normalized });
    return { job_id:jobId, count:normalized.length };
  }

  loadImportPayloads() {
    const records = [];
    for (const fileName of readdirSync(this.importDir).sort()) {
      const extension = path.extname(fileName).toLowerCase();
      if (!['.json', '.csv'].includes(extension)) continue;
      const sourcePath = path.join(this.importDir, fileName);
      const raw = readFileSync(sourcePath, 'utf8');
      const parsed = extension === '.json' ? normalizeRecords(JSON.parse(raw)) : normalizeRecords(parseCsv(raw));
      records.push(...parsed.map((item) => ({ ...item, __source_file:sourcePath })));
      renameSync(sourcePath, path.join(this.importedDir, `${fileName}.done`));
    }
    return records;
  }

  enqueueScan(platform = null) {
    return this.db.queueScanJob('local_import', platform, { mode:'scheduled', platform, created_at:this.clock().toISOString() });
  }

  processScanJob(job) {
    const payload = parseJson(job.payload_json, {});
    const platformFilter = String(job.creator_ref ?? '').trim() || null;
    let items = payload.mode === 'manual' && payload.items
      ? normalizeRecords(payload.items, payload.platform ?? 'douyin')
      : this.loadImportPayloads();
    if (platformFilter) items = items.filter((item) => String(item.platform ?? '') === platformFilter);
    if (!items.length) return { status:'empty', scored:0, total:0 };
    const imported = [];
    for (const raw of items) {
      const creatorExternalId = String(raw.creator_id ?? '').trim();
      const platform = String(raw.platform ?? 'douyin').trim();
      if (!creatorExternalId) continue;
      const creatorId = this.db.upsertCreator(platform, creatorExternalId, String(raw.creator_name ?? '').trim(), integer(raw.follower_count));
      const [workId] = this.db.upsertWork(creatorId, platform, {
        ...raw,
        title:String(raw.title ?? '').trim(),
        publish_at:raw.publish_at == null ? this.clock().toISOString() : String(raw.publish_at),
        likes:integer(raw.likes), favorites:integer(raw.favorites),
        plays:Object.hasOwn(raw, 'plays') && raw.plays == null ? null : integer(raw.plays),
      });
      imported.push(workId);
    }
    const scored = imported.map((workId) => this.scoreAndQueueOne(workId));
    return { status:'ok', scored:scored.length, total:items.length, items:scored };
  }

  scoreAndQueueOne(workId) {
    const work = this.db.getWork(workId);
    if (!work) throw new Error('作品不存在。');
    const metric = platformCoreMetric(work.platform, work.likes, work.favorites);
    const history = this.db.historyMetrics(work.creator_id, work.platform, workId);
    const frozen = this.db.getScore(workId);
    let score;
    if (frozen?.baseline_version === 'work-history-v1' && frozen.baseline_metric != null) {
      const followers = integer(frozen.follower_snapshot || work.follower_count);
      const rValue = metric / Number(frozen.baseline_metric);
      const mValue = followers > 0 ? integer(work.likes) / followers : 0;
      score = {
        version:'legacy-v1', r_value:pythonRound(rValue, 4), m_value:pythonRound(mValue, 4),
        grade:evaluateGrade(rValue, mValue, followers), tier:tierKeyFromFollowers(followers),
        baseline_metric:Number(frozen.baseline_metric), sample_count:integer(frozen.baseline_sample_count),
        follower_snapshot:followers, baseline_at:frozen.baseline_at, baseline_version:'work-history-v1',
      };
    } else {
      score = scoreWork(metric, work.follower_count, history, { mMetric:work.likes });
      Object.assign(score, {
        version:'legacy-v1', follower_snapshot:integer(work.follower_count),
        baseline_at:score.baseline_metric == null ? null : this.clock().toISOString(),
        baseline_version:score.baseline_metric == null ? null : 'work-history-v1',
      });
    }
    this.db.upsertScore(workId, score);
    if (this.shouldAutoEnqueue(score.grade)) {
      this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
    } else if (!VALID_ANALYSIS_GRADES.has(String(score.grade).toUpperCase())) {
      this.db.cancelPendingAnalysis(workId, '当前等级不允许派发');
    }
    return { work_id:workId, work:work.work_id, score };
  }

  async runScanWorker() {
    if (this.scanRunning) return { status:'busy' };
    this.scanRunning = true;
    const job = this.db.takeNextScanJob();
    if (!job) { this.scanRunning = false; return { status:'idle' }; }
    try {
      const result = this.processScanJob(job);
      this.db.finishScanJob(job.id, 'completed');
      return result;
    } catch (error) {
      this.db.finishScanJob(job.id, 'failed', error.message);
      throw error;
    } finally { this.scanRunning = false; }
  }

  async runAnalysisWorker({ manual = false, workId = null } = {}) {
    if (this.analysisRunning) return { status:'busy', processed:0 };
    if (!manual && !this.analysisAuto.enabled) return { status:'disabled', processed:0 };
    const budget = this.getAnalysisBudget();
    if (budget.remaining_today <= 0) return { status:'daily_limit', processed:0, budget };
    this.db.cancelIneligibleQueuedAnalysis('当前正式评分等级不允许派发');
    const rows = manual && workId != null
      ? this.db.nextDispatchBatch(1, workId)
      : this.db.nextDispatchBatch(Math.min(20, budget.remaining_today));
    if (!rows.length) return { status:'idle', processed:0, budget };
    if (typeof this.dispatchBoomSignalCallback !== 'function') {
      return { status:'external_dispatch_disabled', processed:0, queued:rows.length, budget };
    }
    this.analysisRunning = true;
    let processed = 0;
    try {
      for (const item of rows) {
        if (!this.db.beginDispatch(item.id)) continue;
        try {
          const snapshot = parseJson(item.score_snapshot_json, {});
          snapshot.depth = item.analysis_depth === 'full' ? 'full' : 'fast';
          const result = await this.dispatchBoomSignalCallback(snapshot);
          const taskId = String(result?.mission?.taskId ?? result?.taskId ?? '');
          if (!taskId) throw new Error('A君未返回可追踪的军团总任务。');
          this.db.finishDispatch(item.id, 'dispatched', { taskId, result });
          processed += 1;
        } catch (error) {
          const waitingSource = String(error.message).includes('缺少可供小D读取');
          this.db.finishDispatch(item.id, waitingSource ? 'waiting_source' : 'dispatch_failed', { error:String(error.message) });
        }
      }
      return { status:'ok', processed, budget:this.getAnalysisBudget() };
    } finally { this.analysisRunning = false; }
  }

  async tickScan() { try { return await this.runScanWorker(); } catch { return { status:'failed' }; } }
  async tickAnalysis() { try { return await this.runAnalysisWorker({ manual:false }); } catch { return { status:'failed' }; } }

  dashboard() { return this.db.dashboardSummary(); }
  listWorks(filters = {}) { return { works:this.db.listWorksWithScores(filters) }; }
  listVersionedScores(version = 'v2', limit = 100) {
    return { version, controls_dispatch:version === 'v2', items:this.db.listShadowScores(version, limit) };
  }
  getWork(workId) {
    const work = this.db.getWorkDetail(workId);
    if (!work) return null;
    return {
      work,
      score_details:this.db.getShadowScore(workId, 'v2') ?? this.db.getShadowScore(workId, 'shadow-v2'),
      legacy_score:this.db.getShadowScore(workId, 'legacy-v1'),
    };
  }
  listScanJobs(limit = 20) { return { jobs:this.db.listScanJobs(limit) }; }
  listAnalysis(limit = 200) { return { items:this.db.listAnalysisQueue(limit) }; }
  enqueueWorkAnalysis(workId) {
    const work = this.db.getWorkDetail(workId);
    if (!work) return null;
    if (!['T1', 'T2', 'T3'].includes(String(work.grade))) {
      throw new Error('作品必须达到 T1、T2 或 T3 才能派发。');
    }
    const score = {
      score_version:work.score_version, grade:work.grade ?? 'N0', tier:work.tier,
      r_value:work.r_value, m_value:work.m_value, baseline_metric:work.baseline_metric,
      sample_count:work.baseline_sample_count, follower_snapshot:work.follower_snapshot,
      baseline_at:work.score_baseline_at,
    };
    this.db.upsertAnalysisQueue(workId, score.grade, buildBoomSignal(work, score), score.grade === 'T3' ? 'full' : 'fast');
    return { status:'ok', work_id:workId, grade:score.grade };
  }
}

export class BoomIntegrationUnavailableError extends Error {}

export function buildBoomSignal(work, score) {
  const sourceUrl = String(work?.source_url ?? '').trim();
  return {
    schemaVersion:'boom-signal/v1', workRef:`${work?.platform}:${work?.work_id}`,
    workId:String(work?.work_id ?? ''), title:String(work?.title ?? ''), platform:String(work?.platform ?? ''),
    creatorRef:String(work?.creator_external_id ?? ''), creatorName:String(work?.creator_name ?? ''), sourceUrl,
    observedAt:new Date().toISOString(), evidenceKind:'platform_observed',
    sourceRef:sourceUrl || `boom-monitor:work:${work?.id}`,
    scoreVersion:String(score?.version ?? score?.score_version ?? 'legacy-v1'), grade:String(score?.grade ?? 'N0'),
    tier:String(score?.tier ?? 'low'), rValue:Number(score?.r_value ?? 0), mValue:Number(score?.m_value ?? 0),
    absoluteInteractions:score?.absolute_interactions ?? null, signals:score?.signals ?? {},
    observedMetrics:{
      likes:integer(work?.likes), favorites:integer(work?.favorites),
      plays:work?.plays == null ? null : integer(work.plays),
      followers:integer(score?.follower_snapshot || work?.follower_count),
    },
    baseline:{
      metricMedian:score?.baseline_metric ?? null, sampleCount:integer(score?.sample_count),
      followerSnapshot:integer(score?.follower_snapshot), frozenAt:score?.baseline_at ?? null, historyWindow:20,
    },
    formulas:{
      R:'platform_core_metric / frozen_history_median', M:'likes / frozen_follower_snapshot',
      grade:'v2: R + reach(M or absolute interactions) + favorite/share/comment quality',
    },
    baselineVersion:score?.baseline_version ?? null,
  };
}

export function normalizeRecords(raw, defaultPlatform = 'douyin', defaultCreator = '', defaultCreatorName = '', defaultFollowers = 0) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flatMap((item) => normalizeRecords(item, defaultPlatform, defaultCreator, defaultCreatorName, defaultFollowers));
  if (typeof raw !== 'object') return [];
  if (raw.work && typeof raw.work === 'object') {
    return normalizeRecords({
      platform:raw.platform ?? defaultPlatform, creator_id:raw.creator_id ?? defaultCreator,
      creator_name:raw.creator_name ?? defaultCreatorName, follower_count:raw.follower_count ?? defaultFollowers,
      ...raw.work,
    }, defaultPlatform, defaultCreator, defaultCreatorName, defaultFollowers);
  }
  if (Array.isArray(raw.works)) {
    const context = {
      platform:String(raw.platform ?? defaultPlatform), creator_id:String(raw.creator_id ?? defaultCreator).trim(),
      creator_name:String(raw.creator_name ?? defaultCreatorName).trim(), follower_count:integer(raw.follower_count ?? defaultFollowers),
    };
    return raw.works.filter((item) => item && typeof item === 'object').map((item) => ({ ...context, ...item }));
  }
  const record = {
    platform:String(raw.platform ?? defaultPlatform), creator_id:String(raw.creator_id ?? defaultCreator),
    creator_name:String(raw.creator_name ?? defaultCreatorName), follower_count:integer(raw.follower_count ?? defaultFollowers),
    ...raw,
  };
  return Object.hasOwn(record, 'work_id') ? [record] : [];
}

function normalizeAutoConfig(value) {
  const { valid, invalid } = normalizeGradeItems(value?.grades ?? ['T2', 'T3']);
  return {
    enabled:value?.enabled === true && invalid.length === 0 && valid.length > 0,
    grades:valid.length ? valid : ['T2', 'T3'],
  };
}
function parseGrades(value, { strict = true } = {}) {
  const { valid, invalid } = normalizeGradeItems(value);
  if (strict && invalid.length) throw new Error('analysis_auto_grades 只允许 T1、T2、T3');
  return valid;
}
function normalizeGradeItems(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const normalized = [...new Set(items.map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
  return {
    valid:normalized.filter((grade) => VALID_ANALYSIS_GRADES.has(grade)).sort(),
    invalid:normalized.filter((grade) => !VALID_ANALYSIS_GRADES.has(grade)),
  };
}
function normalizeDailyLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) throw new Error('analysis_daily_limit 必须是 0 到 1000 的整数');
  return parsed;
}
function parseCsv(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = csvLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, csvLine(line)[index] ?? ''])));
}
function csvLine(line) {
  const values = []; let value = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { values.push(value); value = ''; }
    else value += character;
  }
  values.push(value); return values;
}
function chinaParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  });
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}
function chinaDayStartIso(date) {
  const parts = chinaParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000).toISOString();
}
function chinaDayKey(date) {
  const parts = chinaParts(date);
  return [parts.year, parts.month, parts.day].map((value, index) => (
    index === 0 ? String(value) : String(value).padStart(2, '0')
  )).join('-');
}
function backupTimestamp(date) {
  return date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function integer(value) { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(integer(value), maximum)); }
