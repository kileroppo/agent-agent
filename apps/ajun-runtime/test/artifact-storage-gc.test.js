import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStorageGcReconciler } from '../src/artifact-storage-gc.ts';

test('ArtifactStorageGcReconciler 安全识别 workspace 路径并在超期后回收', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajun-gc-test-'));
  try {
    const now = 1000000000;
    const oldTime = new Date(now - 10 * 24 * 3600 * 1000); // 10 days ago
    const recentTime = new Date(now - 1 * 3600 * 1000); // 1 hour ago

    // 1. 终态成功任务的历史大媒体文件 (超期 > 7天)
    const successMediaFile = path.join(tmpDir, 'task-done1.mp4');
    fs.writeFileSync(successMediaFile, 'fake video content 12345');
    fs.utimesSync(successMediaFile, oldTime, oldTime);

    // 2. 活跃任务的文件 (不清理)
    const activeMediaFile = path.join(tmpDir, 'task-active1.mp4');
    fs.writeFileSync(activeMediaFile, 'active video content');
    fs.utimesSync(activeMediaFile, oldTime, oldTime);

    // 3. 失败任务的 scratch 目录 (超期 > 24小时)
    const failedScratchDir = path.join(tmpDir, 'task-fail1');
    fs.mkdirSync(failedScratchDir);
    fs.writeFileSync(path.join(failedScratchDir, 'temp.txt'), 'failed log');
    fs.utimesSync(failedScratchDir, oldTime, oldTime);

    // 4. 孤儿文件 (超期 > 6小时)
    const orphanFile = path.join(tmpDir, 'orphan-old.tmp');
    fs.writeFileSync(orphanFile, 'orphan content');
    fs.utimesSync(orphanFile, oldTime, oldTime);

    // 5. 新建孤儿文件 (< 6小时，不清理)
    const freshOrphanFile = path.join(tmpDir, 'orphan-fresh.tmp');
    fs.writeFileSync(freshOrphanFile, 'fresh content');
    fs.utimesSync(freshOrphanFile, recentTime, recentTime);

    const store = {
      async list() {
        return [
          { taskId: 'task-done1', status: 'succeeded' },
          { taskId: 'task-active1', status: 'running' },
          { taskId: 'task-fail1', status: 'failed' },
        ];
      },
    };

    const reconciler = new ArtifactStorageGcReconciler({
      workspaceDirs: [tmpDir],
      store,
      now: () => now,
    });

    // 路径安全性检查
    assert.equal(reconciler.isSafePath(path.join(tmpDir, 'some-file.txt')), true);
    assert.equal(reconciler.isSafePath('/etc/passwd'), false);

    // 执行 GC
    const result = await reconciler.runGc({ dryRun: false, now });
    assert.equal(result.cleanedFilesCount, 3); // successMedia, failedScratchDir, orphanFile

    // 验证文件存在性
    assert.equal(fs.existsSync(successMediaFile), false);
    assert.equal(fs.existsSync(activeMediaFile), true);
    assert.equal(fs.existsSync(failedScratchDir), false);
    assert.equal(fs.existsSync(orphanFile), false);
    assert.equal(fs.existsSync(freshOrphanFile), true);

    const rec = await reconciler.reconcile();
    assert.equal(rec.status, 'reconciled');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
