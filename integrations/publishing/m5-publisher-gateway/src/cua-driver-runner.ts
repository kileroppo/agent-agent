import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CUA_PLATFORM_ORIGINS, CUA_PUBLISH_ACTIONS, CUA_RUNNER_SCHEMA, } from './cua-connector.ts';
import { coded } from './policy.ts';
import { validateApprovedProfileLease, validateApprovedSelectorBundle, } from './cua-trust-contracts.ts';
import { CuaDriverCliBridge } from './cua-driver-cli-bridge.ts';
import { cuaSemanticSnapshot, findExactRef, findFileInputRef, findRichTextInputRef, parseBrowserPrepareResult, } from './cua-semantic-snapshot.ts';
export { CuaDriverCliBridge, findExactRef, findFileInputRef, findRichTextInputRef, parseBrowserPrepareResult, };
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
export class CuaDriverPublisherRunner {
    bridge: any;
    clock: any;
    contract: any;
    enabled: any;
    profileLease: any;
    resultPollAttempts: any;
    resultPollIntervalMs: any;
    selectorBundles: any;
    selectorMaps: any;
    sessions: any;
    sleep: any;
    temporaryRoot: any;
    constructor({ enabled = false, selectorMaps = {}, selectorBundles = {}, profileLease = null, bridge = new CuaDriverCliBridge(), temporaryRoot = os.tmpdir(), clock = () => new Date(), resultPollAttempts = 20, resultPollIntervalMs = 250, sleep = (milliseconds: any) => new Promise((resolve) => setTimeout(resolve, milliseconds)), }: any = {}) {
        this.enabled = enabled === true;
        if (Object.keys(selectorMaps || {}).length > 0
            && Object.keys(selectorBundles || {}).length > 0) {
            throw coded('cua_selector_source_conflict', '不能同时注入未批准 selector map 和已批准 selector bundle。');
        }
        this.selectorMaps = { ...selectorMaps };
        this.selectorBundles = { ...selectorBundles };
        this.profileLease = profileLease ? { ...profileLease } : null;
        this.bridge = bridge;
        this.temporaryRoot = temporaryRoot;
        this.clock = clock;
        if (!Number.isInteger(resultPollAttempts)
            || resultPollAttempts < 1
            || resultPollAttempts > 40
            || !Number.isInteger(resultPollIntervalMs)
            || resultPollIntervalMs < 0
            || resultPollIntervalMs > 1000
            || typeof sleep !== 'function') {
            throw coded('cua_result_poll_invalid', '发布结果轮询必须是最多40次、每次最多1秒的只读有界轮询。');
        }
        this.resultPollAttempts = resultPollAttempts;
        this.resultPollIntervalMs = resultPollIntervalMs;
        this.sleep = sleep;
        this.sessions = new Map();
        const profileMode = this.profileLease ? 'isolated_named' : 'isolated_new';
        this.contract = Object.freeze({
            schemaVersion: CUA_RUNNER_SCHEMA,
            profileMode,
            profileName: this.profileLease?.profileName || null,
            accountIdentityVerification: this.profileLease
                ? 'page_identity_sha256'
                : 'unverified',
            selectorTrust: Object.keys(this.selectorBundles).length > 0
                ? 'approved_bundle'
                : 'unapproved',
            allowedActions: Object.freeze([...CUA_PUBLISH_ACTIONS]),
            arbitraryDesktop: false,
        });
    }
    async beginSession(input: any = {}) {
        if (!this.enabled) {
            throw coded('cua_runner_disabled', 'CuaDriver runner 默认关闭，尚未获得单独启用批准。');
        }
        const profile = validateBeginInput(input, this.contract, this.profileLease, this.clock);
        const approvedBundle = this.selectorBundles[input.platform]
            ? validateApprovedSelectorBundle(this.selectorBundles[input.platform], {
                platform: input.platform,
                origin: input.origin,
                clock: this.clock,
            })
            : null;
        const selectors = validateSelectorMap(approvedBundle
            ? {
                ...approvedBundle.selectorMap,
                platform: approvedBundle.platform,
                origin: approvedBundle.origin,
                selectorBundle: {
                    bundleVersion: approvedBundle.bundleVersion,
                    approvalRef: approvedBundle.approval.approvalRef,
                    selectorChecksum: approvedBundle.approval.selectorChecksum,
                    expiresAt: approvedBundle.approval.expiresAt,
                },
            }
            : this.selectorMaps[input.platform], input.platform, input.origin);
        const directory = await fs.mkdtemp(path.join(this.temporaryRoot, 'm5-cua-runner-'));
        await fs.chmod(directory, 0o700);
        const sessionId = `m5-cua-${crypto.randomUUID()}`;
        try {
            const bridgeSession = await this.bridge.open({
                sessionId,
                platform: input.platform,
                origin: input.origin,
                readableDirectory: directory,
                selectors,
                profileMode: profile.mode,
                profileName: profile.name || null,
            });
            const initial = cuaSemanticSnapshot.normalize(await this.bridge.snapshot(bridgeSession), input.origin, selectors);
            const stopReason = cuaSemanticSnapshot.stopReason(initial.raw, selectors.stopPatterns);
            if (stopReason) {
                await this.bridge.close(bridgeSession).catch(() => undefined);
                await fs.rm(directory, { recursive: true, force: true });
                return {
                    sessionId,
                    observation: cuaSemanticSnapshot.stopObservation(input.origin, stopReason),
                };
            }
            if (!cuaSemanticSnapshot.verifyAccountIdentity(initial.raw, selectors.identity, profile.identityClaim)) {
                await this.bridge.close(bridgeSession).catch(() => undefined);
                await fs.rm(directory, { recursive: true, force: true });
                return {
                    sessionId,
                    observation: cuaSemanticSnapshot.stopObservation(input.origin, 'account_switch'),
                };
            }
            this.sessions.set(sessionId, {
                bridgeSession,
                directory,
                origin: input.origin,
                platform: input.platform,
                selectors,
                profile,
                accountIdentityVerified: true,
                nextActionIndex: 0,
            });
            return {
                sessionId,
                observation: {
                    kind: 'ok',
                    pageState: initial.pageState === 'editing' ? 'editing' : 'ready',
                    origin: initial.origin,
                },
            };
        }
        catch (error: any) {
            await fs.rm(directory, { recursive: true, force: true });
            throw error;
        }
    }
    async perform(input: any = {}) {
        const session = this.sessions.get(String(input.sessionId || ''));
        if (!session)
            throw coded('cua_session_missing', 'CUA session 不存在或已经结束。');
        validatePerformInput(input, session);
        const before = cuaSemanticSnapshot.normalize(await this.bridge.snapshot(session.bridgeSession), session.origin, session.selectors);
        const beforeStop = cuaSemanticSnapshot.stopReason(before.raw, session.selectors.stopPatterns);
        if (beforeStop)
            return cuaSemanticSnapshot.stopObservation(session.origin, beforeStop);
        const action = input.action;
        let result;
        if (action === 'upload_media') {
            const media = await materializeMediaLease({
                directory: session.directory,
                mediaLease: input.input?.mediaLease,
                verifiedMedia: input.input?.verifiedMedia,
            });
            result = await this.bridge.upload(session.bridgeSession, session.selectors.actions.upload_media, media.file);
        }
        else if (action === 'set_title' || action === 'set_body') {
            result = await this.bridge.type(session.bridgeSession, session.selectors.actions[action], String(input.input?.text || ''));
        }
        else if (action === 'set_tags') {
            const tags = Array.isArray(input.input?.tags) ? input.input.tags : [];
            result = await this.bridge.type(session.bridgeSession, session.selectors.actions.set_tags, tags.length > 0 ? ` ${tags.join(' ')}` : '');
        }
        else if (action === 'submit_publish') {
            result = await this.bridge.click(session.bridgeSession, session.selectors.actions.submit_publish);
        }
        else {
            const pollInput: Record<string, any> = {
                bridge: this.bridge,
                bridgeSession: session.bridgeSession,
                origin: session.origin,
                selectors: session.selectors,
                attempts: this.resultPollAttempts,
                intervalMs: this.resultPollIntervalMs,
                sleep: this.sleep,
            };
            result = session.selectors.result.mode === 'management_detail'
                && typeof this.bridge.readManagementResult === 'function'
                ? await this.bridge.readManagementResult({
                    ...pollInput,
                    expectedTitle: input.input?.expectedTitle,
                })
                : await pollPublishedResult(pollInput);
        }
        const after = cuaSemanticSnapshot.normalize(result, session.origin, session.selectors);
        const stopReason = cuaSemanticSnapshot.stopReason(after.raw, session.selectors.stopPatterns);
        if (stopReason)
            return cuaSemanticSnapshot.stopObservation(session.origin, stopReason);
        session.nextActionIndex += 1;
        if (action === 'read_result') {
            const published = cuaSemanticSnapshot.publishedResult(after.raw, session.selectors, this.clock, input.input?.expectedTitle);
            if (!published)
                return cuaSemanticSnapshot.stopObservation(session.origin, 'unknown_page');
            return {
                kind: 'ok',
                pageState: 'published',
                origin: after.origin,
                accountIdentityVerified: session.accountIdentityVerified === true,
                ...published,
            };
        }
        return {
            kind: 'ok',
            pageState: action === 'submit_publish' ? 'submitted' : 'editing',
            origin: after.origin,
        };
    }
    async endSession(input: any = {}) {
        const sessionId = String(input.sessionId || '');
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        this.sessions.delete(sessionId);
        try {
            await this.bridge.close(session.bridgeSession);
        }
        finally {
            await fs.rm(session.directory, { recursive: true, force: true });
        }
    }
}
async function pollPublishedResult({ bridge, bridgeSession, origin, selectors, attempts, intervalMs, sleep, }: any) {
    let last: any = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = await bridge.snapshot(bridgeSession);
        const normalized = cuaSemanticSnapshot.normalize(last, origin, selectors);
        if (normalized.origin !== origin
            || normalized.pageState === 'published'
            || cuaSemanticSnapshot.stopReason(normalized.raw, selectors.stopPatterns)) {
            return last;
        }
        if (attempt + 1 < attempts && intervalMs > 0)
            await sleep(intervalMs);
    }
    return last;
}
async function materializeMediaLease({ directory, mediaLease, verifiedMedia }: any) {
    if (mediaLease?.immutableLease !== true
        || typeof mediaLease?.createReadStream !== 'function'
        || !/^sha256:[a-f0-9]{64}$/.test(String(verifiedMedia?.checksum || ''))
        || !Number.isInteger(verifiedMedia?.bytes)
        || verifiedMedia.bytes < 0
        || verifiedMedia.bytes > MAX_MEDIA_BYTES) {
        throw coded('invalid_cua_media_lease', 'CUA 上传需要审核哈希绑定的不可变媒体 lease。');
    }
    const file = path.join(directory, 'media-upload');
    const handle = await fs.open(file, 'wx', 0o400);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
        for await (const chunk of mediaLease.createReadStream()) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_MEDIA_BYTES)
                throw coded('cua_media_too_large', 'CUA 上传文件不得超过 2 GiB。');
            hash.update(buffer);
            await handle.write(buffer);
        }
        await handle.sync();
    }
    catch (error: any) {
        await handle.close().catch(() => undefined);
        await fs.rm(file, { force: true });
        throw error;
    }
    await handle.close();
    const checksum = `sha256:${hash.digest('hex')}`;
    if (checksum !== verifiedMedia.checksum || bytes !== verifiedMedia.bytes) {
        await fs.rm(file, { force: true });
        throw coded('cua_media_verification_failed', 'CUA 上传临时副本与审核哈希或字节数不一致。');
    }
    return { file, checksum, bytes };
}
function validateBeginInput(input: any, contract: any, profileLease: any, clock: any) {
    const expectedOrigin = CUA_PLATFORM_ORIGINS[input.platform];
    const actionsMatch = Array.isArray(input.allowedActions)
        && input.allowedActions.length === CUA_PUBLISH_ACTIONS.length
        && input.allowedActions.every((action: any, index: any) => action === CUA_PUBLISH_ACTIONS[index]);
    if (!expectedOrigin
        || input.origin !== expectedOrigin
        || input.profile?.mode !== contract.profileMode
        || (contract.profileMode === 'isolated_named'
            && input.profile?.name !== contract.profileName)
        || (contract.profileMode === 'isolated_new' && input.profile?.name)
        || !actionsMatch) {
        throw coded('cua_begin_input_invalid', 'CUA session 只允许精确官方 origin、独立 Profile 和固定六步动作。');
    }
    if (contract.profileMode === 'isolated_named') {
        const approved = validateApprovedProfileLease(profileLease, {
            platform: input.platform,
            accountRef: input.accountRef,
            clock,
        });
        return {
            mode: 'isolated_named',
            name: approved.profileName,
            identityClaim: approved.identityClaim,
        };
    }
    return { mode: 'isolated_new' };
}
function validatePerformInput(input: any, session: any) {
    const expectedAction = CUA_PUBLISH_ACTIONS[session.nextActionIndex];
    if (input.platform !== session.platform
        || input.expectedOrigin !== session.origin
        || input.action !== expectedAction) {
        throw coded('cua_action_sequence_invalid', 'CUA 发布动作越权、跨平台或顺序不正确。');
    }
}
function validateSelectorMap(selectors: any, platform: any, origin: any) {
    const resultMode = selectors?.result?.mode || 'direct';
    const managementResultValid = resultMode !== 'management_detail' || (typeof selectors?.result?.managementPath === 'string'
        && selectors.result.managementPath.startsWith('/')
        && !selectors.result.managementPath.startsWith('//')
        && !selectors.result.managementPath.includes('\\')
        && typeof selectors?.result?.managementReadyText === 'string'
        && selectors.result.managementReadyText.trim()
        && Array.isArray(selectors?.result?.publishedStatusTexts)
        && selectors.result.publishedStatusTexts.length > 0
        && selectors.result.publishedStatusTexts.length <= 5
        && selectors.result.publishedStatusTexts.every((item: any) => (typeof item === 'string' && item.trim() && item.length <= 40)));
    if (!selectors
        || selectors.platform !== platform
        || selectors.origin !== origin
        || typeof selectors.path !== 'string'
        || !selectors.identity?.accountTextPattern
        || !selectors.actions
        || !selectors.actions.upload_media?.label
        || !selectors.actions.set_title?.label
        || !selectors.actions.set_body?.label
        || !selectors.actions.set_tags?.label
        || !selectors.actions.submit_publish?.label
        || !selectors.result?.successText
        || !selectors.result?.contentIdPattern
        || !selectors.result?.evidencePathPrefix
        || !['direct', 'management_detail'].includes(resultMode)
        || !managementResultValid) {
        throw coded('cua_selector_map_missing', `${platform} 尚无经过审核的官方创作页 selector map，真实 CUA 保持关闭。`);
    }
    let pattern;
    let identityPattern;
    try {
        pattern = new RegExp(selectors.result.contentIdPattern);
        identityPattern = new RegExp(selectors.identity.accountTextPattern, 'i');
    }
    catch {
        throw coded('cua_selector_map_invalid', 'CUA selector map 的账号或内容 ID 规则无效。');
    }
    if (!pattern.source
        || pattern.flags.includes('g')
        || !identityPattern.source
        || identityPattern.flags.includes('g')) {
        throw coded('cua_selector_map_invalid', 'CUA selector map 的内容 ID 规则不能为空或使用全局匹配。');
    }
    const evidence = new URL(selectors.result.evidencePathPrefix, origin);
    if (evidence.origin !== origin) {
        throw coded('cua_selector_map_invalid', 'CUA selector map 的发布证据路径逃逸了官方 origin。');
    }
    return {
        ...selectors,
        identity: { ...selectors.identity, accountTextRegex: identityPattern },
        stopPatterns: cuaSemanticSnapshot.stopPatterns(selectors.stopPatterns),
        result: { ...selectors.result, mode: resultMode, contentIdRegex: pattern },
    };
}
