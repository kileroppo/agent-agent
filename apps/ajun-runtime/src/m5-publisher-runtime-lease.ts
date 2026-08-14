import crypto from 'node:crypto';
import { M5_PLATFORMS } from '@agent-army/m5-contracts';
import { PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA, PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA, PUBLISHER_COST_REPORTER_SCHEMA, createProductionPublisherComposition, } from '@agent-army/m5-publisher-gateway';
export class PublisherRuntimeLease {
    #getDependencies: any;
    #authorizeRequest: any;
    #runtimeProvider: any;
    #synchronizeState: any;
    #runtime: any = null;
    #runtimePromise: any = null;
    #approvalPolicy: any = null;
    constructor({ paperclipAccess, connectorDependencies, workspaceRoot, ledgerPath, paperclipControl, clock = (): any => new Date(), getDependencies, authorizeRequest, runtimeProvider, synchronizeState, }: any = {}) {
        this.#getDependencies = typeof getDependencies === 'function'
            ? getDependencies
            : (): any => ({
                paperclipAccess,
                connectorDependencies,
                workspaceRoot,
                ledgerPath,
                paperclipControl,
                clock,
            });
        this.#authorizeRequest = typeof authorizeRequest === 'function'
            ? authorizeRequest
            : (input: any): any => this.authorize(input.action, input.campaignId, input.context, { allowExactReplay: input.allowExactReplay });
        this.#runtimeProvider = typeof runtimeProvider === 'function'
            ? runtimeProvider
            : (authorization: any): any => this.getRuntime(authorization);
        this.#synchronizeState = typeof synchronizeState === 'function'
            ? synchronizeState
            : (): any => { };
        const dependencies: any = this.#dependencies();
        assertProductionDependencies(dependencies.paperclipAccess, dependencies.connectorDependencies);
    }
    async acquire({ action, campaignId, context, allowExactReplay = false, }: any = {}): Promise<any> {
        const authorization: any = await this.#authorizeRequest({
            action,
            campaignId,
            context,
            allowExactReplay,
        });
        const runtime: any = await this.#runtimeProvider(authorization);
        return { runtime, authorization };
    }
    async authorize(action: any, campaignId: any, context: any, { allowExactReplay = false, }: any = {}): Promise<any> {
        return authorizeOnce({
            paperclipAccess: this.#dependencies().paperclipAccess,
            action,
            campaignId,
            context,
            allowExactReplay,
        });
    }
    async getRuntime(authorization: any): Promise<any> {
        const snapshot: any = await this.#dependencies()
            .paperclipAccess
            .getPublisherConnectorApprovalSnapshot(structuredClone(authorization));
        let approvalPolicy: any;
        try {
            approvalPolicy = normalizePublisherApprovalSnapshot(snapshot, this.#dependencies().clock());
        }
        catch (error: any) {
            if (this.#runtimePromise)
                this.#runtimePromise.invalidated = true;
            throw error;
        }
        if (this.#runtime) {
            assertSameApprovalPolicy(this.#approvalPolicy, approvalPolicy, this.#dependencies().clock());
            return this.#runtime;
        }
        if (this.#runtimePromise) {
            try {
                assertSameApprovalPolicy(this.#runtimePromise.approvalPolicy, approvalPolicy, this.#dependencies().clock());
            }
            catch (error: any) {
                this.#runtimePromise.invalidated = true;
                throw error;
            }
            return this.#runtimePromise.promise;
        }
        const pending: Record<string, any> = {
            approvalPolicy,
            invalidated: false,
            promise: null,
        };
        pending.promise = Promise.resolve().then((): any => {
            if (pending.invalidated)
                throw approvalSnapshotChanged();
            const dependencies: any = this.#dependencies();
            const composition: any = createProductionPublisherComposition({
                enabled: true,
                approvalSnapshot: snapshot,
                connectorDependencies: this.productionConnectorDependencies(),
                workspaceRoot: dependencies.workspaceRoot,
                ledgerPath: dependencies.ledgerPath,
                paperclipControl: dependencies.paperclipControl,
                costReporter: this.paperclipCostReporter(),
                accountIdentityVerifier: this.paperclipAccountIdentityVerifier(),
                clock: dependencies.clock,
            });
            const runtime: any = composition.createRuntime();
            assertSameApprovalPolicy(approvalPolicy, approvalPolicy, this.#dependencies().clock());
            if (pending.invalidated
                || composition.approvalSnapshotId !== approvalPolicy.snapshotId) {
                throw approvalSnapshotChanged();
            }
            this.#runtime = runtime;
            this.#approvalPolicy = approvalPolicy;
            this.#synchronizeState({
                runtime,
                approvalSnapshotId: approvalPolicy.snapshotId,
                approvalSnapshotFingerprint: approvalPolicy.fingerprint,
                approvalSnapshotValidUntil: approvalPolicy.validUntil,
            });
            return runtime;
        }).finally((): any => {
            if (this.#runtimePromise === pending) {
                this.#runtimePromise = null;
                this.#synchronizeState({ runtimePromise: null });
            }
        });
        this.#runtimePromise = pending;
        this.#synchronizeState({ runtimePromise: pending });
        return pending.promise;
    }
    productionConnectorDependencies(): any {
        const connectorDependencies: any = this.#dependencies().connectorDependencies;
        const douyin: any = connectorDependencies.douyinOfficialApi;
        return {
            ...(douyin
                ? {
                    douyinOfficialApi: {
                        httpRequest: douyin.httpRequest,
                        credentialResolver: (input: any): any => (this.#dependencies().paperclipAccess
                            .resolvePublisherCredentialReference(input)),
                        ...(douyin.maxUploadBytes === undefined
                            ? {}
                            : { maxUploadBytes: douyin.maxUploadBytes }),
                    },
                }
                : {}),
            ...(connectorDependencies.cuaRunners
                ? { cuaRunners: connectorDependencies.cuaRunners }
                : {}),
            ...(connectorDependencies.xhsOwnMetricsCua
                ? { xhsOwnMetricsCua: connectorDependencies.xhsOwnMetricsCua }
                : {}),
        };
    }
    paperclipCostReporter(): any {
        return Object.freeze({
            contract: Object.freeze({
                schemaVersion: PUBLISHER_COST_REPORTER_SCHEMA,
                deterministic: true,
                source: 'paperclip',
            }),
            assertCampaignBudget: (input: any): any => (this.#dependencies().paperclipAccess.assertPublisherCampaignBudget(input)),
            recordConnectorAttempt: (input: any): any => (this.#dependencies().paperclipAccess.recordPublisherConnectorAttempt(input)),
        });
    }
    paperclipAccountIdentityVerifier(): any {
        return Object.freeze({
            contract: Object.freeze({
                schemaVersion: PUBLISHER_ACCOUNT_IDENTITY_VERIFIER_SCHEMA,
                deterministic: true,
                source: 'paperclip',
            }),
            verify: (input: any): any => (this.#dependencies().paperclipAccess.verifyPublisherAccountIdentity(input)),
        });
    }
    #dependencies(): any {
        return this.#getDependencies();
    }
}
export class M5PublisherBindingError extends Error {
    code: any;
    constructor(message: any, code: any = 'm5_publisher_binding_failed') {
        super(message);
        this.code = code;
    }
}
function assertProductionDependencies(paperclipAccess: any, connectorDependencies: any): any {
    const required: any[] = [
        'authorizePublisherRequest',
        'getPublisherConnectorApprovalSnapshot',
        'resolvePublisherCredentialReference',
        'verifyPublisherAccountIdentity',
        'assertPublisherCampaignBudget',
        'recordPublisherConnectorAttempt',
        'assertPublisherMetricRecoveryAllowed',
    ];
    if (required.some((method: any): any => typeof paperclipAccess?.[method] !== 'function')) {
        throw new M5PublisherBindingError('A君真实 Publisher 必须注入 Paperclip 授权、connector 批准快照、Secret 引用解析、账号身份核验和费用适配器。', 'paperclip_publisher_access_required');
    }
    if (!connectorDependencies
        || typeof connectorDependencies !== 'object'
        || Array.isArray(connectorDependencies)) {
        throw new M5PublisherBindingError('A君真实 Publisher 必须显式注入已审核 transport 或 CUA runner。', 'publisher_connector_dependencies_required');
    }
}
async function authorizeOnce({ paperclipAccess, action, campaignId, context, allowExactReplay, }: any): Promise<any> {
    const presented: Record<string, any> = {
        action: String(context?.action || ''),
        runId: String(context?.runId || ''),
        issueId: String(context?.issueId || ''),
        campaignId: String(context?.campaignId || ''),
        agentId: String(context?.agentId || ''),
        authorizationId: String(context?.authorizationId || ''),
    };
    if (presented.action !== action
        || presented.campaignId !== String(campaignId || '')
        || Object.entries(presented)
            .filter(([field]: any): any => field !== 'action')
            .some(([, value]: any): any => !validAuthorizationReference(value))) {
        throw new M5PublisherBindingError('A君 Publisher 缺少与 action、Run、Issue、Campaign 和控制器一致的可信授权上下文。', 'publisher_authorization_scope_mismatch');
    }
    let result: any;
    try {
        result = await paperclipAccess.authorizePublisherRequest(structuredClone(presented));
    }
    catch {
        throw new M5PublisherBindingError('Paperclip Publisher Run 授权核验失败。', 'publisher_request_unauthorized');
    }
    if (result?.authorized !== true
        || Object.entries(presented).some(([field, value]: any): any => result[field] !== value)) {
        throw new M5PublisherBindingError('Paperclip Publisher 授权范围与 action、Run、Issue 或 Campaign 不一致。', 'publisher_authorization_scope_mismatch');
    }
    if (result?.replayed === true) {
        if (allowExactReplay === true)
            return { ...presented, replayed: true };
        throw new M5PublisherBindingError('Paperclip Publisher 一次性授权已经使用，拒绝重放。', 'publisher_authorization_replayed');
    }
    return presented;
}
function normalizePublisherApprovalSnapshot(snapshot: any, nowValue: any): any {
    const now: any = validClock(nowValue);
    const capturedAt: any = Date.parse(snapshot?.capturedAt);
    if (!snapshot
        || typeof snapshot !== 'object'
        || Array.isArray(snapshot)
        || snapshot.schemaVersion !== PUBLISHER_APPROVAL_SNAPSHOT_SCHEMA
        || snapshot.source !== 'paperclip'
        || typeof snapshot.snapshotId !== 'string'
        || !snapshot.snapshotId.startsWith('paperclip:')
        || !Number.isFinite(capturedAt)
        || capturedAt > now.getTime()
        || !Array.isArray(snapshot.approvals)
        || snapshot.approvals.length === 0) {
        throw approvalSnapshotInvalid();
    }
    const approvals: any[] = [];
    const identities: any = new Set();
    for (const raw of snapshot.approvals) {
        const capability: any = raw?.capability || 'publish';
        const expiresAt: any = Date.parse(raw?.expiresAt);
        const identity: any = `${String(raw?.platform || '')}:${String(capability || '')}`;
        if (!M5_PLATFORMS.includes(raw?.platform)
            || !['publish', 'read_own_metrics'].includes(capability)
            || !['douyin_official_api', 'cua', 'xhs_own_metrics_cua']
                .includes(raw?.connectorKind)
            || (capability === 'publish' && raw?.connectorKind === 'xhs_own_metrics_cua')
            || (capability === 'read_own_metrics'
                && !['douyin_official_api', 'xhs_own_metrics_cua'].includes(raw?.connectorKind))
            || raw?.status !== 'approved'
            || typeof raw?.approvalRef !== 'string'
            || !raw.approvalRef.startsWith('paperclip:')
            || !Number.isFinite(expiresAt)
            || identities.has(identity)) {
            throw approvalSnapshotInvalid();
        }
        if (expiresAt <= now.getTime())
            throw approvalSnapshotExpired();
        identities.add(identity);
        approvals.push({
            platform: raw.platform,
            capability,
            connectorKind: raw.connectorKind,
            status: raw.status,
            approvalRef: raw.approvalRef,
            expiresAt: new Date(expiresAt).toISOString(),
        });
    }
    approvals.sort((left: any, right: any): any => (`${left.platform}:${left.capability}`.localeCompare(`${right.platform}:${right.capability}`)));
    const validUntil: any = Math.min(...approvals.map((approval: any): any => Date.parse(approval.expiresAt)));
    const fingerprint: any = `sha256:${crypto.createHash('sha256')
        .update(stableJson({
        schemaVersion: snapshot.schemaVersion,
        source: snapshot.source,
        snapshotId: snapshot.snapshotId,
        approvals,
    }))
        .digest('hex')}`;
    return Object.freeze({
        snapshotId: snapshot.snapshotId,
        fingerprint,
        validUntil,
    });
}
function assertSameApprovalPolicy(expected: any, current: any, nowValue: any): any {
    const now: any = validClock(nowValue);
    if (!Number.isFinite(expected?.validUntil)
        || expected.validUntil <= now.getTime()
        || !Number.isFinite(current?.validUntil)
        || current.validUntil <= now.getTime()) {
        throw approvalSnapshotExpired();
    }
    if (expected?.snapshotId !== current?.snapshotId
        || expected?.fingerprint !== current?.fingerprint
        || expected?.validUntil !== current?.validUntil) {
        throw approvalSnapshotChanged();
    }
}
function approvalSnapshotInvalid(): any {
    return new M5PublisherBindingError('Paperclip connector 批准快照结构、状态或能力范围无效，拒绝复用真实 Runtime。', 'publisher_approval_snapshot_invalid');
}
function approvalSnapshotExpired(): any {
    return new M5PublisherBindingError('Paperclip connector 批准快照已经到期；旧 Runtime 保持停止，必须重新批准并显式重建。', 'publisher_approval_snapshot_expired');
}
function approvalSnapshotChanged(): any {
    return new M5PublisherBindingError('Paperclip connector 批准快照已经变化；旧 Runtime 保持停止，必须显式重建。', 'publisher_approval_snapshot_changed');
}
function validClock(value: any): any {
    const timestamp: any = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isFinite(timestamp)) {
        throw new M5PublisherBindingError('A君 Publisher 时钟无效，拒绝核验 connector 批准。', 'publisher_clock_invalid');
    }
    return new Date(timestamp);
}
function stableJson(value: any): any {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key: any): any => (`${JSON.stringify(key)}:${stableJson(value[key])}`)).join(',')}}`;
}
function validAuthorizationReference(value: any): any {
    return /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/.test(String(value || ''));
}
