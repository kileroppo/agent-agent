import assert from 'node:assert/strict';
import test from 'node:test';

import { canRefreshConsole, startRefreshScheduler } from '../public/refresh-scheduler.js';

test('控制台只在页面可见、已通过访问门禁且表单未输入时自动刷新', () => {
  const accessForm = { contains:(node) => node === 'access-input' };
  const loginForm = { contains:(node) => node === 'login-input' };
  const page = { hidden:false, activeElement:null };
  const input = { page, accessGate:{ hidden:true }, forms:[accessForm, loginForm] };

  assert.equal(canRefreshConsole(input), true);
  page.hidden = true;
  assert.equal(canRefreshConsole(input), false);
  page.hidden = false;
  input.accessGate.hidden = false;
  assert.equal(canRefreshConsole(input), false);
  input.accessGate.hidden = true;
  page.activeElement = 'login-input';
  assert.equal(canRefreshConsole(input), false);
});

test('控制台按配置间隔后台刷新，并在停止后解除定时器和可见性监听', async () => {
  const scheduled = [];
  const cleared = [];
  const listeners = new Map();
  const calls = [];
  const scheduler = startRefreshScheduler({
    refresh:async (options) => calls.push(options),
    canRefresh:() => true,
    intervalMs:15_000,
    schedule:(callback, delay) => {
      scheduled.push({ callback, delay });
      return 'refresh-timer';
    },
    cancel:(timer) => cleared.push(timer),
    visibilityTarget:{
      addEventListener:(name, callback) => listeners.set(name, callback),
      removeEventListener:(name, callback) => {
        if (listeners.get(name) === callback) listeners.delete(name);
      },
    },
  });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15_000);
  assert.equal(listeners.has('visibilitychange'), true);

  await scheduler.refreshNow();
  assert.deepEqual(calls, [{ background:true }]);

  scheduler.stop();
  assert.deepEqual(cleared, ['refresh-timer']);
  assert.equal(listeners.has('visibilitychange'), false);
  assert.equal(await scheduler.refreshNow(), false);
});

test('页面不可刷新或上一轮未结束时不叠加后台请求', async () => {
  let scheduledCallback;
  let refreshAllowed = true;
  let releaseRefresh;
  const pendingRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  let calls = 0;
  const scheduler = startRefreshScheduler({
    refresh:async () => {
      calls += 1;
      await pendingRefresh;
    },
    canRefresh:() => refreshAllowed,
    schedule:(callback) => {
      scheduledCallback = callback;
      return 'timer';
    },
    cancel:() => undefined,
    visibilityTarget:null,
  });

  const first = scheduler.refreshNow();
  assert.equal(await scheduler.refreshNow(), false);
  scheduledCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  releaseRefresh();
  assert.equal(await first, true);
  refreshAllowed = false;
  assert.equal(await scheduler.refreshNow(), false);
  assert.equal(calls, 1);
  scheduler.stop();
});
