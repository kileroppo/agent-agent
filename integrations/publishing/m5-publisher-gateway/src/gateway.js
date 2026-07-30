import crypto from 'node:crypto';
import {
  coded,
  publishIdempotencyKey,
  receiptId,
  STOP_REASONS,
  validatePublishRequest
} from './policy.js';
import {
  PublisherCostRecorder,
  createFakePublisherCostReporter,
} from './cost-reporting.js';

const IMMEDIATE_PAUSE_REASONS = new Set(STOP_REASONS);
const PRODUCTION_GATEWAY_ACTIVATION = Symbol('production-gateway-activation');
const HOUR_MS = 3_600_000;
const METRIC_CHECKPOINT_OFFSETS = Object.freeze({
  '2h':2 * HOUR_MS,
  '24h':24 * HOUR_MS,
  '72h':72 * HOUR_MS,
});
const METRIC_CLAIM_LEASE_MS = 10 * 60 * 1000;
const MAX_METRIC_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const MAX_METRIC_RETRIES = 2;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const METRIC_RECOVERY_ACTION = 'publisher.reconcile_stale_attempt';
const METRIC_RECOVERY_CONCLUSIONS = new Set([
  'no_external_effect',
  'external_effect_verified',
]);
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export function createProductionPublisherGateway(options) {
  return new PublisherGateway({
    ...options,
    mode:'real',
    productionActivation:PRODUCTION_GATEWAY_ACTIVATION,
  });
}

export class PublisherGateway {
  constructor({
    repository,
    connectors,
    metricConnectors = null,
    artifactVerifier,
    paperclipControl,
    costReporter,
    costRecorder,
    approvalGuard = null,
    mode = 'fake',
    productionActivation = null,
    clock = () => new Date(),
  }) {
    if (mode === 'real' && productionActivation !== PRODUCTION_GATEWAY_ACTIVATION) {
      throw coded('real_gateway_disabled', '真实 Publisher Gateway 尚未获得单独批准；平台外部幂等与真实连接器核验尚未完成。');
    }
    if (!['fake', 'real'].includes(mode)) {
      throw coded('invalid_publisher_mode', 'Publisher Gateway 模式只允许 fake 或 real。');
    }
    if (!repository?.read || !repository?.update || !artifactVerifier?.verify) {
      throw coded('publisher_dependencies_missing', 'Publisher Gateway 必须使用事务账本和实际文件哈希验证器。');
    }
    if (!paperclipControl?.assertPublishAllowed || !paperclipControl?.pauseCampaignAndDisableCron) {
      throw coded(
        'paperclip_control_required',
        'Publisher Gateway 必须连接 Paperclip 控制适配器；活动授权真相和 Cron 控制不能保存在发布器内。',
      );
    }
    if (
      mode === 'real'
      && typeof approvalGuard?.assertCapabilityAllowed !== 'function'
    ) {
      throw coded(
        'publisher_approval_guard_required',
        '真实 Publisher Gateway 必须在每次外部调用前重新核验 connector capability 批准。',
      );
    }
    this.repository = repository;
    this.connectors = connectors;
    this.metricConnectors = metricConnectors || (mode === 'fake' ? connectors : {});
    this.artifactVerifier = artifactVerifier;
    this.paperclipControl = paperclipControl;
    this.approvalGuard = approvalGuard;
    this.mode = mode;
    validateConnectorModes(connectors, mode);
    validateConnectorModes(this.metricConnectors, mode);
    this.clock = clock;
    if (costRecorder) {
      if (
        typeof costRecorder.assertCampaignBudget !== 'function'
        || typeof costRecorder.recordLocalZeroAttempt !== 'function'
      ) {
        throw coded(
          'publisher_cost_reporter_required',
          'Publisher 费用记录器契约无效。',
        );
      }
      this.costRecorder = costRecorder;
    } else {
      this.costRecorder = new PublisherCostRecorder({
        repository,
        costReporter:costReporter || (
          mode === 'fake' ? createFakePublisherCostReporter() : null
        ),
        clock,
      });
    }
    this.inflight = new Map();
    this.metricInflight = new Map();
    this.publishTail = Promise.resolve();
    this.processHardStop = null;
  }

  async publish(request) {
    const key = publishIdempotencyKey(request);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.publishTail
      .catch(() => undefined)
      .then(() => this.publishOnce(request))
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    this.publishTail = pending;
    return pending;
  }

  async publishOnce(request) {
    await this.assertOperational();
    const now = this.clock();
    request = await this.withCanonicalGrant(request, now);
    const preflight = validatePublishRequest(request, now);
    if (!preflight.passed) throw coded('publish_preflight_failed', preflight.errors.join(' '));
    await this.assertConnectorApproval(request.platform, 'publish', now);
    const mediaLease = await this.acquireMediaLease(request.mediaPath, request.contentChecksum);
    try {
      return await this.publishVerified(request, preflight, mediaLease, now);
    } finally {
      await mediaLease.release();
    }
  }

  async acquireMediaLease(relativePath, expectedChecksum) {
    if (typeof this.artifactVerifier.acquire === 'function') {
      return this.artifactVerifier.acquire(relativePath, expectedChecksum);
    }
    const verified = await this.artifactVerifier.verify(relativePath, expectedChecksum);
    return {
      ...verified,
      immutableLease:false,
      createReadStream:null,
      async release() {},
    };
  }

