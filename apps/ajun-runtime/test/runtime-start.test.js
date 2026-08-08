import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntime } from '../src/runtime-composition-root.js';
import { startRuntime, startRuntimeBackgroundServices } from '../src/runtime-start.js';

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
    },
    logger:{ log:(message) => logs.push(message), warn:() => undefined },
  });
  context.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  });

  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const overview = await fetch(`${baseUrl}/api/overview`);
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.ok(Array.isArray(payload.tasks));
  assert.equal(runtime.services.hermesNativeCompletionWatcher.detailBaseUrl, '');

  const disclosureState = await fetch(`${baseUrl}/disclosure-state.js`);
  assert.equal(disclosureState.status, 200);
  assert.match(disclosureState.headers.get('content-type'), /^text\/javascript/);
  assert.match(await disclosureState.text(), /replaceChildrenPreservingDisclosureState/);

  const consoleNavigation = await fetch(`${baseUrl}/console-navigation.js`);
  assert.equal(consoleNavigation.status, 200);
  assert.match(consoleNavigation.headers.get('content-type'), /^text\/javascript/);
  assert.match(await consoleNavigation.text(), /createConsoleNavigation/);

  const missing = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error:'未找到该入口。' });

  assert.equal(runtime.source.projectRoot, await fs.realpath(fileURLToPath(new URL('../../..', import.meta.url))));
  assert.equal(runtime.source.mode, 'legacy_runtime_git_root');
  assert.equal(logs.length, 1);
});

test('后台服务沿用原启动顺序，cloud 模式不启动本机小D', () => {
  const calls = [];
  const service = (name) => ({ start:(input) => calls.push([name, input]) });
  startRuntimeBackgroundServices({
    deploymentMode:'cloud',
    feishuChannelStartup:{ startLegacyAJun:true, skipAgentIds:['ajun'] },
    logger:{ warn:() => undefined },
    services:{
      interruptedLocalExecutionReconciler:service('interrupted-local-execution'),
      paperclipRosterReconciler:service('roster'),
      approvalExpiryReconciler:service('approval-expiry'),
      xiaodReconciler:service('xiaod'),
      paperclipRepairReconciler:service('repair'),
      paperclipHermesTaskReconciler:service('hermes-task'),
      missionReconciler:service('mission'),
      hermesNativeCompletionWatcher:service('completion-watch'),
      technicalRepairWatchdog:service('repair-watchdog'),
      officialFeishuChannelRunner:service('legacy-feishu'),
      agentFeishuChannelFleet:service('employee-feishu'),
    },
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'interrupted-local-execution',
    'roster',
    'approval-expiry',
    'repair',
    'hermes-task',
    'mission',
    'completion-watch',
    'repair-watchdog',
    'legacy-feishu',
    'employee-feishu',
  ]);
  assert.deepEqual(calls.at(-1)[1], { skipAgentIds:['ajun'] });
});
