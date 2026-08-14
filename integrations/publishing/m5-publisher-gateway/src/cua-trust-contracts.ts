import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CUA_PLATFORM_ORIGINS } from './cua-connector.ts';
import { coded } from './policy.ts';
export const CUA_SELECTOR_BUNDLE_SCHEMA = 'agent.army/cua-selector-bundle/v1';
export const CUA_PROFILE_LEASE_SCHEMA = 'agent.army/cua-profile-lease/v1';
const MAX_SELECTOR_BUNDLE_BYTES = 256 * 1024;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export async function loadApprovedSelectorBundle({ file, trustedRoot, approval, platform, clock = () => new Date(), }: any = {}) {
    const resolvedFile = path.resolve(String(file || ''));
    const resolvedRoot = path.resolve(String(trustedRoot || ''));
    if (!path.isAbsolute(String(file || ''))
        || !path.isAbsolute(String(trustedRoot || ''))
        || resolvedRoot === path.parse(resolvedRoot).root
        || !isInside(resolvedRoot, resolvedFile)) {
        throw coded('cua_selector_bundle_path_invalid', 'selector bundle 必须位于受信任的非根目录内。');
    }
    const [rootRealPath, fileStat] = await Promise.all([
        fs.realpath(resolvedRoot),
        fs.lstat(resolvedFile),
    ]);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw coded('cua_selector_bundle_file_invalid', 'selector bundle 必须是普通文件，不能是符号链接。');
    }
    if ((fileStat.mode & 0o022) !== 0) {
        throw coded('cua_selector_bundle_permissions_invalid', 'selector bundle 不能允许组或其他用户写入。');
    }
    if (fileStat.size <= 0 || fileStat.size > MAX_SELECTOR_BUNDLE_BYTES) {
        throw coded('cua_selector_bundle_size_invalid', 'selector bundle 必须介于 1 byte 和 256 KiB。');
    }
    const fileRealPath = await fs.realpath(resolvedFile);
    if (rootRealPath !== resolvedRoot
        || fileRealPath !== resolvedFile
        || !isInside(rootRealPath, fileRealPath)) {
        throw coded('cua_selector_bundle_path_invalid', 'selector bundle 路径包含符号链接或逃逸受信任目录。');
    }
    const bytes = await fs.readFile(fileRealPath);
    const checksum = sha256(bytes);
    let document;
    try {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw coded('cua_selector_bundle_json_invalid', 'selector bundle 不是有效 JSON。');
    }
    if (approval?.bundleChecksum !== checksum) {
        throw coded('cua_selector_bundle_checksum_mismatch', 'selector bundle 文件哈希与 Paperclip 批准不一致。');
    }
    return validateApprovedSelectorBundle({ ...document, approval: { ...approval } }, { platform, clock });
}
export function validateApprovedSelectorBundle(bundle: any, { platform, origin = CUA_PLATFORM_ORIGINS[platform], clock = () => new Date(), }: any = {}) {
    const now = normalizeNow(clock);
    const expiresAt = Date.parse(bundle?.approval?.expiresAt);
    const expectedChecksum = selectorBundleChecksum(bundle);
    if (!CUA_PLATFORM_ORIGINS[platform]
        || origin !== CUA_PLATFORM_ORIGINS[platform]
        || bundle?.schemaVersion !== CUA_SELECTOR_BUNDLE_SCHEMA
        || bundle?.platform !== platform
        || bundle?.origin !== origin
        || !validVersion(bundle?.bundleVersion)
        || bundle?.approval?.status !== 'approved'
        || bundle?.approval?.source !== 'paperclip'
        || typeof bundle?.approval?.approvalRef !== 'string'
        || !bundle.approval.approvalRef.startsWith('paperclip:')
        || bundle?.approval?.platform !== platform
        || bundle?.approval?.bundleVersion !== bundle.bundleVersion
        || bundle?.approval?.selectorChecksum !== expectedChecksum
        || !Number.isFinite(expiresAt)
        || expiresAt <= now.getTime()) {
        throw coded('cua_selector_bundle_approval_invalid', `${String(platform || 'unknown')} selector bundle 缺少有效、未过期且哈希绑定的 Paperclip 批准。`);
    }
    if (!validSelectorMapShape(bundle?.selectorMap)) {
        throw coded('cua_selector_bundle_invalid', 'selector bundle 缺少账号核验、固定五步动作或真实回执定位契约。');
    }
    return Object.freeze({
        schemaVersion: bundle.schemaVersion,
        bundleVersion: bundle.bundleVersion,
        platform,
        origin,
        selectorMap: deepFreeze(structuredClone(bundle.selectorMap)),
        approval: Object.freeze({
            source: 'paperclip',
            status: 'approved',
            approvalRef: bundle.approval.approvalRef,
            selectorChecksum: expectedChecksum,
            expiresAt: new Date(expiresAt).toISOString(),
        }),
    });
}
export function selectorBundleChecksum(bundle: any) {
    const approvedDocument: Record<string, any> = {
        schemaVersion: bundle?.schemaVersion,
        bundleVersion: bundle?.bundleVersion,
        platform: bundle?.platform,
        origin: bundle?.origin,
        selectorMap: bundle?.selectorMap,
    };
    return sha256(Buffer.from(canonicalJson(approvedDocument)));
}
export function validateApprovedProfileLease(lease: any, { platform, accountRef, clock = () => new Date(), }: any = {}) {
    const now = normalizeNow(clock);
    const expiresAt = Date.parse(lease?.expiresAt);
    if (lease?.schemaVersion !== CUA_PROFILE_LEASE_SCHEMA
        || lease?.source !== 'paperclip'
        || lease?.status !== 'approved'
        || typeof lease?.leaseRef !== 'string'
        || !lease.leaseRef.startsWith('paperclip:')
        || lease?.platform !== platform
        || lease?.accountRef !== accountRef
        || !PROFILE_NAME_PATTERN.test(String(lease?.profileName || ''))
        || lease?.identityClaim?.kind !== 'page_identity_sha256'
        || !/^sha256:[a-f0-9]{64}$/.test(String(lease?.identityClaim?.value || ''))
        || !Number.isFinite(expiresAt)
        || expiresAt <= now.getTime()
        || containsSecretMaterial(lease)) {
        throw coded('cua_profile_lease_invalid', `${String(platform || 'unknown')} 命名 Profile 缺少有效、未过期且账号绑定的 Paperclip lease。`);
    }
    return Object.freeze({
        schemaVersion: CUA_PROFILE_LEASE_SCHEMA,
        source: 'paperclip',
        status: 'approved',
        leaseRef: lease.leaseRef,
        platform,
        accountRef,
        profileName: lease.profileName,
        identityClaim: Object.freeze({
            kind: 'page_identity_sha256',
            value: lease.identityClaim.value,
        }),
        expiresAt: new Date(expiresAt).toISOString(),
    });
}
function containsSecretMaterial(value: any): boolean {
    const forbidden = /(cookie|token|secret|password|credential|storage|loginstate)/i;
    if (!value || typeof value !== 'object')
        return false;
    return Object.entries(value).some(([key, item]: any) => (forbidden.test(key) || containsSecretMaterial(item)));
}
function validVersion(value: any) {
    return /^[1-9]\d*\.\d+\.\d+$/.test(String(value || ''));
}
function validSelectorMapShape(value: any) {
    const resultMode = value?.result?.mode || 'direct';
    const managementResultValid = resultMode !== 'management_detail' || (typeof value?.result?.managementPath === 'string'
        && value.result.managementPath.startsWith('/')
        && !value.result.managementPath.startsWith('//')
        && !value.result.managementPath.includes('\\')
        && typeof value?.result?.managementReadyText === 'string'
        && value.result.managementReadyText.trim()
        && Array.isArray(value?.result?.publishedStatusTexts)
        && value.result.publishedStatusTexts.length > 0
        && value.result.publishedStatusTexts.length <= 5
        && value.result.publishedStatusTexts.every((item: any) => (typeof item === 'string' && item.trim() && item.length <= 40)));
    if (!value
        || typeof value.path !== 'string'
        || !value.path.startsWith('/')
        || typeof value.identity?.accountTextPattern !== 'string'
        || !value.actions?.upload_media?.label
        || !value.actions?.set_title?.label
        || !value.actions?.set_body?.label
        || !value.actions?.set_tags?.label
        || !value.actions?.submit_publish?.label
        || !value.result?.successText
        || !value.result?.contentIdPattern
        || !value.result?.evidencePathPrefix
        || !['direct', 'management_detail'].includes(resultMode)
        || !managementResultValid) {
        return false;
    }
    try {
        const identity = new RegExp(value.identity.accountTextPattern, 'i');
        const content = new RegExp(value.result.contentIdPattern);
        return Boolean(identity.source && content.source && !content.flags.includes('g'));
    }
    catch {
        return false;
    }
}
function normalizeNow(clock: any) {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw coded('cua_trust_clock_invalid', 'CUA 信任契约时钟无效。');
    }
    return date;
}
function isInside(root: any, target: any) {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function sha256(bytes: any) {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
function canonicalJson(value: any): string {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key: any) => (`${JSON.stringify(key)}:${canonicalJson(value[key])}`)).join(',')}}`;
    }
    return JSON.stringify(value);
}
function deepFreeze(value: any) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value))
        return value;
    Object.freeze(value);
    for (const item of Object.values(value))
        deepFreeze(item);
    return value;
}
