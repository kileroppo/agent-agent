import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskRunEventStore } from '../src/task-run-event-store.js';
import { TaskRunEventRetention } from '../src/task-run-event-retention.js';

test('运行事件只追加白名单字段并脱敏摘要，不保存正文和 secret', async () => {
  await withStore(async ({ store, filePath }) => {
    const event = store.appendTaskRunEvent({
      eventId:'event-1', taskId:'task-1', traceId:'trace-1', eventType:'capability_call_failed',
      capabilityId:'vision.analyze', status:'failed', startedAt:'2026-05-01T00:00:00Z',
      artifactRefs:['artifact:one', 'artifact:one'], errorCode:'provider_unavailable',
      safeSummary:'Authorization: Bearer top-secret token=abc url=https://x.test/?api_key=123',
      prompt:'这里是绝不能落库的完整提示词', requestBody:{ password:'also-secret' },
    });
    assert.equal(event.safeSummary.includes('top-secret'), false);
    assert.equal(event.safeSummary.includes('abc'), false);
    assert.deepEqual(event.artifactRefs, ['artifact:one']);
    assert.equal('prompt' in event, false);

    const raw = new DatabaseSync(filePath, { readOnly:true });
    const columns = raw.prepare('PRAGMA table_info(task_run_events)').all().map((column) => column.name);
    assert.equal(columns.includes('prompt'), false);
    const row = raw.prepare('SELECT * FROM task_run_events WHERE event_id = ?').get('event-1');
    assert.equal(JSON.stringify(row).includes('完整提示词'), false);
    assert.equal(JSON.stringify(row).includes('also-secret'), false);
    raw.close();
    assert.throws(() => store.appendTaskRunEvent({ ...event }), (error) => error.code === 'task_run_event_exists');
  });
});

test('运行事件按时间正序游标分页，并支持快捷和结构化过滤', async () => {
  await withStore(async ({ store }) => {
    const fixtures = [
      ['e1', 'capability_call_started', 'running', null, null, 'vision.analyze'],
      ['e2', 'capability_call_failed', 'failed', 'timeout', null, 'vision.analyze'],
      ['e3', 'route_fallback_started', 'running', null, null, 'vision.analyze'],
      ['e4', 'quality_check_completed', 'succeeded', null, 0.2, 'vision.analyze'],
      ['e5', 'workflow_completed', 'succeeded', null, null, null],
    ];
    fixtures.forEach(([eventId, eventType, status, errorCode, costAmount, capabilityId], index) => store.appendTaskRunEvent({
      eventId, taskId:'task-page', eventType, status, errorCode, costAmount, capabilityId,
      startedAt:`2026-05-01T00:00:0${index}.000Z`,
    }));
    const first = store.queryTaskRunEvents({ taskId:'task-page', limit:2 });
    assert.deepEqual(first.items.map((event) => event.eventId), ['e1', 'e2']);
    assert.ok(first.nextCursor);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-page', cursor:first.nextCursor, limit:2 }).items.map((event) => event.eventId), ['e3', 'e4']);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-page', filters:['failure'] }).items.map((event) => event.eventId), ['e2']);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-page', filters:['fallback'] }).items.map((event) => event.eventId), ['e3']);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-page', filters:{ flags:['failure', 'cost'], capabilityIds:['vision.analyze'] } }).items.map((event) => event.eventId), ['e2', 'e4']);
  });
});

