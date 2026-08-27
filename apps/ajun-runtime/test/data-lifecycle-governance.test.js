import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';
import { TaskRunEventStore } from '../src/task-run-event-store.ts';
import { ArtifactStorageGcReconciler } from '../src/artifact-storage-gc.ts';
import { FeedbackEvalDatasetService } from '../src/feedback-eval-dataset.ts';
import { DataLifecycleGovernanceReconciler } from '../src/data-lifecycle-governance.ts';

async function withGovernanceContext(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-data-governance-test-'));
  const dataDir = path.join(dir, 'data');
  const workspaceDir = path.join(dir, 'workspace');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const store = new SQLiteTaskStore(path.join(dataDir, 'runtime.sqlite'));
  const taskRunEvents = new TaskRunEventStore(path.join(dataDir, 'task-run-events.sqlite'));
  const artifactStorageGc = new ArtifactStorageGcReconciler({
    store,
    workspaceDirs: [workspaceDir],
  });
  const feedbackEvalDataset = new FeedbackEvalDatasetService({
    store,
    datasetFilePath: path.join(dataDir, 'eval-cases.json'),
  });

  const reconciler = new DataLifecycleGovernanceReconciler({
    store,
    taskRunEvents,
    artifactStorageGc,
    feedbackEvalDataset,
    dataDir,
    contentWorkspaceDir: workspaceDir,
  });

  try {
    await run({ store, taskRunEvents, artifactStorageGc, feedbackEvalDataset, reconciler, dataDir, workspaceDir });
  } finally {
    store.close();
    taskRunEvents.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('DataLifecycleGovernanceReconciler 能够正确检查存储水位、执行统一数据闭环并在 dryRun/apply 间保证安全', async () => {
  await withGovernanceContext(async ({ store, taskRunEvents, reconciler, workspaceDir }) => {
    const baseTime = Date.parse('2026-08-20T12:00:00.000Z');

    // 1. 创建过期例行任务
    const routineTask = await store.createTask({
      taskType: 'operations.health-review',
      status: 'queued',
      source: { channel: 'paperclip' },
      input: { title: 'A君定时本机巡检', description: 'agent-army:operations-health-v1' },
    });
    await store.updateTask(routineTask.taskId, { status: 'running' });
    await store.updateTask(routineTask.taskId, { status: 'succeeded' });
    const tenDaysAgo = new Date(baseTime - 10 * 86400000).toISOString();
    store.database.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(tenDaysAgo, routineTask.taskId);

    // 2. 创建过期 transient 运行事件
    taskRunEvents.appendTaskRunEvent({
      eventId: 'evt-old-1',
      taskId: routineTask.taskId,
      eventType: 'task_started',
      status: 'started',
      startedAt: tenDaysAgo,
      retentionClass: 'transient',
    });

    // 3. 在工作区创建孤儿临时文件
    const orphanFile = path.join(workspaceDir, 'tmp-orphan-1.mp4');
    await fs.writeFile(orphanFile, 'fake video stream data');

    // 4. 检查存储概览
    const overview = await reconciler.inspectStorageStatus();
    assert.ok(overview.inspectedAt);
    assert.equal(overview.tasksCount.tasks, 1);
    assert.equal(overview.eventsCount.totalEvents, 1);
    assert.equal(overview.retentionPolicies.routineTasksDays, 7);

    // 5. 执行 dry-run
    const dryRunRes = await reconciler.runFullClosedLoop({ dryRun: true, now: baseTime });
    assert.equal(dryRunRes.mode, 'dry-run');
    assert.equal(dryRunRes.status, 'reconciled');
    assert.ok(dryRunRes.totalReclaimedItems >= 1);

    // 数据库中数据依然存在
    assert.ok(await store.getTask(routineTask.taskId));

    // 6. 执行 apply
    const applyRes = await reconciler.reconcile();
    assert.equal(applyRes.status, 'reconciled');
    assert.equal(applyRes.changed, true);
    assert.ok(applyRes.workCount >= 1);

    // 验证过期任务和事件已清理
    assert.equal(await store.getTask(routineTask.taskId), null);
    const postEvents = taskRunEvents.queryTaskRunEvents({ taskId: routineTask.taskId });
    assert.equal(postEvents.items.length, 0);
  });
});
