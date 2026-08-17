import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryReceiptSummary,
  deliveryRecoveryAction,
  isDeliveryConfirmed,
  normalizeDeliveryReceipt,
} from '../src/delivery-receipt-state.ts';

test('旧 uncertain 状态兼容迁移为 delivery_unknown，且不保留自由文本错误', () => {
  const receipt = normalizeDeliveryReceipt({
    deliveryId:'receipt-1', state:'uncertain', reason:'Authorization: Bearer secret-value',
  });
  assert.equal(receipt.status, 'delivery_unknown');
  assert.equal(receipt.errorCode, 'delivery_outcome_unknown');
  assert.deepEqual(deliveryRecoveryAction(receipt), {
    action:'verify_delivery', label:'核对飞书送达',
    message:'交付结果不确定，已停止自动重发；请先核对原会话，再决定是否恢复发送。',
  });
});

test('已送达必须同时有回执证据，才允许被视为完整交付', () => {
  const withoutEvidence = normalizeDeliveryReceipt({ deliveryId:'receipt-2', status:'delivered' });
  const confirmed = normalizeDeliveryReceipt({
    deliveryId:'receipt-3', status:'delivered',
    evidence:{ type:'provider_message_acknowledged', observedAt:'2026-08-17T00:00:00.000Z', reference:'msg-3' },
  });
  assert.equal(isDeliveryConfirmed(withoutEvidence), false);
  assert.equal(isDeliveryConfirmed(confirmed), true);
  assert.equal(deliveryReceiptSummary(confirmed).confirmed, true);
});

test('回执证据引用移除 URL 查询凭据并拒绝敏感自由文本', () => {
  const url = normalizeDeliveryReceipt({
    deliveryId:'receipt-url', status:'delivered',
    evidence:{ type:'provider_ack', observedAt:'2026-08-17T00:00:00.000Z', reference:'https://example.com/message/1?token=secret#fragment' },
  });
  const secret = normalizeDeliveryReceipt({
    deliveryId:'receipt-secret', status:'delivered',
    evidence:{ type:'provider_ack', observedAt:'2026-08-17T00:00:00.000Z', reference:'Bearer secret-value' },
  });
  assert.equal(url.evidence.reference, 'https://example.com/message/1');
  assert.equal(secret.evidence.reference, undefined);
});
