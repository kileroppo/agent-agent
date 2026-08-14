import crypto from 'node:crypto';
const DEFAULT_PAPERCLIP_URL: any = 'http://127.0.0.1:3100';
const RECOVERY_ACTION: any = 'publisher.reconcile_stale_attempt';
const RECOVERY_KIND: any = 'metric_recovery_authorization_v1';
const RECOVERY_CONCLUSIONS: any = new Set([
    'no_external_effect',
    'external_effect_verified',
]);
const CREDENTIAL_INPUT_FIELDS: any = new Set([
    'apiKey',
    'runId',
    'issueId',
    'agentId',
    'companyId',
    'approvalId',
]);
const UUID_PATTERN: any = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SCOPE_KEYS: any = Object.freeze([
    'action',
    'attemptId',
    'authorizationId',
    'campaignId',
    'collectionKey',
    'conclusion',
    'consumerAgentId',
    'evidenceRef',
    'issueId',
    'receiptId',
]);
export class PaperclipMetricRecoveryAccess {
    baseUrl: any;
    clock: any;
    currentRunCredentialProvider: any;
    fetch: any;
    timeoutMs: any;
    constructor({ baseUrl = DEFAULT_PAPERCLIP_URL, fetchImpl = fetch, currentRunCredentialProvider, clock = (): any => new Date(), timeoutMs = 2500, }: any = {}) {
        if (typeof fetchImpl !== 'function') {
            throw accessError('Paperclip recovery HTTP client 未配置。');
        }
        if (typeof currentRunCredentialProvider !== 'function') {
            throw accessError('Paperclip current-run credential provider 未配置。');
        }
        this.baseUrl = loopbackPaperclipUrl(baseUrl);
        this.fetch = fetchImpl;
        this.currentRunCredentialProvider = currentRunCredentialProvider;
        this.clock = clock;
        this.timeoutMs = validTimeout(timeoutMs);
    }
    async assertPublisherMetricRecoveryAllowed(input: any = {}): Promise<any> {
        rejectCallerCredentials(input);
        const request: any = normalizeRecoveryRequest(input);
        let credential: any;
        try {
            credential = normalizeCurrentRunCredential(await this.currentRunCredentialProvider());
        }
        catch {
            throw accessError('Paperclip 当前 Run 凭据不可用。');
        }
        const expectedAuthorizationId: any = canonicalMetricRecoveryAuthorizationId(credential.approvalId);
        if (request.authorizationId !== expectedAuthorizationId) {
            throw accessError('Paperclip recovery approval 映射不一致。');
        }
        const scope: any = canonicalRecoveryScope({
            action: request.action,
            attemptId: request.attemptId,
            authorizationId: expectedAuthorizationId,
            campaignId: request.campaignId,
            collectionKey: request.collectionKey,
            conclusion: request.conclusion,
            consumerAgentId: credential.agentId,
            evidenceRef: request.evidenceRef,
            issueId: credential.issueId,
            receiptId: request.receiptId,
        });
        const responsePayload: any = await this.consume({
            approvalId: credential.approvalId,
            apiKey: credential.apiKey,
            runId: credential.runId,
            scope,
        });
        const receipt: any = validateConsumeReceipt(responsePayload, {
            credential,
            scope,
            scopeHash: hashMetricRecoveryScope(scope),
            now: validDate(this.clock()),
        });
        return {
            authorized: true,
            source: 'paperclip',
            action: request.action,
            campaignId: request.campaignId,
            receiptId: request.receiptId,
            collectionKey: request.collectionKey,
            attemptId: request.attemptId,
            conclusion: request.conclusion,
            authorizationId: expectedAuthorizationId,
            evidenceRef: request.evidenceRef,
            approvalRef: `paperclip:approval:${credential.approvalId}`,
            replayed: receipt.replayed,
        };
    }
    async consume({ approvalId, apiKey, runId, scope }: any): Promise<any> {
        let response: any;
        try {
            response = await this.fetch(`${this.baseUrl}/api/approvals/${encodeURIComponent(approvalId)}`
                + '/recovery-authorizations/consume', {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${apiKey}`,
                    'content-type': 'application/json',
                    'x-paperclip-run-id': runId,
                },
                body: JSON.stringify({ scope }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch {
            throw accessError('Paperclip recovery consume 请求失败。');
        }
        if (response?.status !== 200 || response?.ok !== true) {
            throw accessError('Paperclip recovery consume 未获准。');
        }
        try {
            return await response.json();
        }
        catch {
            throw accessError('Paperclip recovery consume 回执无效。');
        }
    }
}
export function canonicalMetricRecoveryAuthorizationId(approvalId: any): any {
    const normalized: any = uuid(approvalId);
    if (!normalized) {
        throw accessError('Paperclip recovery approvalId 无效。');
    }
    return `paperclip:approval:${normalized}:recovery`;
}
export function hashMetricRecoveryScope(scope: any): any {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(canonicalRecoveryScope(scope)))
        .digest('hex')}`;
}
export class PaperclipMetricRecoveryAccessError extends Error {
    code: any;
    name: any;
    constructor(message: any, code: any = 'paperclip_metric_recovery_access_denied') {
        super(message);
        this.name = 'PaperclipMetricRecoveryAccessError';
        this.code = code;
    }
}
function normalizeRecoveryRequest(input: any): any {
    if (!isRecord(input))
        throw accessError('Paperclip recovery 请求无效。');
    const action: any = text(input.action);
    const campaignId: any = uuid(input.campaignId);
    const receiptId: any = uuid(input.receiptId);
    const collectionKey: any = text(input.collectionKey);
    const attemptId: any = safeRef(input.attemptId);
    const conclusion: any = text(input.conclusion);
    const authorizationId: any = safeRef(input.authorizationId);
    const evidenceRef: any = safeRef(input.evidenceRef);
    const match: any = collectionKey?.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(2h|24h|72h)$/i);
    if (action !== RECOVERY_ACTION
        || !campaignId
        || !receiptId
        || !match
        || match[1].toLowerCase() !== receiptId
        || !attemptId
        || !RECOVERY_CONCLUSIONS.has(conclusion)
        || !authorizationId
        || !evidenceRef) {
        throw accessError('Paperclip recovery scope 无效。');
    }
    return {
        action,
        campaignId,
        receiptId,
        collectionKey: `${receiptId}:${match[2]}`,
        attemptId,
        conclusion,
        authorizationId,
        evidenceRef,
    };
}
function normalizeCurrentRunCredential(value: any): any {
    if (!isRecord(value))
        throw accessError('current-run credential 无效。');
    const credential: Record<string, any> = {
        apiKey: text(value.apiKey),
        runId: uuid(value.runId),
        issueId: uuid(value.issueId),
        agentId: uuid(value.agentId),
        companyId: uuid(value.companyId),
        approvalId: uuid(value.approvalId),
    };
    if (!credential.apiKey
        || credential.apiKey.length > 12288
        || Object.entries(credential)
            .filter(([key]: any): any => key !== 'apiKey')
            .some(([, item]: any): any => !item)) {
        throw accessError('current-run credential 无效。');
    }
    return credential;
}
function validateConsumeReceipt(value: any, { credential, scope, scopeHash, now, }: any): any {
    const approval: any = value?.approval;
    const payload: any = approval?.payload;
    const expiresAt: any = Date.parse(payload?.expiresAt);
    const consumedAt: any = Date.parse(payload?.consumedAt);
    const statePairValid: any = (value?.applied === true && value?.replayed === false)
        || (value?.applied === false && value?.replayed === true);
    if (!isRecord(value)
        || !isRecord(approval)
        || approval.id !== credential.approvalId
        || approval.companyId !== credential.companyId
        || approval.type !== 'request_board_approval'
        || approval.status !== 'approved'
        || !isRecord(payload)
        || payload.governanceKind !== RECOVERY_KIND
        || !sameScope(payload.scope, scope)
        || payload.scopeHash !== scopeHash
        || !Number.isFinite(expiresAt)
        || expiresAt <= now.getTime()
        || text(payload.revokedAt)
        || !Number.isFinite(consumedAt)
        || payload.consumedByRunId !== credential.runId
        || payload.consumedByAgentId !== credential.agentId
        || !statePairValid) {
        throw accessError('Paperclip recovery consume 回执与可信 scope 不一致。');
    }
    return { replayed: value.replayed === true };
}
function canonicalRecoveryScope(value: any): any {
    if (!isRecord(value))
        throw accessError('Paperclip recovery scope 无效。');
    const actualKeys: any = Object.keys(value).sort();
    if (actualKeys.length !== SCOPE_KEYS.length
        || actualKeys.some((key: any, index: any): any => key !== SCOPE_KEYS[index])) {
        throw accessError('Paperclip recovery scope 字段无效。');
    }
    const canonical: any = JSON.parse(canonicalJson(value));
    if (canonical.action !== RECOVERY_ACTION
        || !uuid(canonical.campaignId)
        || !uuid(canonical.receiptId)
        || !uuid(canonical.issueId)
        || !uuid(canonical.consumerAgentId)
        || !safeRef(canonical.attemptId)
        || !safeRef(canonical.authorizationId)
        || !safeRef(canonical.evidenceRef)
        || !RECOVERY_CONCLUSIONS.has(canonical.conclusion)
        || canonical.collectionKey
            !== `${canonical.receiptId.toLowerCase()}:${checkpoint(canonical.collectionKey)}`) {
        throw accessError('Paperclip recovery scope 值无效。');
    }
    canonical.campaignId = canonical.campaignId.toLowerCase();
    canonical.receiptId = canonical.receiptId.toLowerCase();
    canonical.issueId = canonical.issueId.toLowerCase();
    canonical.consumerAgentId = canonical.consumerAgentId.toLowerCase();
    return canonical;
}
function checkpoint(collectionKey: any): any {
    const match: any = text(collectionKey)?.match(/:(2h|24h|72h)$/);
    return match?.[1] || '';
}
function sameScope(actual: any, expected: any): any {
    try {
        return canonicalJson(canonicalRecoveryScope(actual))
            === canonicalJson(canonicalRecoveryScope(expected));
    }
    catch {
        return false;
    }
}
function rejectCallerCredentials(input: any): any {
    if (!isRecord(input)
        || Object.keys(input).some((key: any): any => CREDENTIAL_INPUT_FIELDS.has(key))) {
        throw accessError('Paperclip recovery 身份只能由 current-run provider 提供。');
    }
}
function loopbackPaperclipUrl(value: any): any {
    let url: any;
    try {
        url = new URL(String(value || ''));
    }
    catch {
        throw accessError('Paperclip recovery URL 无效。');
    }
    if (url.protocol !== 'http:'
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || (url.pathname !== '/' && url.pathname !== '')
        || url.search
        || url.hash
        || url.username
        || url.password) {
        throw accessError('Paperclip recovery URL 必须是本机 HTTP origin。');
    }
    return url.origin;
}
function canonicalJson(value: any): any {
    if (value === null)
        return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw accessError('scope JSON 数字无效。');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item: any): any => canonicalJson(item)).join(',')}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key: any): any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    throw accessError('scope JSON 无效。');
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw accessError('Paperclip recovery 时钟无效。');
    return date;
}
function validTimeout(value: any): any {
    if (!Number.isSafeInteger(value) || value < 100 || value > 30000) {
        throw accessError('Paperclip recovery timeout 无效。');
    }
    return value;
}
function safeRef(value: any): any {
    const normalized: any = text(value);
    return normalized && SAFE_REF_PATTERN.test(normalized) ? normalized : null;
}
function uuid(value: any): any {
    const normalized: any = text(value);
    return normalized && UUID_PATTERN.test(normalized)
        ? normalized.toLowerCase()
        : null;
}
function text(value: any): any {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}
function isRecord(value: any): any {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function accessError(message: any): any {
    return new PaperclipMetricRecoveryAccessError(message);
}
