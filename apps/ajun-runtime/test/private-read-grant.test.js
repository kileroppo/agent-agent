import assert from 'node:assert/strict';
import test from 'node:test';
import { consumePrivateReadGrant, privateReadGrantStatus, resolvePrivateReadGrant, revokePrivateReadGrant } from '../src/private-read-grant.js';

const now = new Date('2026-08-02T02:00:00.000Z');
const scope = { chatSelector:'项目群', startTime:'2026-08-02T00:00:00.000Z', endTime:'2026-08-02T02:00:00.000Z', maxMessages:200 };
const task = { taskId:'task-1', assigneeAgentId:'wechat-chat-retriever', input:{ context:{ feishuChatRef:'oc_owner' } } };

function approval() {
  return { approvalId:'approval-1', taskId:'task-1', action:'wechat-private-chat-read', status:'approved', decisionBy:'owner', validUntil:'2026-08-02T02:30:00.000Z', requestedScope:scope };
}

test('批准创建 30 分钟且最多 10 次的绑定授权，同任务重试不重复扣次', () => {
  const resolved = resolvePrivateReadGrant({ approvals:[approval()], task, expectedScope:scope, now });
  assert.equal(resolved.created, true);
  assert.equal(resolved.grant.maxUses, 10);
  assert.equal(resolved.grant.feishuChatRef, 'oc_owner');
  const first = consumePrivateReadGrant(resolved.grant, { taskId:'task-1', now });
  const retried = consumePrivateReadGrant(first, { taskId:'task-1', now:new Date(now.getTime() + 1_000) });
  assert.equal(retried.uses.length, 1);
  assert.equal(privateReadGrantStatus(retried, { now }).remainingUses, 9);
});

test('改变会话范围、过期或撤销后不能复用授权', () => {
  const created = resolvePrivateReadGrant({ approvals:[approval()], task, expectedScope:scope, now }).grant;
  const stored = { ...approval(), privateReadGrant:created };
  assert.equal(resolvePrivateReadGrant({ approvals:[stored], task:{ ...task, taskId:'task-2' }, expectedScope:{ ...scope, maxMessages:100 }, now }), null);
  const revoked = revokePrivateReadGrant(created, { now });
  assert.equal(privateReadGrantStatus(revoked, { now }).status, 'revoked');
  assert.throws(() => consumePrivateReadGrant(revoked, { taskId:'task-2', now }), (error) => error.code === 'private_read_grant_unavailable');
});
