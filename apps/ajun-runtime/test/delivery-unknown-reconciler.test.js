import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryUnknownReconciler } from '../src/workflow/delivery-unknown-reconciler.ts';

test('DeliveryUnknownReconciler 通过反查探针将已送达消息收敛为 delivered', async () => {
  const now = 1700000000000;
  const tasks = [
    {
      taskId: 'task-unknown-1',
      status: 'succeeded',
      deliveryReceipt: {
        deliveryId: 'del-1',
        status: 'delivery_unknown',
        channel: 'feishu',
        unknownAt: new Date(now - 1000).toISOString(),
      },
    },
  ];

  const store = {
    async list() { return tasks; },
    async save(t) {
      const idx = tasks.findIndex((i) => i.taskId === t.taskId);
      if (idx >= 0) tasks[idx] = t;
    },
  };

  const deliveryProbe = {
    async queryDeliveryStatus({ deliveryId }) {
      if (deliveryId === 'del-1') {
        return { status: 'delivered', messageId: 'msg-feishu-100', observedAt: new Date(now).toISOString() };
      }
      return null;
    },
  };

  const reconciler = new DeliveryUnknownReconciler({
    store,
    deliveryProbe,
    now: () => now,
  });

  const res = await reconciler.reconcile({ now });
  assert.equal(res.status, 'reconciled');
  assert.equal(res.resolvedCount, 1);
  assert.equal(tasks[0].deliveryReceipt.status, 'delivered');
  assert.equal(tasks[0].deliveryReceipt.evidence.type, 'readback_probe');
  assert.equal(tasks[0].deliveryReceipt.evidence.reference, 'msg-feishu-100');
});

test('DeliveryUnknownReconciler 对未送达消息在有效期内触发单次受控补偿重发', async () => {
  const now = 1700000000000;
  const tasks = [
    {
      taskId: 'task-unknown-2',
      status: 'succeeded',
      deliveryReceipt: {
        deliveryId: 'del-2',
        status: 'delivery_unknown',
        channel: 'feishu',
        unknownAt: new Date(now - 1000).toISOString(),
      },
    },
  ];

  const store = {
    async list() { return tasks; },
    async save(t) {
      const idx = tasks.findIndex((i) => i.taskId === t.taskId);
      if (idx >= 0) tasks[idx] = t;
    },
  };

  let retrySent = 0;
  const deliverySender = {
    async sendDelivery(t) {
      retrySent += 1;
      return { success: true, messageId: 'msg-retry-ok' };
    },
  };

  const reconciler = new DeliveryUnknownReconciler({
    store,
    deliverySender,
    now: () => now,
  });

  const res = await reconciler.reconcile({ now });
  assert.equal(res.status, 'reconciled');
  assert.equal(retrySent, 1);
  assert.equal(tasks[0].deliveryReceipt.status, 'delivered');
  assert.equal(tasks[0].deliveryReceipt.evidence.type, 'retry_sender');
  assert.equal(tasks[0].deliveryReceipt.evidence.reference, 'msg-retry-ok');
});

test('DeliveryUnknownReconciler 超出有效核对窗口自动收敛为明确的 failed', async () => {
  const now = 1700000000000;
  const tasks = [
    {
      taskId: 'task-unknown-3',
      status: 'succeeded',
      deliveryReceipt: {
        deliveryId: 'del-3',
        status: 'delivery_unknown',
        channel: 'feishu',
        unknownAt: new Date(now - 48 * 3600 * 1000).toISOString(), // 48h ago (> 24h)
      },
    },
  ];

  const store = {
    async list() { return tasks; },
    async save(t) {
      const idx = tasks.findIndex((i) => i.taskId === t.taskId);
      if (idx >= 0) tasks[idx] = t;
    },
  };

  const reconciler = new DeliveryUnknownReconciler({
    store,
    now: () => now,
  });

  const res = await reconciler.reconcile({ now });
  assert.equal(res.status, 'reconciled');
  assert.equal(res.failedCount, 1);
  assert.equal(tasks[0].deliveryReceipt.status, 'failed');
  assert.equal(tasks[0].deliveryReceipt.errorCode, 'delivery_verification_timeout');
});
