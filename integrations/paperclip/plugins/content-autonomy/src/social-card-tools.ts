import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { M5_PLATFORM_IDS, M5_SCHEMA_IDS } from '@agent-army/m5-contracts';
import { coded, safeRelativePath, sha256 } from './policy.ts';
const defaultExecuteFile = promisify(execFile);
const DEFAULT_RENDERER_SCRIPT = fileURLToPath(new URL('../scripts/render-social-card-package.mjs', import.meta.url));
const CARD_KINDS = Object.freeze(['cover', 'evidence', 'checklist']);
export async function renderM5SocialCardPackage(ctx: any, params: any, run: any, options: any = {}) {
    const validation = validateM5SocialCardProps(params?.props);
    if (!validation.passed)
        throw coded('social_card_props_invalid', validation.errors.join(' '));
    const root = await workspaceRoot(ctx, run.companyId, true);
    await validateReferencedAssets(root, params.props);
    const output = await newWorkspaceDirectory(root, params.outputDir);
    const temporary = `${output.absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const rendererScript = await resolveRendererScript(options.rendererScript || DEFAULT_RENDERER_SCRIPT);
    const execute = options.executeFile || defaultExecuteFile;
    try {
        await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
        const propsBytes = Buffer.from(`${JSON.stringify(params.props, null, 2)}\n`, 'utf8');
        await fs.writeFile(path.join(temporary, 'social-card.props.json'), propsBytes, { mode: 0o600, flag: 'wx' });
        await execute(process.execPath, [
            rendererScript,
            '--props', path.join(temporary, 'social-card.props.json'),
            '--output', temporary,
            '--public-dir', root,
        ], {
            cwd: path.dirname(rendererScript),
            timeout: 5 * 60000,
            maxBuffer: 2000000,
        });
        const manifestPath = path.join(temporary, 'social-card-render-manifest.tson');
        const manifestBytes = await fs.readFile(manifestPath);
        const manifest = parseJson(manifestBytes, 'social_card_manifest_invalid', '社交卡渲染清单不是有效 JSON。');
        const cards = await verifiedRenderedCards(temporary, manifest, params.props.cards);
        await fs.rename(temporary, output.absolute);
        await hardenDirectory(output.absolute);
        return {
            content: '受控小红书静态卡包已写入内容工作区；本工具不会发布。',
            data: {
                schemaVersion: M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE,
                platform: M5_PLATFORM_IDS.XIAOHONGSHU,
                outputDir: output.relative,
                propsPath: path.posix.join(output.relative, 'social-card.props.json'),
                propsChecksum: sha256(propsBytes),
                manifestPath: path.posix.join(output.relative, 'social-card-render-manifest.tson'),
                manifestChecksum: sha256(manifestBytes),
                templateBindingHash: params.props.templateBinding.bindingHash,
                rightsBasis: params.props.rightsBasis,
                rightsBasisHash: sha256(Buffer.from(params.props.rightsBasis, 'utf8')),
                cards: cards.map((card: any) => ({
                    ...card,
                    relativePath: path.posix.join(output.relative, card.file),
                })),
                checks: {
                    dimensions: true,
                    fileHashes: true,
                    assetLineage: true,
                    rightsBasis: true,
                    externalNetworkUsed: false,
                },
                command: { executable: 'node', profile: 'm5-social-card-controlled-v1' },
            },
        };
    }
    catch (error: any) {
        await fs.rm(temporary, { recursive: true, force: true });
        if (error?.code && String(error.code).startsWith('social_card_'))
            throw error;
        throw coded('social_card_render_failed', `受控社交卡渲染失败：${String(error?.code || 'renderer_error')}。`);
    }
}
export function validateM5SocialCardProps(props: any) {
    const errors = [];
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return { passed: false, errors: ['社交卡 props 必须是对象。'] };
    }
    if (props.platform !== M5_PLATFORM_IDS.XIAOHONGSHU)
        errors.push('社交卡平台必须是 xiaohongshu。');
    if (!boundedText(props.title, 1, 40))
        errors.push('社交卡标题长度必须是 1–40 个字符。');
    if (!boundedText(props.subtitle, 1, 120))
        errors.push('社交卡副标题长度必须是 1–120 个字符。');
    if (!boundedText(props.sourceLabel, 1, 80))
        errors.push('社交卡来源标签长度必须是 1–80 个字符。');
    if (!boundedText(props.rightsBasis, 1, 500))
        errors.push('社交卡必须提供素材版权依据。');
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(props.templateBinding?.bindingHash || ''))) {
        errors.push('社交卡必须绑定可信模板哈希。');
    }
    const ledger = Array.isArray(props.assetLedger) ? props.assetLedger : [];
    const ledgerPaths = ledger.map((item: any) => String(item?.relativePath || ''));
    if (ledger.length < 1
        || ledger.length > 12
        || new Set(ledgerPaths).size !== ledger.length
        || ledger.some((item: any) => !safeImagePath(item?.relativePath) || !sha256Value(item?.checksum))) {
        errors.push('社交卡素材账本必须包含 1–12 个图片相对路径和 sha256。');
    }
    const assetPaths = new Set(ledger.map((item: any) => String(item.relativePath || '')));
    const cards = Array.isArray(props.cards) ? props.cards : [];
    if (cards.length < 3 || cards.length > 9) {
        errors.push('小红书静态卡必须包含 3–9 页。');
    }
    else {
        const ids = new Set();
        for (const [index, card] of cards.entries()) {
            if (typeof card?.id !== 'string'
                || !/^[a-z0-9][a-z0-9-]{1,48}$/i.test(card.id)
                || ids.has(card.id)) {
                errors.push(`第 ${index + 1} 页 id 无效或重复。`);
            }
            ids.add(card?.id);
            if (!CARD_KINDS.includes(card?.kind))
                errors.push(`第 ${index + 1} 页版式不在白名单。`);
            const limits = cardTextLimits(card?.kind);
            if (!boundedText(card?.headline, 1, limits.headline))
                errors.push(`第 ${index + 1} 页标题长度无效。`);
            if (!boundedText(card?.body, 1, limits.body))
                errors.push(`第 ${index + 1} 页正文长度无效。`);
            const bullets = Array.isArray(card?.bullets) ? card.bullets : [];
            if (bullets.length > limits.bullets || bullets.some((item: any) => !boundedText(item, 1, limits.bullet))) {
                errors.push(`第 ${index + 1} 页要点数量或长度超过固定版式上限。`);
            }
            if (card?.imageSrc != null && (!safeImagePath(card.imageSrc) || !assetPaths.has(card.imageSrc))) {
                errors.push(`第 ${index + 1} 页图片必须来自可信素材账本。`);
            }
        }
        if (cards[0]?.kind !== 'cover')
            errors.push('社交卡第一页必须是 cover。');
    }
    return { passed: errors.length === 0, errors };
}
async function verifiedRenderedCards(directory: any, manifest: any, requestedCards: any) {
    if (manifest?.schemaVersion !== 1
        || manifest?.platform !== M5_PLATFORM_IDS.XIAOHONGSHU
        || !Array.isArray(manifest.cards)
        || manifest.cards.length !== requestedCards.length) {
        throw coded('social_card_manifest_invalid', '社交卡渲染清单与请求页数或平台不一致。');
    }
    const results = [];
    for (const [index, item] of manifest.cards.entries()) {
        const expectedId = requestedCards[index].id;
        if (item?.id !== expectedId
            || !/^[a-z0-9][a-z0-9._-]*\.png$/i.test(String(item?.file || ''))
            || String(item.file).includes('..')
            || item.width !== 1080
            || item.height !== 1440
            || !sha256Value(item.checksum)
            || !Number.isInteger(item.bytes)
            || item.bytes <= 0) {
            throw coded('social_card_manifest_invalid', `社交卡第 ${index + 1} 页清单字段无效。`);
        }
        const bytes = await fs.readFile(path.join(directory, item.file));
        const dimensions = pngDimensions(bytes);
        if (bytes.length !== item.bytes
            || sha256(bytes) !== item.checksum
            || dimensions.width !== 1080
            || dimensions.height !== 1440) {
            throw coded('social_card_output_invalid', `社交卡第 ${index + 1} 页文件尺寸或哈希不匹配。`);
        }
        results.push({
            id: item.id,
            file: item.file,
            width: dimensions.width,
            height: dimensions.height,
            bytes: bytes.length,
            checksum: sha256(bytes),
        });
    }
    return results;
}
async function validateReferencedAssets(root: any, props: any) {
    for (const asset of props.assetLedger) {
        const relative = safeRelativePath(asset.relativePath);
        const absolute = await fs.realpath(path.resolve(root, relative)).catch(() => null);
        if (!absolute || !absolute.startsWith(`${root}${path.sep}`)) {
            throw coded('social_card_asset_denied', '社交卡素材不存在或通过符号链接逃逸工作区。');
        }
        const bytes = await fs.readFile(absolute);
        if (sha256(bytes) !== String(asset.checksum).toLowerCase()) {
            throw coded('social_card_asset_checksum_mismatch', '社交卡素材哈希与可信账本不一致。');
        }
    }
}
async function workspaceRoot(ctx: any, companyId: any, writable: any) {
    const status = await ctx.localFolders.status(companyId, 'content-workspace');
    if (!status.healthy || !status.realPath || (writable && !status.writable)) {
        throw coded('content_workspace_unavailable', '内容生产工作区不可写。');
    }
    return fs.realpath(status.realPath);
}
async function newWorkspaceDirectory(root: any, relativePath: any) {
    const relative = safeRelativePath(relativePath);
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(`${root}${path.sep}`))
        throw coded('path_escape', '社交卡输出路径逃逸工作区。');
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    const parent = await fs.realpath(path.dirname(candidate));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`))
        throw coded('symlink_escape', '社交卡输出目录逃逸工作区。');
    const absolute = path.join(parent, path.basename(candidate));
    if (await fs.lstat(absolute).then(() => true).catch(() => false)) {
        throw coded('social_card_output_exists', '社交卡输出目录已存在，禁止覆盖不可变产物。');
    }
    return { root, absolute, relative };
}
async function resolveRendererScript(configured: any) {
    const script = await fs.realpath(configured).catch(() => null);
    if (!script || script !== path.resolve(configured)) {
        throw coded('social_card_renderer_unavailable', '固定社交卡渲染脚本不可用。');
    }
    return script;
}
async function hardenDirectory(directory: any) {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile())
            await fs.chmod(path.join(directory, entry.name), 0o600);
    }
}
function pngDimensions(bytes: any) {
    const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
    if (bytes.length < 36
        || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || !bytes.subarray(-12).equals(iend))
        throw coded('social_card_output_invalid', '社交卡输出不是有效 PNG。');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function parseJson(bytes: any, code: any, message: any) {
    try {
        return JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw coded(code, message);
    }
}
function safeImagePath(value: any) {
    if (typeof value !== 'string')
        return false;
    const text = String(value || '').replaceAll('\\', '/');
    return /\.(?:png|jpe?g|webp)$/i.test(text)
        && !text.startsWith('/')
        && text.split('/').every((part: any) => part && part !== '.' && part !== '..');
}
function sha256Value(value: any) {
    return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}
function boundedText(value: any, minimum: any, maximum: any) {
    if (typeof value !== 'string')
        return false;
    const text = String(value || '').trim();
    return [...text].length >= minimum && [...text].length <= maximum;
}
function cardTextLimits(kind: any) {
    if (kind === 'cover')
        return { headline: 14, body: 60, bullets: 3, bullet: 18 };
    if (kind === 'evidence')
        return { headline: 16, body: 60, bullets: 3, bullet: 24 };
    return { headline: 16, body: 60, bullets: 6, bullet: 24 };
}
