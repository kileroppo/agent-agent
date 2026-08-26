import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntime } from '../src/runtime-composition-root.ts';
import { startRuntime, startRuntimeBackgroundServices } from '../src/runtime-start.ts';
import { dynamicTaskCardRolloutEnabled } from '../src/runtime/feishu-command-composition.ts';
import { startConsoleRuntimeFixture } from './fixtures/console-runtime-fixture.js';

test('startRuntime 负责监听，并可在隔离冒烟中关闭后台副作用', async (context) => {
  const calls = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type':'application/json' });
    response.end('{"ready":true}');
  });
  const runtime = await startRuntime({
    createRuntime:async () => ({
      server,
      host:'127.0.0.1',
      port:0,
      lanEnabled:false,
      deploymentMode:'local',
      feishuChannelStartup:{ startLegacyAJun:true, skipAgentIds:[] },
      logger:{ log:(message) => calls.push(['log', message]), warn:() => undefined },
      services:{
        paperclipRosterReconciler:{ start:() => calls.push(['roster']) },
      },
    }),
    startBackgroundServices:false,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(runtime.host, '127.0.0.1');
  assert.ok(runtime.port > 0);
  assert.deepEqual(calls.map(([kind]) => kind), ['log']);
  const response = await fetch(`http://127.0.0.1:${runtime.port}`);
  assert.deepEqual(await response.json(), { ready:true });
});

test('动态任务卡启用时仍保留未建立卡片锚点的 HTTP/MCP 完成跟进', () => {
  const calls = [];
  startRuntimeBackgroundServices({
    deploymentMode:'local',
    feishuChannelStartup:{ dynamicTaskCardEnabled:true, startLegacyAJun:false, skipAgentIds:[] },
    logger:{ warn:() => undefined },
    services:{
      hermesNativeCompletionWatcher:{ start:() => calls.push('legacy-completion-watch') },
      agentFeishuChannelFleet:{ start:() => calls.push('fleet') },
    },
  });
  assert.deepEqual(calls, ['legacy-completion-watch', 'fleet']);
});

test('动态任务卡灰度必须同时由 Hermes 原生 A君持有，且默认关闭', () => {
  assert.equal(dynamicTaskCardRolloutEnabled({}), false);
  assert.equal(dynamicTaskCardRolloutEnabled({ AJUN_FEISHU_DYNAMIC_TASK_CARD:'true' }), false);
  assert.equal(dynamicTaskCardRolloutEnabled({
    AJUN_FEISHU_DYNAMIC_TASK_CARD:'true',
    AJUN_HERMES_NATIVE_FEISHU:'true',
  }), true);
});

