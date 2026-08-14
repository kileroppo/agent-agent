import crypto from 'node:crypto';
import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded, STOP_REASONS } from './policy.ts';
const IMMEDIATE_PAUSE_REASONS = new Set(STOP_REASONS);
const HOUR_MS = 3600000;
const METRIC_CHECKPOINT_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
    '2h': 2 * HOUR_MS,
    '24h': 24 * HOUR_MS,
    '72h': 72 * HOUR_MS,
});
const METRIC_CLAIM_LEASE_MS = 10 * 60 * 1000;
const MAX_METRIC_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const MAX_METRIC_RETRIES = 2;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export class MetricCollectionExecution {
    activateGlobalHardStop: any;
    assertConnectorApproval: any;
    assertOperational: any;
    clock: any;
    costRecorder: any;
    metricConnectors: any;
    metricInflight: any;
    mode: any;
    pauseInPaperclip: any;
    repository: any;
    constructor({ repository, metricConnectors, costRecorder, mode, clock, assertOperational, assertConnectorApproval, pauseInPaperclip, activateGlobalHardStop, }: any) {
        this.repository = repository;
        this.metricConnectors = metricConnectors;
        this.costRecorder = costRecorder;
        this.mode = mode;
        this.clock = clock;
        this.assertOperational = assertOperational;
        this.assertConnectorApproval = assertConnectorApproval;
        this.pauseInPaperclip = pauseInPaperclip;
        this.activateGlobalHardStop = activateGlobalHardStop;
        this.metricInflight = new Map();
    }
    collect(input: any = {}) {
        const inflightKey = `${String(input.receiptId || '').trim()}:${String(input.collectionKey || '').trim()}`;
        if (this.metricInflight.has(inflightKey))
            return this.metricInflight.get(inflightKey);
        const pending = this.#collectOnce(input).finally(() => {
            this.metricInflight.delete(inflightKey);
        });
        this.metricInflight.set(inflightKey, pending);
        return pending;
    }
    async #collectOnce(input: any = {}) {
        await this.assertOperational();
        const receiptIdentifier = String(input.receiptId || '').trim();
        const authorizedCampaignId = String(input.campaignId || '').trim();
        const collectionKey = String(input.collectionKey || '').trim();
        const requestedCollectedAt = normalizeTimestamp(input.collectedAt);
        const collectionMatch = collectionKey.match(/^([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}):(2h|24h|72h)$/);
        if (!RECEIPT_ID_PATTERN.test(receiptIdentifier)
            || !authorizedCampaignId
            || !requestedCollectedAt
            || !collectionMatch
            || collectionMatch[1].toLowerCase() !== receiptIdentifier.toLowerCase()) {
            throw coded('invalid_metric_collection_request', '指标采集必须绑定同一 receiptId 与固定的 2h、24h 或 72h collectionKey。');
        }
        const checkpoint = collectionMatch[2];
        const collectedAt = normalizeTimestamp(this.clock());
        if (!collectedAt)
            throw coded('invalid_publisher_clock', 'Publisher Gateway 指标采集时钟无效。');
        const attemptKey = `metric:${collectionKey}`;
        const claimToken = crypto.randomUUID();
        const claimExpiresAt = new Date(Date.parse(collectedAt) + METRIC_CLAIM_LEASE_MS).toISOString();
        const claim = await this.repository.update((state: any) => {
            const receipt: any = Object.values(state.receipts).find((item: any) => (String(item.receiptId || '').toLowerCase() === receiptIdentifier.toLowerCase()));
            if (!receipt)
                return { kind: 'missing' };
            if (receipt.campaignId !== authorizedCampaignId)
                return { kind: 'campaign_scope_mismatch' };
            if (collectionKey !== `${receipt.receiptId}:${checkpoint}`)
                return { kind: 'conflict' };
            const publishedAt = Date.parse(receipt.publishedAt);
            if (!Number.isFinite(publishedAt))
                return { kind: 'invalid_receipt' };
            const dueAt = publishedAt + METRIC_CHECKPOINT_OFFSETS[checkpoint];
            if (Date.parse(collectedAt) < dueAt) {
                return { kind: 'not_due', dueAt: new Date(dueAt).toISOString() };
            }
            const existing = state.metricSnapshots.find((item: any) => item.collectionKey === collectionKey);
            if (existing) {
                if (String(existing.receiptId || '').toLowerCase() !== receiptIdentifier.toLowerCase()
                    || existing.collectionKey !== `${receipt.receiptId}:${checkpoint}`) {
                    return { kind: 'conflict' };
                }
                return { kind: 'replay', snapshot: existing };
            }
            const previous = state.attempts[attemptKey];
            if (previous?.state === 'blocked' && previous?.hardStop === true) {
                return {
                    kind: 'hard_stopped',
                    reason: previous.stopReason,
                    receipt,
                    pauseRequired: !validPauseControlResult(previous.pauseControl, receipt.campaignId),
                };
            }
            if (previous?.state === 'invoking') {
                return { kind: 'active' };
            }
            const previousLeaseExpiresAt = Date.parse(previous?.claimExpiresAt);
            if (previous?.state === 'prepared'
                && Number.isFinite(previousLeaseExpiresAt)
                && previousLeaseExpiresAt > Date.parse(collectedAt)) {
                return { kind: 'active' };
            }
            const retryCount = previous ? Number(previous.retryCount || 0) + 1 : 0;
            if (retryCount > MAX_METRIC_RETRIES)
                return { kind: 'retry_exhausted' };
            state.attempts[attemptKey] = {
                ...(previous || {
                    attemptId: `attempt_${crypto.randomUUID()}`,
                    kind: 'metric_snapshot',
                    idempotencyKey: attemptKey,
                    collectionKey,
                    receiptId: receipt.receiptId,
                    campaignId: receipt.campaignId,
                    platform: receipt.platform,
                    createdAt: this.clock().toISOString(),
                }),
                state: 'prepared',
                retryCount,
                stopReason: null,
                claimToken,
                claimExpiresAt,
                updatedAt: this.clock().toISOString(),
            };
            delete state.attempts[attemptKey].metricRecovery;
            return { kind: 'claimed', receipt, claimToken };
        });
        if (claim.kind === 'missing')
            throw coded('publish_receipt_not_found', '指标采集找不到指定发布回执。');
        if (claim.kind === 'campaign_scope_mismatch') {
            throw coded('metric_campaign_scope_mismatch', 'Paperclip 指标授权的 Campaign 与发布回执不一致，拒绝跨活动读取。');
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
            throw coded('metric_collection_active', '同一发布回执与检查点正在采集；等待当前只读会话完成，禁止并发启动第二个连接器。');
        }
        if (claim.kind === 'hard_stopped') {
            if (claim.pauseRequired) {
                await this.pauseInPaperclip({
                    idempotencyKey: attemptKey,
                    campaignId: claim.receipt.campaignId,
                    reason: claim.reason || 'metric_hard_stop_recovery',
                    now: new Date(collectedAt),
                });
            }
            throw coded('metric_collection_hard_stopped', `指标采集已因 ${claim.reason || 'safety_stop'} 硬停；必须先由负责人恢复 Campaign，禁止自动重试。`);
        }
        if (claim.kind === 'retry_exhausted') {
            throw coded('metric_retry_exhausted', '同一指标检查点已达到两次安全重试上限，必须由 Paperclip 转为 blocked 并给出人工恢复动作。');
        }
        if (claim.kind === 'replay')
            return { replayed: true, snapshot: claim.snapshot };
        const connector = this.metricConnectors[claim.receipt.platform];
        if (!connector?.readOwnMetrics) {
            await this.#stopMetricAttempt(attemptKey, 'connector_unavailable', claim.claimToken);
            throw coded('metric_connector_unavailable', '指标连接器不可用。');
        }
        try {
            await this.assertConnectorApproval(claim.receipt.platform, 'read_own_metrics', new Date(collectedAt));
        }
        catch (error: any) {
            await this.#blockMetricAttempt(attemptKey, String(error?.code || 'metric_connector_approval_invalid'), claim.claimToken);
            throw error;
        }
        const connectorMode = String(connector.connectorMode || this.mode);
        let budget;
        try {
            budget = await this.costRecorder.assertCampaignBudget({
                campaignId: claim.receipt.campaignId,
                connectorMode,
                operation: 'read_own_metrics',
                checkedAt: new Date(collectedAt),
            });
        }
        catch (error: any) {
            await this.#blockMetricAttempt(attemptKey, 'budget_unavailable', claim.claimToken);
            await this.pauseInPaperclip({
                idempotencyKey: attemptKey,
                campaignId: claim.receipt.campaignId,
                reason: 'budget_unavailable',
                now: new Date(collectedAt),
            });
            throw error;
        }
        if (!budget.allowed) {
            await this.#blockMetricAttempt(attemptKey, 'budget_exceeded', claim.claimToken);
            await this.pauseInPaperclip({
                idempotencyKey: attemptKey,
                campaignId: claim.receipt.campaignId,
                reason: 'budget_exceeded',
                now: new Date(collectedAt),
            });
            throw coded('publisher_budget_exceeded', 'Paperclip 活动剩余预算不足；CampaignGrant 已暂停且 Cron 已关闭，指标连接器未调用。');
        }
        await this.repository.update((state: any) => {
            const attempt = state.attempts[attemptKey];
            if (attempt?.claimToken !== claim.claimToken || attempt?.state !== 'prepared') {
                throw coded('metric_collection_claim_lost', '指标采集 claim 已失效，拒绝启动连接器。');
            }
            attempt.state = 'invoking';
            attempt.invokingAt = this.clock().toISOString();
            delete attempt.claimExpiresAt;
        });
        let metricResult: any;
        let metricError: any = null;
        try {
            await this.assertConnectorApproval(claim.receipt.platform, 'read_own_metrics', validGatewayClock(this.clock()));
        }
        catch (error: any) {
            await this.#blockMetricAttempt(attemptKey, String(error?.code || 'real_metric_connector_approval_invalid'), claim.claimToken);
            throw error;
        }
        try {
            metricResult = validateMetricConnectorResult(await connector.readOwnMetrics(claim.receipt, collectedAt, { checkpoint, collectionKey }), claim.receipt, { checkpoint, collectionKey, collectedAt });
        }
        catch (error: any) {
            metricError = error;
        }
        const hardStopReason = normalizedMetricHardStopReason(metricError);
        const metricCostReportingErrorCode = normalizedMetricCostReportingErrorCode(metricError);
        if (hardStopReason) {
            let blockWritebackError: any = null;
            try {
                await this.#blockMetricAttempt(attemptKey, hardStopReason, claim.claimToken, true, metricCostReportingErrorCode);
            }
            catch (error: any) {
                blockWritebackError = error;
            }
            let pauseError: any = null;
            try {
                await this.pauseInPaperclip({
                    idempotencyKey: attemptKey,
                    campaignId: claim.receipt.campaignId,
                    reason: hardStopReason,
                    now: new Date(collectedAt),
                });
            }
            catch (error: any) {
                pauseError = error;
            }
            if (blockWritebackError) {
                await this.activateGlobalHardStop({
                    campaignId: claim.receipt.campaignId,
                    reason: 'metric_hard_stop_writeback_failed',
                    controlError: String(blockWritebackError?.code || 'publisher_ledger_writeback_failure'),
                    activatedAt: this.clock().toISOString(),
                });
                if (pauseError)
                    throw pauseError;
                throw coded('metric_hard_stop_writeback_failed_hard_stop', '平台指标已触发安全硬停且 Paperclip 已暂停，但指标账本回写失败；Publisher Gateway 已全局硬停，禁止重试。');
            }
            if (pauseError)
                throw pauseError;
        }
        if (connector.costReportingMode !== 'transport_actual') {
            try {
                await this.costRecorder.recordLocalZeroAttempt({
                    campaignId: claim.receipt.campaignId,
                    idempotencyKey: attemptKey,
                    connectorMode: String(connector.connectorMode || this.mode),
                    operation: 'read_own_metrics',
                    receiptRef: collectionKey,
                    occurredAt: this.clock(),
                });
            }
            catch (error: any) {
                const costReportingErrorCode = normalizedCostReportingErrorCode(error);
                if (hardStopReason) {
                    await this.#recordMetricCostReportingFailure(attemptKey, costReportingErrorCode);
                }
                else {
                    await this.#stopMetricAttempt(attemptKey, costReportingErrorCode, claim.claimToken);
                }
                throw error;
            }
        }
        if (metricError) {
            if (hardStopReason) {
                throw coded(`metric_collection_stopped_${hardStopReason}`, `平台本人内容指标采集已因 ${hardStopReason} 硬停；CampaignGrant 已暂停且 Cron 已关闭。`);
            }
            await this.#stopMetricAttempt(attemptKey, String(metricError?.code || 'metric_collection_failed'), claim.claimToken);
            throw coded('metric_collection_failed', '平台本人内容指标采集失败，等待 Paperclip 决定恢复动作。');
        }
        if (!metricResult) {
            throw coded('metric_collection_result_missing', '指标连接器没有返回可验证结果，已拒绝写入快照。');
        }
        const snapshot: Record<string, any> = {
            snapshotId: metricSnapshotId(collectionKey),
            collectionKey,
            platform: claim.receipt.platform,
            receiptId: claim.receipt.receiptId,
            contentVersionId: claim.receipt.contentVersionId,
            collectedAt,
            metrics: metricResult.metrics,
            ...(metricResult.accountRef
                ? {
                    accountRef: metricResult.accountRef,
                    externalContentId: metricResult.externalContentId,
                    source: metricResult.source,
                }
                : {}),
        };
        const committed = await this.repository.update((state: any) => {
            const existing = state.metricSnapshots.find((item: any) => item.collectionKey === collectionKey);
            if (existing)
                return { kind: 'replay', snapshot: existing };
            const attempt = state.attempts[attemptKey];
            if (attempt?.claimToken !== claim.claimToken || attempt?.state !== 'invoking') {
                return { kind: 'claim_lost' };
            }
            state.metricSnapshots.push(snapshot);
            attempt.state = 'snapshot_recorded';
            attempt.snapshotId = snapshot.snapshotId;
            attempt.updatedAt = this.clock().toISOString();
            delete attempt.claimToken;
            delete attempt.claimExpiresAt;
            return { kind: 'recorded' };
        });
        if (committed.kind === 'replay') {
            return { replayed: true, snapshot: committed.snapshot };
        }
        if (committed.kind !== 'recorded') {
            throw coded('metric_collection_claim_lost', '指标采集完成前 claim 已失效；拒绝覆盖新所有者或重复写入快照。');
        }
        return { replayed: false, snapshot };
    }
    async #stopMetricAttempt(attemptKey: any, reason: any, claimToken: any = null) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[attemptKey];
            if (!attempt)
                return;
            if (claimToken && attempt.claimToken !== claimToken)
                return;
            attempt.state = 'stopped';
            attempt.stopReason = reason;
            attempt.updatedAt = this.clock().toISOString();
            delete attempt.claimToken;
            delete attempt.claimExpiresAt;
        });
    }
    async #blockMetricAttempt(attemptKey: any, reason: any, claimToken: any = null, hardStop: any = false, costReportingErrorCode: any = null) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[attemptKey];
            if (!attempt)
                return;
            if (claimToken && attempt.claimToken !== claimToken)
                return;
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
    async #recordMetricCostReportingFailure(attemptKey: any, errorCode: any) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[attemptKey];
            if (!attempt?.hardStop || attempt.state !== 'blocked')
                return;
            attempt.costReportingErrorCode = errorCode;
            attempt.updatedAt = this.clock().toISOString();
        });
    }
}
function normalizeTimestamp(value: any) {
    const timestamp = value instanceof Date
        ? value.getTime()
        : Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function validGatewayClock(value: any) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw coded('invalid_publisher_clock', 'Publisher Gateway 时钟无效。');
    }
    return date;
}
function normalizedMetricHardStopReason(error: any) {
    if (error?.hardStop !== true)
        return null;
    const reason = String(error?.stopReason || '');
    if (IMMEDIATE_PAUSE_REASONS.has(reason))
        return reason;
    if (['login', 'login_required'].includes(reason))
        return 'identity_verification';
    if (reason === 'risk')
        return 'risk_control';
    return 'unknown_page';
}
function normalizedMetricCostReportingErrorCode(error: any) {
    if (error?.hardStop !== true || !error?.costReportingErrorCode)
        return null;
    return normalizedCostReportingErrorCode({
        code: error.costReportingErrorCode,
    });
}
function normalizedCostReportingErrorCode(error: any) {
    const code = String(error?.code || '');
    return /^[a-z][a-z0-9_]{1,127}$/.test(code)
        ? code
        : 'cost_reporting_failed';
}
function metricSnapshotId(collectionKey: any) {
    return `metric_${crypto.createHash('sha256').update(collectionKey).digest('hex').slice(0, 32)}`;
}
function validPauseControlResult(value: any, campaignId: any) {
    return value?.campaignId === campaignId
        && value?.grantStatus === 'paused'
        && value?.cronStatus === 'disabled'
        && typeof value?.controlEventId === 'string'
        && value.controlEventId.length > 0;
}
function validateMetricConnectorResult(value: any, receipt: any, context: any) {
    const isEvidenceBound = Boolean(value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.hasOwn(value, 'metrics'));
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
        if (Object.keys(value).sort().join('\n') !== allowedKeys.join('\n')
            || value.platform !== receipt.platform
            || value.receiptId !== receipt.receiptId
            || value.accountRef !== receipt.accountRef
            || value.externalContentId !== receipt.externalContentId
            || value.contentVersionId !== receipt.contentVersionId
            || value.collectionKey !== context.collectionKey
            || value.checkpoint !== context.checkpoint
            || value.collectedAt !== context.collectedAt
            || !validMetricSource(value.source, context)) {
            throw coded('metric_result_identity_mismatch', '平台指标证据与 PublishReceipt、检查点或获批只读来源不一致。');
        }
    }
    const metrics = isEvidenceBound ? value.metrics : value;
    const expectedKeys = receipt.platform === M5_PLATFORM_IDS.XIAOHONGSHU
        ? ['comments', 'likes', 'saves', 'views']
        : receipt.platform === M5_PLATFORM_IDS.DOUYIN
            ? ['comments', 'downloads', 'forwards', 'likes', 'shares', 'views']
            : null;
    const actualKeys = metrics && typeof metrics === 'object' && !Array.isArray(metrics)
        ? Object.keys(metrics).sort()
        : [];
    if (!expectedKeys
        || actualKeys.join('\n') !== expectedKeys.join('\n')
        || actualKeys.some((key: any) => !Number.isSafeInteger(metrics[key]) || metrics[key] < 0)) {
        throw coded('metric_result_unverified', '平台指标必须是该平台允许字段的精确非负整数，拒绝额外字段、估算值或缺失值。');
    }
    return Object.freeze({
        metrics: Object.freeze(Object.fromEntries(expectedKeys.map((key: any) => [key, metrics[key]]))),
        ...(isEvidenceBound
            ? {
                accountRef: value.accountRef,
                externalContentId: value.externalContentId,
                source: structuredClone(value.source),
            }
            : {}),
    });
}
function validMetricSource(value: any, context: any) {
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
    const rawMetricKeys: any[] = ['comments', 'likes', 'saves', 'views'];
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
        && rawMetricKeys.every((key: any) => exactRawMetricValue(value.rawMetrics[key]));
}
function exactRawMetricValue(value: any) {
    if (Number.isSafeInteger(value) && value >= 0)
        return true;
    if (typeof value !== 'string')
        return false;
    const text = value.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(text)
        && !/^(?:[1-9]\d{0,2})(?:,\d{3})+$/.test(text)) {
        return false;
    }
    const parsed = Number(text.replaceAll(',', ''));
    return Number.isSafeInteger(parsed) && parsed >= 0;
}
