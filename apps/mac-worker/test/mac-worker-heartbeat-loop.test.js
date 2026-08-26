import assert from 'node:assert/strict';
import test from 'node:test';
import { ResilientHeartbeatLoop } from '../src/mac-worker-heartbeat-loop.ts';

test('ResilientHeartbeatLoop 正常发送心跳并在任务推进时上报阶段', async () => {
  const heartbeats = [];
  const fakeCloud = {
    async heartbeat(taskId, payload) {
      heartbeats.push({ taskId, payload });
      return { ok: true };
    },
  };

  const loop = new ResilientHeartbeatLoop({
    cloud: fakeCloud,
    taskId: 'task-mac-101',
    workerId: 'worker-mac-01',
    leaseId: 'lease-001',
    intervalMs: 50,
  });

  loop.start(() => ({ stage: 'transcribing_audio', progress: 45 }));

  const res = await loop.tick();
  assert.equal(res.ok, true);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].taskId, 'task-mac-101');
  assert.equal(heartbeats[0].payload.stage, 'transcribing_audio');
  assert.equal(heartbeats[0].payload.progress, 45);
  assert.equal(loop.isHealthy(), true);

  loop.stop();
});

test('ResilientHeartbeatLoop 遇到 422 租约丢失时停止循环并触发回调', async () => {
  let leaseLostTriggered = false;
  const fakeCloud = {
    async heartbeat() {
      const err = new Error('Lease Expired');
      err.status = 422;
      throw err;
    },
  };

  const loop = new ResilientHeartbeatLoop({
    cloud: fakeCloud,
    taskId: 'task-mac-102',
    workerId: 'worker-mac-01',
    leaseId: 'lease-002',
    onLeaseLost: () => {
      leaseLostTriggered = true;
    },
  });

  loop.start();
  const res = await loop.tick();
  assert.equal(res.ok, false);
  assert.equal(res.status, 'lease_lost');
  assert.equal(leaseLostTriggered, true);
});
