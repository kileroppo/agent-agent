import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalExpiryReconciler } from '../src/approval-expiry-reconciler.js';

test('过期确认整理器会交给任务服务自动关闭旧确认', async () => {
  let calls = 0;
  const reconciler = new ApprovalExpiryReconciler({
    tasks:{ async expirePendingApprovals() { calls += 1; return [{ approval:{ approvalId:'approval-1' } }]; } }
  });
  const result = await reconciler.reconcile();
  assert.equal(result.status, 'synced');
  assert.equal(result.expired.length, 1);
  assert.equal(calls, 1);
});

test('任务服务暂时不可用时保留待重试状态', async () => {
  const reconciler = new ApprovalExpiryReconciler({ tasks:{ async expirePendingApprovals() { throw new Error('temporary unavailable'); } } });
  const result = await reconciler.reconcile();
  assert.equal(result.status, 'sync_pending');
  assert.equal(result.reason, '过期确认暂时无法自动整理。');
});
