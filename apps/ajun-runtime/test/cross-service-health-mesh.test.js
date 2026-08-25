import assert from 'node:assert/strict';
import test from 'node:test';
import { CrossServiceHealthMesh } from '../src/cross-service-health-mesh.ts';

test('CrossServiceHealthMesh 正常探测保持 healthy 状态', async () => {
  let now = 1700000000000;
  const mesh = new CrossServiceHealthMesh({
    services: [
      {
        key: 'xiaod',
        name: '小D媒体转录',
        probeFn: async () => ({ ok: true, latencyMs: 5 }),
      },
    ],
    now: () => now,
  });

  const ok = await mesh.probeService('xiaod');
  assert.equal(ok, true);

  const state = mesh.getServiceState('xiaod');
  assert.equal(state.status, 'healthy');
  assert.equal(state.consecutiveFailures, 0);

  const rec = await mesh.reconcile();
  assert.equal(rec.status, 'reconciled');
  assert.equal(rec.healthyCount, 1);
  assert.equal(rec.serviceStates.xiaod, 'healthy');
});

test('CrossServiceHealthMesh 探测失败触发自愈重启并在恢复后发出 onServiceRestored 通知', async () => {
  let now = 1700000000000;
  let isDown = true;
  let restartAttempts = 0;
  const restoredEvents = [];
  const degradedEvents = [];

  const mesh = new CrossServiceHealthMesh({
    services: [
      {
        key: 'local-ai',
        name: 'Local AI 插件',
        probeFn: async () => ({ ok: !isDown, latencyMs: 10 }),
        restarter: async () => {
          restartAttempts += 1;
          isDown = false; // 模拟重启后变好
          return true;
        },
        maxRestartsPerWindow: 3,
      },
    ],
    onServiceRestored: (k) => { restoredEvents.push(k); },
    onServiceDegraded: (k) => { degradedEvents.push(k); },
    now: () => now,
  });

  // 1. 首次失败 -> 状态 degraded，触发 restarter
  const ok1 = await mesh.probeService('local-ai');
  assert.equal(ok1, false);
  assert.equal(restartAttempts, 1);
  assert.equal(degradedEvents.length, 1);

  // 2. 再次探测（由于 restarter 恢复了服务） -> healthy，触发 onServiceRestored
  const ok2 = await mesh.probeService('local-ai');
  assert.equal(ok2, true);
  assert.equal(restoredEvents.length, 1);
  assert.equal(restoredEvents[0], 'local-ai');

  const state = mesh.getServiceState('local-ai');
  assert.equal(state.status, 'healthy');
});

test('CrossServiceHealthMesh 遵守自愈重启熔断上限', async () => {
  let now = 1700000000000;
  let restartCount = 0;

  const mesh = new CrossServiceHealthMesh({
    services: [
      {
        key: 'failing-service',
        name: '持续崩溃服务',
        probeFn: async () => ({ ok: false }),
        restarter: async () => {
          restartCount += 1;
          return true;
        },
        maxRestartsPerWindow: 2,
        restartWindowMs: 60000,
      },
    ],
    now: () => now,
  });

  await mesh.probeService('failing-service'); // attempt 1
  await mesh.probeService('failing-service'); // attempt 2
  await mesh.probeService('failing-service'); // attempt 3 (should be blocked by rate limit)

  assert.equal(restartCount, 2);
  const state = mesh.getServiceState('failing-service');
  assert.equal(state.status, 'offline');
});
