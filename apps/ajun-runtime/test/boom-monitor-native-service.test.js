import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createBoomMonitorService, routeBoomMonitorApi } from '../src/boom-monitor/index.ts';

function collectedBundle() {
  return {
    schemaVersion:'agent.army/boom-metrics-bundle/v1', status:'collected', platform:'xiaohongshu',
    sourceUrl:'https://example.com/target', observedAt:'2026-08-06T12:00:00Z',
    creator:{ id:'creator-1', name:'作者', followerCount:2_147 },
    currentWork:{ id:'target', title:'当前作品', sourceUrl:'https://example.com/target', likes:93, favorites:34, shares:24, comments:7, plays:null },
    historyWorks:Array.from({ length:12 }, (_, index) => ({ id:`history-${index}`, likes:8, favorites:2, shares:0, comments:0 })),
    historyOrder:'creator_feed_desc', sampleCount:12,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-'));
  const service = createBoomMonitorService({ dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory });
  return { directory, service, async close(){ service.close(); await rm(directory, { recursive:true, force:true }); } };
}

test('native service persists v2 and defaults auto dispatch to disabled', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  const result = fx.service.ingestMetricsBundle(collectedBundle());
  assert.equal(result.score.version, 'v2');
  assert.equal(result.score.grade, 'T1');
  assert.equal(Object.hasOwn(result, 'legacy_score'), false);
  assert.equal(fx.service.getSettings().analysis_auto.enabled, false);
  assert.equal(fx.service.listAnalysis().items.length, 0);
  assert.equal(fx.service.getWork(result.work_id).score_details.grade, 'T1');
  const listed = fx.service.listWorks().works[0];
  assert.equal(listed.baseline_metric, 10);
  assert.deepEqual(
    ['id', 'work_id', 'title', 'platform', 'publish_at', 'grade', 'r_value', 'm_value', 'baseline_metric', 'analysis_status']
      .filter((field) => !Object.hasOwn(listed, field)),
    [],
  );
  assert.equal((await stat(path.join(fx.directory, 'boom.sqlite'))).mode & 0o777, 0o600);
});

test('native service persists a collected platform publish time', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  const value = collectedBundle();
  value.currentWork.publishedAt = '2026-08-14T13:41:00.000Z';
  fx.service.ingestMetricsBundle(value);
  assert.equal(fx.service.listWorks().works[0].publish_at, '2026-08-14T13:41:00.000Z');
});

test('settings and daily limit survive reopen; enabling queues but never dispatches externally', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-settings-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const dbPath = path.join(directory, 'boom.sqlite');
  const first = createBoomMonitorService({ dbPath, dataDir:directory });
  first.updateSettings({ analysis_auto_enabled:true, analysis_auto_grades:'T1,T2', analysis_daily_limit:7 });
  first.close();
  const service = createBoomMonitorService({ dbPath, dataDir:directory });
  t.after(() => service.close());
  assert.deepEqual(service.getSettings().analysis_auto, { enabled:true, grades:['T1', 'T2'], daily_limit:7 });
  assert.equal(service.getSettings().analysis_budget.daily_limit, 7);
  service.ingestMetricsBundle(collectedBundle());
  assert.equal(service.listAnalysis().items[0].status, 'queued');
  assert.deepEqual(await service.runAnalysisWorker(), {
    status:'external_dispatch_disabled', processed:0, queued:1, budget:service.getAnalysisBudget(),
  });
  assert.equal(service.listAnalysis().items[0].status, 'queued');
});

test('自动派发设置拒绝 N0 并清理旧库中的非法等级', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-grade-settings-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const dbPath = path.join(directory, 'boom.sqlite');
  const first = createBoomMonitorService({ dbPath, dataDir:directory });
  const before = first.getSettings();
  assert.throws(
    () => first.updateSettings({ analysis_auto_enabled:true, analysis_auto_grades:'T2,N0' }),
    /只允许 T1、T2、T3/,
  );
  assert.deepEqual(first.getSettings(), before);
  assert.throws(
    () => first.updateSettings({ analysis_auto_enabled:true, analysis_auto_grades:'T1', daily_limit:-1 }),
    /0 到 1000/,
  );
  assert.throws(
    () => first.updateSettings({ analysis_auto_enabled:'false' }),
    /必须是布尔值/,
  );
  assert.deepEqual(first.getSettings(), before);
  first.db.setSetting('analysis_auto', { enabled:true, grades:['N0'] });
  first.close();
  const reopened = createBoomMonitorService({ dbPath, dataDir:directory });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getSettings().analysis_auto, { enabled:false, grades:['T2', 'T3'], daily_limit:5 });
  assert.deepEqual(reopened.db.getSetting('analysis_auto'), { enabled:false, grades:['T2', 'T3'] });
});

