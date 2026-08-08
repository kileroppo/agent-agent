import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeJob } from '../src/domain.js';
import { JobStore, JobStoreConflictError } from '../src/store.js';

test('restart recovery preserves a retryable failure that the retry route accepts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-store-'));
  try {
    await fs.writeFile(path.join(root, 'jobs.json'), JSON.stringify([{
      id: 'job-1', status: 'transcribing', createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z', log: []
    }]));
    const store = new JobStore(root);
    await store.init();
    const job = store.get('job-1');
    assert.equal(job.status, 'failed');
    assert.equal(job.failure.retryable, true);
    assert.match(job.failure.recovery, /重试小D任务/);
    assert.equal(job.failureHistory.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('重启发生在飞书交付凭据落账后只重放本地完成状态，不重跑外部交付', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-store-delivery-recovery-'));
  try {
    await fs.writeFile(path.join(root, 'jobs.json'), JSON.stringify([{
      id:'job-delivered', status:'delivering', createdAt:'2026-08-08T00:00:00.000Z', updatedAt:'2026-08-08T00:00:00.000Z', log:[],
      output:{
        markdownPath:'/tmp/fake.md', reviewStatus:'auto_confirmed',
        larkDelivery:{ state:'delivered', url:'https://feishu.cn/docx/fake-doc', permissionGranted:true, completedAt:'2026-08-08T00:01:00.000Z' }
      }
    }]));
    const store = new JobStore(root);
    await store.init();
    const job = store.get('job-delivered');
    assert.equal(job.status, 'completed');
    assert.equal(job.output.larkUrl, 'https://feishu.cn/docx/fake-doc');
    assert.equal(job.output.larkPermissionGranted, true);
    assert.equal(job.failure, null);
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

test('Mac工作间重复提交同一云端任务只创建一个小D工作', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-worker-dedupe-'));
  try {
    const store = new JobStore(root);
    await store.init();
    const input = {
      sourceType:'url',
      sourceUrl:'https://example.com/video.mp4',
      ingress:{ platform:'agent-army-mac-worker', idempotencyKey:'agent-army:task-1234' }
    };
    const first = await store.createOrGetByIngressKey(makeJob(input));
    const second = await store.createOrGetByIngressKey(makeJob(input));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(store.list().length, 1);
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

test('并发任务创建和更新保持单一幂等任务及可重启的完整状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-store-concurrency-'));
  try {
    const store = new JobStore(root);
    await store.init();
    const ingress = { platform:'agent-army-mac-worker', idempotencyKey:'agent-army:task-concurrent' };
    const sameIntent = Array.from({ length:24 }, () => makeJob({
      sourceType:'url', sourceUrl:'https://example.com/video.mp4', ingress
    }));
    const results = await Promise.all(sameIntent.map((job) => store.createOrGetByIngressKey(job)));
    assert.equal(results.filter((item) => item.created).length, 1);
    assert.equal(new Set(results.map((item) => item.job.id)).size, 1);

    const extraJobs = Array.from({ length:23 }, (_, index) => makeJob({
      sourceType:'url', sourceUrl:`https://example.com/video-${index}.mp4`
    }));
    await Promise.all(extraJobs.map((job) => store.create(job)));
    await Promise.all(extraJobs.map((job, index) => store.update(job.id, {
      status:'completed', progress:100, output:{ index }
    }, { stage:'completed', message:`done ${index}` })));

    assert.equal((await fs.stat(path.join(root, 'jobs.json'))).mode & 0o777, 0o600);
    const restarted = new JobStore(root);
    await restarted.init();
    assert.equal(restarted.list().length, 24);
    assert.equal(restarted.list().filter((job) => job.status === 'completed').length, 23);
    assert.deepEqual(restarted.list().filter((job) => job.status === 'completed').map((job) => job.output.index).sort((a, b) => a - b), Array.from({ length:23 }, (_, index) => index));
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

test('同一幂等标识的输入漂移被拒绝且不会替换原任务', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-store-intent-'));
  try {
    const store = new JobStore(root);
    await store.init();
    const ingress = { platform:'agent-army-mac-worker', idempotencyKey:'agent-army:task-intent' };
    const first = await store.createOrGetByIngressKey(makeJob({
      sourceType:'url', sourceUrl:'https://example.com/original.mp4', ingress
    }));
    await assert.rejects(
      store.createOrGetByIngressKey(makeJob({
        sourceType:'url', sourceUrl:'https://example.com/different.mp4', ingress
      })),
      JobStoreConflictError
    );
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, first.job.id);
    assert.equal(store.list()[0].sourceUrl, 'https://example.com/original.mp4');
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});

test('任务持久化失败会回滚阶段状态且写入队列可以恢复', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-store-rollback-'));
  try {
    const store = new JobStore(root);
    await store.init();
    const job = await store.create(makeJob({ sourceType:'url', sourceUrl:'https://example.com/video.mp4' }));
    const persist = store.persist.bind(store);
    store.persist = async () => { throw new Error('simulated job disk failure'); };
    await assert.rejects(store.update(job.id, { status:'transcribing', progress:45 }), /simulated job disk failure/);
    assert.equal(store.get(job.id).status, 'queued');
    assert.equal(store.get(job.id).progress, 0);

    store.persist = persist;
    await store.update(job.id, { status:'completed', progress:100 });
    assert.equal(store.get(job.id).status, 'completed');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'jobs.json'), 'utf8'))[0].status, 'completed');
  } finally { await fs.rm(root, { recursive:true, force:true }); }
});