  async publishVerified(request, preflight, mediaLease, now) {
    const verifiedMedia = {
      relativePath:mediaLease.relativePath,
      checksum:mediaLease.checksum,
      bytes:mediaLease.bytes,
      immutableLease:mediaLease.immutableLease === true,
    };
    const campaignId = request.campaignId;
    const claim = await this.repository.update((state) => {
      const existing = state.receipts[preflight.idempotencyKey];
      if (existing) return { kind:'replay', receipt:existing };
      const existingAttempt = state.attempts[preflight.idempotencyKey];
      if (existingAttempt) {
        if (
          existingAttempt.state === 'blocked'
          && ['budget_exceeded', 'budget_unavailable'].includes(existingAttempt.stopReason)
        ) {
          existingAttempt.state = 'prepared';
          existingAttempt.retryCount = Number(existingAttempt.retryCount || 0) + 1;
          existingAttempt.stopReason = null;
          existingAttempt.updatedAt = now.toISOString();
          return { kind:'claimed', attemptId:existingAttempt.attemptId };
        }
        return {
          kind:'blocked',
          code:'publish_attempt_ambiguous',
          reason:'publish_attempt_requires_reconciliation',
          attempt:existingAttempt,
        };
      }
      const campaignReceipts = Object.values(state.receipts)
        .filter((receipt) => receipt.campaignId === campaignId);
      const dailyPlatformReceipts = campaignReceipts.filter((receipt) => (
        receipt.platform === request.platform && receipt.scheduledDate === request.scheduledDate
      ));
      if (campaignReceipts.length >= request.grant.totalPublishLimit
        || dailyPlatformReceipts.length >= request.grant.dailyPublishLimitPerPlatform) {
        const blocked = createAttempt({
          request,
          preflight,
          verifiedMedia,
          now,
          state:'blocked',
          stopReason:'grant_limit_exceeded',
        });
        state.attempts[preflight.idempotencyKey] = blocked;
        return {
          kind:'blocked',
          code:'grant_limit_exceeded',
          reason:'grant_limit_exceeded',
          attempt:blocked,
        };
      }
      const duplicate = Object.values(state.receipts).find((receipt) => (
        receipt.platform === request.platform && receipt.contentChecksum === request.contentChecksum
      ));
      if (duplicate) {
        const blocked = createAttempt({
          request,
          preflight,
          verifiedMedia,
          now,
          state:'blocked',
          stopReason:'duplicate_content',
        });
        state.attempts[preflight.idempotencyKey] = blocked;
        return {
          kind:'blocked',
          code:'duplicate_content',
          reason:'duplicate_content',
          attempt:blocked,
        };
      }
      const attempt = createAttempt({
        request,
        preflight,
        verifiedMedia,
        now,
        state:'prepared',
      });
      state.attempts[preflight.idempotencyKey] = attempt;
      return { kind:'claimed', attemptId:attempt.attemptId };
    });
    if (claim.kind === 'replay') return { replayed:true, receipt:claim.receipt };
    if (claim.kind === 'blocked') {
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:claim.reason,
        now,
      });
      throw coded(claim.code, `发布已停止：${claim.reason}。`);
    }

    const connector = this.connectors[request.platform];
    if (!connector) {
      await this.markAttemptAmbiguous(preflight.idempotencyKey, 'connector_unavailable', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'publish_attempt_requires_reconciliation',
        now,
      });
      throw coded('connector_unavailable', '发布平台连接器不可用，Paperclip 活动已暂停。');
    }
    const connectorMode = String(connector.connectorMode || this.mode);
    let budget;
    try {
      budget = await this.costRecorder.assertCampaignBudget({
        campaignId,
        connectorMode,
        operation:'publish',
        checkedAt:now,
      });
    } catch (error) {
      await this.blockAttempt(preflight.idempotencyKey, 'budget_unavailable', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'budget_unavailable',
        now,
      });
      throw error;
    }
    if (!budget.allowed) {
      await this.blockAttempt(preflight.idempotencyKey, 'budget_exceeded', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'budget_exceeded',
        now,
      });
      throw coded(
        'publisher_budget_exceeded',
        'Paperclip 活动剩余预算不足；CampaignGrant 已暂停且 Cron 已关闭，平台连接器未调用。',
      );
    }
    await this.repository.update((state) => {
      const attempt = state.attempts[preflight.idempotencyKey];
      attempt.state = 'invoking';
      attempt.invokingAt = now.toISOString();
    });
    const safeRequest = structuredClone(request);
    delete safeRequest.mediaPath;
    const connectorRequest = {
      ...safeRequest,
      idempotencyKey:preflight.idempotencyKey,
      accountRef:request.grant.accountRefs[request.platform],
      verifiedMedia
    };
    if (mediaLease.immutableLease) {
      connectorRequest.mediaLease = Object.freeze({
        createReadStream:() => mediaLease.createReadStream(),
      });
    }

    let result;
    let connectorError = null;
    try {
      await this.assertConnectorApproval(
        request.platform,
        'publish',
        validGatewayClock(this.clock()),
      );
    } catch (error) {
      await this.blockAttempt(
        preflight.idempotencyKey,
        String(error?.code || 'real_connector_approval_invalid'),
        validGatewayClock(this.clock()),
      );
      throw error;
    }
    try {
      result = await connector.publish(connectorRequest);
    } catch (error) {
      connectorError = error;
    }
    if (connector.costReportingMode !== 'transport_actual') {
      try {
        await this.costRecorder.recordLocalZeroAttempt({
          campaignId,
          idempotencyKey:preflight.idempotencyKey,
          connectorMode,
          operation:'publish',
          receiptRef:preflight.idempotencyKey,
          occurredAt:this.clock(),
        });
      } catch (error) {
        await this.markAttemptAmbiguous(
          preflight.idempotencyKey,
          String(error?.code || 'cost_reporting_failed'),
          now,
        );
        await this.pauseInPaperclip({
          idempotencyKey:preflight.idempotencyKey,
          campaignId,
          reason:'publish_attempt_requires_reconciliation',
          now,
        });
        throw error;
      }
    }
    if (connectorError) {
      await this.markAttemptAmbiguous(
        preflight.idempotencyKey,
        String(connectorError?.code || 'transport_failure'),
        now,
      );
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'publish_attempt_requires_reconciliation',
        now,
      });
      throw coded('publish_attempt_ambiguous', '平台调用结果不确定，Paperclip 活动已暂停并要求人工核对；禁止自动重发。');
    }
    if (result.state === 'stopped') {
      const stopped = await this.recordStoppedAttempt(
        preflight.idempotencyKey,
        campaignId,
        result.stopReason,
        now,
      );
      if (stopped.pauseRequired) {
        await this.pauseInPaperclip({
          idempotencyKey:preflight.idempotencyKey,
          campaignId,
          reason:result.stopReason,
          now,
        });
      }
      throw coded(`publish_stopped_${result.stopReason}`, `发布已安全停止：${result.stopReason}。`);
    }
    if (result.state !== 'published' || !result.externalContentId || !validEvidence(result.evidence)) {
      await this.markAttemptAmbiguous(preflight.idempotencyKey, 'unverified_result', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'publish_attempt_requires_reconciliation',
        now,
      });
      throw coded('publish_result_unverified', '平台未返回结构化内容ID或成功证据，Paperclip 活动已暂停并禁止重发。');
    }
    if (connectorMode.endsWith('_cua') && !validCuaEvidence(result)) {
      await this.markAttemptAmbiguous(preflight.idempotencyKey, 'cua_evidence_unverified', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'publish_attempt_requires_reconciliation',
        now,
      });
      throw coded(
        'publish_result_unverified',
        'CUA 没有返回账号核验、真实内容页、selector 版本和快照哈希，活动已暂停并禁止重发。',
      );
    }
    if (result.accountRef !== connectorRequest.accountRef) {
      await this.markAttemptAmbiguous(preflight.idempotencyKey, 'account_mismatch', now);
      await this.pauseInPaperclip({
        idempotencyKey:preflight.idempotencyKey,
        campaignId,
        reason:'publish_attempt_requires_reconciliation',
        now,
      });
      throw coded('publisher_account_mismatch', '连接器实际账号与活动授权引用不一致，Paperclip 活动已暂停。');
    }
    const publishedAt = Number.isFinite(Date.parse(result.publishedAt))
      ? new Date(result.publishedAt).toISOString()
      : now.toISOString();
    await this.repository.update((state) => {
      const attempt = state.attempts[preflight.idempotencyKey];
      attempt.state = 'external_succeeded';
      attempt.externalContentId = result.externalContentId;
      attempt.evidence = result.evidence;
      if (connectorMode.endsWith('_cua')) {
        attempt.evidenceObservation = cuaEvidenceObservation(result);
      }
      attempt.publishedAt = publishedAt;
      attempt.updatedAt = now.toISOString();
    });

    const receipt = {
      receiptId:receiptId(preflight.idempotencyKey),
      idempotencyKey:preflight.idempotencyKey,
      campaignId,
      platform:request.platform,
      contentVersionId:request.contentVersionId,
      contentChecksum:verifiedMedia.checksum,
      scheduledDate:request.scheduledDate,
      externalContentId:result.externalContentId,
      evidence:result.evidence,
      accountRef:result.accountRef,
      publishedAt,
      connectorMode:connector.connectorMode || this.mode,
      ...(connectorMode.endsWith('_cua')
        ? { evidenceObservation:cuaEvidenceObservation(result) }
        : {}),
    };
    await this.repository.update((state) => {
      state.receipts[preflight.idempotencyKey] = receipt;
      state.attempts[preflight.idempotencyKey].state = 'receipt_recorded';
      state.attempts[preflight.idempotencyKey].receiptId = receipt.receiptId;
      state.attempts[preflight.idempotencyKey].updatedAt = now.toISOString();
    });
    return { replayed:false, receipt };
  }

  async collectMetricSnapshot(input = {}) {
    const inflightKey = `${String(input.receiptId || '').trim()}:${String(input.collectionKey || '').trim()}`;
    if (this.metricInflight.has(inflightKey)) return this.metricInflight.get(inflightKey);
    const pending = this.collectMetricSnapshotOnce(input).finally(() => {
      this.metricInflight.delete(inflightKey);
    });
    this.metricInflight.set(inflightKey, pending);
    return pending;
  }

  async collectMetricSnapshotOnce(input = {}) {
    await this.assertOperational();
    const receiptIdentifier = String(input.receiptId || '').trim();
    const authorizedCampaignId = String(input.campaignId || '').trim();
    const collectionKey = String(input.collectionKey || '').trim();
    const requestedCollectedAt = normalizeTimestamp(input.collectedAt);
    const collectionMatch = collectionKey.match(
      /^([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}):(2h|24h|72h)$/,
    );
    if (
      !RECEIPT_ID_PATTERN.test(receiptIdentifier)
      || !authorizedCampaignId
      || !requestedCollectedAt
      || !collectionMatch
      || collectionMatch[1].toLowerCase() !== receiptIdentifier.toLowerCase()
    ) {
      throw coded(
        'invalid_metric_collection_request',
        '指标采集必须绑定同一 receiptId 与固定的 2h、24h 或 72h collectionKey。',
      );
    }
    const checkpoint = collectionMatch[2];
    const collectedAt = normalizeTimestamp(this.clock());
    if (!collectedAt) throw coded('invalid_publisher_clock', 'Publisher Gateway 指标采集时钟无效。');
    const attemptKey = `metric:${collectionKey}`;
    const claimToken = crypto.randomUUID();
    const claimExpiresAt = new Date(
      Date.parse(collectedAt) + METRIC_CLAIM_LEASE_MS,
    ).toISOString();
    const claim = await this.repository.update((state) => {
      const receipt = Object.values(state.receipts).find((item) => (
        String(item.receiptId || '').toLowerCase() === receiptIdentifier.toLowerCase()
      ));
      if (!receipt) return { kind:'missing' };
      if (receipt.campaignId !== authorizedCampaignId) return { kind:'campaign_scope_mismatch' };
      if (collectionKey !== `${receipt.receiptId}:${checkpoint}`) return { kind:'conflict' };
      const publishedAt = Date.parse(receipt.publishedAt);
      if (!Number.isFinite(publishedAt)) return { kind:'invalid_receipt' };
      const dueAt = publishedAt + METRIC_CHECKPOINT_OFFSETS[checkpoint];
      if (Date.parse(collectedAt) < dueAt) {
        return { kind:'not_due', dueAt:new Date(dueAt).toISOString() };
      }
      const existing = state.metricSnapshots.find((item) => item.collectionKey === collectionKey);
      if (existing) {
        if (
          String(existing.receiptId || '').toLowerCase() !== receiptIdentifier.toLowerCase()
          || existing.collectionKey !== `${receipt.receiptId}:${checkpoint}`
        ) {
          return { kind:'conflict' };
        }
        return { kind:'replay', snapshot:existing };
      }
      const previous = state.attempts[attemptKey];
      if (previous?.state === 'blocked' && previous?.hardStop === true) {
        return {
          kind:'hard_stopped',
          reason:previous.stopReason,
          receipt,
          pauseRequired:!validPauseControlResult(
            previous.pauseControl,
            receipt.campaignId,
          ),
        };
      }
      if (previous?.state === 'invoking') {
        return { kind:'active' };
      }
      const previousLeaseExpiresAt = Date.parse(previous?.claimExpiresAt);
      if (
        previous?.state === 'prepared'
        && Number.isFinite(previousLeaseExpiresAt)
        && previousLeaseExpiresAt > Date.parse(collectedAt)
      ) {
        return { kind:'active' };
      }
      const retryCount = previous ? Number(previous.retryCount || 0) + 1 : 0;
      if (retryCount > MAX_METRIC_RETRIES) return { kind:'retry_exhausted' };
      state.attempts[attemptKey] = {
        ...(previous || {
          attemptId:`attempt_${crypto.randomUUID()}`,
          kind:'metric_snapshot',
          idempotencyKey:attemptKey,
          collectionKey,
          receiptId:receipt.receiptId,
          campaignId:receipt.campaignId,
          platform:receipt.platform,
          createdAt:this.clock().toISOString(),
        }),
        state:'prepared',
        retryCount,
        stopReason:null,
        claimToken,
        claimExpiresAt,
        updatedAt:this.clock().toISOString(),
      };
      delete state.attempts[attemptKey].metricRecovery;
      return { kind:'claimed', receipt, claimToken };
    });
    if (claim.kind === 'missing') throw coded('publish_receipt_not_found', '指标采集找不到指定发布回执。');
    if (claim.kind === 'campaign_scope_mismatch') {
      throw coded(
        'metric_campaign_scope_mismatch',
        'Paperclip 指标授权的 Campaign 与发布回执不一致，拒绝跨活动读取。',
      );
    }
    if (claim.kind === 'invalid_receipt') {
      throw coded('publish_receipt_invalid', '指标采集对应的发布回执缺少有效发布时间。');
    }
    if (claim.kind === 'not_due') {
      throw coded('metric_checkpoint_not_due', `指标检查点尚未到期；最早采集时间为 ${claim.dueAt}。`);
    }
    if (claim.kind === 'conflict') {
      throw coded('metric_snapshot_identity_conflict', '已有指标快照与当前发布回执身份不一致，拒绝跨回执重放。');
    }
    if (claim.kind === 'active') {
      throw coded(
        'metric_collection_active',
        '同一发布回执与检查点正在采集；等待当前只读会话完成，禁止并发启动第二个连接器。',
      );
    }
    if (claim.kind === 'hard_stopped') {
      if (claim.pauseRequired) {
        await this.pauseInPaperclip({
          idempotencyKey:attemptKey,
          campaignId:claim.receipt.campaignId,
          reason:claim.reason || 'metric_hard_stop_recovery',
          now:new Date(collectedAt),
        });
      }
      throw coded(
        'metric_collection_hard_stopped',
        `指标采集已因 ${claim.reason || 'safety_stop'} 硬停；必须先由负责人恢复 Campaign，禁止自动重试。`,
      );
    }
    if (claim.kind === 'retry_exhausted') {
      throw coded(
        'metric_retry_exhausted',
        '同一指标检查点已达到两次安全重试上限，必须由 Paperclip 转为 blocked 并给出人工恢复动作。',
      );
    }
    if (claim.kind === 'replay') return { replayed:true, snapshot:claim.snapshot };
    const connector = this.metricConnectors[claim.receipt.platform];
    if (!connector?.readOwnMetrics) {
      await this.stopMetricAttempt(attemptKey, 'connector_unavailable', claim.claimToken);
      throw coded('metric_connector_unavailable', '指标连接器不可用。');
    }
    try {
      await this.assertConnectorApproval(
        claim.receipt.platform,
        'read_own_metrics',
        new Date(collectedAt),
      );
    } catch (error) {
      await this.blockMetricAttempt(
        attemptKey,
        String(error?.code || 'metric_connector_approval_invalid'),
        claim.claimToken,
      );
      throw error;
    }
    const connectorMode = String(connector.connectorMode || this.mode);
    let budget;
    try {
      budget = await this.costRecorder.assertCampaignBudget({
        campaignId:claim.receipt.campaignId,
        connectorMode,
        operation:'read_own_metrics',
        checkedAt:new Date(collectedAt),
      });
    } catch (error) {
      await this.blockMetricAttempt(
        attemptKey,
        'budget_unavailable',
        claim.claimToken,
      );
      await this.pauseInPaperclip({
        idempotencyKey:attemptKey,
        campaignId:claim.receipt.campaignId,
        reason:'budget_unavailable',
        now:new Date(collectedAt),
      });
      throw error;
    }
    if (!budget.allowed) {
      await this.blockMetricAttempt(
        attemptKey,
        'budget_exceeded',
        claim.claimToken,
      );
      await this.pauseInPaperclip({
        idempotencyKey:attemptKey,
        campaignId:claim.receipt.campaignId,
        reason:'budget_exceeded',
        now:new Date(collectedAt),
      });
      throw coded(
        'publisher_budget_exceeded',
        'Paperclip 活动剩余预算不足；CampaignGrant 已暂停且 Cron 已关闭，指标连接器未调用。',
      );
    }
    await this.repository.update((state) => {
      const attempt = state.attempts[attemptKey];
      if (attempt?.claimToken !== claim.claimToken || attempt?.state !== 'prepared') {
        throw coded('metric_collection_claim_lost', '指标采集 claim 已失效，拒绝启动连接器。');
      }
      attempt.state = 'invoking';
      attempt.invokingAt = this.clock().toISOString();
      delete attempt.claimExpiresAt;
    });
    let metricResult;
    let metricError = null;
    try {
      await this.assertConnectorApproval(
        claim.receipt.platform,
        'read_own_metrics',
        validGatewayClock(this.clock()),
      );
    } catch (error) {
      await this.blockMetricAttempt(
        attemptKey,
        String(error?.code || 'real_metric_connector_approval_invalid'),
        claim.claimToken,
      );
      throw error;
    }
    try {
      metricResult = validateMetricConnectorResult(
        await connector.readOwnMetrics(
          claim.receipt,
          collectedAt,
          { checkpoint, collectionKey },
        ),
        claim.receipt,
        { checkpoint, collectionKey, collectedAt },
      );
    } catch (error) {
      metricError = error;
    }
    const hardStopReason = normalizedMetricHardStopReason(metricError);
    const metricCostReportingErrorCode =
      normalizedMetricCostReportingErrorCode(metricError);
    if (hardStopReason) {
      let blockWritebackError = null;
      try {
        await this.blockMetricAttempt(
          attemptKey,
          hardStopReason,
          claim.claimToken,
          true,
          metricCostReportingErrorCode,
        );
      } catch (error) {
        blockWritebackError = error;
      }
      let pauseError = null;
      try {
        await this.pauseInPaperclip({
          idempotencyKey:attemptKey,
          campaignId:claim.receipt.campaignId,
          reason:hardStopReason,
          now:new Date(collectedAt),
        });
      } catch (error) {
        pauseError = error;
      }
      if (blockWritebackError) {
        await this.activateGlobalHardStop({
          campaignId:claim.receipt.campaignId,
          reason:'metric_hard_stop_writeback_failed',
          controlError:String(
            blockWritebackError?.code || 'publisher_ledger_writeback_failure',
          ),
          activatedAt:this.clock().toISOString(),
        });
        if (pauseError) throw pauseError;
        throw coded(
          'metric_hard_stop_writeback_failed_hard_stop',
          '平台指标已触发安全硬停且 Paperclip 已暂停，但指标账本回写失败；Publisher Gateway 已全局硬停，禁止重试。',
        );
      }
      if (pauseError) throw pauseError;
    }
    if (connector.costReportingMode !== 'transport_actual') {
      try {
        await this.costRecorder.recordLocalZeroAttempt({
          campaignId:claim.receipt.campaignId,
          idempotencyKey:attemptKey,
          connectorMode:String(connector.connectorMode || this.mode),
          operation:'read_own_metrics',
          receiptRef:collectionKey,
          occurredAt:this.clock(),
        });
      } catch (error) {
        const costReportingErrorCode = normalizedCostReportingErrorCode(error);
        if (hardStopReason) {
          await this.recordMetricCostReportingFailure(
            attemptKey,
            costReportingErrorCode,
          );
        } else {
          await this.stopMetricAttempt(
            attemptKey,
            costReportingErrorCode,
            claim.claimToken,
          );
        }
        throw error;
      }
    }
    if (metricError) {
      if (hardStopReason) {
        throw coded(
          `metric_collection_stopped_${hardStopReason}`,
          `平台本人内容指标采集已因 ${hardStopReason} 硬停；CampaignGrant 已暂停且 Cron 已关闭。`,
        );
      }
      await this.stopMetricAttempt(
        attemptKey,
        String(metricError?.code || 'metric_collection_failed'),
        claim.claimToken,
      );
      throw coded('metric_collection_failed', '平台本人内容指标采集失败，等待 Paperclip 决定恢复动作。');
    }
    const snapshot = {
      snapshotId:metricSnapshotId(collectionKey),
      collectionKey,
      platform:claim.receipt.platform,
      receiptId:claim.receipt.receiptId,
      contentVersionId:claim.receipt.contentVersionId,
      collectedAt,
      metrics:metricResult.metrics,
      ...(metricResult.accountRef
        ? {
          accountRef:metricResult.accountRef,
          externalContentId:metricResult.externalContentId,
          source:metricResult.source,
        }
        : {}),
    };
    const committed = await this.repository.update((state) => {
      const existing = state.metricSnapshots.find(
        (item) => item.collectionKey === collectionKey,
      );
      if (existing) return { kind:'replay', snapshot:existing };
      const attempt = state.attempts[attemptKey];
      if (attempt?.claimToken !== claim.claimToken || attempt?.state !== 'invoking') {
        return { kind:'claim_lost' };
      }
      state.metricSnapshots.push(snapshot);
      attempt.state = 'snapshot_recorded';
      attempt.snapshotId = snapshot.snapshotId;
      attempt.updatedAt = this.clock().toISOString();
      delete attempt.claimToken;
      delete attempt.claimExpiresAt;
      return { kind:'recorded' };
    });
    if (committed.kind === 'replay') {
      return { replayed:true, snapshot:committed.snapshot };
    }
    if (committed.kind !== 'recorded') {
      throw coded(
        'metric_collection_claim_lost',
        '指标采集完成前 claim 已失效；拒绝覆盖新所有者或重复写入快照。',
      );
    }
    return { replayed:false, snapshot };
  }

  async getReceipt(identifier) {
    const receipts = Object.values((await this.repository.read()).receipts);
    return receipts.find((receipt) => (
      receipt.receiptId === identifier || receipt.idempotencyKey === identifier
    )) || null;
  }

  async getAttempt(idempotencyKey) {
    return (await this.repository.read()).attempts[idempotencyKey] || null;
  }

  async assertCurrentMetricRecoveryAuthorization(target, attemptId) {
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

  async reconcileMetricInvocation(input = {}) {
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
    await this.assertCurrentMetricRecoveryAuthorization(
      target,
      initial.attempt.attemptId,
    );
    const {
      authorization,
      checkedAt,
    } = await this.assertCurrentMetricRecoveryAuthorization(
      target,
      initial.attempt.attemptId,
    );
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

  async getSafetyStatus() {
    const state = await this.repository.read();
    return structuredClone(state.safetyLatch);
  }

  async assertOperational() {
    if (this.processHardStop?.active) {
      throw coded('publisher_global_hard_stop', 'Publisher Gateway 已全局硬停；必须先恢复 Paperclip 控制面并人工解除运行实例。');
    }
    const state = await this.repository.read();
    if (state.safetyLatch?.active) {
      this.processHardStop = structuredClone(state.safetyLatch);
      throw coded('publisher_global_hard_stop', 'Publisher Gateway 已全局硬停；必须先恢复 Paperclip 控制面并人工解除运行实例。');
    }
  }

  async assertConnectorApproval(platform, capability, checkedAt) {
    if (this.mode !== 'real') return;
    await this.approvalGuard.assertCapabilityAllowed({
      platform,
      capability,
      checkedAt:checkedAt.toISOString(),
    });
  }

  async withCanonicalGrant(request, now) {
    let result;
    try {
      result = await this.paperclipControl.assertPublishAllowed({
        campaignId:request.campaignId,
        checkedAt:now.toISOString(),
      });
    } catch {
      throw coded('paperclip_control_unavailable', '无法从 Paperclip 核验当前 CampaignGrant，发布已失败关闭。');
    }
    if (
      result?.campaignId !== request.campaignId
      || result?.grantStatus !== 'active'
      || result?.currentStage !== 'campaign_active'
      || !result?.canonicalGrant
      || typeof result.canonicalGrant !== 'object'
      || Array.isArray(result.canonicalGrant)
    ) {
      throw coded('campaign_not_active', 'Paperclip 当前 CampaignGrant 不是 active，拒绝发布。');
    }
    return {
      ...structuredClone(request),
      grant:structuredClone(result.canonicalGrant),
    };
  }

  async pauseInPaperclip({ idempotencyKey, campaignId, reason, now }) {
    const pauseKey = `publisher-pause:${campaignId}:${reason}`;
    try {
      const result = await this.paperclipControl.pauseCampaignAndDisableCron({
        campaignId,
        reason,
        idempotencyKey:pauseKey,
        requestedAt:now.toISOString(),
      });
      if (!validPauseControlResult(result, campaignId)) {
        throw coded('invalid_paperclip_pause_receipt', 'Paperclip 暂停回执没有同时证明 Grant 已暂停且 Cron 已关闭。');
      }
      await this.repository.update((state) => {
        const attempt = state.attempts[idempotencyKey];
        if (attempt) {
          attempt.pauseControl = {
            campaignId,
            grantStatus:'paused',
            cronStatus:'disabled',
            controlEventId:String(result.controlEventId),
            confirmedAt:now.toISOString(),
          };
          attempt.updatedAt = now.toISOString();
        }
      });
      return result;
    } catch (error) {
      await this.activateGlobalHardStop({
        campaignId,
        reason:'paperclip_pause_writeback_failed',
        controlError:String(error?.code || 'paperclip_control_failure'),
        activatedAt:now.toISOString(),
      });
      throw coded(
        'paperclip_pause_failed_hard_stop',
        'Paperclip 未确认 CampaignGrant 暂停和 Cron 关闭；Publisher Gateway 已全局硬停，禁止继续发布。',
      );
    }
  }

  async activateGlobalHardStop(latch) {
    this.processHardStop = { active:true, ...structuredClone(latch) };
    try {
      await this.repository.update((state) => {
        state.safetyLatch = structuredClone(this.processHardStop);
      });
    } catch {
      // 进程内门闩已先激活；即使持久化介质故障，本实例也绝不继续发布。
    }
  }

  async markAttemptAmbiguous(idempotencyKey, reason, now) {
    await this.repository.update((state) => {
      const attempt = state.attempts[idempotencyKey];
      if (attempt) {
        attempt.state = 'ambiguous';
        attempt.ambiguousReason = reason;
        attempt.updatedAt = now.toISOString();
      }
    });
  }

  async blockAttempt(idempotencyKey, reason, now) {
    await this.repository.update((state) => {
      const attempt = state.attempts[idempotencyKey];
      if (attempt) {
        attempt.state = 'blocked';
        attempt.stopReason = reason;
        attempt.updatedAt = now.toISOString();
      }
    });
  }

  async recordStoppedAttempt(idempotencyKey, campaignId, reason, now) {
    return this.repository.update((state) => {
      const attempt = state.attempts[idempotencyKey];
      attempt.state = 'stopped';
      attempt.stopReason = reason;
      attempt.updatedAt = now.toISOString();
      const consecutiveFailures = countFailuresSinceLastReceipt(state, campaignId);
      return {
        consecutiveFailures,
        pauseRequired:IMMEDIATE_PAUSE_REASONS.has(reason) || consecutiveFailures >= 2,
      };
    });
  }

  async stopMetricAttempt(attemptKey, reason, claimToken = null) {
    await this.repository.update((state) => {
      const attempt = state.attempts[attemptKey];
      if (!attempt) return;
      if (claimToken && attempt.claimToken !== claimToken) return;
      attempt.state = 'stopped';
      attempt.stopReason = reason;
      attempt.updatedAt = this.clock().toISOString();
      delete attempt.claimToken;
      delete attempt.claimExpiresAt;
    });
  }

  async blockMetricAttempt(
    attemptKey,
    reason,
    claimToken = null,
    hardStop = false,
    costReportingErrorCode = null,
  ) {
    await this.repository.update((state) => {
      const attempt = state.attempts[attemptKey];
      if (!attempt) return;
      if (claimToken && attempt.claimToken !== claimToken) return;
      attempt.state = 'blocked';
      attempt.stopReason = reason;
      attempt.hardStop = hardStop === true;
      if (costReportingErrorCode) {
        attempt.costReportingErrorCode = costReportingErrorCode;
      }
      attempt.updatedAt = this.clock().toISOString();
      delete attempt.claimToken;
      delete attempt.claimExpiresAt;
    });
  }

  async recordMetricCostReportingFailure(attemptKey, errorCode) {
    await this.repository.update((state) => {
      const attempt = state.attempts[attemptKey];
      if (!attempt?.hardStop || attempt.state !== 'blocked') return;
      attempt.costReportingErrorCode = errorCode;
      attempt.updatedAt = this.clock().toISOString();
    });
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

function createAttempt({ request, preflight, verifiedMedia, now, state, stopReason }) {
  return {
    attemptId:`attempt_${crypto.randomUUID()}`,
    kind:'publish',
    idempotencyKey:preflight.idempotencyKey,
    campaignId:request.campaignId,
    platform:request.platform,
    contentVersionId:request.contentVersionId,
    contentChecksum:verifiedMedia.checksum,
    state,
    ...(stopReason ? { stopReason } : {}),
    createdAt:now.toISOString()
  };
}

function countFailuresSinceLastReceipt(state, campaignId) {
  let failures = 0;
  const attempts = Object.values(state.attempts)
    .filter((attempt) => attempt.kind === 'publish' && attempt.campaignId === campaignId);
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.state === 'receipt_recorded') break;
    if (attempt.state === 'stopped') failures += 1;
  }
  return failures;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function validGatewayClock(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw coded('invalid_publisher_clock', 'Publisher Gateway 时钟无效。');
  }
  return date;
}

function normalizedMetricHardStopReason(error) {
  if (error?.hardStop !== true) return null;
  const reason = String(error?.stopReason || '');
  if (IMMEDIATE_PAUSE_REASONS.has(reason)) return reason;
  if (['login', 'login_required'].includes(reason)) return 'identity_verification';
  if (reason === 'risk') return 'risk_control';
  return 'unknown_page';
}

function normalizedMetricCostReportingErrorCode(error) {
  if (error?.hardStop !== true || !error?.costReportingErrorCode) return null;
  return normalizedCostReportingErrorCode({
    code:error.costReportingErrorCode,
  });
}

function normalizedCostReportingErrorCode(error) {
  const code = String(error?.code || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(code)
    ? code
    : 'cost_reporting_failed';
}

function metricSnapshotId(collectionKey) {
  return `metric_${crypto.createHash('sha256').update(collectionKey).digest('hex').slice(0, 32)}`;
}

function validPauseControlResult(value, campaignId) {
  return value?.campaignId === campaignId
    && value?.grantStatus === 'paused'
    && value?.cronStatus === 'disabled'
    && typeof value?.controlEventId === 'string'
    && value.controlEventId.length > 0;
}

function validEvidence(value) {
  return typeof value === 'string' && /^(?:fake|https):\/\/\S+$/.test(value);
}

function validateMetricConnectorResult(value, receipt, context) {
  const isEvidenceBound = Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(value, 'metrics'),
  );
  if (isEvidenceBound) {
    const allowedKeys = [
      'accountRef',
      'checkpoint',
      'collectedAt',
      'collectionKey',
      'contentVersionId',
      'externalContentId',
      'metrics',
      'platform',
      'receiptId',
      'source',
    ].sort();
    if (
      Object.keys(value).sort().join('\n') !== allowedKeys.join('\n')
      || value.platform !== receipt.platform
      || value.receiptId !== receipt.receiptId
      || value.accountRef !== receipt.accountRef
      || value.externalContentId !== receipt.externalContentId
      || value.contentVersionId !== receipt.contentVersionId
      || value.collectionKey !== context.collectionKey
      || value.checkpoint !== context.checkpoint
      || value.collectedAt !== context.collectedAt
      || !validMetricSource(value.source, context)
    ) {
      throw coded(
        'metric_result_identity_mismatch',
        '平台指标证据与 PublishReceipt、检查点或获批只读来源不一致。',
      );
    }
  }
  const metrics = isEvidenceBound ? value.metrics : value;
  const expectedKeys = receipt.platform === 'xiaohongshu'
    ? ['comments', 'likes', 'saves', 'views']
    : receipt.platform === 'douyin'
      ? ['comments', 'downloads', 'forwards', 'likes', 'shares', 'views']
      : null;
  const actualKeys = metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    ? Object.keys(metrics).sort()
    : [];
  if (
    !expectedKeys
    || actualKeys.join('\n') !== expectedKeys.join('\n')
    || actualKeys.some((key) => !Number.isSafeInteger(metrics[key]) || metrics[key] < 0)
  ) {
    throw coded(
      'metric_result_unverified',
      '平台指标必须是该平台允许字段的精确非负整数，拒绝额外字段、估算值或缺失值。',
    );
  }
  return Object.freeze({
    metrics:Object.freeze(
      Object.fromEntries(expectedKeys.map((key) => [key, metrics[key]])),
    ),
    ...(isEvidenceBound
      ? {
        accountRef:value.accountRef,
        externalContentId:value.externalContentId,
        source:structuredClone(value.source),
      }
      : {}),
  });
}

function validMetricSource(value, context) {
  const expectedKeys = [
    'approvalRef',
    'capturedAt',
    'kind',
    'origin',
    'pageKind',
    'rawMetrics',
    'selectorBundleVersion',
    'selectorChecksum',
  ].sort();
  const rawMetricKeys = ['comments', 'likes', 'saves', 'views'];
  const capturedAt = Date.parse(value?.capturedAt);
  const observationAgeMs = Date.parse(context.collectedAt) - capturedAt;
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === expectedKeys.join('\n')
    && value.kind === 'official_creator_ui'
    && ['https://creator.xiaohongshu.com', 'https://pro.xiaohongshu.com']
      .includes(value.origin)
    && value.pageKind === 'own_note_detail'
    && /^[1-9]\d*\.\d+\.\d+$/.test(String(value.selectorBundleVersion || ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(value.selectorChecksum || ''))
    && String(value.approvalRef || '').startsWith('paperclip:')
    && Number.isFinite(capturedAt)
    && observationAgeMs >= 0
    && observationAgeMs <= MAX_METRIC_OBSERVATION_AGE_MS
    && value.rawMetrics
    && typeof value.rawMetrics === 'object'
    && !Array.isArray(value.rawMetrics)
    && Object.keys(value.rawMetrics).sort().join('\n')
      === rawMetricKeys.join('\n')
    && rawMetricKeys.every((key) => exactRawMetricValue(value.rawMetrics[key]));
}

function exactRawMetricValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (
    !/^(?:0|[1-9]\d*)$/.test(text)
    && !/^(?:[1-9]\d{0,2})(?:,\d{3})+$/.test(text)
  ) {
    return false;
  }
  const parsed = Number(text.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function validCuaEvidence(value) {
  if (
    value?.accountIdentityVerified !== true
    || !/^sha256:[a-f0-9]{64}$/.test(String(value?.evidenceSnapshotHash || ''))
    || !/^[1-9]\d*\.\d+\.\d+$/.test(String(value?.selectorBundleVersion || ''))
    || !Number.isFinite(Date.parse(value?.observedAt))
  ) {
    return false;
  }
  try {
    const evidence = new URL(value.evidence);
    return evidence.protocol === 'https:'
      && evidence.pathname.includes(encodeURIComponent(value.externalContentId));
  } catch {
    return false;
  }
}

function cuaEvidenceObservation(value) {
  return {
    evidenceSnapshotHash:value.evidenceSnapshotHash,
    selectorBundleVersion:value.selectorBundleVersion,
    observedAt:new Date(value.observedAt).toISOString(),
    accountIdentityVerified:true,
  };
}

function validateConnectorModes(connectors, mode) {
  const connectorModes = Object.values(connectors || {})
    .map((connector) => String(connector?.connectorMode || ''));
  if (
    (mode === 'real' && connectorModes.some((value) => !value.startsWith('real:')))
    || (mode === 'fake' && connectorModes.some((value) => value.startsWith('real:')))
  ) {
    throw coded(
      'publisher_connector_mode_mismatch',
      'fake 与 real connector 不得在同一个 Publisher Gateway 中混用。',
    );
  }
}

export { publishIdempotencyKey };
