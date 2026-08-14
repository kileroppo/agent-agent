import crypto from 'node:crypto';
import { coded } from './policy.ts';
const DEFAULT_STOP_PATTERNS = Object.freeze({
    captcha: ['验证码', 'captcha'],
    identity_verification: ['身份验证', '实名认证', 'verify your identity'],
    account_switch: ['切换账号', '账号已切换', 'switch account'],
    risk_control: ['风控', '操作频繁', '异常操作', 'risk control'],
    platform_violation: ['违规', '内容不符合规范', 'violation'],
});
function normalizeSnapshot(value: any, expectedOrigin: any, selectors: any) {
    const raw = unwrapCuaPayload(value);
    const origin = findOrigin(raw);
    if (origin !== expectedOrigin) {
        return { raw, origin: origin || '', pageState: 'unknown' };
    }
    const text = flattenText(raw);
    return {
        raw,
        origin,
        pageState: text.includes(selectors.result.successText) ? 'published' : 'editing',
    };
}
function detectStopReason(value: any, configured: any = {}) {
    const text = flattenText(value).toLowerCase();
    for (const [reason, patterns] of Object.entries(configured) as Array<[string, any[]]>) {
        if (patterns.some((pattern: any) => text.includes(pattern.toLowerCase())))
            return reason;
    }
    return null;
}
function normalizeStopPatterns(configured: any = {}) {
    const output: Record<string, any> = {};
    for (const [reason, defaults] of Object.entries(DEFAULT_STOP_PATTERNS)) {
        const extra = Array.isArray(configured[reason]) ? configured[reason] : [];
        output[reason] = [...new Set([...defaults, ...extra].map(String).filter(Boolean))];
    }
    return output;
}
function parsePublishedResult(raw: any, selectors: any, clock: any, expectedTitle: any) {
    const text = flattenText(raw);
    const isManagementResult = selectors.result.mode === 'management_detail';
    if (isManagementResult) {
        if (!isManagementEntryReady(raw, selectors.result, expectedTitle))
            return null;
    }
    else if (!text.includes(selectors.result.successText))
        return null;
    if (typeof expectedTitle !== 'string' || !expectedTitle.trim() || !text.includes(expectedTitle.trim())) {
        return null;
    }
    const pageUrl = findPageUrl(raw);
    if (!pageUrl)
        return null;
    const evidence = new URL(pageUrl);
    const contentId = `${text} ${evidence.href}`.match(selectors.result.contentIdRegex)?.[0];
    if (!contentId)
        return null;
    if (evidence.origin !== selectors.origin)
        return null;
    if (isManagementResult) {
        if (!evidence.pathname.startsWith(selectors.result.evidencePathPrefix)
            || !evidence.href.includes(contentId))
            return null;
    }
    else {
        const expectedPath = `${selectors.result.evidencePathPrefix}${encodeURIComponent(contentId)}`;
        if (!evidence.pathname.startsWith(expectedPath))
            return null;
    }
    const observedAt = clock().toISOString();
    return {
        externalContentId: contentId,
        evidence: evidence.href,
        evidenceSnapshotHash: `sha256:${crypto.createHash('sha256')
            .update(JSON.stringify({ url: evidence.href, text }))
            .digest('hex')}`,
        selectorBundleVersion: selectors.selectorBundle?.bundleVersion || null,
        observedAt,
        publishedAt: observedAt,
    };
}
function isManagementEntryReady(raw: any, result: any, expectedTitle: any) {
    if (typeof expectedTitle !== 'string' || !expectedTitle.trim())
        return false;
    const text = flattenText(raw);
    return text.includes(result.managementReadyText)
        && text.includes(expectedTitle.trim())
        && result.publishedStatusTexts.some((status: any) => text.includes(status));
}
function hasManagementEvidence(raw: any, result: any) {
    const pageUrl = findPageUrl(raw);
    if (!pageUrl)
        return false;
    const evidence = new URL(pageUrl);
    const contentId = `${flattenText(raw)} ${evidence.href}`.match(result.contentIdRegex)?.[0];
    return Boolean(contentId
        && evidence.pathname.startsWith(result.evidencePathPrefix)
        && evidence.href.includes(contentId));
}
function combineManagementEvidence(managementSnapshot: any, detailSnapshot: any) {
    return {
        managementEvidence: withoutPageUrls(unwrapCuaPayload(managementSnapshot)),
        detailEvidence: unwrapCuaPayload(detailSnapshot),
    };
}
function withoutPageUrls(value: any): any {
    if (Array.isArray(value))
        return value.map(withoutPageUrls);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]: any) => !['url', 'page_url', 'pageUrl'].includes(key))
        .map(([key, item]: any) => [key, withoutPageUrls(item)]));
}
function verifyPageAccountIdentity(raw: any, identity: any, claim: any) {
    if (identity?.accountTextRegex instanceof RegExp === false
        || claim?.kind !== 'page_identity_sha256'
        || !/^sha256:[a-f0-9]{64}$/.test(String(claim?.value || ''))) {
        return false;
    }
    const text = flattenText(raw);
    const matches = [...text.matchAll(cloneGlobal(identity.accountTextRegex))]
        .map((match: any) => String(match[1] || '').trim().toLowerCase())
        .filter(Boolean);
    const unique: any[] = [...new Set(matches)];
    if (unique.length !== 1)
        return false;
    const actual = `sha256:${crypto.createHash('sha256').update(unique[0]).digest('hex')}`;
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(claim.value));
}
function cloneGlobal(pattern: any) {
    return new RegExp(pattern.source, `${pattern.flags.replaceAll('g', '')}g`);
}
function stopObservation(origin: any, reason: any) {
    return { kind: 'stop', reason, pageState: 'stopped', origin };
}
function parseJson(value: any, label: any) {
    try {
        return JSON.parse(String(value).trim());
    }
    catch {
        throw coded('invalid_cua_output', `${label} 未返回可解析的 JSON。`);
    }
}
function unwrapCuaPayload(value: any): any {
    if (typeof value === 'string') {
        try {
            return unwrapCuaPayload(JSON.parse(value));
        }
        catch {
            return value;
        }
    }
    if (Array.isArray(value))
        return value.map(unwrapCuaPayload);
    if (!value || typeof value !== 'object')
        return value;
    if (Array.isArray(value.content)) {
        const text = value.content.find((item: any) => typeof item?.text === 'string')?.text;
        if (text)
            return unwrapCuaPayload(text);
    }
    if (value.result && Object.keys(value).length <= 3)
        return unwrapCuaPayload(value.result);
    return value;
}
export function parseBrowserPrepareResult(value: any) {
    const prepared = unwrapCuaPayload(value);
    const refusalEnvelope = walk(prepared, (item: any) => (item
        && typeof item === 'object'
        && (item.status === 'refused'
            || (item.refusal && typeof item.refusal === 'object'))));
    if (refusalEnvelope) {
        const refusal = refusalEnvelope.refusal;
        const code = (typeof refusal?.code === 'string'
            && /^[a-z][a-z0-9_]{2,80}$/.test(refusal.code.trim()))
            ? refusal.code.trim()
            : 'browser_prepare_refused';
        const message = (typeof refusal?.message === 'string'
            && refusal.message.trim()
            && refusal.message.trim().length <= 500)
            ? refusal.message.trim()
            : 'CuaDriver 拒绝准备隔离浏览器。';
        throw coded(code, message);
    }
    const preparedPid = findNumber(prepared, 'prepared_pid');
    if (!preparedPid) {
        throw coded('prepared_browser_pid_missing', 'CuaDriver 未返回隔离浏览器 PID。');
    }
    return preparedPid;
}
function walk(value: any, visit: any): any {
    if (visit(value))
        return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found: any = walk(item, visit);
            if (found !== undefined)
                return found;
        }
    }
    else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            const found: any = walk(item, visit);
            if (found !== undefined)
                return found;
        }
    }
    return undefined;
}
function findNumber(value: any, key: any) {
    const found = walk(value, (item: any) => (item && typeof item === 'object' && Number.isInteger(item[key])));
    return found?.[key];
}
function findString(value: any, key: any) {
    const found = walk(value, (item: any) => (item && typeof item === 'object' && typeof item[key] === 'string'));
    return found?.[key];
}
function findOrigin(value: any) {
    const pageUrl = findPageUrl(value);
    return pageUrl ? new URL(pageUrl).origin : null;
}
function findPageUrl(value: any) {
    const matches: any[] = [];
    walkAll(value, (item: any) => {
        if (!item || typeof item !== 'object')
            return;
        for (const key of ['url', 'page_url', 'pageUrl']) {
            if (typeof item[key] !== 'string')
                continue;
            try {
                const candidate = new URL(item[key]);
                if (['http:', 'https:'].includes(candidate.protocol))
                    matches.push(candidate.href);
            }
            catch {
                // Ignore malformed values; ambiguity or absence fails closed below.
            }
        }
    });
    const unique: any[] = [...new Set(matches)];
    return unique.length === 1 ? unique[0] : null;
}
export function findRef(value: any, expectedName: any, action: any) {
    const target = expectedName.toLowerCase();
    const matches: any[] = [];
    walkAll(value, (item: any) => {
        if (!item || typeof item !== 'object' || typeof item.ref !== 'string')
            return false;
        const name = [
            item.name,
            item.accessible_name,
            item.label,
            item.text,
            item.description,
        ].filter(Boolean).join(' ').toLowerCase();
        const actions = Array.isArray(item.actions) ? item.actions : [];
        if (name.includes(target) && actions.includes(action))
            matches.push(item);
        return false;
    });
    const uniqueRefs: any[] = [...new Set(matches.map((item: any) => item.ref))];
    if (uniqueRefs.length === 0) {
        throw coded('browser_ref_missing', `页面快照中未找到“${expectedName}”的 ${action} ref。`);
    }
    if (uniqueRefs.length !== 1) {
        throw coded('browser_ref_ambiguous', `页面中“${expectedName}”的 ${action} ref 不唯一，拒绝猜测。`);
    }
    return uniqueRefs[0];
}
export function findExactRef(value: any, expectedName: any, action: any) {
    const target = String(expectedName || '').trim().toLowerCase();
    const matches: any[] = [];
    walkAll(value, (item: any) => {
        if (!item || typeof item !== 'object' || typeof item.ref !== 'string')
            return;
        const names = [
            item.name,
            item.accessible_name,
            item.label,
            item.text,
            item.description,
        ].filter((name: any) => typeof name === 'string')
            .map((name: any) => name.trim().toLowerCase());
        const actions = Array.isArray(item.actions) ? item.actions : [];
        if (target && names.includes(target) && actions.includes(action))
            matches.push(item.ref);
    });
    const uniqueRefs: any[] = [...new Set(matches)];
    if (uniqueRefs.length === 0) {
        throw coded('browser_ref_missing', `页面快照中未找到标题精确为“${expectedName}”的 ${action} ref。`);
    }
    if (uniqueRefs.length !== 1) {
        throw coded('browser_ref_ambiguous', `页面中标题精确为“${expectedName}”的 ${action} ref 不唯一，拒绝猜测。`);
    }
    return uniqueRefs[0];
}
export function findFileInputRef(value: any) {
    const matches: any[] = [];
    walkAll(value, (item: any) => {
        if (!item || typeof item !== 'object' || typeof item.ref !== 'string')
            return;
        const node = String(item.node || '').toLowerCase();
        const label = String(item.label || '');
        if (node === 'input'
            && /(?:^|\s)type\s*=\s*(?:file|"file"|'file')(?:\s|$)/i.test(label)) {
            matches.push(item.ref);
        }
    });
    const uniqueRefs: any[] = [...new Set(matches)];
    if (uniqueRefs.length === 0) {
        throw coded('browser_ref_missing', '页面快照中未找到唯一的文件上传 input ref。');
    }
    if (uniqueRefs.length !== 1) {
        throw coded('browser_ref_ambiguous', '页面中存在多个文件上传 input ref，拒绝猜测。');
    }
    return uniqueRefs[0];
}
export function findRichTextInputRef(value: any) {
    const matches: any[] = [];
    walkAll(value, (item: any) => {
        if (!item || typeof item !== 'object' || typeof item.ref !== 'string')
            return;
        const node = String(item.node || '').toLowerCase();
        const label = String(item.label || '');
        if (node === 'div' && /(?:^|\s)role\s*=\s*textbox(?:\s|$)/i.test(label)) {
            matches.push(item.ref);
        }
    });
    const uniqueRefs: any[] = [...new Set(matches)];
    if (uniqueRefs.length === 0) {
        throw coded('browser_ref_missing', '页面快照中未找到唯一的富文本正文 ref。');
    }
    if (uniqueRefs.length !== 1) {
        throw coded('browser_ref_ambiguous', '页面中存在多个富文本正文 ref，拒绝猜测。');
    }
    return uniqueRefs[0];
}
function walkAll(value: any, visit: any) {
    visit(value);
    if (Array.isArray(value)) {
        for (const item of value)
            walkAll(item, visit);
    }
    else if (value && typeof value === 'object') {
        for (const item of Object.values(value))
            walkAll(item, visit);
    }
}
function flattenText(value: any): string {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map(flattenText).join(' ');
    if (value && typeof value === 'object')
        return Object.values(value).map(flattenText).join(' ');
    return '';
}
export const cuaSemanticSnapshot = Object.freeze({
    normalize: normalizeSnapshot,
    stopReason: detectStopReason,
    stopPatterns: normalizeStopPatterns,
    publishedResult: parsePublishedResult,
    managementEntryReady: isManagementEntryReady,
    hasManagementEvidence,
    combineManagementEvidence,
    verifyAccountIdentity: verifyPageAccountIdentity,
    stopObservation,
    parseJson,
    unwrap: unwrapCuaPayload,
    walk,
    findString,
    text: flattenText,
});
