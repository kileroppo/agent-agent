import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTaskService } from './support/task-service-fixture.js';

test('TaskApprovalLifecycle 撤销微信临时授权并返回真实状态', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({ taskId:'wechat-task', source:{ chatRef:'chat-a' } });
  records.approvals.push({
    approvalId:'approval-1', taskId:'wechat-task', action:'wechat-private-chat-read', status:'approved',
    privateReadGrant:{ grantId:'grant-1', maxUses:10, uses:[{ taskId:'task-1' }], expiresAt:'2099-01-01T00:00:00.000Z', revokedAt:null },
  });
  const revoked = await service.revokePrivateReadGrant('approval-1', { chatRef:'chat-a', revokedBy:'feishu-owner' });
  assert.equal(revoked.privateReadGrant.revokedBy, 'feishu-owner');
  assert.equal(revoked.privateReadGrantStatus.status, 'revoked');
  assert.equal(revoked.privateReadGrantStatus.remainingUses, 9);
});

test('TaskApprovalLifecycle 拒绝跨会话撤销临时授权', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({ taskId:'wechat-task', source:{ chatRef:'chat-a' } });
  records.approvals.push({
    approvalId:'approval-1', taskId:'wechat-task', action:'wechat-private-chat-read', status:'approved',
    privateReadGrant:{ grantId:'grant-1', maxUses:10, uses:[], expiresAt:'2099-01-01T00:00:00.000Z', revokedAt:null },
  });
  await assert.rejects(
    () => service.revokePrivateReadGrant('approval-1', { chatRef:'chat-b' }),
    /会话与原任务不一致/,
  );
});

test('TaskApprovalLifecycle 过期持有型审批时关闭原任务并同步 Paperclip', async () => {
  const updated = [];
  const governance = { async update(task) { updated.push(task); return { ...task.governance, status:'synced' }; } };
  const { service, records } = setupTaskService({ governance });
  records.tasks.push({ taskId:'old-task', status:'waiting_approval', approvalRefs:['old-approval'], governance:{ paperclipIssueId:'issue-old' } });
  records.approvals.push({ approvalId:'old-approval', taskId:'old-task', status:'pending', validUntil:'2020-01-01T00:00:00.000Z' });
  const expired = await service.expirePendingApprovals();
  assert.equal(expired.length, 1);
  assert.equal(records.approvals[0].status, 'expired');
  assert.equal(records.tasks[0].status, 'cancelled');
  assert.equal(records.tasks[0].currentStage, 'approval_expired');
  assert.equal(records.tasks[0].error.code, 'approval_expired');
  assert.equal(updated.length, 1);
});

test('TaskApprovalLifecycle 过期非持有型控制审批时不关闭原任务', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({ taskId:'media-1', status:'running', execution:{ control:{ action:'pause-task', status:'waiting_approval' } } });
  records.approvals.push({ approvalId:'control-approval', taskId:'media-1', action:'pause-task', holdTask:false, status:'pending', validUntil:'2020-01-01T00:00:00.000Z' });
  await service.expirePendingApprovals();
  assert.equal(records.approvals[0].status, 'expired');
  assert.equal(records.tasks[0].status, 'running');
  assert.equal(records.tasks[0].execution.control.status, 'expired');
});
