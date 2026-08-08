import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHotReloadMonitor, startBrowserHotReload } from '../public/hot-reload-client.js';
import { createRuntime } from '../src/runtime-composition-root.js';
import { startRuntime } from '../src/runtime-start.js';

test('开发运行版本变化后只刷新一次页面', async () => {
  const responses = [
    { enabled:true, revision:'boot-1' },
    { enabled:true, revision:'boot-1' },
    { enabled:true, revision:'boot-2' },
  ];
  let reloads = 0;
  const monitor = createHotReloadMonitor({
    fetchImpl:async () => ({
      ok:true,
      async json() { return responses.shift(); },
    }),
    reload:() => { reloads += 1; },
  });

  assert.equal((await monitor.check()).status, 'baseline');
  assert.equal((await monitor.check()).status, 'unchanged');
  assert.equal((await monitor.check()).status, 'reloaded');
  assert.equal(reloads, 1);
});

test('正式运行未开放热更新端点时不启动轮询', async () => {
  let scheduled = 0;
  const monitor = startBrowserHotReload({
    fetchImpl:async () => ({ ok:false, status:404 }),
    schedule:() => { scheduled += 1; },
  });

  assert.equal((await monitor.ready).status, 'disabled');
  assert.equal(scheduled, 0);
});

test('开发运行公开本机热更新版本并提供浏览器客户端', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-hot-reload-'));
  const runtime = await startRuntime({
    createRuntime,
    startBackgroundServices:false,
    environment:{
      ...process.env,
      PORT:'0',
      AJUN_HOST:'127.0.0.1',
      AJUN_DEV_HOT_RELOAD:'true',
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
    logger:{ log:() => undefined, warn:() => undefined },
  });
  context.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await fs.rm(temporaryRoot, { recursive:true, force:true });
  });

  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const stateResponse = await fetch(`${baseUrl}/api/dev/hot-reload`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.enabled, true);
  assert.match(state.revision, /^boot:/);

  const clientResponse = await fetch(`${baseUrl}/hot-reload-client.js`);
  assert.equal(clientResponse.status, 200);
  assert.match(clientResponse.headers.get('content-type'), /^text\/javascript/);
});

test('开发命令使用独立端口、关闭后台副作用并监听前后端源码', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts.dev;

  assert.match(command, /AJUN_DEV_HOT_RELOAD=true/);
  assert.match(command, /AJUN_DISABLE_BACKGROUND_SERVICES=true/);
  assert.match(command, /PORT=\$\{PORT:-4322\}/);
  assert.match(command, /--watch-path=src/);
  assert.match(command, /--watch-path=public/);
});
