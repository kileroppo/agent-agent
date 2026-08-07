import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskRecordService } from '../src/task-record-service.js';

const task = {
  taskId:'11111111-1111-4111-8111-111111111111',
  status:'succeeded',
  taskType:'office.presentation-package',
  assigneeAgentId:'office-assistant',
  input:{ title:'整理汇报', description:'列表不需要返回的长任务正文' },
  artifactRefs:[{ type:'report', data:{ body:'列表不需要返回的大体积产物' } }],
  recordView:'completed',
  currentStage:'completed',
  createdAt:'2026-08-07T10:00:00.000Z',
  updatedAt:'2026-08-07T10:10:00.000Z',
};

test('任务记录列表只返回行摘要，完整正文和产物按选中详情读取', async () => {
  const service = new TaskRecordService({
    store:{
      queryTasks:async () => ({ items:[task], total:1, counts:{ needs_action:0, active:0, completed:1, all:1 } }),
      getTask:async () => task,
      listApprovals:async () => [],
    },
  });

  const page = await service.list({ view:'completed' });
  assert.equal(page.items[0].recordSummary, true);
  assert.equal(page.items[0].input.title, '整理汇报');
  assert.equal(Object.hasOwn(page.items[0].input, 'description'), false);
  assert.equal(Object.hasOwn(page.items[0], 'artifactRefs'), false);

  const detail = await service.detail(task.taskId);
  assert.equal(detail.input.description, '列表不需要返回的长任务正文');
  assert.deepEqual(detail.artifactRefs, task.artifactRefs);
});
