import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskFocus } from '../src/task-overview-focus.js';

test('任务概览只把业务任务计入进行中并保留后台计数', () => {
  const tasks = [
    { taskId:'business', status:'running', input:{ title:'业务工作' }, approvalRefs:[] },
    {
      taskId:'routine',
      taskType:'operations.health-review',
      status:'running',
      source:{ channel:'paperclip' },
      input:{ title:'A君定时本机巡检' },
      approvalRefs:[],
    },
  ];
  const focus = buildTaskFocus(tasks, []);
  assert.equal(focus.inProgress, 1);
  assert.equal(focus.backgroundInProgress, 1);
  assert.equal(focus.next.taskId, 'business');
});

test('任务概览返回最多五条老板待办', () => {
  const tasks = Array.from({ length:7 }, (_, index) => ({
    taskId:`approval-${index}`,
    status:'waiting_approval',
    input:{ title:`待确认 ${index}` },
    approvalRefs:[],
  }));
  const focus = buildTaskFocus(tasks, []);
  assert.equal(focus.ownerActionable, 7);
  assert.equal(focus.actions.length, 5);
});
