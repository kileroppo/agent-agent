import assert from 'node:assert/strict';
import test from 'node:test';
import { TechnicalRepairWatchdog } from '../src/technical-repair-watchdog.js';

function setup(tasks, governance = null) {
  const store = {
    async list() { return tasks; },
    async updateTask(taskId, patch) { const task = tasks.find((item) => item.taskId === taskId); Object.assign(task, patch); return task; }
  };
  return new TechnicalRepairWatchdog({ store, governance, now:() => Date.parse('2026-07-22T12:00:00.000Z'), staleAfterMs:90_000 });
}

test('过期且没有修复证据的本机修理任务会转为待测试', async () => {
  const tasks = [{ taskId:'repair-local', taskType:'operations.technical-repair', status:'running', currentStage:'isolated_workspace_ready', updatedAt:'2026-07-22T11:57:00.000Z', execution:{ executor:'technical-expert' } }];
  await setup(tasks).reconcile();
  assert.equal(tasks[0].status, 'waiting_test');
  assert.equal(tasks[0].currentStage, 'repair_waiting_for_test');
  assert.match(tasks[0].error.userMessage, /其他工作可以继续推进/);
});

test('新任务和仍在等待 Paperclip 真正开始的任务不会被看守器提前停下', async () => {
  const tasks = [
    { taskId:'repair-fresh', taskType:'operations.technical-repair', status:'running', currentStage:'isolated_workspace_ready', updatedAt:'2026-07-22T11:59:30.000Z' },
    { taskId:'repair-paperclip', taskType:'operations.technical-repair', status:'running', currentStage:'paperclip_engineering_assigned', updatedAt:'2026-07-22T11:50:00.000Z', governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' } }
  ];
  await setup(tasks).reconcile();
  assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[1].status, 'running');
});

test('Paperclip 指派的本机修理若超时无证据，也会两边一起转为待测试', async () => {
  const tasks = [{ taskId:'repair-paperclip-local', taskType:'operations.technical-repair', status:'running', currentStage:'isolated_workspace_ready', updatedAt:'2026-07-22T11:50:00.000Z', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'paperclip-tech-1' } }];
  let projected;
  await setup(tasks, { async update(task) { projected = task; return { ...task.governance, status:'synced' }; } }).reconcile();
  assert.equal(tasks[0].status, 'waiting_test');
  assert.equal(projected.status, 'waiting_test');
  assert.equal(tasks[0].governance.status, 'synced');
});

test('历史待测试任务会补同步给 Paperclip，避免治理台继续显示待开始', async () => {
  const tasks = [{ taskId:'repair-history', taskType:'operations.technical-repair', status:'waiting_test', currentStage:'repair_waiting_for_test', updatedAt:'2026-07-22T11:50:00.000Z', governance:{ paperclipIssueId:'issue-1', paperclipAssigneeAgentId:'paperclip-tech-1' }, execution:{} }];
  let projected;
  await setup(tasks, { async update(task) { projected = task; return { ...task.governance, status:'synced' }; } }).reconcile();
  assert.equal(projected.status, 'waiting_test');
  assert.equal(tasks[0].governance.status, 'synced');
  assert.ok(tasks[0].execution.paperclipWaitingTestSyncedAt);
});
