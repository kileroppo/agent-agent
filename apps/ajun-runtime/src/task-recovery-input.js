import { safeText } from './task-recovery-policy.js';

const ACTION_KEYS = Object.freeze([
  'use_confirmed_transcript_only',
  'request_safe_recovery',
  'request_read_only_diagnosis',
  'retry_visual_analysis_after_recovery',
]);

export class TaskRecoveryError extends Error {
  constructor(message, { code = 'task_recovery_invalid', httpStatus = 422 } = {}) {
    super(message);
    this.name = 'TaskRecoveryError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function cleanActionKey(value) {
  const normalized = String(value || '').trim();
  if (!ACTION_KEYS.includes(normalized)) throw recoveryError('恢复动作无效。', 'task_recovery_action_invalid', 422);
  return normalized;
}

export function cleanRequestId(value) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{7,127}$/.test(normalized)) {
    throw recoveryError('恢复请求缺少有效幂等键。', 'task_recovery_idempotency_required', 422);
  }
  return normalized;
}

export function cleanActor(actor) {
  return {
    kind:'local-owner',
    ref:safeText(actor?.ref || actor?.requestedBy || 'A君', 120) || 'A君',
  };
}

export function recoveryError(message, code, httpStatus) {
  return new TaskRecoveryError(message, { code, httpStatus });
}
