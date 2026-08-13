import assert from 'node:assert/strict';
import test from 'node:test';

import { PaperclipApprovalResolution } from '../src/paperclip-approval-resolution.js';
import { ValidationError } from '../src/task-service.js';

test('Paperclip 审批 Interface 跨 Module 实例共享单飞并拒绝相反决定', async () => {
  const approval = {
    approvalId:'approval-1',
    taskId:'task-1',
    status:'pending',
    governanceMode:'paperclip',
    requestedScope:{ taskType:'operations.health-review', title:'审批回归', assigneeAgentId:'operator' },
  };
  const task = {
    taskId:'task-1',
    taskType:'operations.health-review',
    status:'waiting_approval',
    assigneeAgentId:'operator',
    input:{ title:'审批回归' },
    governance:{ paperclipApprovalId:'paperclip-approval-1' },
  };
  let releaseDecision;
  let resolutions = 0;
  const service = {
    approvalResolutionRuns:new Map(),
    governance:{
      async resolveApproval() {
        resolutions += 1;
        await new Promise((resolve) => { releaseDecision = resolve; });
        return { status:'approved' };
      },
    },
    registry:{ async list() { return [{ agentId:'operator' }]; } },
    store:{
      async listApprovals() { return [approval]; },
      async list() { return [task]; },
      async updateApproval(_id, patch) { Object.assign(approval, patch); return approval; },
      async resolveApprovalAndUpdateTask(_approvalId, approvalPatch, _taskId, taskPatch) {
        Object.assign(approval, approvalPatch);
        Object.assign(task, taskPatch);
        return { approval, task };
      },
    },
    async executeTask(value) { return { ...value, status:'succeeded' }; },
  };

  const first = new PaperclipApprovalResolution(service).resolve('approval-1', 'approve');
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = new PaperclipApprovalResolution(service).resolve('approval-1', 'approve');
  await assert.rejects(
    new PaperclipApprovalResolution(service).resolve('approval-1', 'reject'),
    (error) => error instanceof ValidationError && error.code === 'approval_resolution_conflict',
  );
  releaseDecision();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(resolutions, 1);
  assert.equal(firstResult.status, 'succeeded');
  assert.equal(duplicateResult.status, 'succeeded');
  assert.equal(approval.status, 'approved');
  assert.equal(service.approvalResolutionRuns.size, 0);
});

test('Paperclip 审批 Interface 保持公开 ValidationError identity', async () => {
  const resolution = new PaperclipApprovalResolution({ approvalResolutionRuns:new Map() });
  await assert.rejects(
    Promise.resolve().then(() => resolution.resolve('approval-1', 'invalid')),
    (error) => error instanceof ValidationError && error.message === '组织级审批决定无效。',
  );
});

test('Paperclip 审批整理器保持存储顺序、公开解析路径与 300 字错误截断', async () => {
  const approvals = [
    pendingDecision('approval-1', 'approve'),
    pendingDecision('approval-2', 'reject'),
    { ...pendingDecision('approval-ignored', 'approve'), status:'approved' },
    pendingDecision('approval-3', 'approve'),
  ];
  const calls = [];
  const longReason = '失'.repeat(320);
  const service = {
    store:{ async listApprovals() { return approvals; } },
    async resolvePaperclipApproval(approvalId, decision, options) {
      calls.push({ approvalId, decision, options });
      if (approvalId === 'approval-2') throw new Error(longReason);
      return { taskId:`task-for-${approvalId}` };
    },
  };

  const results = await new PaperclipApprovalResolution(service).reconcile();

  assert.deepEqual(calls.map(({ approvalId }) => approvalId), ['approval-1', 'approval-2', 'approval-3']);
  assert.deepEqual(calls[0], {
    approvalId:'approval-1',
    decision:'approve',
    options:{ decisionBy:'by-approval-1', decisionReason:'reason-approval-1', chatRef:'chat-approval-1' },
  });
  assert.deepEqual(results, [
    { approvalId:'approval-1', status:'reconciled', taskId:'task-for-approval-1' },
    { approvalId:'approval-2', status:'sync_pending', reason:longReason.slice(0, 300) },
    { approvalId:'approval-3', status:'reconciled', taskId:'task-for-approval-3' },
  ]);
});

function pendingDecision(approvalId, decision) {
  return {
    approvalId,
    status:'pending',
    governanceMode:'paperclip',
    externalDecision:{
      state:'resolving',
      decision,
      decisionBy:`by-${approvalId}`,
      decisionReason:`reason-${approvalId}`,
      chatRef:`chat-${approvalId}`,
    },
  };
}
