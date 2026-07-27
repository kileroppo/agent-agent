import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeJob } from '../src/domain.js';
import { JobStore } from '../src/store.js';

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
