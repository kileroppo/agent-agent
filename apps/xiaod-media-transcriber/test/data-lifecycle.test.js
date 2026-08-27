import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobStore } from '../src/store.ts';
import { XiaodDataLifecycleService } from '../src/data-lifecycle-service.ts';

async function withTestContext(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-lifecycle-test-'));
  const store = new JobStore(dir);
  await store.init();
  try {
    await run({ store, dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('Xiaod JobStore.pruneExpiredJobs 安全清理超期已完成和已失败任务及对应作业目录，保护活跃任务', async () => {
  await withTestContext(async ({ store, dir }) => {
    const baseTime = Date.parse('2026-08-20T12:00:00.000Z');
    const jobsDir = path.join(dir, 'jobs');

    // 1. 活跃任务（进行中，不应被清理）
    const activeJob = {
      id: 'job-active-1',
      status: 'transcribing',
      createdAt: new Date(baseTime - 20 * 86400000).toISOString(),
      updatedAt: new Date(baseTime - 20 * 86400000).toISOString(),
      log: [],
    };
    await store.create(activeJob);
    const activeJobDir = path.join(jobsDir, activeJob.id);
    await fs.mkdir(activeJobDir, { recursive: true });
    await fs.writeFile(path.join(activeJobDir, 'audio.wav'), 'active audio data');

    // 2. 近期完成任务（未超期，不应被清理）
    const recentJob = {
      id: 'job-recent-1',
      status: 'completed',
      createdAt: new Date(baseTime - 5 * 86400000).toISOString(),
      updatedAt: new Date(baseTime - 5 * 86400000).toISOString(),
      log: [],
    };
    await store.create(recentJob);
    const recentJobDir = path.join(jobsDir, recentJob.id);
    await fs.mkdir(recentJobDir, { recursive: true });
    await fs.writeFile(path.join(recentJobDir, 'transcript.txt'), 'recent transcript');

    // 3. 过期成功任务（超过 14 天，应被清理）
    const expiredJob = {
      id: 'job-expired-1',
      status: 'completed',
      createdAt: new Date(baseTime - 20 * 86400000).toISOString(),
      updatedAt: new Date(baseTime - 20 * 86400000).toISOString(),
      log: [],
    };
    await store.create(expiredJob);
    const expiredJobDir = path.join(jobsDir, expiredJob.id);
    await fs.mkdir(expiredJobDir, { recursive: true });
    await fs.writeFile(path.join(expiredJobDir, 'heavy-video.mp4'), 'heavy video content');

    // 4. 过期失败任务（超过 3 天，应被清理）
    const failedJob = {
      id: 'job-failed-1',
      status: 'failed',
      createdAt: new Date(baseTime - 5 * 86400000).toISOString(),
      updatedAt: new Date(baseTime - 5 * 86400000).toISOString(),
      log: [],
    };
    await store.create(failedJob);
    const failedJobDir = path.join(jobsDir, failedJob.id);
    await fs.mkdir(failedJobDir, { recursive: true });
    await fs.writeFile(path.join(failedJobDir, 'error-dump.bin'), 'failed artifact');

    // 测试 dryRun
    const dryRun = await store.pruneExpiredJobs({
      now: baseTime,
      succeededRetentionMs: 14 * 86400000,
      failedRetentionMs: 3 * 86400000,
      dryRun: true,
    });

    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.prunedJobsCount, 2);
    assert.deepEqual(dryRun.prunedJobIds.sort(), ['job-expired-1', 'job-failed-1']);
    assert.ok(dryRun.reclaimedBytes > 0);

    // 验证此时文件与内存均未删除
    assert.ok(store.get('job-expired-1'));
    assert.ok(store.get('job-failed-1'));

    // 测试 apply
    const apply = await store.pruneExpiredJobs({
      now: baseTime,
      succeededRetentionMs: 14 * 86400000,
      failedRetentionMs: 3 * 86400000,
      dryRun: false,
    });

    assert.equal(apply.mode, 'apply');
    assert.equal(apply.prunedJobsCount, 2);
    assert.equal(store.get('job-expired-1'), null);
    assert.equal(store.get('job-failed-1'), null);
    assert.ok(store.get('job-active-1'));
    assert.ok(store.get('job-recent-1'));

    // 验证目录也被正确清理
    await assert.rejects(() => fs.stat(expiredJobDir));
    await assert.rejects(() => fs.stat(failedJobDir));
    assert.ok(await fs.stat(activeJobDir));
    assert.ok(await fs.stat(recentJobDir));
  });
});

test('XiaodDataLifecycleService 定期执行与状态查询', async () => {
  await withTestContext(async ({ store }) => {
    const service = new XiaodDataLifecycleService({
      store,
      now: () => Date.now(),
    });

    const result = await service.runGc({ dryRun: true });
    assert.equal(result.mode, 'dry-run');

    const status = service.getStatus();
    assert.equal(status.status, 'active');
    assert.ok(status.lastResult);

    service.start();
    service.stop();
  });
});
