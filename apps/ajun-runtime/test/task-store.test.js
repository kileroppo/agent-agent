import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/task-store.js';

test('并发登记任务不会丢失记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-task-store-'));
  try {
    const store = new TaskStore(path.join(directory, 'runtime.json'));
    const created = await Promise.all(Array.from({ length: 24 }, (_, index) => store.createTask({ taskType: 'army.intake', input: { title: `任务 ${index}` }, status: 'queued', currentStage: 'queued_for_execution' })));
    const tasks = await store.list();
    assert.equal(tasks.length, 24);
    assert.equal(new Set(created.map((task) => task.taskId)).size, 24);
    assert.deepEqual(new Set(tasks.map((task) => task.input.title)), new Set(Array.from({ length: 24 }, (_, index) => `任务 ${index}`)));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('相同飞书幂等键只创建一条任务', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-task-store-'));
  try {
    const store = new TaskStore(path.join(directory, 'runtime.json'));
    const [first, duplicate] = await Promise.all([
      store.createTask({ idempotencyKey: 'feishu:message-1', taskType: 'army.intake', input: { title: '检查系统状态' }, status: 'queued' }),
      store.createTask({ idempotencyKey: 'feishu:message-1', taskType: 'army.intake', input: { title: '检查系统状态' }, status: 'queued' })
    ]);
    assert.equal(first.taskId, duplicate.taskId);
    assert.equal((await store.list()).length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('并发状态更新不会互相覆盖字段', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-task-store-'));
  try {
    const store = new TaskStore(path.join(directory, 'runtime.json'));
    const task = await store.createTask({ taskType: 'army.intake', input: { title: '保留状态' }, status: 'queued', currentStage: 'queued_for_execution' });
    await Promise.all([
      store.updateTask(task.taskId, { status: 'running', currentStage: 'starting' }),
      store.updateTask(task.taskId, { execution: { executor: 'task-coordinator' } })
    ]);
    const saved = (await store.list()).find((item) => item.taskId === task.taskId);
    assert.equal(saved.status, 'running');
    assert.equal(saved.currentStage, 'starting');
    assert.deepEqual(saved.execution, { executor: 'task-coordinator' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('会话上下文只保存结构化事实，可在重启后继续接住追问', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-task-store-'));
  try {
    const filePath = path.join(directory, 'runtime.json');
    const store = new TaskStore(filePath);
    await store.setConversationContext('chat-safe-ref', { kind:'usage_report', recordedTaskCount:18, taskIds:['task-1'], expiresAt:'2026-07-23T00:00:00.000Z' });
    const restarted = new TaskStore(filePath);
    assert.deepEqual(await restarted.getConversationContext('chat-safe-ref'), {
      schemaVersion:'agent.army/conversation-context/v1',
      kind:'usage_report', recordedTaskCount:18, taskIds:['task-1'], expiresAt:'2026-07-23T00:00:00.000Z', updatedAt:(await store.getConversationContext('chat-safe-ref')).updatedAt
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
