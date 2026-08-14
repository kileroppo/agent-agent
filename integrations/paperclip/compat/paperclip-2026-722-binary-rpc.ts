import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
export const PAPERCLIP_VERSION: any = '2026.722.0';
export const CONTENT_PLUGIN_VERSION: any = '0.5.0';
export const HOST_ORIGINAL_SHA256: any = '3113cfdd8f60726086945deaf066f5941a7758099a3eebd10456c703388068eb';
export const HOST_PATCHED_SHA256: any = '71f8702afcc70cbe366e7d64138c820abe97a77fb679cfe27c9af8382569d8c1';
export const CONTENT_PLUGIN_STEPFUN_SHA256: any = '524c917e1d784250263e5c7af2657b1f7ad9a4066f39d22e0558f008858a578e';
export const BACKUP_SUFFIX: any = '.agent-army-paperclip-2026.722.0-binary-rpc.bak';
const CONTENT_PLUGIN_STEPFUN_SHA256_BY_VERSION: any = Object.freeze({
    '0.4.6': 'd0c3ba28e2a175e16beacf3f2ee2761caa77aec5a6b62cf710869210be11ecf7',
    '0.4.7': 'd0c3ba28e2a175e16beacf3f2ee2761caa77aec5a6b62cf710869210be11ecf7',
    '0.4.8': 'df8223807097e865db59b80a109530030ff36ffb06e032426fa01366404be4de',
    '0.4.9': 'df8223807097e865db59b80a109530030ff36ffb06e032426fa01366404be4de',
    '0.5.0': CONTENT_PLUGIN_STEPFUN_SHA256,
});
export function contentPluginStepfunShaForVersion(version: any): any {
    return CONTENT_PLUGIN_STEPFUN_SHA256_BY_VERSION[String(version || '')] ?? null;
}
const HOST_RELATIVE_PATH: any = '@paperclipai/server/dist/services/plugin-host-services.js';
const HOST_ORIGINAL: any = `    return {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage ?? "",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
    };`;
const HOST_PATCHED: any = `    const responseBody = Buffer.concat(chunks);
    delete headers["x-paperclip-body-encoding"];
    const contentType = String(headers["content-type"] ?? "").toLowerCase();
    const isTextBody = !contentType ||
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("javascript") ||
        contentType.includes("x-www-form-urlencoded") ||
        contentType.includes("svg");
    if (!isTextBody) {
        headers["x-paperclip-body-encoding"] = "base64";
    }
    return {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage ?? "",
        headers,
        body: isTextBody ? responseBody.toString("utf8") : responseBody.toString("base64"),
    };`;
