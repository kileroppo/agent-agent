import crypto from 'node:crypto';
import { M5_SCHEMA_IDS } from '@agent-army/m5-contracts';
import { PublisherCostRecorder } from './cost-reporting.ts';
import { coded } from './policy.ts';
import { WECHAT_DRAFT_PLATFORM } from './wechat-wenyan-connector.ts';
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ARTICLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,500}\.md$/i;
const FORBIDDEN_REQUEST_FIELDS = new Set([
    'appId',
    'appSecret',
    'accessToken',
    'refreshToken',
    'cookie',
    'credential',
]);
export function wechatDraftIdempotencyKey(request: any) {
    return [
        String(request?.campaignId || ''),
        WECHAT_DRAFT_PLATFORM,
        String(request?.contentVersionId || ''),
        'create_draft',
    ].join(':');
}
export class WechatDraftGateway {
    approvalScope: any;
    artifactVerifier: any;
    clock: any;
    connector: any;
    costRecorder: any;
    inflight: any;
    paperclipControl: any;
    repository: any;
    constructor({ repository, artifactVerifier, connector, approvalScope, paperclipControl, costReporter, costRecorder, clock = () => new Date(), }: any = {}) {
        if (!repository?.read || !repository?.update || typeof artifactVerifier?.acquire !== 'function') {
            throw coded('wechat_draft_dependencies_missing', '公众号草稿网关必须使用事务账本和不可变文件租约。');
        }
        if (connector?.platform !== WECHAT_DRAFT_PLATFORM
            || connector?.connectorMode !== 'real:wechat_wenyan_cli'
            || typeof connector?.createDraft !== 'function') {
            throw coded('wechat_draft_connector_invalid', '公众号草稿网关必须注入受控 Wenyan connector。');
        }
        if (!String(approvalScope?.accountRef || '').startsWith('paperclip:account:')
            || !String(approvalScope?.secretRef || '').startsWith('paperclip:secret:')) {
            throw coded('wechat_draft_approval_scope_invalid', '公众号草稿网关必须绑定获批账号与 Secret Reference。');
        }
        if (typeof paperclipControl?.assertWechatDraftAllowed !== 'function'
            || typeof paperclipControl?.pauseCampaignAndDisableCron !== 'function') {
            throw coded('paperclip_control_required', '公众号草稿网关必须逐次核验 Paperclip 授权并能暂停活动。');
        }
        this.repository = repository;
        this.artifactVerifier = artifactVerifier;
        this.connector = connector;
        this.approvalScope = Object.freeze(structuredClone(approvalScope));
        this.paperclipControl = paperclipControl;
        this.clock = clock;
        this.costRecorder = costRecorder || new PublisherCostRecorder({
            repository,
            costReporter,
            clock,
        });
        this.inflight = new Map();
    }
    async createDraft(request: any) {
        const normalized = validateDraftRequest(request);
        if (normalized.accountRef !== this.approvalScope.accountRef
            || normalized.secretRef !== this.approvalScope.secretRef) {
            throw coded('wechat_draft_approval_scope_mismatch', '公众号草稿请求与连接器批准账号不一致。');
        }
        const key = wechatDraftIdempotencyKey(normalized);
        if (this.inflight.has(key))
            return this.inflight.get(key);
        const pending = this.createDraftOnce(normalized, key).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
        return pending;
    }
    async createDraftOnce(request: any, idempotencyKey: any) {
        const now = validClock(this.clock());
        await this.assertAuthorized(request, now);
        const leases: any[] = [];
        try {
            for (const file of request.files) {
                leases.push(await this.artifactVerifier.acquire(file.relativePath, file.checksum));
            }
            let budget;
            try {
                budget = await this.costRecorder.assertCampaignBudget({
                    campaignId: request.campaignId,
                    connectorMode: this.connector.connectorMode,
                    operation: 'create_wechat_draft',
                    checkedAt: now,
                });
            }
            catch (error: any) {
                await this.pauseBeforeExternal(request, 'budget_unavailable', now);
                throw error;
            }
            if (!budget.allowed) {
                await this.pauseBeforeExternal(request, 'budget_exceeded', now);
                throw coded('publisher_budget_exceeded', 'Paperclip 活动剩余预算不足，公众号草稿连接器未调用。');
            }
            const claim = await this.repository.update((state: any) => {
                const receipt = state.receipts[idempotencyKey];
                if (receipt)
                    return { kind: 'replay', receipt };
                if (state.attempts[idempotencyKey])
                    return { kind: 'ambiguous' };
                state.attempts[idempotencyKey] = {
                    schemaVersion: 'agent.army/wechat-draft-attempt/v1',
                    idempotencyKey,
                    campaignId: request.campaignId,
                    contentVersionId: request.contentVersionId,
                    accountRef: request.accountRef,
                    authorizationId: request.authorizationId,
                    state: 'prepared',
                    createdAt: now.toISOString(),
                };
                return { kind: 'claimed' };
            });
            if (claim.kind === 'replay')
                return { replayed: true, receipt: claim.receipt };
            if (claim.kind === 'ambiguous') {
                throw coded('wechat_draft_attempt_ambiguous', '同一公众号草稿已有未完成尝试，禁止自动重试。');
            }
            try {
                await this.assertAuthorized(request, validClock(this.clock()));
            }
            catch (error: any) {
                await this.blockAttempt(idempotencyKey, String(error?.code || 'authorization_invalid'));
                throw error;
            }
            await this.repository.update((state: any) => {
                state.attempts[idempotencyKey].state = 'invoking';
                state.attempts[idempotencyKey].invokingAt = validClock(this.clock()).toISOString();
            });
            let result;
            try {
                result = await this.connector.createDraft({
                    ...request,
                    files: leases.map((lease: any) => ({
                        relativePath: lease.relativePath,
                        createReadStream: () => lease.createReadStream(),
                    })),
                });
                await this.costRecorder.recordLocalZeroAttempt({
                    campaignId: request.campaignId,
                    idempotencyKey,
                    connectorMode: this.connector.connectorMode,
                    operation: 'create_wechat_draft',
                    receiptRef: idempotencyKey,
                    occurredAt: validClock(this.clock()),
                });
            }
            catch (error: any) {
                await this.failAmbiguous(request, idempotencyKey, error);
            }
            if (result?.state !== 'draft_created'
                || !SAFE_REFERENCE.test(String(result.externalDraftId || ''))
                || result.evidence !== `wenyan:draft:${result.externalDraftId}`
                || result.accountRef !== request.accountRef
                || !Number.isFinite(Date.parse(result.draftCreatedAt))) {
                await this.failAmbiguous(request, idempotencyKey, coded('wechat_draft_result_unverified', '公众号草稿回执无法核验。'));
            }
            const receipt = Object.freeze({
                schemaVersion: M5_SCHEMA_IDS.WECHAT_DRAFT_RECEIPT,
                kind: 'WechatDraftReceipt',
                receiptId: draftReceiptId(idempotencyKey),
                idempotencyKey,
                campaignId: request.campaignId,
                platform: WECHAT_DRAFT_PLATFORM,
                contentVersionId: request.contentVersionId,
                accountRef: request.accountRef,
                externalDraftId: result.externalDraftId,
                evidence: result.evidence,
                draftCreatedAt: new Date(result.draftCreatedAt).toISOString(),
                connectorMode: this.connector.connectorMode,
                externalPublished: false,
                groupSent: false,
                humanReviewRequired: true,
            });
            try {
                await this.repository.update((state: any) => {
                    state.receipts[idempotencyKey] = receipt;
                    state.attempts[idempotencyKey].state = 'receipt_recorded';
                    state.attempts[idempotencyKey].receiptId = receipt.receiptId;
                    state.attempts[idempotencyKey].updatedAt = validClock(this.clock()).toISOString();
                });
            }
            catch (error: any) {
                await this.failAmbiguous(request, idempotencyKey, coded('wechat_draft_receipt_commit_failed', '公众号草稿外部成功，但本地回执未能安全落账。'));
            }
            return { replayed: false, receipt };
        }
        finally {
            await Promise.allSettled(leases.map((lease: any) => lease.release()));
        }
    }
    async assertAuthorized(request: any, checkedAt: any) {
        let result;
        try {
            result = await this.paperclipControl.assertWechatDraftAllowed({
                campaignId: request.campaignId,
                accountRef: request.accountRef,
                secretRef: request.secretRef,
                authorizationId: request.authorizationId,
                checkedAt: checkedAt.toISOString(),
            });
        }
        catch {
            throw coded('paperclip_control_unavailable', '无法从 Paperclip 核验公众号草稿授权。');
        }
        if (result?.authorized !== true
            || result?.source !== 'paperclip'
            || result?.capability !== 'create_wechat_draft'
            || result?.campaignId !== request.campaignId
            || result?.accountRef !== request.accountRef
            || result?.secretRef !== request.secretRef
            || result?.authorizationId !== request.authorizationId
            || !String(result?.approvalRef || '').startsWith('paperclip:')
            || !Number.isFinite(Date.parse(result?.expiresAt))
            || Date.parse(result.expiresAt) <= checkedAt.getTime()) {
            throw coded('wechat_draft_authorization_invalid', 'Paperclip 当前公众号草稿授权无效或已经过期。');
        }
    }
    async blockAttempt(idempotencyKey: any, reason: any) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[idempotencyKey];
            if (!attempt)
                return;
            attempt.state = 'blocked';
            attempt.stopReason = reason;
            attempt.updatedAt = validClock(this.clock()).toISOString();
        });
    }
    async failAmbiguous(request: any, idempotencyKey: any, error: any) {
        await this.repository.update((state: any) => {
            const attempt = state.attempts[idempotencyKey];
            if (!attempt)
                return;
            attempt.state = 'ambiguous';
            attempt.stopReason = String(error?.code || 'wechat_draft_transport_failure');
            attempt.updatedAt = validClock(this.clock()).toISOString();
        }).catch(() => undefined);
        try {
            const pause = await this.paperclipControl.pauseCampaignAndDisableCron({
                campaignId: request.campaignId,
                reason: 'wechat_draft_attempt_requires_reconciliation',
                idempotencyKey: `wechat-draft-pause:${request.campaignId}:${idempotencyKey}`,
                requestedAt: validClock(this.clock()).toISOString(),
            });
            if (pause?.campaignId !== request.campaignId
                || pause?.grantStatus !== 'paused'
                || pause?.cronStatus !== 'disabled') {
                throw new Error('invalid pause receipt');
            }
        }
        catch {
            throw coded('paperclip_pause_failed_hard_stop', '公众号草稿结果不确定且 Paperclip 未确认暂停；必须人工停机核对。');
        }
        throw coded('wechat_draft_attempt_ambiguous', '公众号草稿调用结果不确定，活动已暂停；禁止自动重试。');
    }
    async pauseBeforeExternal(request: any, reason: any, checkedAt: any) {
        try {
            const pause = await this.paperclipControl.pauseCampaignAndDisableCron({
                campaignId: request.campaignId,
                reason,
                idempotencyKey: `wechat-draft-pause:${request.campaignId}:${reason}`,
                requestedAt: checkedAt.toISOString(),
            });
            if (pause?.campaignId !== request.campaignId
                || pause?.grantStatus !== 'paused'
                || pause?.cronStatus !== 'disabled') {
                throw new Error('invalid pause receipt');
            }
        }
        catch {
            throw coded('paperclip_pause_failed_hard_stop', 'Paperclip 未确认预算硬停，公众号草稿连接器保持关闭。');
        }
    }
}
function validateDraftRequest(value: any) {
    if (containsForbiddenRequestField(value)
        || value?.schemaVersion !== M5_SCHEMA_IDS.WECHAT_DRAFT_REQUEST
        || !safeRef(value.campaignId)
        || !safeRef(value.contentVersionId)
        || !String(value.accountRef || '').startsWith('paperclip:account:')
        || !String(value.secretRef || '').startsWith('paperclip:secret:')
        || !String(value.authorizationId || '').startsWith('paperclip:')
        || !ARTICLE_PATH.test(String(value.articlePath || ''))
        || !Array.isArray(value.files)
        || value.files.length < 1
        || value.files.length > 25) {
        throw coded('wechat_draft_request_invalid', '公众号草稿请求结构、Paperclip 引用或正文路径无效。');
    }
    const paths = new Set();
    for (const file of value.files) {
        const relativePath = String(file?.relativePath || '').replaceAll('\\', '/');
        if (!relativePath || relativePath.startsWith('/')
            || relativePath.split('/').some((part: any) => !part || part === '.' || part === '..')
            || paths.has(relativePath)
            || !SHA256.test(String(file?.checksum || ''))) {
            throw coded('wechat_draft_request_invalid', '公众号草稿文件清单路径或哈希无效。');
        }
        paths.add(relativePath);
    }
    if (!paths.has(value.articlePath)) {
        throw coded('wechat_draft_request_invalid', '公众号 Markdown 正文不在审核文件清单内。');
    }
    return structuredClone(value);
}
function containsForbiddenRequestField(value: any) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).some((key: any) => FORBIDDEN_REQUEST_FIELDS.has(key))
        : false;
}
function safeRef(value: any) {
    return SAFE_REFERENCE.test(String(value || ''));
}
function validClock(value: any) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw coded('wechat_draft_clock_invalid', '公众号草稿网关时钟无效。');
    }
    return value;
}
function draftReceiptId(idempotencyKey: any) {
    return `wechat-draft-${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
}
