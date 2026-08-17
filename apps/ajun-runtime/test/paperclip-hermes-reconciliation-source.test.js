import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipHermesReconciliationSource } from '../src/paperclip-hermes-reconciliation-source.ts';

test('Hermes 启动时只做一次历史发现，后续只查活跃任务和已跟踪任务', async () => {
  let task = {
    taskId:'hermes-1',
    taskType:'governance.architecture-review',
    status:'running',
    execution:{ owner:'paperclip-hermes' },
    governance:{ paperclipIssueId:'issue-1' },
  };
  const queries = [];
  const store = {
    async queryTasks(query) {
      queries.push(query.view);
      const active = query.view === 'active' && task.status === 'running' ? [task] : [];
      const all = query.view === 'all' ? [task] : [];
      return { items:active.length ? active : all, nextCursor:null };
    },
    async getTask() { return task; },
  };
  const source = new PaperclipHermesReconciliationSource(store);

  assert.deepEqual((await source.list()).map((item) => item.taskId), ['hermes-1']);
  task = { ...task, status:'succeeded', execution:{ outcome:'verified_artifact_ready' } };
  assert.deepEqual(await source.list(), []);

  assert.deepEqual(queries, ['active', 'all', 'active']);
});
