import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { MacWorker } from '../src/mac-worker.ts';
import { WorkerStateStore } from '../src/state-store.ts';

test('Mac工作间拒绝明文远程地址和非本机小D地址', () => {
  const base = { AGENT_ARMY_WORKER_TOKEN:'a'.repeat(32), AGENT_ARMY_WORKER_ID:'boss-mac' };
  assert.throws(() => loadConfig({ ...base, AGENT_ARMY_CLOUD_URL:'http://cloud.example.com', XIAOD_RUNTIME_URL:'http://127.0.0.1:4318' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, AGENT_ARMY_CLOUD_URL:'https://cloud.example.com', XIAOD_RUNTIME_URL:'http://192.168.1.2:4318' }), /loopback/);
});

test('Mac工作间以云端任务号幂等创建小D工作并回报进度和完成', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-worker-state-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const stateStore = new WorkerStateStore(path.join(directory, 'state.json'));
  const heartbeats = [];
  const completions = [];
  let leaseCalls = 0;
  let localStatus = 'transcribing';
  const cloud = {
    async lease() {
      leaseCalls += 1;
      return leaseCalls === 1 ? {
        job:{
          taskId:'cloud-task-1',
          leaseId:'lease-1',
          taskType:'media.transcribe-and-refine',
          idempotencyKey:'agent-army:cloud-task-1',
          input:{ title:'整理公开视频', sourceUrl:'https://example.com/video.mp4' }
        },
        nextPollAfterMs:5_000
      } : { job:null, nextPollAfterMs:5_000 };
    },
    async heartbeat(taskId, payload) { heartbeats.push({ taskId, payload }); },
    async complete(taskId, payload) { completions.push({ taskId, payload }); }
  };
  let creates = 0;
  const xiaod = {
    async create(input) { creates += 1; assert.equal(input.idempotencyKey, 'agent-army:cloud-task-1'); return { id:'xiaod-local-1' }; },
    async get() {
      return localStatus === 'completed'
        ? { id:'xiaod-local-1', status:'completed', title:'整理稿', progress:100, output:{ markdownPath:'/private/local/output.md', larkUrl:'https://example.feishu.cn/docx/1', larkPermissionGranted:true }, quality:{ passed:true } }
        : { id:'xiaod-local-1', status:'transcribing', progress:45 };
    }
  };
  const worker = new MacWorker({ cloud, xiaod, stateStore, workerId:'boss-mac' });

  assert.equal((await worker.runOnce()).status, 'working');
  assert.equal(creates, 1);
  assert.equal(heartbeats[0].payload.progress, 45);
  localStatus = 'completed';
  assert.equal((await worker.runOnce()).status, 'completed');
  assert.equal(creates, 1);
  assert.equal(completions[0].payload.result.validation.nonEmpty, true);
  assert.equal('markdownPath' in completions[0].payload.result, false);
  const state = await stateStore.read();
  assert.equal(state.activeLease, null);
  assert.equal(state.jobs['cloud-task-1'].xiaodJobId, 'xiaod-local-1');
});
