import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';

async function withStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-sqlite-prune-test-'));
  const filePath = path.join(dir, 'runtime.sqlite');
  const store = new SQLiteTaskStore(filePath);
  try {
    await run({ store, filePath, dir });
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('SQLiteTaskStore.pruneExpiredRecords 安全按期清理过期例行任务、闲置会话与测试实例，且保护活跃任务', async () => {
  await withStore(async ({ store }) => {
    const baseTime = Date.parse('2026-08-20T12:00:00.000Z');

    // 1. 创建活跃任务（不应被清理）
    const activeTask = await store.createTask({
      taskType: 'army.media',
      status: 'queued',
      input: { title: '正在运行的转录' },
    });
    await store.updateTask(activeTask.taskId, { status: 'running' });

    // 2. 创建近期成功的任务（不应被清理）
    const recentTask = await store.createTask({
      taskType: 'army.media',
      status: 'queued',
      input: { title: '最近完成的转录' },
    });
    await store.updateTask(recentTask.taskId, { status: 'running' });
    await store.updateTask(recentTask.taskId, { status: 'succeeded' });

    // 3. 创建过期的例行巡检任务（超过7天，已成功，应该被清理）
    const expiredRoutineTask = await store.createTask({
      taskType: 'operations.health-review',
      status: 'queued',
      source: { channel: 'paperclip' },
      input: { title: 'A君定时本机巡检', description: 'agent-army:operations-health-v1' },
    });
    await store.updateTask(expiredRoutineTask.taskId, { status: 'running' });
    await store.updateTask(expiredRoutineTask.taskId, { status: 'succeeded' });
    const tenDaysAgo = new Date(baseTime - 10 * 86400000).toISOString();
    store.database.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(tenDaysAgo, expiredRoutineTask.taskId);

    // 4. 创建过期的只读诊断任务（超过7天，应该被清理）
    const expiredDiagTask = await store.createTask({
      taskType: 'operations.failure-recovery',
      status: 'queued',
      source: { channel: 'internal-recovery' },
      recovery: { mode: 'read_only_diagnosis' },
      input: { context: { diagnosisOnly: 1 } },
    });
    await store.updateTask(expiredDiagTask.taskId, { status: 'running' });
    await store.updateTask(expiredDiagTask.taskId, { status: 'succeeded' });
    store.database.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(tenDaysAgo, expiredDiagTask.taskId);

    // 5. 创建过期的对话上下文（超过30天）与近期对话上下文
    await store.setConversationContext('chat-recent', { kind: 'test', note: '近期' });
    await store.setConversationContext('chat-old', { kind: 'test', note: '过期' });
    const fortyDaysAgo = new Date(baseTime - 40 * 86400000).toISOString();
    store.database.prepare('UPDATE conversation_contexts SET updated_at = ? WHERE chat_ref = ?').run(fortyDaysAgo, 'chat-old');

    // 6. 创建过期的测试实例
    const testInst = await store.createTestInstance({ proposalId: 'prop-1', status: 'stopped' });
    store.database.prepare('UPDATE test_instances SET updated_at = ? WHERE test_instance_id = ?').run(fortyDaysAgo, testInst.testInstanceId);

    // 先运行 dryRun 检查
    const dryRunResult = await store.pruneExpiredRecords({
      now: baseTime,
      routineRetentionDays: 7,
      conversationContextRetentionDays: 30,
      testInstanceRetentionDays: 30,
      terminalTaskRetentionDays: 90,
      dryRun: true,
    });

    assert.equal(dryRunResult.mode, 'dry-run');
    assert.equal(dryRunResult.expiring.routineTasks, 2);
    assert.equal(dryRunResult.expiring.conversationContexts, 1);
    assert.equal(dryRunResult.expiring.testInstances, 1);
    assert.equal(dryRunResult.totalDeleted, 0);

    // 数据库中数据依然存在
    assert.ok(await store.getTask(expiredRoutineTask.taskId));
    assert.ok(await store.getTask(expiredDiagTask.taskId));
    assert.ok(await store.getConversationContext('chat-old'));

    // 执行 apply
    const applyResult = await store.pruneExpiredRecords({
      now: baseTime,
      routineRetentionDays: 7,
      conversationContextRetentionDays: 30,
      testInstanceRetentionDays: 30,
      terminalTaskRetentionDays: 90,
      dryRun: false,
    });

    assert.equal(applyResult.mode, 'apply');
    assert.equal(applyResult.deleted.routineTasks, 2);
    assert.equal(applyResult.deleted.conversationContexts, 1);
    assert.equal(applyResult.deleted.testInstances, 1);
    assert.equal(applyResult.totalDeleted, 4);

    // 验证结果：过期数据已删除，活跃与近期数据完整保留
    assert.equal(await store.getTask(expiredRoutineTask.taskId), null);
    assert.equal(await store.getTask(expiredDiagTask.taskId), null);
    assert.equal(await store.getConversationContext('chat-old'), null);

    assert.ok(await store.getTask(activeTask.taskId));
    assert.ok(await store.getTask(recentTask.taskId));
    assert.ok(await store.getConversationContext('chat-recent'));
  });
});
