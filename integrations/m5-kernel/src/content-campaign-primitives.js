const CASE_ID = /^[0-9a-f-]{8,80}$/i;
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function safeId(value, message) {
  const id = String(value || '').trim();
  if (!CASE_ID.test(id)) throw new ContentCampaignError(message);
  return id;
}

export function safeReceiptId(value) {
  const id = String(value || '').trim();
  if (!RECEIPT_ID.test(id)) throw new ContentCampaignError('发布凭证标识无效。');
  return id;
}

export function safeOpaqueId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id) ? id : null;
}

export function safeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function asList(value) {
  return Array.isArray(value) ? value : [];
}
import { ContentCampaignError } from './campaign-domain.js';
