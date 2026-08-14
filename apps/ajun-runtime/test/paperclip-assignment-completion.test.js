import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipHermesTaskReconciler } from '../src/paperclip-hermes-task-reconciler.ts';
import { PaperclipAssignmentCompletion } from '../src/paperclip-assignment-completion.ts';
import { taskServiceExecutionMethods } from '../src/task-service-execution.ts';

function taskFixture(taskPatch = {}) {
  return {
    taskId:'task-1',
    status:'waiting_test',
    governance:{
      paperclipIssueId:'issue-1',
      completionSync:{
        status:'pending',
        paperclipIssueId:'issue-1',
        paperclipRunId:'run-1',
        taskStatus:'waiting_test',
        expectedIssueStatus:'blocked',
        requestedAt:'2026-08-13T10:00:00.000Z',
      },
    },
    ...taskPatch,
  };
}

test('PaperclipAssignmentCompletion 先读回已生效终态，再确认本地完成同步', async () => {
  const updates = [];
  const task = taskFixture();
  const protocol = new PaperclipAssignmentCompletion({
    store:{
      async updateTask(taskId, patch) {
        updates.push({ taskId, patch });
        return { ...task, ...patch };
      },
    },
    governance:{
      async getPaperclipIssue(issueId) {
        assert.equal(issueId, 'issue-1');
        return { status:'blocked' };
      },
      async completePaperclipIssue() {
        throw new Error('should not complete again');
      },
    },
    now:() => '2026-08-13T10:01:00.000Z',
  });

  const updated = await protocol.ensure(task, {
    issueId:'issue-1',
    runId:'run-1',
  }, {
    paperclipAgentId:'paperclip-agent-1',
    apiKey:'secret',
  });

  assert.equal(updates.length, 1);
  assert.equal(updated.governance.completionSync.status, 'confirmed');
  assert.equal(updated.governance.completionSync.expectedIssueStatus, 'blocked');
  assert.equal(updated.governance.syncedAt, '2026-08-13T10:01:00.000Z');
});

test('PaperclipAssignmentCompletion 用同一个 Interface 收口重启后的 pending completion', async () => {
  let task = taskFixture({
    status:'failed',
    governance:{
      paperclipIssueId:'issue-1',
      completionSync:{
        status:'pending',
        paperclipIssueId:'issue-1',
        paperclipRunId:'run-1',
        taskStatus:'failed',
        expectedIssueStatus:'blocked',
        requestedAt:'2026-08-13T10:00:00.000Z',
      },
    },
  });
  const protocol = new PaperclipAssignmentCompletion({
    store:{
      async updateTask(taskId, patch) {
        assert.equal(taskId, 'task-1');
        task = { ...task, ...patch };
        return task;
      },
    },
    governance:{
      async getPaperclipIssue() {
        return { status:'blocked' };
      },
    },
    now:() => '2026-08-13T10:02:00.000Z',
  });

  const updated = await protocol.reconcilePending(task);

  assert.equal(updated.governance.completionSync.status, 'confirmed');
  assert.equal(updated.governance.completionSync.taskStatus, 'failed');
  assert.equal(updated.governance.syncedAt, '2026-08-13T10:02:00.000Z');
});

test('TaskService 的完成同步仍经过公开 confirm seam，兼容构造后 override/spy', async () => {
  const service = {
    governance:{
      async getPaperclipIssue() {
        return { status:'blocked' };
      },
      async completePaperclipIssue() {
        throw new Error('should not complete again');
      },
    },
    async syncM5StageWorkProducts() {
      throw new Error('should not sync succeeded artifacts');
    },
  };
  Object.assign(service, taskServiceExecutionMethods);
  const calls = [];
  service.confirmPaperclipAssignmentCompletion = async (task, assignment) => {
    calls.push({ taskId:task.taskId, issueId:assignment.issueId, runId:assignment.runId });
    return { ...task, governance:{ ...(task.governance || {}), via:'public-confirm-seam' } };
  };

  const updated = await service.ensurePaperclipAssignmentCompletion({
    task:taskFixture(),
    assignment:{ issueId:'issue-1', runId:'run-1' },
    paperclipAgentId:'paperclip-agent-1',
    apiKey:'secret',
  });

  assert.deepEqual(calls, [{ taskId:'task-1', issueId:'issue-1', runId:'run-1' }]);
  assert.equal(updated.governance.via, 'public-confirm-seam');
});

test('Reconciler 的 pending completion 在构造后替换 store/governance/now 仍读取最新依赖', async () => {
  let task = taskFixture();
  const reconciler = new PaperclipHermesTaskReconciler({
    store:{ async list() { return []; }, async updateTask() { throw new Error('stale store'); } },
    governance:{ async getPaperclipIssue() { throw new Error('stale governance'); } },
    now:() => Date.parse('2026-08-13T09:59:00.000Z'),
  });
  reconciler.store = {
    async list() { return [task]; },
    async updateTask(taskId, patch) {
      assert.equal(taskId, 'task-1');
      task = { ...task, ...patch };
      return task;
    },
  };
  reconciler.governance = {
    async getPaperclipIssue(issueId) {
      assert.equal(issueId, 'issue-1');
      return { status:'blocked' };
    },
  };
  reconciler.now = () => Date.parse('2026-08-13T10:03:00.000Z');

  await reconciler.reconcilePendingCompletion(task);

  assert.equal(task.governance.completionSync.status, 'confirmed');
  assert.equal(task.governance.syncedAt, '2026-08-13T10:03:00.000Z');
});
