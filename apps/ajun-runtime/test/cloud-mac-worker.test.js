import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudXiaodExecutor } from '../src/cloud-xiaod-executor.js';
import { MacWorkerTaskBridge } from '../src/mac-worker-task-bridge.js';
import { TaskStore } from '../src/task-store.js';

test('云端小D任务在 Mac 离线时安全排队，不会误报执行或失败', async () => {
  const executor = new CloudXiaodExecutor();
  const result = await executor.execute({
    taskId:'media-cloud-1',
    input:{ sourceUrl:'https://example.com/video.mp4' },
    routing:{ reason:'已路由给小D。' }
  });
  assert.equal(result.status, 'waiting_worker');
  assert.equal(result.currentStage, 'waiting_for_mac_worker');
  assert.equal(result.execution.mode, 'mac_worker');
  assert.equal(result.execution.worker.state, 'waiting');
  assert.deepEqual(result.artifactRefs, []);
});

test('Mac工作间使用短租约领取同一任务并回写经过验证的脱敏产物', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-mac-worker-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const store = new TaskStore(path.join(directory, 'runtime.json'));
  const queued = await store.createTask({
    taskType:'media.transcribe-and-refine',
    status:'waiting_worker',
    currentStage:'waiting_for_mac_worker',
    assigneeAgentId:'xiaod',
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video.mp4' },
    execution:{ executor:'xiaod', mode:'mac_worker', worker:{ state:'waiting' } }
  });
  let now = Date.parse('2026-07-26T08:00:00.000Z');
  const token = 'worker-token-with-at-least-32-characters';
  const bridge = new MacWorkerTaskBridge({ store, token, now:() => now, leaseMs:60_000 });

  assert.equal(bridge.authorize(`Bearer ${token}`), true);
  assert.equal(bridge.authorize('Bearer wrong-token'), false);
  const leased = await bridge.lease({ workerId:'boss-mac', capabilities:['media.transcribe-and-refine', 'unknown'] });
  assert.equal(leased.job.taskId, queued.taskId);
  assert.equal(leased.job.input.sourceUrl, 'https://example.com/video.mp4');
  assert.equal(leased.job.idempotencyKey, `agent-army:${queued.taskId}`);
  assert.equal((await bridge.lease({ workerId:'boss-mac', capabilities:['media.transcribe-and-refine'] })).job, null);

  now += 10_000;
  const heartbeat = await bridge.heartbeat(queued.taskId, {
    workerId:'boss-mac',
    leaseId:leased.job.leaseId,
    stage:'transcribing',
    progress:42
  });
  assert.equal(heartbeat.status, 'running');
  assert.equal(heartbeat.execution.worker.progress, 42);
  assert.equal(heartbeat.currentStage, 'mac_worker_transcribing');

  now += 10_000;
  const completed = await bridge.complete(queued.taskId, {
    workerId:'boss-mac',
    leaseId:leased.job.leaseId,
    result:{
      status:'succeeded',
      xiaodJobId:'local-xiaod-1',
      title:'公开视频整理稿',
      larkUrl:'https://example.feishu.cn/docx/example',
      larkPermissionGranted:true,
      validation:{ exists:true, readable:true, nonEmpty:true, qualityPassed:true }
    }
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.execution.worker.state, 'completed');
  assert.equal(completed.artifactRefs[0].validation.qualityPassed, true);
  assert.equal(completed.artifactRefs[0].data.larkPermissionGranted, true);
  assert.match(completed.artifactRefs[0].location, /^mac-worker:\/\//);
  assert.doesNotMatch(JSON.stringify(completed), /\/Users\/|Cookie|token-with/);
  assert.equal(bridge.snapshot(await store.list()).status, 'ready');
});

test('过期的 Mac工作间租约可以由在线设备接管，旧租约不能覆盖新结果', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-worker-lease-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const store = new TaskStore(path.join(directory, 'runtime.json'));
  const task = await store.createTask({
    taskType:'media.transcribe-and-refine',
    status:'waiting_worker',
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video.mp4' },
    execution:{ executor:'xiaod', mode:'mac_worker', worker:{ state:'waiting' } }
  });
  let now = Date.parse('2026-07-26T08:00:00.000Z');
  const bridge = new MacWorkerTaskBridge({ store, token:'another-worker-token-with-32-characters', now:() => now, leaseMs:1_000 });
  const first = await bridge.lease({ workerId:'old-mac', capabilities:['media.transcribe-and-refine'] });
  now += 2_000;
  const second = await bridge.lease({ workerId:'new-mac', capabilities:['media.transcribe-and-refine'] });
  assert.equal(second.job.taskId, task.taskId);
  assert.notEqual(second.job.leaseId, first.job.leaseId);
  await assert.rejects(
    () => bridge.heartbeat(task.taskId, { workerId:'old-mac', leaseId:first.job.leaseId, stage:'working' }),
    (error) => error.code === 'worker_lease_mismatch'
  );
});

test('Mac工作间不能把没有可验证产物的成功回报写成完成', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-worker-proof-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const store = new TaskStore(path.join(directory, 'runtime.json'));
  const task = await store.createTask({
    taskType:'media.transcribe-and-refine',
    status:'waiting_worker',
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video.mp4' },
    execution:{ executor:'xiaod', mode:'mac_worker', worker:{ state:'waiting' } }
  });
  const bridge = new MacWorkerTaskBridge({ store, token:'proof-worker-token-with-32-characters' });
  const lease = await bridge.lease({ workerId:'boss-mac', capabilities:['media.transcribe-and-refine'] });
  await assert.rejects(
    () => bridge.complete(task.taskId, {
      workerId:'boss-mac',
      leaseId:lease.job.leaseId,
      result:{ status:'succeeded', xiaodJobId:'job-without-output', validation:{ exists:true, readable:true, nonEmpty:false } }
    }),
    (error) => error.code === 'worker_artifact_invalid'
  );
  assert.equal((await store.list())[0].status, 'running');
});

test('Mac工作间不能把未确认飞书权限的产物写成成功', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-worker-permission-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const store = new TaskStore(path.join(directory, 'runtime.json'));
  const task = await store.createTask({
    taskType:'media.transcribe-and-refine',
    status:'waiting_worker',
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video.mp4' },
    execution:{ executor:'xiaod', mode:'mac_worker', worker:{ state:'waiting' } },
  });
  const bridge = new MacWorkerTaskBridge({ store, token:'permission-worker-token-with-32-characters' });
  const lease = await bridge.lease({ workerId:'boss-mac', capabilities:['media.transcribe-and-refine'] });

  await assert.rejects(
    () => bridge.complete(task.taskId, {
      workerId:'boss-mac',
      leaseId:lease.job.leaseId,
      result:{
        status:'succeeded',
        xiaodJobId:'job-unverified-permission',
        larkUrl:'https://example.feishu.cn/docx/unverified',
        larkPermissionGranted:false,
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
    }),
    (error) => error.code === 'worker_artifact_invalid',
  );
  assert.equal((await store.list())[0].status, 'running');
});
