import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskNotification } from '../src/task-notification.ts';

function completedTask(receipt) {
  return {
    taskId:'delivery-task', taskType:'report.public-material', status:'succeeded',
    input:{ title:'整理公开资料' }, source:{ chatRef:'chat-a' },
    artifactRefs:[{
      type:'public_web_report', validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ summary:'已整理出公开资料。' },
    }],
    ...(receipt ? { deliveryReceipt:receipt } : {}),
  };
}

test('业务产物成功但飞书送达未知时，通知不能冒充完整交付', async () => {
  const task = completedTask({
    deliveryId:'receipt-unknown', status:'delivery_unknown', channel:'feishu',
    evidence:{ type:'send_started', observedAt:'2026-08-17T00:00:00.000Z' },
  });
  const notification = new TaskNotification({
    store:{ list:async () => [task], listApprovals:async () => [] }, registry:{ get:async () => null },
  });
  const result = await notification.status(task.taskId, 'chat-a');
  assert.equal(result.status, 'delivery_unknown');
  assert.equal(result.deliveryReceipt.confirmed, false);
  assert.equal(result.deliveryReceipt.action.action, 'verify_delivery');
  assert.match(result.message, /不能把它说成你已经收到/);
});

test('有可核验送达回执后，通知才恢复完整业务交付文本', async () => {
  const task = completedTask({
    deliveryId:'receipt-delivered', status:'delivered', channel:'feishu',
    evidence:{ type:'provider_message_acknowledged', observedAt:'2026-08-17T00:00:00.000Z', reference:'msg-1' },
  });
  const notification = new TaskNotification({
    store:{ list:async () => [task], listApprovals:async () => [] }, registry:{ get:async () => null },
  });
  const result = await notification.status(task.taskId, 'chat-a');
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /已整理出公开资料/);
});