test('真实 createRuntime 使用临时状态和随机端口提供公开 HTTP Interface', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-http-'));
  const logs = [];
  const runtime = await startRuntime({
    createRuntime,
    startBackgroundServices:false,
    environment:{
      ...process.env,
      PORT:'0',
      AJUN_HOST:'127.0.0.1',
      AGENT_ARMY_SOURCE_PROJECT_ROOT:'',
      AGENT_ARMY_TASK_STORE:'json',
      AGENT_ARMY_DATA_DIR:path.join(temporaryRoot, 'data'),
      AGENT_ARMY_PRIVATE_DIR:path.join(temporaryRoot, 'private'),
      PAPERCLIP_REPAIR_WORKTREE_PARENT:path.join(temporaryRoot, 'worktrees'),
      AGENT_ARMY_CONTENT_WORKSPACE_DIR:path.join(temporaryRoot, 'content'),
      AGENT_ARMY_HERMES_PROFILE_ROOT:path.join(temporaryRoot, 'hermes'),
      AUTO_WORK_ROOT:path.join(temporaryRoot, 'auto-work'),
      XIAOD_ARTIFACT_ROOT:path.join(temporaryRoot, 'xiaod'),
      AJUN_HERMES_NATIVE_FEISHU:'false',
      AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'',
      AJUN_BOOM_MONITOR_ENABLED:'true',
    },
    logger:{ log:(message) => logs.push(message), warn:() => undefined },
  });
  context.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  });

  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthText = await health.text();
  const healthPayload = JSON.parse(healthText);
  assert.equal(healthPayload.status, 'healthy');
  assert.ok(Buffer.byteLength(healthText) < 10 * 1024);
  assert.deepEqual(
    healthPayload.optional.components.find((item) => item.id === 'boom-monitor'),
    { id:'boom-monitor', name:'爆款雷达', status:'limited', detail:'历史和手动工具可用，自动监控已关闭。' },
  );
  const overview = await fetch(`${baseUrl}/api/overview`);
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.ok(Array.isArray(payload.tasks));
  assert.equal(runtime.services.hermesNativeCompletionWatcher.detailBaseUrl, '');
  assert.equal(runtime.services.boomMonitor, null);
  assert.deepEqual([...runtime.services.reconciliationCoordinator.jobs.keys()], [
    'paperclip-roster',
    'approval-expiry',
    'xiaod',
    'paperclip-repair',
    'paperclip-hermes-task',
    'cross-agent-mission',
    'technical-repair-watchdog',
    'task-liveness-watchdog',
    'artifact-storage-gc',
    'delivery-unknown',
    'health-mesh',
    'anomaly-alerting',
    'feedback-eval-dataset',
    'sqlite-wal-governor',
    'credential-decay-warner',
    'approval-escalation',
  ]);
  assert.equal(Object.hasOwn(runtime.services, 'xiaodReconciler'), false);
  assert.equal(Object.hasOwn(runtime.services, 'missionReconciler'), false);
  await assert.rejects(fs.access(path.join(temporaryRoot, 'data', 'm5-budget-ticket-ed25519.pem')), { code:'ENOENT' });
  await assert.rejects(fs.access(path.join(temporaryRoot, 'private', 'product-maturity-child-policy.key')), { code:'ENOENT' });

  const consoleOverview = await fetch(`${baseUrl}/api/console-overview`);
  assert.equal(consoleOverview.status, 200);
  const consoleText = await consoleOverview.text();
  const consolePayload = JSON.parse(consoleText);
  assert.equal(Object.hasOwn(consolePayload, 'tasks'), false);
  assert.ok(Array.isArray(consolePayload.recentTasks));
  assert.ok(Buffer.byteLength(consoleText) < 50 * 1024);

  const taskRecords = await fetch(`${baseUrl}/api/task-records?view=needs_action&limit=24`);
  assert.equal(taskRecords.status, 200);
  assert.deepEqual(await taskRecords.json(), {
    items:[],
    total:0,
    counts:{ needs_action:0, active:0, completed:0, all:0 },
    nextCursor:null,
    revision:'::0',
    routineSummary:{ hidden:0, today:0, attention:0, latestUpdatedAt:null },
    query:{
      view:'needs_action', q:'', agentId:'', taskType:'', backlogCategory:'', since:'', until:'', includeRoutine:false, limit:24, cursor:null,
    },
  });

  const disclosureState = await fetch(`${baseUrl}/disclosure-state.js`);
  assert.equal(disclosureState.status, 200);
  assert.match(disclosureState.headers.get('content-type'), /^text\/javascript/);
  assert.match(await disclosureState.text(), /replaceChildrenPreservingDisclosureState/);

  const consoleNavigation = await fetch(`${baseUrl}/console-navigation.js`);
  assert.equal(consoleNavigation.status, 200);
  assert.match(consoleNavigation.headers.get('content-type'), /^text\/javascript/);
  assert.match(await consoleNavigation.text(), /createConsoleNavigation/);

  const accessViews = await fetch(`${baseUrl}/app-access-views.js`);
  assert.equal(accessViews.status, 200);
  assert.match(accessViews.headers.get('content-type'), /^text\/javascript/);
  assert.match(await accessViews.text(), /export function createAccessViews/);

  const interactions = await fetch(`${baseUrl}/app-interactions.js`);
  assert.equal(interactions.status, 200);
  assert.match(interactions.headers.get('content-type'), /^text\/javascript/);
  assert.match(await interactions.text(), /export function bindConsoleInteractions/);

  const refreshScheduler = await fetch(`${baseUrl}/refresh-scheduler.js`);
  assert.equal(refreshScheduler.status, 200);
  assert.match(refreshScheduler.headers.get('content-type'), /^text\/javascript/);
  assert.match(await refreshScheduler.text(), /export function startRefreshScheduler/);

  const taskRecordDetailView = await fetch(`${baseUrl}/task-record-detail-view.js`);
  assert.equal(taskRecordDetailView.status, 200);
  assert.match(taskRecordDetailView.headers.get('content-type'), /^text\/javascript/);
  assert.match(await taskRecordDetailView.text(), /export function renderAttentionDetail/);

  const taskRecordFilter = await fetch(`${baseUrl}/task-record-filter.js`);
  assert.equal(taskRecordFilter.status, 200);
  assert.match(taskRecordFilter.headers.get('content-type'), /^text\/javascript/);
  assert.match(await taskRecordFilter.text(), /selectTaskRecordFilter/);

  const taskRecordWorkbench = await fetch(`${baseUrl}/task-record-workbench.js`);
  assert.equal(taskRecordWorkbench.status, 200);
  assert.match(taskRecordWorkbench.headers.get('content-type'), /^text\/javascript/);
  assert.match(await taskRecordWorkbench.text(), /createTaskRecordWorkbench/);

  const billingEntryFilter = await fetch(`${baseUrl}/billing-entry-filter.js`);
  assert.equal(billingEntryFilter.status, 200);
  assert.match(billingEntryFilter.headers.get('content-type'), /^text\/javascript/);
  assert.match(await billingEntryFilter.text(), /filterBillingEntries/);

  const billingLedgerWorkbench = await fetch(`${baseUrl}/billing-ledger-workbench.js`);
  assert.equal(billingLedgerWorkbench.status, 200);
  assert.match(billingLedgerWorkbench.headers.get('content-type'), /^text\/javascript/);
  assert.match(await billingLedgerWorkbench.text(), /createBillingLedgerWorkbench/);

  const consoleWithRecordState = await fetch(`${baseUrl}/?recordView=all&recordTime=all`);
  assert.equal(consoleWithRecordState.status, 200);
  assert.match(consoleWithRecordState.headers.get('content-type'), /^text\/html/);
  assert.match(await consoleWithRecordState.text(), /id="record-workbench"/);

  const versionedRecordWorkbench = await fetch(`${baseUrl}/task-record-workbench.js?v=acceptance`);
  assert.equal(versionedRecordWorkbench.status, 200);
  assert.match(versionedRecordWorkbench.headers.get('content-type'), /^text\/javascript/);

  const boomConsole = await fetch(`${baseUrl}/boom-monitor-console.js`);
  assert.equal(boomConsole.status, 200);
  assert.match(boomConsole.headers.get('content-type'), /^text\/javascript/);
  assert.match(await boomConsole.text(), /createBoomMonitorConsole/);

  const boomHealth = await fetch(`${baseUrl}/api/boom-monitor/health`);
  assert.equal(boomHealth.status, 200);
  const boomHealthPayload = await boomHealth.json();
  assert.equal(boomHealthPayload.runtime, 'ajun-native');
  assert.equal(boomHealthPayload.status, 'idle');
  assert.equal(boomHealthPayload.automation.enabled, false);

  const boomSettings = await fetch(`${baseUrl}/api/boom-monitor/settings`);
  assert.equal(boomSettings.status, 200);
  assert.equal((await boomSettings.json()).analysis_auto.enabled, false);

  const missing = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error:'未找到该入口。' });

  assert.equal(runtime.source.projectRoot, await fs.realpath(fileURLToPath(new URL('../../..', import.meta.url))));
  assert.equal(runtime.source.mode, 'legacy_runtime_git_root');
  assert.equal(logs.length, 1);
});

