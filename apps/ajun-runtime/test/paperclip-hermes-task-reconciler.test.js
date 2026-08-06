import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipHermesTaskReconciler } from '../src/paperclip-hermes-task-reconciler.js';

function setup({ issueStatus, artifactRefs = [], taskType = 'governance.architecture-review', error = null, issueError = null }) {
  let task = {
    taskId:'task-1',
    taskType,
    status:'running',
    currentStage:'paperclip_hermes_running',
    execution:{ owner:'paperclip-hermes' },
    governance:{ paperclipIssueId:'issue-1' },
    artifactRefs,
    error
  };
  const store = {
    async list() { return [task]; },
    async updateTask(taskId, patch) {
      assert.equal(taskId, task.taskId);
      task = { ...task, ...patch };
      return task;
    }
  };
  const governance = {
    async getPaperclipIssue() {
      if (issueError) throw issueError;
      return { status:issueStatus };
    }
  };
  const reconciler = new PaperclipHermesTaskReconciler({
    store,
    governance,
    now:() => Date.parse('2026-07-28T10:00:00.000Z')
  });
  return { reconciler, get task() { return task; } };
}

test('Paperclip 已取消的 Hermes 任务会收口为已取消', async () => {
  const fixture = setup({ issueStatus:'cancelled' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'cancelled');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_cancelled');
  assert.equal(fixture.task.execution.outcome, 'cancelled_in_paperclip');
});

test('Paperclip 已阻塞且没有本地产物时如实记为失败', async () => {
  const fixture = setup({ issueStatus:'blocked' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_failed');
  assert.equal(fixture.task.error.code, 'paperclip_hermes_failed');
});

test('Paperclip 已阻塞但留有可读产物时转为待测试而不冒充成功', async () => {
  const priorError = { code:'paperclip_hermes_reported_failure', userMessage:'员工回报失败。' };
  const fixture = setup({
    issueStatus:'blocked',
    error:priorError,
    artifactRefs:[{
      type:'video_content_analysis_report',
      validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:false }
    }]
  });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_waiting_test');
  assert.equal(fixture.task.error, priorError);
});

test('Paperclip 标记完成但缺少本地证据时转为待测试', async () => {
  const fixture = setup({ issueStatus:'done' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_evidence_missing');
});

test('Paperclip 暂时不可用时不刷新或改写任务真相', async () => {
  const fixture = setup({ issueError:new Error('connect refused') });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_running');
});

test('技术修复任务继续交由专用收口器处理', async () => {
  const fixture = setup({ issueStatus:'blocked', taskType:'operations.technical-repair' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
});
