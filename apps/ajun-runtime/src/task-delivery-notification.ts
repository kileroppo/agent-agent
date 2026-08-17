import {
  deliveryReceiptSummary,
  isDeliveryConfirmed,
  normalizeDeliveryReceipt,
} from './delivery-receipt-state.ts';

/**
 * Keeps the delivery truth separate from task execution truth: a readable
 * artifact can be successful while its external hand-off remains unconfirmed.
 */
export function taskDeliveryNotification(task: any, title: any): any {
  const receipt = taskDeliveryReceipt(task);
  if (!receipt || isDeliveryConfirmed(receipt)) return null;
  const summary: any = deliveryReceiptSummary(receipt);
  const action: any = summary?.action;
  const safeTitle = String(title || '这项任务').trim();
  const message: any = summary?.status === 'delivery_unknown'
    ? `“${safeTitle}”的业务产物已完成，但飞书交付结果不确定；系统已停止自动重发，不能把它说成你已经收到。${action ? ` 下一步：${action.label}。` : ''}`
    : summary?.status === 'failed'
      ? `“${safeTitle}”的业务产物已完成，但飞书交付尚未开始或明确失败；不能把它说成完整交付。${action ? ` 下一步：${action.label}。` : ''}`
      : `“${safeTitle}”的业务产物已完成，正在等待飞书交付确认；确认前不会把它说成完整交付。`;
  return Object.freeze({
    status:summary?.status || 'delivery_pending',
    message,
    deliveryReceipt:summary,
  });
}

function taskDeliveryReceipt(task: any): any {
  return normalizeDeliveryReceipt(task?.deliveryReceipt)
    || normalizeDeliveryReceipt(task?.delivery)
    || normalizeDeliveryReceipt(artifact(task, 'delivery_receipt')?.data)
    || normalizeDeliveryReceipt(artifact(task, 'external_delivery_receipt')?.data);
}

function artifact(task: any, type: any): any {
  return task?.artifactRefs?.find((item: any): any => item.type === type);
}