test('隔离 HTTP 夹具完整提供失败、待补充、待验证、待审批和成功记录', async (context) => {
  const fixture = await startConsoleRuntimeFixture();
  context.after(() => fixture.close());
  const { baseUrl } = fixture;
  const pageResponse = await fetch(`${baseUrl}/api/task-records?view=all&limit=24`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.items.map((task) => task.status).sort(),
    ['failed', 'needs_input', 'succeeded', 'waiting_approval', 'waiting_test'],
  );

  for (const summary of page.items) {
    const detailResponse = await fetch(`${baseUrl}/api/tasks/${summary.taskId}`);
    assert.equal(detailResponse.status, 200);
    const { task } = await detailResponse.json();
    assert.equal(task.status, summary.status);
    assert.equal(task.recordSummary, undefined);
  }

  const failedSummary = page.items.find((task) => task.status === 'failed');
  const failed = await (await fetch(`${baseUrl}/api/tasks/${failedSummary.taskId}`)).json();
  const roleReport = failed.task.artifactRefs.find((artifact) => artifact.type === 'employee_role_report');
  assert.equal(Object.hasOwn(roleReport, 'data'), false);
  assert.match(failed.task.presentation.attention.cause, /Chrome 会话/);
  assert.match(failed.task.presentation.attention.remainingRisks, /真实读取能力/);

  const approvalSummary = page.items.find((task) => task.status === 'waiting_approval');
  const approval = await (await fetch(`${baseUrl}/api/tasks/${approvalSummary.taskId}`)).json();
  assert.equal(approval.task.pendingApproval.reason, '需要确认只读检查仅覆盖指定公开页面。');
  assert.deepEqual(approval.task.pendingApproval.requestedScope, { mode:'read_only', targets:['公开页面'] });

  const overviewResponse = await fetch(`${baseUrl}/api/console-overview`);
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(Object.hasOwn(overview, 'tasks'), false);
  assert.equal(overview.taskFocus.ownerActionable, 4);
  assert.equal(overview.taskFocus.next.status, 'waiting_approval');

  const succeededSummary = page.items.find((task) => task.status === 'succeeded');
  const feedbackResponse = await fetch(`${baseUrl}/api/mcp/tasks/${succeededSummary.taskId}/feedback`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ sentiment:'useful', note:'验收通过。', chatRef:'fixture-chat' }),
  });
  assert.equal(feedbackResponse.status, 200);
  const feedbackPayload = await feedbackResponse.json();
  assert.equal(feedbackPayload.task.feedback.sentiment, 'useful');
  assert.equal(feedbackPayload.task.evaluation.humanAcceptance.status, 'accepted');

  const crossChatFeedback = await fetch(`${baseUrl}/api/mcp/tasks/${succeededSummary.taskId}/feedback`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ sentiment:'useful', chatRef:'other-chat' }),
  });
  assert.equal(crossChatFeedback.status, 403);
});

