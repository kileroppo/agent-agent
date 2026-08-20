import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindRefreshProtectedForms,
  canRefreshConsole,
  clearRefreshDraft,
  startRefreshScheduler,
} from '../public/refresh-scheduler.js';

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

test('动态授权表单一旦有未保存输入，失去焦点后也继续阻止自动刷新', () => {
  const protectedForm = {
    contains:() => false,
    dataset:{ refreshDirty:'true' },
  };
  const page = {
    hidden:false,
    activeElement:null,
    querySelectorAll:(selector) => selector === 'form[data-refresh-protected]' ? [protectedForm] : [],
  };

  assert.equal(canRefreshConsole({ page, accessGate:{ hidden:true } }), false);
  assert.equal(clearRefreshDraft(protectedForm), true);
  assert.equal(canRefreshConsole({ page, accessGate:{ hidden:true } }), true);
});

test('动态表单输入会被标为未保存，解除绑定后不再监听', () => {
  const listeners = new Map();
  const removed = [];
  const page = {
    addEventListener:(name, callback, capture) => listeners.set(name, { callback, capture }),
    removeEventListener:(name, callback, capture) => removed.push({ name, callback, capture }),
  };
  const form = { dataset:{} };
  const target = { closest:() => form };
  const binding = bindRefreshProtectedForms({ page });

  listeners.get('input').callback({ target });
  assert.equal(form.dataset.refreshDirty, 'true');
  binding.stop();
  assert.deepEqual(removed.map(({ name, capture }) => [name, capture]), [
    ['input', true],
    ['change', true],
    ['reset', true],
  ]);
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
      const id = scheduled.length;
      scheduled.push({ callback, delay });
      return id;
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
  assert.equal(cleared.length >= 1, true);
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

test('连续失败使用指数退避，成功后恢复原始间隔', async () => {
  const scheduled = [];
  let shouldFail = true;
  const scheduler = startRefreshScheduler({
    refresh:async () => {
      if (shouldFail) throw new Error('network error');
    },
    canRefresh:() => true,
    intervalMs:1000,
    schedule:(callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length - 1;
    },
    cancel:() => undefined,
    visibilityTarget:null,
  });

  assert.equal(scheduled[0].delay, 1000);

  await scheduler.refreshNow();
  assert.equal(scheduler.consecutiveFailures, 1);
  assert.equal(scheduled[scheduled.length - 1].delay, 2000);

  await scheduler.refreshNow();
  assert.equal(scheduler.consecutiveFailures, 2);
  assert.equal(scheduled[scheduled.length - 1].delay, 4000);

  await scheduler.refreshNow();
  assert.equal(scheduler.consecutiveFailures, 3);
  assert.equal(scheduled[scheduled.length - 1].delay, 8000);

  shouldFail = false;
  await scheduler.refreshNow();
  assert.equal(scheduler.consecutiveFailures, 0);
  assert.equal(scheduled[scheduled.length - 1].delay, 1000);

  scheduler.stop();
});

test('退避上限为60秒', async () => {
  const scheduled = [];
  const scheduler = startRefreshScheduler({
    refresh:async () => { throw new Error('fail'); },
    canRefresh:() => true,
    intervalMs:5000,
    schedule:(callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length - 1;
    },
    cancel:() => undefined,
    visibilityTarget:null,
  });

  for (let i = 0; i < 8; i++) {
    await scheduler.refreshNow();
  }

  const lastDelay = scheduled[scheduled.length - 1].delay;
  assert.equal(lastDelay <= 60000, true, 'Expected delay <= 60000 but got ' + lastDelay);

  scheduler.stop();
});

test('达到失败阈值时调用 onDegraded 回调，恢复后调用 onRecovered', async () => {
  const degradedCalls = [];
  let recoveredCalls = 0;
  let shouldFail = true;
  const scheduler = startRefreshScheduler({
    refresh:async () => {
      if (shouldFail) throw new Error('fail');
    },
    canRefresh:() => true,
    intervalMs:1000,
    failureThreshold:2,
    onDegraded:(failures) => degradedCalls.push(failures),
    onRecovered:() => { recoveredCalls += 1; },
    schedule:(callback, delay) => delay,
    cancel:() => undefined,
    visibilityTarget:null,
  });

  await scheduler.refreshNow();
  assert.equal(degradedCalls.length, 0);

  await scheduler.refreshNow();
  assert.equal(degradedCalls.length, 1);
  assert.equal(degradedCalls[0], 2);

  await scheduler.refreshNow();
  assert.equal(degradedCalls.length, 2);
  assert.equal(degradedCalls[1], 3);

  shouldFail = false;
  await scheduler.refreshNow();
  assert.equal(recoveredCalls, 1);
  assert.equal(scheduler.consecutiveFailures, 0);

  await scheduler.refreshNow();
  assert.equal(recoveredCalls, 1);

  scheduler.stop();
});

test('默认失败阈值为3', async () => {
  const degradedCalls = [];
  const scheduler = startRefreshScheduler({
    refresh:async () => { throw new Error('fail'); },
    canRefresh:() => true,
    intervalMs:1000,
    onDegraded:(failures) => degradedCalls.push(failures),
    schedule:(callback, delay) => delay,
    cancel:() => undefined,
    visibilityTarget:null,
  });

  await scheduler.refreshNow();
  await scheduler.refreshNow();
  assert.equal(degradedCalls.length, 0);

  await scheduler.refreshNow();
  assert.equal(degradedCalls.length, 1);
  assert.equal(degradedCalls[0], 3);

  scheduler.stop();
});
