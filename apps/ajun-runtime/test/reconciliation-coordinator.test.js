import assert from 'node:assert/strict';
import test from 'node:test';
import { ReconciliationCoordinator } from '../src/reconciliation-coordinator.ts';

test('空闲任务指数退避，有工作后恢复最短检查周期', async () => {
  let now = 1_000;
  const results = [0, 0, 1];
  const coordinator = new ReconciliationCoordinator({ now:() => now });
  coordinator.register({ name:'work', intervalMs:100, maxIntervalMs:400, reconcile:async () => results.shift() });

  await coordinator.runDue({ force:true });
  assert.equal(coordinator.jobs.get('work').nextRunAt, 1_200);
  now = 1_200;
  await coordinator.runDue();
  assert.equal(coordinator.jobs.get('work').nextRunAt, 1_600);
  now = 1_600;
  await coordinator.runDue();
  assert.equal(coordinator.jobs.get('work').nextRunAt, 1_700);
  assert.equal(coordinator.jobs.get('work').idleRuns, 0);
});

test('store mutation 会唤醒协调器且 stop 会取消订阅', () => {
  let listener;
  let unsubscribed = false;
  const scheduled = [];
  const coordinator = new ReconciliationCoordinator({
    now:() => 5_000,
    mutationSource:{ subscribe(callback) { listener = callback; return () => { unsubscribed = true; }; } },
    setTimer(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimer() {},
    jobs:[{ name:'tasks', intervalMs:1_000, reconcile:async () => 0 }],
  });

  coordinator.start();
  coordinator.jobs.get('tasks').nextRunAt = 9_000;
  listener();
  assert.equal(coordinator.jobs.get('tasks').nextRunAt, 5_000);
  assert.equal(scheduled.at(-1).delay, 0);
  coordinator.stop();
  assert.equal(unsubscribed, true);
});

test('相同后台错误只报告一次，恢复时再报告一次', async () => {
  const events = [];
  let failing = true;
  const coordinator = new ReconciliationCoordinator({ onEvent:(event) => events.push(event) });
  coordinator.register({
    name:'paperclip',
    reconcile:async () => {
      if (failing) throw new Error('connection refused token=private-value');
      return 0;
    },
  });

  await coordinator.runDue({ force:true });
  await coordinator.runDue({ force:true });
  failing = false;
  await coordinator.runDue({ force:true });

  assert.deepEqual(events.map((event) => event.type), ['reconciliation_failed', 'reconciliation_recovered']);
  assert.doesNotMatch(events[0].reason, /private-value/);
});