test('in-process callbacks collect metrics and dispatch a trackable mission without HTTP or token', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-injected-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const calls = [];
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    collectMetrics:async (input) => { calls.push(['collect', input]); return collectedBundle(); },
    dispatchBoomSignal:async (signal) => { calls.push(['dispatch', signal]); return { mission:{ taskId:'mission-1' } }; },
  });
  t.after(() => service.close());
  service.updateSettings({ analysis_auto_enabled:true, analysis_auto_grades:'T1' });
  const collected = await service.collectUrl({ url:'https://example.com/target', history_limit:99 });
  assert.equal(collected.score.grade, 'T1');
  const result = await service.runAnalysisWorker();
  assert.equal(result.processed, 1);
  assert.equal(calls[0][0], 'collect');
  assert.equal(calls[0][1].historyLimit, 20);
  assert.equal(calls[1][0], 'dispatch');
  assert.equal(calls[1][1].scoreVersion, 'v2');
  assert.equal(service.listAnalysis().items[0].status, 'submitted');
  assert.equal(service.listAnalysis().items[0].army_task_id, 'mission-1');
  assert.equal(service.listWorks().works[0].army_task_id, 'mission-1');
});

test('雷达持续对账军团任务真实阶段并显性暴露规划卡死', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-mission-state-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  let snapshot = { mission:{ taskId:'mission-state', status:'queued', currentStage:'approval_approved', updatedAt:'2026-08-15T00:00:00.000Z', artifactRefs:[] }, children:[] };
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    now:() => new Date('2026-08-15T01:00:00.000Z'), missionStuckAfterMs:30_000,
    dispatchBoomSignal:async () => ({ mission:{ taskId:'mission-state' } }),
    getMissionSnapshot:async () => snapshot,
  });
  t.after(() => service.close());
  const collected = service.ingestMetricsBundle(collectedBundle());
  service.enqueueWorkAnalysis(collected.work_id);
  await service.runAnalysisWorker({ manual:true, workId:collected.work_id });
  await service.refreshAnalysisStatuses();
  assert.equal(service.listAnalysis().items[0].status, 'needs_input');
  assert.equal(service.listAnalysis().items[0].mission_stage, 'approval_approved');
  assert.match(service.listAnalysis().items[0].dispatch_error, /安全恢复/);

  snapshot = { mission:{ taskId:'mission-state', status:'running', currentStage:'mission_planned', updatedAt:'2026-08-15T01:01:00.000Z', artifactRefs:[{ type:'cross_agent_mission_plan' }] }, children:[
    { taskId:'xiaod-child', taskType:'media.transcribe-and-refine', status:'running', currentStage:'xiaod_downloading', updatedAt:'2026-08-15T01:01:01.000Z' },
  ] };
  await service.refreshAnalysisStatuses();
  assert.equal(service.listAnalysis().items[0].status, 'acquiring');
  assert.equal(service.listAnalysis().items[0].mission_stage, 'xiaod_downloading');

  snapshot.children.push({ taskId:'analysis-child', taskType:'content.video-benchmark-analysis', status:'running', currentStage:'content_analysis_running', updatedAt:'2026-08-15T01:02:00.000Z' });
  await service.refreshAnalysisStatuses();
  assert.equal(service.listAnalysis().items[0].status, 'analyzing');

  snapshot = { mission:{ taskId:'mission-state', status:'succeeded', currentStage:'mission_completed', updatedAt:'2026-08-15T01:03:00.000Z', artifactRefs:[{ type:'cross_agent_mission_summary' }] }, children:snapshot.children };
  await service.refreshAnalysisStatuses();
  assert.equal(service.listAnalysis().items[0].status, 'completed');
  assert.equal(service.getSettings().analysis_budget.dispatched_today, 1);
});

test('抖音推荐首页会明确要求作品链接且不会调用指标采集器', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-invalid-douyin-url-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  let collectCalls = 0;
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    collectMetrics:async () => { collectCalls += 1; return collectedBundle(); },
  });
  t.after(() => service.close());

  const response = await routeBoomMonitorApi({
    method:'POST', url:'/api/boom-monitor/collect/url', local:true,
    readBody:async () => ({ url:'https://www.douyin.com/?recommend=1' }),
    getService:async () => service,
  });
  assert.equal(response.status, 422);
  assert.match(response.payload.detail, /必须粘贴具体的抖音作品链接，不能使用推荐首页/);
  assert.equal(collectCalls, 0);
});

test('抖音整段分享文案会提取作品短链后再采集', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-douyin-share-text-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const calls = [];
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    collectMetrics:async (input) => { calls.push(input); return collectedBundle(); },
  });
  t.after(() => service.close());

  await service.collectUrl({
    url:'4.30 Zzg:/ 太卷了！改变视频行业的AI又迭代了什么？ https://v.douyin.com/Ujhi8EjlHAY/ 复制此链接，打开抖音搜索，直接观看视频！',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://v.douyin.com/Ujhi8EjlHAY/');
});