export function serializePaperclipHttpBody(headersInput: any, bytesInput: any): any {
    const headers: any = Object.fromEntries(Object.entries(headersInput || {}).map(([key, value]: any): any => [key.toLowerCase(), String(value)]));
    delete headers['x-paperclip-body-encoding'];
    const contentType: any = String(headers['content-type'] ?? '').toLowerCase();
    const isTextBody: any = !contentType
        || contentType.startsWith('text/')
        || contentType.includes('json')
        || contentType.includes('xml')
        || contentType.includes('javascript')
        || contentType.includes('x-www-form-urlencoded')
        || contentType.includes('svg');
    const bytes: any = Buffer.from(bytesInput);
    if (!isTextBody)
        headers['x-paperclip-body-encoding'] = 'base64';
    return {
        headers,
        body: isTextBody ? bytes.toString('utf8') : bytes.toString('base64'),
    };
}
export function patchHostSource(source: any): any {
    const text: any = String(source);
    if (sha256(text) === HOST_PATCHED_SHA256)
        return text;
    if (sha256(text) !== HOST_ORIGINAL_SHA256 || occurrences(text, HOST_ORIGINAL) !== 1) {
        throw compatError('Paperclip host源码SHA或补丁锚点不匹配，拒绝修改未知版本。');
    }
    const patched: any = text.replace(HOST_ORIGINAL, HOST_PATCHED);
    if (sha256(patched) !== HOST_PATCHED_SHA256) {
        throw compatError('Paperclip host目标SHA不匹配，拒绝写入。');
    }
    return patched;
}
export async function resolveCompatibilityTargets({ paperclipEntry, pluginEntry, verifyPlugin = true, expectedPluginVersion = CONTENT_PLUGIN_VERSION, }: any): Promise<any> {
    const paperclipRoot: any = await packageRootForEntry(paperclipEntry, 'paperclipai');
    const paperclipPackage: any = await readPackage(path.join(paperclipRoot, 'package.json'));
    if (paperclipPackage.version !== PAPERCLIP_VERSION) {
        throw compatError(`只允许 Paperclip ${PAPERCLIP_VERSION}，当前为 ${paperclipPackage.version || 'unknown'}。`);
    }
    const nodeModulesRoot: any = path.dirname(paperclipRoot);
    const serverRoot: any = path.join(nodeModulesRoot, '@paperclipai', 'server');
    const serverPackage: any = await readPackage(path.join(serverRoot, 'package.json'));
    if (serverPackage.name !== '@paperclipai/server' || serverPackage.version !== PAPERCLIP_VERSION) {
        throw compatError('Paperclip server包名或版本不匹配。');
    }
    const hostFile: any = path.join(nodeModulesRoot, HOST_RELATIVE_PATH);
    await assertInside(serverRoot, hostFile);
    let pluginRoot: any = null;
    if (verifyPlugin) {
        const expectedStepfunSha: any = contentPluginStepfunShaForVersion(expectedPluginVersion);
        if (!expectedStepfunSha) {
            throw compatError(`内容插件版本不在binary-RPC兼容白名单：${expectedPluginVersion || 'unknown'}。`);
        }
        pluginRoot = await packageRootForEntry(pluginEntry, '@agent-army/paperclip-content-autonomy');
        const pluginPackage: any = await readPackage(path.join(pluginRoot, 'package.json'));
        if (pluginPackage.version !== expectedPluginVersion) {
            throw compatError(`内容插件必须为 ${expectedPluginVersion}，当前为 ${pluginPackage.version || 'unknown'}。`);
        }
        const stepfunFile: any = path.join(
            pluginRoot,
            'src',
            expectedPluginVersion === CONTENT_PLUGIN_VERSION ? 'stepfun-tools.ts' : 'stepfun-tools.js',
        );
        await assertInside(pluginRoot, stepfunFile);
        if (await fileSha256(stepfunFile) !== expectedStepfunSha) {
            throw compatError('内容插件StepFun二进制解码实现SHA不匹配，拒绝修改host。');
        }
    }
    return {
        paperclipRoot,
        pluginRoot,
        hostFile,
        backupFile: `${hostFile}${BACKUP_SUFFIX}`,
    };
}
export async function applyCompatibilityPatch(options: any): Promise<any> {
    const targets: any = await resolveCompatibilityTargets(options);
    const result: any = await applyVersionLockedFile({
        file: targets.hostFile,
        backupFile: targets.backupFile,
        originalSha: HOST_ORIGINAL_SHA256,
        patchedSha: HOST_PATCHED_SHA256,
        patch: (current: any): any => Buffer.from(patchHostSource(current.toString('utf8'))),
    });
    return { ...result, ...targets };
}
export async function rollbackCompatibilityPatch(options: any): Promise<any> {
    const targets: any = await resolveCompatibilityTargets({ ...options, verifyPlugin: false });
    const result: any = await rollbackVersionLockedFile({
        file: targets.hostFile,
        backupFile: targets.backupFile,
        originalSha: HOST_ORIGINAL_SHA256,
        patchedSha: HOST_PATCHED_SHA256,
    });
    return { ...result, ...targets };
}
export async function applyVersionLockedFile({ file, backupFile, originalSha, patchedSha, patch, }: any): Promise<any> {
    const current: any = await fs.readFile(file);
    const currentSha: any = sha256(current);
    const backup: any = await readOptional(backupFile);
    if (backup && sha256(backup) !== originalSha) {
        throw compatError('现有兼容补丁备份SHA不匹配，拒绝覆盖。');
    }
    if (currentSha === patchedSha) {
        if (!backup)
            throw compatError('目标已是补丁SHA但缺少可信备份，拒绝声称可回滚。');
        return { changed: false, status: 'already_applied' };
    }
    if (currentSha !== originalSha) {
        throw compatError('当前SHA既非原版也非目标版，拒绝修改。');
    }
    const patched: any = Buffer.from(await patch(current));
    if (sha256(patched) !== patchedSha)
        throw compatError('目标SHA不匹配，拒绝写入。');
    const temporary: any = `${file}.agent-army.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, patched, { flag: 'wx', mode: 0o644 });
    try {
        if (!backup)
            await fs.writeFile(backupFile, current, { flag: 'wx', mode: 0o600 });
        if (await fileSha256(backupFile) !== originalSha) {
            throw compatError('兼容补丁备份写入后SHA不匹配。');
        }
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
    return { changed: true, status: 'applied' };
}
export async function rollbackVersionLockedFile({ file, backupFile, originalSha, patchedSha, }: any): Promise<any> {
    const currentSha: any = await fileSha256(file);
    const backup: any = await readOptional(backupFile);
    if (!backup || sha256(backup) !== originalSha) {
        throw compatError('缺少可信原版备份，拒绝回滚。');
    }
    if (currentSha === originalSha) {
        return { changed: false, status: 'already_rolled_back' };
    }
    if (currentSha !== patchedSha) {
        throw compatError('当前SHA不是兼容补丁目标版，拒绝回滚未知内容。');
    }
    const temporary: any = `${file}.agent-army.rollback.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, backup, { flag: 'wx', mode: 0o644 });
    try {
        if (await fileSha256(temporary) !== originalSha) {
            throw compatError('回滚临时文件SHA不匹配。');
        }
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
    return { changed: true, status: 'rolled_back' };
}
async function packageRootForEntry(entryValue: any, expectedName: any): Promise<any> {
    const entry: any = await fs.realpath(path.resolve(required(entryValue, `${expectedName}入口缺失。`)));
    let current: any = path.dirname(entry);
    for (;;) {
        const packageFile: any = path.join(current, 'package.json');
        const record: any = await readPackage(packageFile, { optional: true });
        if (record?.name === expectedName)
            return current;
        const parent: any = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    throw compatError(`入口不属于 ${expectedName} 包。`);
}
async function assertInside(rootValue: any, fileValue: any): Promise<any> {
    const root: any = await fs.realpath(rootValue);
    const file: any = await fs.realpath(fileValue);
    if (!file.startsWith(`${root}${path.sep}`))
        throw compatError('兼容补丁目标路径逃逸包目录。');
}
async function readPackage(file: any, { optional = false }: any = {}): Promise<any> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error: any) {
        if (optional && error?.code === 'ENOENT')
            return null;
        throw compatError(`无法读取或解析包元数据：${path.basename(path.dirname(file))}。`);
    }
}
async function readOptional(file: any): Promise<any> {
    try {
        return await fs.readFile(file);
    }
    catch (error: any) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function fileSha256(file: any): Promise<any> {
    return sha256(await fs.readFile(file));
}
function sha256(value: any): any {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function occurrences(source: any, needle: any): any {
    return source.split(needle).length - 1;
}
function required(value: any, message: any): any {
    const text: any = String(value || '').trim();
    if (!text)
        throw compatError(message);
    return text;
}
function compatError(message: any): any {
    const error: any = new Error(message);
    error.name = 'PaperclipBinaryRpcCompatError';
    return error;
}
