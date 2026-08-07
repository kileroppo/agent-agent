import crypto from 'node:crypto';
import { coded } from './policy.js';

const METRIC_RECOVERY_ACTION = 'publisher.reconcile_stale_attempt';
const METRIC_RECOVERY_CONCLUSIONS = new Set([
  'no_external_effect',
  'external_effect_verified',
]);
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class MetricInvocationRecovery {
  constructor({
    repository,
    paperclipControl,
    clock,
    pauseInPaperclip,
    activateGlobalHardStop,
  }) {
    this.repository = repository;
    this.paperclipControl = paperclipControl;
    this.clock = clock;
    this.pauseInPaperclip = pauseInPaperclip;
    this.activateGlobalHardStop = activateGlobalHardStop;
  }

  async assertCurrentAuthorization(target, attemptId) {
    const checkedAt = validGatewayClock(this.clock()).toISOString();
    let authorization;
    try {
      authorization = await this.paperclipControl.assertMetricRecoveryAllowed({
        action:METRIC_RECOVERY_ACTION,
        campaignId:target.campaignId,
        receiptId:target.receiptId,
        collectionKey:target.collectionKey,
        attemptId,
        conclusion:target.conclusion,
        authorizationId:target.authorizationId,
        evidenceRef:target.evidenceRef,
        checkedAt,
      });
    } catch {
      throw coded(
        'metric_recovery_unauthorized',
        'Paperclip 未确认负责人已核对该指标外部调用，账本保持 invoking。',
      );
    }
    validateMetricRecoveryAuthorization(authorization, {
      ...target,
      attemptId,
    });
    return { authorization, checkedAt };
  }

  async reconcile(input = {}) {
    const target = normalizeMetricRecoveryInput(input);
    const attemptKey = `metric:${target.collectionKey}`;
    const initialState = await this.repository.read();
    const initial = metricRecoveryTarget(initialState, target);
    if (initial.recovery) {
      if (
        initial.recovery.authorizationId === target.authorizationId
        && initial.recovery.conclusion === target.conclusion
        && initial.recovery.evidenceRef === target.evidenceRef
      ) {
        return {
          replayed:true,
          recovery:publicMetricRecovery(initial.recovery),
        };
      }
      throw coded(
        'metric_recovery_already_resolved',
        '该指标调用已经由另一份人工核对结论处理，拒绝覆盖。',
      );
    }
    if (initial.attempt.state !== 'invoking') {
      throw coded(
        'metric_recovery_not_required',
        '只有外部调用终止状态未确认的 invoking 指标 attempt 才允许人工核对恢复。',
      );
    }
    if (!validMetricRecoveryClaimToken(initial.attempt.claimToken)) {
      throw coded(
        'metric_recovery_claim_invalid',
        'invoking 指标 attempt 缺少有效持久 claimToken，拒绝在无法确认调用所有权时套用人工核对结论。',
      );
    }
    if (metricRecoveryAuthorizationOwner(initialState, target.authorizationId)) {
      throw coded(
        'metric_recovery_authorization_reused',
        '该 Paperclip 人工核对授权已用于另一指标 attempt，拒绝跨检查点或跨活动重放。',
      );
    }
    if (typeof this.paperclipControl.assertMetricRecoveryAllowed !== 'function') {
      throw coded(
        'paperclip_metric_recovery_control_required',
        '指标未决调用恢复必须注入独立的 Paperclip 人工核对授权适配器。',
      );
    }
    await this.assertCurrentAuthorization(target, initial.attempt.attemptId);
    const {
      authorization,
      checkedAt,
    } = await this.assertCurrentAuthorization(target, initial.attempt.attemptId);
    const recovery = {
      recoveryId:metricRecoveryId(target.authorizationId),
      action:METRIC_RECOVERY_ACTION,
      conclusion:target.conclusion,
      authorizationId:target.authorizationId,
      approvalRef:authorization.approvalRef,
      evidenceRef:target.evidenceRef,
      resolvedAt:checkedAt,
    };
    if (target.conclusion === 'external_effect_verified') {
      await this.pauseInPaperclip({
        idempotencyKey:attemptKey,
        campaignId:target.campaignId,
        reason:'metric_invocation_external_effect_verified',
        now:new Date(checkedAt),
      });
    }
    let committed;
    try {
      committed = await this.repository.update((state) => {
        const current = metricRecoveryTarget(state, target);
        if (current.recovery) {
          return (
            current.recovery.authorizationId === target.authorizationId
            && current.recovery.conclusion === target.conclusion
            && current.recovery.evidenceRef === target.evidenceRef
          )
            ? { kind:'replay', recovery:current.recovery }
            : { kind:'already_resolved' };
        }
        if (metricRecoveryAuthorizationOwner(state, target.authorizationId)) {
          return { kind:'authorization_reused' };
        }
        if (
          current.attempt.state !== 'invoking'
          || current.attempt.attemptId !== initial.attempt.attemptId
          || current.attempt.claimToken !== initial.attempt.claimToken
        ) {
          return { kind:'changed' };
        }
        current.attempt.state = target.conclusion === 'no_external_effect'
          ? 'failed'
          : 'blocked';
        current.attempt.stopReason = target.conclusion === 'no_external_effect'
          ? 'metric_invocation_confirmed_no_external_effect'
          : 'metric_invocation_external_effect_verified';
        current.attempt.hardStop = target.conclusion === 'external_effect_verified';
        current.attempt.metricRecovery = recovery;
        current.attempt.updatedAt = checkedAt;
        delete current.attempt.claimToken;
        delete current.attempt.claimExpiresAt;
        return { kind:'recorded', recovery };
      });
    } catch (error) {
      if (target.conclusion === 'external_effect_verified') {
        await this.activateGlobalHardStop({
          campaignId:target.campaignId,
          reason:'metric_recovery_writeback_failed',
          controlError:String(
            error?.code || 'publisher_ledger_writeback_failure',
          ),
          activatedAt:this.clock().toISOString(),
        });
        throw coded(
          'metric_recovery_writeback_failed_hard_stop',
          'Paperclip 已暂停外部效果未决的指标调用，但核对账本回写失败；Publisher Gateway 已全局硬停。',
        );
      }
      throw error;
    }
    if (committed.kind === 'already_resolved') {
      throw coded(
        'metric_recovery_already_resolved',
        '该指标调用已由另一份人工核对结论处理，拒绝覆盖。',
      );
    }
    if (committed.kind === 'authorization_reused') {
      throw coded(
        'metric_recovery_authorization_reused',
        '该 Paperclip 人工核对授权已用于另一指标 attempt，拒绝跨检查点或跨活动重放。',
      );
    }
    if (committed.kind === 'changed') {
      throw coded(
        'metric_recovery_target_changed',
        'Paperclip 授权核验期间指标 attempt 已变化，拒绝套用旧核对结论。',
      );
    }
    return {
      replayed:committed.kind === 'replay',
      recovery:publicMetricRecovery(committed.recovery),
    };
  }
}

