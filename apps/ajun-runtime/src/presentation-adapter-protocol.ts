import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceFile } from './workspace-path-guard.ts';
const COMMAND_PROFILES: any = Object.freeze({
    'open-kimi': Object.freeze({ probeMaxBuffer: 256 * 1024, classifyStderr: false, deleteNullEnvironment: false }),
    local: Object.freeze({ probeMaxBuffer: 2 * 1024 * 1024, classifyStderr: true, deleteNullEnvironment: true }),
});
export const DEFAULT_PRESENTATION_RUN: any = Symbol('default-presentation-run');
export class PresentationWorkspace {
    workspaceRoot: any;
    constructor(workspaceRoot: any) {
        this.workspaceRoot = workspaceRoot;
    }
    async newTarget(relativePath: any, extension: any): Promise<any> {
        const relative: any = normalizedRelativePath(relativePath);
        if (path.posix.extname(relative).toLowerCase() !== extension) {
            throw presentationError(`目标必须使用 ${extension} 扩展名。`, 'presentation_path_invalid');
        }
        const target: any = await prepareWorkspaceFile(this.workspaceRoot, relative);
        await this.assertPathMissing(target.target);
        return target;
    }
    async existingFile(relativePath: any, extension: any): Promise<any> {
        const relative: any = normalizedRelativePath(relativePath);
        if (path.posix.extname(relative).toLowerCase() !== extension) {
            throw presentationError(`输入必须使用 ${extension} 扩展名。`, 'presentation_path_invalid');
        }
        const { root, target } = await prepareWorkspaceFile(this.workspaceRoot, relative);
        const stat: any = await fs.lstat(target).catch((): any => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
            throw presentationError('输入文件不存在或不是普通文件。', 'presentation_source_invalid');
        }
        const real: any = await fs.realpath(target);
        if (!real.startsWith(`${root}${path.sep}`)) {
            throw presentationError('输入文件越出工作区。', 'workspace_path_denied');
        }
        return Object.freeze({ root, target: real });
    }
    async assertTargetsNew(projectRoot: any, targets: any): Promise<any> {
        const root: any = await fs.realpath(projectRoot);
        for (const item of targets) {
            const target: any = path.resolve(item.target);
            if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
                throw presentationError('演示文稿产物越出项目目录。', 'workspace_path_denied');
            }
            await this.assertPathMissing(target);
        }
    }
    async assertPathMissing(target: any): Promise<any> {
        const stat: any = await fs.lstat(target).catch((error: any): any => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat) {
            throw presentationError('演示文稿目标已存在；请使用新的版本路径，禁止静默覆盖。', 'workspace_file_exists');
        }
    }
    parseExportSummary(output: any, profile: any): any {
        if (profile === 'open-kimi')
            return parseOpenKimiSummary(output);
        if (profile === 'local')
            return parseLocalSummary(output);
        throw new TypeError(`未知演示文稿导出摘要协议：${profile}`);
    }
    async verifyPptxExport({ profile, manifestPath, outputPath, qaDirectory, summary }: any): Promise<any> {
        const expectedPageCount: any = await pptdPageCount(manifestPath, profile);
        assertExportCounts(profile, summary, expectedPageCount);
        const pptx: any = await fs.readFile(outputPath);
        if (pptx.length < 16 || pptx.subarray(0, 2).toString() !== 'PK') {
            const message: any = profile === 'local' ? '本地 PPTX 文件签名无效。' : 'PPTX 导出文件签名无效。';
            throw presentationError(message, 'presentation_export_invalid');
        }
        const overview: any = path.join(qaDirectory, 'overview.jpg');
        const overviewStat: any = await fs.stat(overview).catch((): any => null);
        if (!overviewStat?.isFile() || overviewStat.size < 1) {
            const message: any = profile === 'local' ? '本地 PPTX 页面预览缺失。' : 'PPTX 导出前的页面图片质检产物缺失。';
            throw presentationError(message, 'presentation_visual_qa_missing');
        }
        return Object.freeze({ summary, pptx, overview });
    }
}
export class PresentationCommandRunner {
    profile: any;
    profileOptions: any;
    constructor({ profile }: any = {}) {
        if (!COMMAND_PROFILES[profile])
            throw new TypeError(`未知演示文稿命令协议：${profile}`);
        this.profile = profile;
        this.profileOptions = COMMAND_PROFILES[profile];
    }
    options(timeoutMs: any = 180000, env: any = null): any {
        return { timeoutMs, maxBuffer: 2 * 1024 * 1024, ...(env ? { env } : {}) };
    }
    defaultRun(command: any, args: any, options: any): any {
        return runCommand(command, args, options, this.profileOptions);
    }
    async probeVersion(run: any, thisArg: any, command: any, args: any): Promise<any> {
        try {
            const output: any = await Reflect.apply(run, thisArg, [command, args, {
                    timeoutMs: 10000,
                    maxBuffer: this.profileOptions.probeMaxBuffer,
                }]);
            return Object.freeze({ ok: true, version: String(output || '').trim().split('\n')[0] });
        }
        catch (error: any) {
            return Object.freeze({ ok: false, version: null, code: error?.code || 'command_failed' });
        }
    }
}
export function freezePresentationReadiness(value: any = {}): any {
    return Object.freeze({
        ...value,
        modes: Object.freeze(Object.fromEntries(Object.entries(value.modes || {}).map(([key, item]: any): any => [key, Object.freeze({ ...item })]))),
    });
}
export function presentationError(message: any, code: any): any {
    return Object.assign(new Error(message), { code, category: 'manual', retryable: false });
}
function normalizedRelativePath(value: any): any {
    return String(value || '').trim().replaceAll('\\', '/');
}
function parseOpenKimiSummary(output: any): any {
    let summary: any;
    try {
        summary = JSON.parse(String(output || '').trim());
    }
    catch {
        throw presentationError('PPTX 导出器没有返回可验证的结构摘要。', 'presentation_export_validation_failed');
    }
    for (const field of ['slides', 'fadeTransitions', 'transitionPatchedSlides', 'fontParts']) {
        if (!Number.isInteger(summary?.[field]) || summary[field] < 0) {
            throw presentationError(`PPTX 导出器缺少有效的 ${field} 校验结果。`, 'presentation_export_validation_failed');
        }
    }
    if (summary.slides < 1) {
        throw presentationError('PPTX 导出结果不包含页面。', 'presentation_export_validation_failed');
    }
    return Object.freeze(summary);
}
function parseLocalSummary(output: any): any {
    const lines: any = String(output || '').trim().split('\n').map((line: any): any => line.trim()).filter(Boolean);
    let summary: any = null;
    for (let index: any = lines.length - 1; index >= 0; index -= 1) {
        try {
            const candidate: any = JSON.parse(lines[index]);
            if (candidate?.schemaVersion === 'agent.army/local-pptx-export/v1') {
                summary = candidate;
                break;
            }
        }
        catch { }
    }
    if (summary?.status !== 'passed'
        || !Number.isInteger(summary.slides)
        || !Number.isInteger(summary.renderedSlides)
        || !Number.isInteger(summary.fadeTransitions)
        || !Number.isInteger(summary.transitionPatchedSlides)
        || !Number.isInteger(summary.fontParts)
        || !Array.isArray(summary.referencedFonts)
        || typeof summary.fontCompatibilityTypeface !== 'string'
        || summary.fontCompatibilityVerified !== true) {
        throw presentationError('本地 PPTX 导出器没有返回可验证摘要。', 'presentation_export_validation_failed');
    }
    return Object.freeze(summary);
}
async function pptdPageCount(manifestPath: any, profile: any): Promise<any> {
    let manifest: any;
    try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (profile === 'local' && (!Array.isArray(manifest.pages) || manifest.pages.length < 1)) {
            throw new Error('missing pages');
        }
    }
    catch {
        throw presentationError('受控适配器只能导出自己生成的 JSON 兼容 PPTD 清单。', 'presentation_source_invalid');
    }
    if (!Array.isArray(manifest.pages) || manifest.pages.length < 1) {
        throw presentationError('PPTD 清单没有有效页面引用。', 'presentation_source_invalid');
    }
    return manifest.pages.length;
}
function assertExportCounts(profile: any, summary: any, expectedPageCount: any): any {
    const openKimiValid: any = profile === 'open-kimi'
        && summary.slides === expectedPageCount
        && summary.fadeTransitions === expectedPageCount
        && summary.transitionPatchedSlides === expectedPageCount;
    const localValid: any = profile === 'local'
        && summary.slides === expectedPageCount
        && summary.renderedSlides === expectedPageCount
        && summary.fadeTransitions === expectedPageCount
        && summary.transitionPatchedSlides === expectedPageCount
        && summary.zipIntegrityValid === true
        && summary.transitionXmlOrderValid === true
        && summary.fontCompatibilityVerified === true;
    if (openKimiValid || localValid)
        return;
    const message: any = profile === 'local'
        ? '本地 PPTX 页数、渲染或 fade 转场校验不一致。'
        : 'PPTX 页数或每页唯一 fade 转场校验不一致。';
    throw presentationError(message, 'presentation_export_validation_failed');
}
function runCommand(command: any, args: any, { timeoutMs = 30000, maxBuffer = 1024 * 1024, env = {} }: any = {}, profile: any): any {
    const childEnvironment: Record<string, any> = { ...process.env };
    for (const [name, value] of Object.entries(env)) {
        if (profile.deleteNullEnvironment && value == null)
            delete childEnvironment[name];
        else
            childEnvironment[name] = profile.deleteNullEnvironment ? String(value) : value;
    }
    return new Promise((resolve: any, reject: any): any => execFile(command, args, {
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        env: childEnvironment,
    }, (error: any, stdout: any, stderr: any): any => {
        if (!error)
            return resolve(stdout);
        return reject(profile.classifyStderr ? classifyLocalCommandError(error, stderr) : error);
    }));
}
function classifyLocalCommandError(error: any, stderr: any): any {
    if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
        return Object.assign(new Error('本地 PPTX 子进程超时。'), { code: 'ETIMEDOUT' });
    }
    let code: any = null;
    for (const line of String(stderr || '').trim().split('\n').reverse()) {
        try {
            const candidate: any = JSON.parse(line);
            if (/^[a-z0-9_]{1,80}$/i.test(String(candidate?.code || ''))) {
                code = candidate.code;
                break;
            }
        }
        catch { }
    }
    return Object.assign(new Error('本地 PPTX 子进程执行失败。'), { code: code || 'local_pptx_command_failed' });
}
