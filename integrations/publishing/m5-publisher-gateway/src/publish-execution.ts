import crypto from 'node:crypto';
import { coded, publishIdempotencyKey, receiptId, STOP_REASONS, validatePublishRequest, } from './policy.ts';
const IMMEDIATE_PAUSE_REASONS = new Set(STOP_REASONS);
export class PublishExecution {
    assertConnectorApproval: any;
    assertOperational: any;
    clock: any;
    connectors: any;
    costRecorder: any;
    getArtifactVerifier: any;
    inflight: any;
    mode: any;
    paperclipControl: any;
    pauseInPaperclip: any;
    publishTail: any;
    repository: any;
    constructor({ repository, connectors, getArtifactVerifier, paperclipControl, costRecorder, mode, clock, assertOperational, assertConnectorApproval, pauseInPaperclip, }: any) {
        this.repository = repository;
        this.connectors = connectors;
        this.getArtifactVerifier = getArtifactVerifier;
        this.paperclipControl = paperclipControl;
        this.costRecorder = costRecorder;
        this.mode = mode;
        this.clock = clock;
        this.assertOperational = assertOperational;
        this.assertConnectorApproval = assertConnectorApproval;
        this.pauseInPaperclip = pauseInPaperclip;
        this.inflight = new Map();
        this.publishTail = Promise.resolve();
    }
    publish(request: any) {
        const key = publishIdempotencyKey(request);
        if (this.inflight.has(key))
            return this.inflight.get(key);
        const pending = this.publishTail
            .catch(() => undefined)
            .then(() => this.#publishOnce(request))
            .finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, pending);
        this.publishTail = pending;
        return pending;
    }
    async #publishOnce(request: any) {
        await this.assertOperational();
        const now = this.clock();
        request = await this.#withCanonicalGrant(request, now);
        const preflight = validatePublishRequest(request, now);
        if (!preflight.passed)
            throw coded('publish_preflight_failed', preflight.errors.join(' '));
        await this.assertConnectorApproval(request.platform, 'publish', now);
        const mediaLease = await this.#acquireMediaLease(request.mediaPath, request.contentChecksum);
        try {
            return await this.#publishVerified(request, preflight, mediaLease, now);
        }
        finally {
            await mediaLease.release();
        }
    }
    async #acquireMediaLease(relativePath: any, expectedChecksum: any) {
        const artifactVerifier = this.getArtifactVerifier();
        if (typeof artifactVerifier.acquire === 'function') {
            return artifactVerifier.acquire(relativePath, expectedChecksum);
        }
        const verified = await artifactVerifier.verify(relativePath, expectedChecksum);
        return {
            ...verified,
            immutableLease: false,
            createReadStream: null,
            async release() { },
        };
    }
    async #publishVerified(request: any, preflight: any, mediaLease: any, now: any) {
        const verifiedMedia: Record<string, any> = {
            relativePath: mediaLease.relativePath,
            checksum: mediaLease.checksum,
            bytes: mediaLease.bytes,
            immutableLease: mediaLease.immutableLease === true,
        };
        const campaignId = request.campaignId;
        const claim = await this.repository.update((state: any) => {
            const existing = state.receipts[preflight.idempotencyKey];
            if (existing)
                return { kind: 'replay', receipt: existing };
            const existingAttempt = state.attempts[preflight.idempotencyKey];
            if (existingAttempt) {
                if (existingAttempt.state === 'blocked'
                    && ['budget_exceeded', 'budget_unavailable'].includes(existingAttempt.stopReason)) {
                    existingAttempt.state = 'prepared';
                    existingAttempt.retryCount = Number(existingAttempt.retryCount || 0) + 1;
                    existingAttempt.stopReason = null;
                    existingAttempt.updatedAt = now.toISOString();
                    return { kind: 'claimed', attemptId: existingAttempt.attemptId };
                }
                return {
                    kind: 'blocked',
                    code: 'publish_attempt_ambiguous',
                    reason: 'publish_attempt_requires_reconciliation',
                    attempt: existingAttempt,
                };
            }
            const campaignReceipts = Object.values(state.receipts)
                .filter((receipt: any) => receipt.campaignId === campaignId);
            const dailyPlatformReceipts = campaignReceipts.filter((receipt: any) => (receipt.platform === request.platform && receipt.scheduledDate === request.scheduledDate));
            if (campaignReceipts.length >= request.grant.totalPublishLimit
                || dailyPlatformReceipts.length >= request.grant.dailyPublishLimitPerPlatform) {
                const blocked = createAttempt({
                    request,
                    preflight,
                    verifiedMedia,
                    now,
                    state: 'blocked',
                    stopReason: 'grant_limit_exceeded',
                });
                state.attempts[preflight.idempotencyKey] = blocked;
                return {
                    kind: 'blocked',
                    code: 'grant_limit_exceeded',
                    reason: 'grant_limit_exceeded',
                    attempt: blocked,
                };
            }
            const duplicate = Object.values(state.receipts).find((receipt: any) => (receipt.platform === request.platform && receipt.contentChecksum === request.contentChecksum));
            if (duplicate) {
                const blocked = createAttempt({
                    request,
                    preflight,
                    verifiedMedia,
                    now,
                    state: 'blocked',
                    stopReason: 'duplicate_content',
                });
                state.attempts[preflight.idempotencyKey] = blocked;
                return {
                    kind: 'blocked',
                    code: 'duplicate_content',
                    reason: 'duplicate_content',
                    attempt: blocked,
                };
            }
            const attempt = createAttempt({
                request,
                preflight,
                verifiedMedia,
                now,
                state: 'prepared',
            });
            state.attempts[preflight.idempotencyKey] = attempt;
            return { kind: 'claimed', attemptId: attempt.attemptId };
        });
        if (claim.kind === 'replay')
            return { replayed: true, receipt: claim.receipt };
        if (claim.kind === 'blocked') {
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: claim.reason,
                now,
            });
            throw coded(claim.code, `发布已停止：${claim.reason}。`);
        }
        const connector = this.connectors[request.platform];
        if (!connector) {
            await this.#markAttemptAmbiguous(preflight.idempotencyKey, 'connector_unavailable', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'publish_attempt_requires_reconciliation',
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
                operation: 'publish',
                checkedAt: now,
            });
        }
        catch (error: any) {
            await this.#blockAttempt(preflight.idempotencyKey, 'budget_unavailable', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'budget_unavailable',
                now,
            });
            throw error;
        }
        if (!budget.allowed) {
            await this.#blockAttempt(preflight.idempotencyKey, 'budget_exceeded', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'budget_exceeded',
                now,
            });
            throw coded('publisher_budget_exceeded', 'Paperclip 活动剩余预算不足；CampaignGrant 已暂停且 Cron 已关闭，平台连接器未调用。');
        }
        await this.repository.update((state: any) => {
            const attempt = state.attempts[preflight.idempotencyKey];
            attempt.state = 'invoking';
            attempt.invokingAt = now.toISOString();
        });
        const safeRequest = structuredClone(request);
        delete safeRequest.mediaPath;
        const connectorRequest: Record<string, any> = {
            ...safeRequest,
            idempotencyKey: preflight.idempotencyKey,
            accountRef: request.grant.accountRefs[request.platform],
            verifiedMedia
        };
        if (mediaLease.immutableLease) {
            connectorRequest.mediaLease = Object.freeze({
                createReadStream: () => mediaLease.createReadStream(),
            });
        }
        let result: any;
        let connectorError: any = null;
        try {
            await this.assertConnectorApproval(request.platform, 'publish', validGatewayClock(this.clock()));
        }
        catch (error: any) {
            await this.#blockAttempt(preflight.idempotencyKey, String(error?.code || 'real_connector_approval_invalid'), validGatewayClock(this.clock()));
            throw error;
        }
        try {
            result = await connector.publish(connectorRequest);
        }
        catch (error: any) {
            connectorError = error;
        }
        if (connector.costReportingMode !== 'transport_actual') {
            try {
                await this.costRecorder.recordLocalZeroAttempt({
                    campaignId,
                    idempotencyKey: preflight.idempotencyKey,
                    connectorMode,
                    operation: 'publish',
                    receiptRef: preflight.idempotencyKey,
                    occurredAt: this.clock(),
                });
            }
            catch (error: any) {
                await this.#markAttemptAmbiguous(preflight.idempotencyKey, String(error?.code || 'cost_reporting_failed'), now);
                await this.pauseInPaperclip({
                    idempotencyKey: preflight.idempotencyKey,
                    campaignId,
                    reason: 'publish_attempt_requires_reconciliation',
                    now,
                });
                throw error;
            }
        }
        if (connectorError) {
            await this.#markAttemptAmbiguous(preflight.idempotencyKey, String(connectorError?.code || 'transport_failure'), now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'publish_attempt_requires_reconciliation',
                now,
            });
            throw coded('publish_attempt_ambiguous', '平台调用结果不确定，Paperclip 活动已暂停并要求人工核对；禁止自动重发。');
        }
        if (result.state === 'stopped') {
            const stopped = await this.#recordStoppedAttempt(preflight.idempotencyKey, campaignId, result.stopReason, now);
            if (stopped.pauseRequired) {
                await this.pauseInPaperclip({
                    idempotencyKey: preflight.idempotencyKey,
                    campaignId,
                    reason: result.stopReason,
                    now,
                });
            }
            throw coded(`publish_stopped_${result.stopReason}`, `发布已安全停止：${result.stopReason}。`);
        }
        if (result.state !== 'published' || !result.externalContentId || !validEvidence(result.evidence)) {
            await this.#markAttemptAmbiguous(preflight.idempotencyKey, 'unverified_result', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'publish_attempt_requires_reconciliation',
                now,
            });
            throw coded('publish_result_unverified', '平台未返回结构化内容ID或成功证据，Paperclip 活动已暂停并禁止重发。');
        }
        if (connectorMode.endsWith('_cua') && !validCuaEvidence(result)) {
            await this.#markAttemptAmbiguous(preflight.idempotencyKey, 'cua_evidence_unverified', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'publish_attempt_requires_reconciliation',
                now,
            });
            throw coded('publish_result_unverified', 'CUA 没有返回账号核验、真实内容页、selector 版本和快照哈希，活动已暂停并禁止重发。');
        }
        if (result.accountRef !== connectorRequest.accountRef) {
            await this.#markAttemptAmbiguous(preflight.idempotencyKey, 'account_mismatch', now);
            await this.pauseInPaperclip({
                idempotencyKey: preflight.idempotencyKey,
                campaignId,
                reason: 'publish_attempt_requires_reconciliation',
                now,
            });
            throw coded('publisher_account_mismatch', '连接器实际账号与活动授权引用不一致，Paperclip 活动已暂停。');
        }
        const publishedAt = Number.isFinite(Date.parse(result.publishedAt))
            ? new Date(result.publishedAt).toISOString()
            : now.toISOString();
        await this.repository.update((state: any) => {
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
        const receipt: Record<string, any> = {
            receiptId: receiptId(preflight.idempotencyKey),
            idempotencyKey: preflight.idempotencyKey,
            campaignId,
            platform: request.platform,
            contentVersionId: request.contentVersionId,
            contentChecksum: verifiedMedia.checksum,
            scheduledDate: request.scheduledDate,
            externalContentId: result.externalContentId,
            evidence: result.evidence,
            accountRef: result.accountRef,
            publishedAt,
            connectorMode: connector.connectorMode || this.mode,
            ...(connectorMode.endsWith('_cua')
                ? { evidenceObservation: cuaEvidenceObservation(result) }
                : {}),
        };
        await this.repository.update((state: any) => {
            state.receipts[preflight.idempotencyKey] = receipt;
            state.attempts[preflight.idempotencyKey].state = 'receipt_recorded';
            state.attempts[preflight.idempotencyKey].receiptId = receipt.receiptId;
            state.attempts[preflight.idempotencyKey].updatedAt = now.toISOString();
        });
        return { replayed: false, receipt };
    }
    async #withCanonicalGrant(request: any, now: any) {
        let result;
        try {
            result = await this.paperclipControl.assertPublishAllowed({
                campaignId: request.campaignId,
                checkedAt: now.toISOString(),
            });
        }
        catch {
            throw coded('paperclip_control_unavailable', '无法从 Paperclip 核验当前 CampaignGrant，发布已失败关闭。');
        }
        if (result?.campaignId !== request.campaignId
            || result?.grantStatus !== 'active'
            || result?.currentStage !== 'campaign_active'
            || !result?.canonicalGrant
            || typeof result.canonicalGrant !== 'object'
            || Array.isArray(result.canonicalGrant)) {
            throw coded('campaign_not_active', 'Paperclip 当前 CampaignGrant 不是 active，拒绝发布。');
        }
        return {
            ...structuredClone(request),
            grant: structuredClone(result.canonicalGrant),
        };
    }
    async #markAttemptAmbiguous(idempotencyKey: any, reason: any, now: any) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[idempotencyKey];
            if (attempt) {
                attempt.state = 'ambiguous';
                attempt.ambiguousReason = reason;
                attempt.updatedAt = now.toISOString();
            }
        });
    }
    async #blockAttempt(idempotencyKey: any, reason: any, now: any) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[idempotencyKey];
            if (attempt) {
                attempt.state = 'blocked';
                attempt.stopReason = reason;
                attempt.updatedAt = now.toISOString();
            }
        });
    }
    async #recordStoppedAttempt(idempotencyKey: any, campaignId: any, reason: any, now: any) {
        return this.repository.update((state: any) => {
            const attempt = state.attempts[idempotencyKey];
            attempt.state = 'stopped';
            attempt.stopReason = reason;
            attempt.updatedAt = now.toISOString();
            const consecutiveFailures = countFailuresSinceLastReceipt(state, campaignId);
            return {
                consecutiveFailures,
                pauseRequired: IMMEDIATE_PAUSE_REASONS.has(reason) || consecutiveFailures >= 2,
            };
        });
    }
}
function createAttempt({ request, preflight, verifiedMedia, now, state, stopReason }: any) {
    return {
        attemptId: `attempt_${crypto.randomUUID()}`,
        kind: 'publish',
        idempotencyKey: preflight.idempotencyKey,
        campaignId: request.campaignId,
        platform: request.platform,
        contentVersionId: request.contentVersionId,
        contentChecksum: verifiedMedia.checksum,
        state,
        ...(stopReason ? { stopReason } : {}),
        createdAt: now.toISOString()
    };
}
function countFailuresSinceLastReceipt(state: any, campaignId: any) {
    let failures = 0;
    const attempts: any[] = Object.values(state.attempts)
        .filter((attempt: any) => attempt.kind === 'publish' && attempt.campaignId === campaignId);
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const attempt = attempts[index];
        if (attempt.state === 'receipt_recorded')
            break;
        if (attempt.state === 'stopped')
            failures += 1;
    }
    return failures;
}
function validGatewayClock(value: any) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw coded('invalid_publisher_clock', 'Publisher Gateway 时钟无效。');
    }
    return date;
}
function validEvidence(value: any) {
    return typeof value === 'string' && /^(?:fake|https):\/\/\S+$/.test(value);
}
function validCuaEvidence(value: any) {
    if (value?.accountIdentityVerified !== true
        || !/^sha256:[a-f0-9]{64}$/.test(String(value?.evidenceSnapshotHash || ''))
        || !/^[1-9]\d*\.\d+\.\d+$/.test(String(value?.selectorBundleVersion || ''))
        || !Number.isFinite(Date.parse(value?.observedAt))) {
        return false;
    }
    try {
        const evidence = new URL(value.evidence);
        return evidence.protocol === 'https:'
            && evidence.pathname.includes(encodeURIComponent(value.externalContentId));
    }
    catch {
        return false;
    }
}
function cuaEvidenceObservation(value: any) {
    return {
        evidenceSnapshotHash: value.evidenceSnapshotHash,
        selectorBundleVersion: value.selectorBundleVersion,
        observedAt: new Date(value.observedAt).toISOString(),
        accountIdentityVerified: true,
    };
}
