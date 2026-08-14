import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-board-'));
process.env.PROGRESS_BOARD_DB = path.join(tempDir, 'test.sqlite');
const store = await import(`../src/store.ts?test=${Date.now()}`);

test('seeds multiple projects and calculates dashboard progress', () => {
  const data = store.dashboard();
  assert.equal(data.projects.length, 3);
  assert.ok(data.stats.progress > 0);
  assert.ok(data.focusTasks.some((task) => task.status === 'blocked'));
});

test('creates a project and task, then updates task status', () => {
  const project = store.createProject({ name: '测试项目', currentPhase: '第一阶段' });
  const task = store.createTask(project.id, { title: '验证看板', phase: '第一阶段', nextAction: '打开浏览器' });
  assert.equal(task.status, 'todo');
  const updated = store.updateTask(task.id, { status: 'done', progress: 20 });
  assert.equal(updated.status, 'done');
  assert.equal(updated.progress, 100);
  assert.equal(store.getProject(project.id).stats.done, 1);
});

test('rejects empty project and task names', () => {
  assert.throws(() => store.createProject({ name: ' ' }), /项目名称不能为空/);
  const project = store.createProject({ name: '校验项目' });
  assert.throws(() => store.createTask(project.id, { title: '' }), /任务名称不能为空/);
});
