import assert from 'node:assert/strict';
import test from 'node:test';
import { queryReconciliationTasks } from '../src/reconciliation-task-query.ts';

test('协调查询使用 taskType 和分页，不退回 store.list 全量读取', async () => {
  const calls = [];
  const store = {
    async list() { throw new Error('不应全量读取'); },
    async queryTasks(query) {
      calls.push(query);
      if (!query.cursor) return {
        items:[{ taskId:'repair-1', taskType:'operations.technical-repair', status:'running' }],
        nextCursor:'page-2',
      };
      return {
        items:[{ taskId:'repair-2', taskType:'operations.technical-repair', status:'succeeded' }],
        nextCursor:null,
      };
    },
  };

  const tasks = await queryReconciliationTasks(store, {
    taskType:'operations.technical-repair',
    views:['active'],
    predicate:(task) => task.status === 'running',
  });

  assert.deepEqual(tasks.map((task) => task.taskId), ['repair-1']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].taskType, 'operations.technical-repair');
  assert.equal(calls[0].view, 'active');
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[1].cursor, 'page-2');
});