function normalizeMetricRecoveryInput(input) {
  const campaignId = String(input?.campaignId || '').trim();
  const receiptId = String(input?.receiptId || '').trim();
  const collectionKey = String(input?.collectionKey || '').trim();
  const conclusion = String(input?.conclusion || '').trim();
  const authorizationId = String(input?.authorizationId || '').trim();
  const evidenceRef = String(input?.evidenceRef || '').trim();
  const collectionMatch = collectionKey.match(
    /^([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}):(2h|24h|72h)$/,
  );
  if (
    !SAFE_REFERENCE_PATTERN.test(campaignId)
    || !RECEIPT_ID_PATTERN.test(receiptId)
    || !collectionMatch
    || collectionMatch[1].toLowerCase() !== receiptId.toLowerCase()
    || !METRIC_RECOVERY_CONCLUSIONS.has(conclusion)
    || !SAFE_REFERENCE_PATTERN.test(authorizationId)
    || !SAFE_REFERENCE_PATTERN.test(evidenceRef)
  ) {
    throw coded(
      'invalid_metric_recovery_request',
      '指标恢复必须绑定 Campaign、回执、固定检查点、负责人核对结论、Paperclip 授权与证据引用。',
    );
  }
  return {
    campaignId,
    receiptId:receiptId.toLowerCase(),
    collectionKey:`${receiptId.toLowerCase()}:${collectionMatch[2]}`,
    conclusion,
    authorizationId,
    evidenceRef,
  };
}