test('explicit manual dispatch works while automatic dispatch stays disabled', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-manual-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    dispatchBoomSignal:async () => ({ mission:{ taskId:'manual-mission' } }),
  });
  t.after(() => service.close());
  const collected = service.ingestMetricsBundle(collectedBundle());
  service.enqueueWorkAnalysis(collected.work_id);
  assert.equal((await service.runAnalysisWorker()).status, 'disabled');
  assert.equal((await service.runAnalysisWorker({ manual:true, workId:collected.work_id })).processed, 1);
  assert.equal(service.listAnalysis().items[0].army_task_id, 'manual-mission');
});

test('single-work manual dispatch cannot fan out and N0 cannot be queued', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-targeted-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const dispatched = [];
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    dispatchBoomSignal:async (signal) => { dispatched.push(signal.workId); return { mission:{ taskId:`mission-${signal.workId}` } }; },
  });
  t.after(() => service.close());
  const first = service.ingestMetricsBundle(collectedBundle());
  const secondBundle = structuredClone(collectedBundle());
  secondBundle.currentWork.id = 'target-2';
  secondBundle.currentWork.sourceUrl = 'https://example.com/target-2';
  secondBundle.sourceUrl = secondBundle.currentWork.sourceUrl;
  const second = service.ingestMetricsBundle(secondBundle);
  service.enqueueWorkAnalysis(first.work_id);
  service.enqueueWorkAnalysis(second.work_id);
  assert.equal((await service.runAnalysisWorker({ manual:true, workId:second.work_id })).processed, 1);
  assert.deepEqual(dispatched, ['target-2']);
  assert.equal(service.listAnalysis().items.filter((item) => item.status === 'queued').length, 1);

  const creator = service.db.upsertCreator('douyin', 'n0-creator', 'N0作者', 1000);
  const [n0WorkId] = service.db.upsertWork(creator, 'douyin', { work_id:'n0', likes:1 });
  assert.throws(() => service.enqueueWorkAnalysis(n0WorkId), /必须达到 T1/);
});

test('陈旧 N0 队列和重新评分降级都不会派发', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-stale-n0-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const dispatched = [];
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    dispatchBoomSignal:async (signal) => { dispatched.push(signal.workId); return { mission:{ taskId:'unexpected' } }; },
  });
  t.after(() => service.close());
  const collected = service.ingestMetricsBundle(collectedBundle());
  service.enqueueWorkAnalysis(collected.work_id);
  service.db.connection.prepare("UPDATE scores SET grade='N0' WHERE work_id=?").run(collected.work_id);
  assert.equal((await service.runAnalysisWorker({ manual:true })).processed, 0);
  assert.equal(service.listAnalysis().items[0].status, 'cancelled');
  assert.deepEqual(dispatched, []);

  const promoted = service.ingestMetricsBundle(collectedBundle());
  service.enqueueWorkAnalysis(promoted.work_id);
  const downgraded = structuredClone(collectedBundle());
  Object.assign(downgraded.currentWork, { likes:0, favorites:0, shares:0, comments:0 });
  const result = service.ingestMetricsBundle(downgraded);
  assert.equal(result.score.grade, 'N0');
  assert.equal(service.listAnalysis().items[0].status, 'cancelled');
  assert.deepEqual(dispatched, []);
});

test('native DB opens the existing schema and only uses earlier works for history', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  const creator = fx.service.db.upsertCreator('douyin', 'creator-1', '作者', 100_000);
  fx.service.db.upsertWork(creator, 'douyin', { work_id:'older', publish_at:'2026-01-01T00:00:00Z', likes:10 });
  const [current] = fx.service.db.upsertWork(creator, 'douyin', { work_id:'current', publish_at:'2026-01-02T00:00:00Z', likes:20 });
  fx.service.db.upsertWork(creator, 'douyin', { work_id:'future', publish_at:'2026-01-03T00:00:00Z', likes:999 });
  assert.deepEqual(fx.service.db.historyMetrics(creator, 'douyin', current), [10]);
});

test('manual import is queued, scanned, persisted, and scored in-process', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  const queued = fx.service.importRecords({
    platform:'douyin', creator:'creator-import', creator_name:'导入作者', follower_count:10_000,
    works:[{ work_id:'work-import', title:'导入作品', publish_at:'2026-01-01T00:00:00Z', likes:100 }],
  });
  assert.equal(queued.count, 1);
  const result = await fx.service.runScanWorker();
  assert.equal(result.status, 'ok');
  assert.equal(result.scored, 1);
  assert.deepEqual(fx.service.dashboard().totals, { creators:1, works:1 });
  assert.equal(fx.service.listWorks().works[0].work_id, 'work-import');
});