test('后台服务只启动统一协调器，不再重复启动旧轮询器', () => {
  const calls = [];
  const service = (name) => ({ start:(input) => calls.push([name, input]) });
  startRuntimeBackgroundServices({
    deploymentMode:'cloud',
    feishuChannelStartup:{ startLegacyAJun:true, skipAgentIds:['ajun'] },
    logger:{ warn:() => undefined },
    services:{
      interruptedLocalExecutionReconciler:service('interrupted-local-execution'),
      deliveryQualityReconciler:service('delivery-quality'),
      paperclipRosterReconciler:service('roster'),
      reconciliationCoordinator:service('reconciliation-coordinator'),
      approvalExpiryReconciler:service('approval-expiry'),
      xiaodReconciler:service('xiaod'),
      paperclipRepairReconciler:service('repair'),
      paperclipHermesTaskReconciler:service('hermes-task'),
      missionReconciler:service('mission'),
      boomMonitor:service('boom-monitor'),
      hermesNativeCompletionWatcher:service('completion-watch'),
      technicalRepairWatchdog:service('repair-watchdog'),
      officialFeishuChannelRunner:service('legacy-feishu'),
      agentFeishuChannelFleet:service('employee-feishu'),
    },
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'interrupted-local-execution',
    'delivery-quality',
    'reconciliation-coordinator',
    'boom-monitor',
    'completion-watch',
    'legacy-feishu',
    'employee-feishu',
  ]);
  assert.deepEqual(calls.at(-1)[1], { skipAgentIds:['ajun'] });
});

test('禁用原生爆款雷达时不打开或创建目标 SQLite', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-boom-fence-'));
  t.after(() => fs.rm(temporaryRoot, { recursive:true, force:true }));
  const dataDir = path.join(temporaryRoot, 'data');
  const runtime = await startRuntime({
    createRuntime,
    startBackgroundServices:false,
    environment:{
      ...process.env,
      PORT:'0',
      AJUN_HOST:'127.0.0.1',
      AGENT_ARMY_SOURCE_PROJECT_ROOT:'',
      AGENT_ARMY_TASK_STORE:'json',
      AGENT_ARMY_DATA_DIR:dataDir,
      AGENT_ARMY_PRIVATE_DIR:path.join(temporaryRoot, 'private'),
      PAPERCLIP_REPAIR_WORKTREE_PARENT:path.join(temporaryRoot, 'worktrees'),
      AGENT_ARMY_CONTENT_WORKSPACE_DIR:path.join(temporaryRoot, 'content'),
      AGENT_ARMY_HERMES_PROFILE_ROOT:path.join(temporaryRoot, 'hermes'),
      AUTO_WORK_ROOT:path.join(temporaryRoot, 'auto-work'),
      XIAOD_ARTIFACT_ROOT:path.join(temporaryRoot, 'xiaod'),
      AJUN_HERMES_NATIVE_FEISHU:'false',
      AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'',
      AJUN_BOOM_MONITOR_ENABLED:'false',
    },
    logger:{ log:() => undefined, warn:() => undefined },
  });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  assert.equal(runtime.services.boomMonitor, null);
  const health = await fetch(`http://127.0.0.1:${runtime.port}/api/boom-monitor/health`);
  assert.equal(health.status, 503);
  await assert.rejects(fs.access(path.join(dataDir, 'boom-monitor.sqlite')), { code:'ENOENT' });
  await assert.rejects(fs.access(path.join(dataDir, 'boom-monitor', 'backups')), { code:'ENOENT' });
});