function metricRecoveryTarget(state, target) {
  const receipt = Object.values(state.receipts).find((item) => (
    String(item.receiptId || '').toLowerCase() === target.receiptId.toLowerCase()
  ));
  if (!receipt) {
    throw coded('publish_receipt_not_found', '指标恢复找不到指定发布回执。');
  }
  if (
    receipt.campaignId !== target.campaignId
    || !target.collectionKey.startsWith(`${receipt.receiptId}:`)
  ) {
    throw coded(
      'metric_recovery_scope_mismatch',
      '指标恢复的 Campaign、回执与 collectionKey 不属于同一可信发布记录。',
    );
  }
  const attempt = state.attempts[`metric:${target.collectionKey}`];
  if (
    !attempt
    || attempt.kind !== 'metric_snapshot'
    || attempt.campaignId !== target.campaignId
    || String(attempt.receiptId || '').toLowerCase() !== target.receiptId.toLowerCase()
    || attempt.collectionKey !== target.collectionKey
  ) {
    throw coded(
      'metric_recovery_target_missing',
      '找不到与该可信发布记录精确绑定的指标 attempt。',
    );
  }
  return {
    receipt,
    attempt,
    recovery:attempt.metricRecovery || null,
  };
}

function validMetricRecoveryClaimToken(value) {
  return typeof value === 'string'
    && SAFE_REFERENCE_PATTERN.test(value);
}

function metricRecoveryAuthorizationOwner(state, authorizationId) {
  return Object.values(state.attempts).find((attempt) => (
    attempt?.kind === 'metric_snapshot'
    && attempt?.metricRecovery?.authorizationId === authorizationId
  )) || null;
}

function validateMetricRecoveryAuthorization(value, expected) {
  if (
    value?.authorized !== true
    || value?.source !== 'paperclip'
    || value?.action !== METRIC_RECOVERY_ACTION
    || value?.campaignId !== expected.campaignId
    || String(value?.receiptId || '').toLowerCase() !== expected.receiptId.toLowerCase()
    || value?.collectionKey !== expected.collectionKey
    || value?.attemptId !== expected.attemptId
    || value?.conclusion !== expected.conclusion
    || value?.authorizationId !== expected.authorizationId
    || value?.evidenceRef !== expected.evidenceRef
    || typeof value?.approvalRef !== 'string'
    || !value.approvalRef.startsWith('paperclip:')
  ) {
    throw coded(
      'metric_recovery_authorization_scope_mismatch',
      'Paperclip 人工核对授权与当前指标 attempt、结论或证据范围不一致。',
    );
  }
}

function metricRecoveryId(authorizationId) {
  return `metric_recovery_${crypto.createHash('sha256')
    .update(`${METRIC_RECOVERY_ACTION}:${authorizationId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function publicMetricRecovery(recovery) {
  return Object.freeze({
    recoveryId:recovery.recoveryId,
    action:recovery.action,
    conclusion:recovery.conclusion,
    evidenceRef:recovery.evidenceRef,
    resolvedAt:recovery.resolvedAt,
    state:recovery.conclusion === 'no_external_effect' ? 'failed' : 'blocked',
    retryAllowed:recovery.conclusion === 'no_external_effect',
    nextAction:recovery.conclusion === 'no_external_effect'
      ? 'request_new_read_own_metrics_authorization'
      : 'keep_metric_attempt_blocked',
  });
}

function validGatewayClock(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw coded('invalid_publisher_clock', 'Publisher Gateway 时钟无效。');
  }
  return date;
}