test('background lifecycle is idempotent and preserves three daily platform schedules', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-schedule-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const service = createBoomMonitorService({
    dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory,
    now:() => new Date('2026-08-07T12:00:15Z'),
  });
  t.after(() => service.close());
  service.start();
  service.start();
  assert.equal(service.timers.length, 4);
  assert.equal(service.listScanJobs().jobs.length, 1);
  assert.equal(service.listScanJobs().jobs[0].creator_ref, 'douyin');
  service.tickSchedules();
  assert.equal(service.listScanJobs().jobs.length, 1);
  service.tickSchedules(new Date('2026-08-07T12:10:15Z'));
  service.tickSchedules(new Date('2026-08-07T12:20:15Z'));
  assert.deepEqual(service.listScanJobs().jobs.map((job) => job.creator_ref).sort(), ['douyin', 'xiaohongshu', 'youtube']);
  await service.startupBackupPromise;
  service.stop();
  service.stop();
  assert.equal(service.timers.length, 0);
});

test('online backup is consistent, private, daily-idempotent, and retains the newest 14 files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boom-native-backup-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const service = createBoomMonitorService({ dbPath:path.join(directory, 'boom.sqlite'), dataDir:directory });
  t.after(() => service.close());
  const ingested = service.ingestMetricsBundle(collectedBundle());

  const firstAt = new Date('2026-08-07T12:00:00.000Z');
  const first = await service.createBackup({ force:true, at:firstAt });
  assert.equal(first.status, 'created');
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  const snapshot = new DatabaseSync(first.path, { readOnly:true });
  t.after(() => snapshot.close());
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(Number(snapshot.prepare('SELECT COUNT(*) AS count FROM works').get().count), 1);
  assert.equal(snapshot.prepare('SELECT grade FROM scores WHERE work_id=?').get(ingested.work_id).grade, 'T1');

  const sameDay = await service.createBackup({ at:new Date('2026-08-07T13:00:00.000Z') });
  assert.equal(sameDay.status, 'current');
  for (let index = 1; index <= 15; index += 1) {
    await service.createBackup({ force:true, at:new Date(firstAt.getTime() + index * 1_000) });
  }
  const files = (await readdir(path.join(directory, 'backups'))).filter((name) => name.endsWith('.sqlite')).sort();
  assert.equal(files.length, 14);
  assert.equal(files.includes(path.basename(first.path)), false);
  for (const file of files) {
    assert.equal((await stat(path.join(directory, 'backups', file))).mode & 0o777, 0o600);
  }
});

test('route adapter preserves Boom API payloads under the unified prefix', async (t) => {
  const fx = await fixture();
  t.after(() => fx.close());
  const settings = await routeBoomMonitorApi({
    method:'POST', url:'/api/boom-monitor/settings', local:true,
    readBody:async () => ({ analysis_auto_enabled:true, analysis_auto_grades:'T1,T3', daily_limit:9 }),
    getService:async () => fx.service,
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.payload.analysis_budget.daily_limit, 9);
  const dashboard = await routeBoomMonitorApi({
    method:'GET', url:'/api/boom-monitor/dashboard', local:true, getService:async () => fx.service,
  });
  assert.deepEqual(dashboard, { status:200, payload:{ totals:{ creators:0, works:0 }, boom:{ T3:0, T2:0, T1:0 }, scan_jobs:0 } });
  const idleHealth = await routeBoomMonitorApi({
    method:'GET', url:'/api/boom-monitor/health', local:true, getService:async () => fx.service,
  });
  assert.equal(idleHealth.status, 200);
  assert.equal(idleHealth.payload.status, 'idle');
  assert.equal(idleHealth.payload.automation.enabled, false);
  let manualInput;
  const manual = await routeBoomMonitorApi({
    method:'POST', url:'/api/boom-monitor/analysis/run', local:true,
    readBody:async () => ({ manual:true, work_id:42 }),
    getService:async () => ({ runAnalysisWorker:async (input) => { manualInput = input; return { status:'idle', processed:0 }; } }),
  });
  assert.deepEqual(manualInput, { manual:true, workId:42 });
  assert.equal(manual.status, 200);
  let resolvedDisabledService = false;
  const disabled = await routeBoomMonitorApi({
    method:'GET', url:'/api/boom-monitor/health', local:true, enabled:false,
    getService:async () => { resolvedDisabledService = true; return fx.service; },
  });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.payload.code, 'boom_monitor_disabled');
  assert.equal(resolvedDisabledService, false);
  assert.equal(await routeBoomMonitorApi({ method:'GET', url:'/elsewhere', local:true, getService:async () => fx.service }), null);
});
