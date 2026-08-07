import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterTaskRecords,
  selectTaskRecordFilter,
} from '../public/task-record-filter.js';

const tasks = [
  { taskId:'task-completed', status:'succeeded' },
  { taskId:'task-active', status:'running' },
  { taskId:'task-attention', status:'failed' },
];

test('单任务详情中点击记录筛选会退出详情并按新状态显示列表', () => {
  assert.deepEqual(
    filterTaskRecords(tasks, { selectedTaskId:'task-completed', statusFilter:'active' }),
    [tasks[0]],
  );

  const selection = selectTaskRecordFilter('task-completed', 'active');

  assert.deepEqual(selection, {
    selectedTaskId:'',
    currentTaskFilter:'active',
    exitedTaskDetail:true,
  });
  assert.deepEqual(
    filterTaskRecords(tasks, {
      selectedTaskId:selection.selectedTaskId,
      statusFilter:selection.currentTaskFilter,
    }),
    [tasks[1]],
  );
});

test('普通记录页切换筛选不会触发退出详情导航', () => {
  assert.deepEqual(selectTaskRecordFilter('', 'completed'), {
    selectedTaskId:'',
    currentTaskFilter:'completed',
    exitedTaskDetail:false,
  });
});