test('90天清理先为故障任务固化永久脱敏事故摘要，永久事件不删除', async () => {
  await withStore(async ({ store }) => {
    store.appendTaskRunEvent({ eventId:'old-start', taskId:'task-old', traceId:'trace-old', eventType:'capability_call_started', status:'running', routeId:'vision-local', provider:'local', startedAt:'2026-01-01T00:00:00Z' });
    store.appendTaskRunEvent({ eventId:'old-fail', taskId:'task-old', traceId:'trace-old', eventType:'capability_call_failed', status:'failed', capabilityId:'vision.analyze', routeId:'vision-local', provider:'local', errorCode:'startup_failure', safeSummary:'password=hidden', startedAt:'2026-01-01T00:01:00Z' });
    store.appendTaskRunEvent({ eventId:'permanent', taskId:'task-old', eventType:'workflow_blocked', status:'blocked', retentionClass:'permanent', startedAt:'2026-01-01T00:02:00Z' });
    store.appendTaskRunEvent({ eventId:'recent', taskId:'task-recent', eventType:'workflow_completed', status:'succeeded', startedAt:'2026-04-30T00:00:00Z' });

    const retention = new TaskRunEventRetention({ eventStore:store, retentionDays:90, clock:() => '2026-05-02T00:00:00Z' });
    const result = retention.runOnce();
    assert.equal(result.deletedEvents, 2);
    assert.equal(result.incidentSummariesCreated, 1);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-old' }).items.map((event) => event.eventId), ['permanent']);
    assert.deepEqual(store.queryTaskRunEvents({ taskId:'task-recent' }).items.map((event) => event.eventId), ['recent']);
    const [summary] = store.queryIncidentSummaries({ taskId:'task-old' });
    assert.equal(summary.taskId, 'task-old');
    assert.deepEqual(summary.errorCodes, ['startup_failure']);
    assert.equal(JSON.stringify(summary).includes('hidden'), false);
    assert.equal(summary.routePath[0].routeId, 'vision-local');
  });
});

test('跨保留周期合并永久事故摘要且不丢历史错误、路线和计数', async () => {
  await withStore(async ({ store }) => {
    store.appendTaskRunEvent({ eventId:'old-start', taskId:'task-history', eventType:'capability_call_started', status:'running', routeId:'route-a', startedAt:'2026-01-01T00:00:00Z' });
    store.appendTaskRunEvent({ eventId:'old-fail', taskId:'task-history', eventType:'capability_call_failed', status:'failed', capabilityId:'vision.analyze', routeId:'route-a', errorCode:'startup_failure', startedAt:'2026-01-01T00:01:00Z' });
    store.appendTaskRunEvent({ eventId:'later-fail', taskId:'task-history', eventType:'capability_call_failed', status:'failed', capabilityId:'audio.transcribe', routeId:'route-b', errorCode:'provider_unavailable', startedAt:'2026-02-15T00:00:00Z' });

    store.cleanupExpiredDetails({ now:'2026-04-02T00:00:00Z', retentionDays:90 });
    const first = store.queryIncidentSummaries({ taskId:'task-history' })[0];
    assert.deepEqual(first.errorCodes, ['startup_failure']);
    assert.equal(first.eventCount, 2);

    store.cleanupExpiredDetails({ now:'2026-06-01T00:00:00Z', retentionDays:90 });
    const merged = store.queryIncidentSummaries({ taskId:'task-history' })[0];
    assert.deepEqual(merged.errorCodes, ['startup_failure', 'provider_unavailable']);
    assert.deepEqual(merged.capabilityIds, ['vision.analyze', 'audio.transcribe']);
    assert.deepEqual([...new Set(merged.routePath.map((item) => item.routeId))], ['route-a', 'route-b']);
    assert.equal(merged.eventCount, 3);
    assert.equal(merged.incidentEventCount, 2);
  });
});

test('Store 可复用外部 SQLite 连接且 close 不接管其生命周期', () => {
  const database = new DatabaseSync(':memory:');
  const store = new TaskRunEventStore(database);
  store.appendTaskRunEvent({ taskId:'task-shared', eventType:'task_received' });
  store.close();
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_run_events').get().count, 1);
  database.close();
});

async function withStore(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-task-run-events-'));
  const filePath = path.join(directory, 'runtime.sqlite');
  const store = new TaskRunEventStore(filePath);
  try { await operation({ store, filePath, directory }); }
  finally { store.close(); await fs.rm(directory, { recursive:true, force:true }); }
}
