import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PresentationCommandRunner, PresentationWorkspace, DEFAULT_PRESENTATION_RUN, freezePresentationReadiness as freezeReadiness, presentationError as pptError, } from './presentation-adapter-protocol.ts';
const SKILL_RELATIVE_ROOT: any = 'open-kimi-ppt-skill';
const SKILL_ENTRY: any = 'skills/open-kimi-ppt/SKILL.md';
const EXPORT_PPTX: any = 'skills/open-kimi-ppt/scripts/export_pptx.py';
const EXPORT_IMAGES: any = 'skills/open-kimi-ppt/scripts/export_images.py';
const EXPORT_HOST: any = 'skills/open-kimi-ppt/scripts/export_host.html';
const EXPECTED_PACKAGE_VERSION: any = '1.0.0';
const EXPECTED_SOURCE_HASH: any = '672358d16ef70aa907b8181d451e649465aded3ed1a9cf613b2de5771a70cb10';
const MIN_AGENT_BROWSER_VERSION: any = Object.freeze([0, 33, 2]);
const ALLOWED_DESIGN_MODES: any = new Set(['self_directed', 'design_system', 'template', 'style_transfer']);
const ALLOWED_CLASSIFICATIONS: any = new Set(['public', 'redacted', 'internal', 'sensitive']);
const EXTERNAL_CLASSIFICATIONS: any = new Set(['public', 'redacted']);
const ALLOWED_IMAGE_TYPES: any = Object.freeze({
    png: { mimeType: 'image/png', signatures: [Buffer.from([0x89, 0x50, 0x4e, 0x47])] },
    jpg: { mimeType: 'image/jpeg', signatures: [Buffer.from([0xff, 0xd8, 0xff])] },
    jpeg: { mimeType: 'image/jpeg', signatures: [Buffer.from([0xff, 0xd8, 0xff])] },
    gif: { mimeType: 'image/gif', signatures: [Buffer.from('GIF87a'), Buffer.from('GIF89a')] },
    svg: { mimeType: 'image/svg+xml', signatures: [] },
});
export class OpenKimiPptAdapter {
    agentBrowserBinary: any;
    chromeBinary: any;
    commands: any;
    expectedPackageVersion: any;
    expectedSourceHash: any;
    nodeBinary: any;
    now: any;
    prepareExecutionEnvironment: any;
    pythonBinary: any;
    readinessProbeImpl: any;
    run: any;
    sharedSkillsRoot: any;
    skillRoot: any;
    constructor({ sharedSkillsRoot = process.env.AGENT_ARMY_SHARED_SKILLS_ROOT
        || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib'), pythonBinary = process.env.AGENT_ARMY_OPEN_KIMI_PYTHON || 'python3', nodeBinary = process.env.AGENT_ARMY_OPEN_KIMI_NODE || 'node', agentBrowserBinary = process.env.AGENT_ARMY_OPEN_KIMI_AGENT_BROWSER || 'agent-browser', chromeBinary = process.env.AGENT_ARMY_OPEN_KIMI_CHROME
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', expectedPackageVersion = EXPECTED_PACKAGE_VERSION, expectedSourceHash = EXPECTED_SOURCE_HASH, readinessProbeImpl = null, runImpl = DEFAULT_PRESENTATION_RUN, prepareExecutionEnvironmentImpl = prepareNoInstallEnvironment, now = (): any => new Date(), }: any = {}) {
        this.sharedSkillsRoot = path.resolve(sharedSkillsRoot);
        this.skillRoot = path.join(this.sharedSkillsRoot, SKILL_RELATIVE_ROOT);
        this.pythonBinary = pythonBinary;
        this.nodeBinary = nodeBinary;
        this.agentBrowserBinary = agentBrowserBinary;
        this.chromeBinary = chromeBinary;
        this.expectedPackageVersion = expectedPackageVersion;
        this.expectedSourceHash = expectedSourceHash;
        this.readinessProbeImpl = readinessProbeImpl;
        this.commands = new PresentationCommandRunner({ profile: 'open-kimi' });
        this.run = runImpl === DEFAULT_PRESENTATION_RUN
            ? this.commands.defaultRun.bind(this.commands)
            : runImpl;
        this.prepareExecutionEnvironment = prepareExecutionEnvironmentImpl;
        this.now = now;
    }
    async readiness(): Promise<any> {
        if (typeof this.readinessProbeImpl === 'function') {
            return freezeReadiness(await this.readinessProbeImpl());
        }
        const source: any = await this.#sourceReadiness();
        const dependencies: any = await this.#dependencyReadiness();
        const composeStatus: any = source.ready ? 'ready' : 'needs_capability';
        const missing: any[] = [
            ...(source.ready ? [] : source.issues),
            ...dependencies.issues,
        ];
        const exportStatus: any = source.ready && dependencies.ready ? 'ready' : 'needs_capability';
        return freezeReadiness({
            status: composeStatus === 'ready' && exportStatus === 'ready' ? 'ready' : composeStatus === 'ready' ? 'partial' : 'needs_capability',
            source,
            dependencies,
            modes: {
                compose: { status: composeStatus, externalDataProcessing: false },
                visualQa: { status: exportStatus, externalDataProcessing: true },
                export: { status: exportStatus, externalDataProcessing: true },
            },
            recovery: missing.length
                ? `缺少兼容的演示文稿导出能力：${missing.join('；')}。运行时不会自动安装或升级。`
                : null,
        });
    }
    async writePptd({ access, input, workspaceRoot }: any): Promise<any> {
        const readiness: any = await this.readiness();
        if (readiness.modes?.compose?.status !== 'ready') {
            throw pptError(readiness.recovery || 'OpenKimi PPTD 能力当前不可用。', 'presentation_compose_needs_capability');
        }
        const workspace: any = new PresentationWorkspace(workspaceRoot);
        const manifestTarget: any = await workspace.newTarget(access?.relativePath, '.pptd');
        const project: any = normalizePresentation(input);
        const projectRoot: any = manifestTarget.parent;
        const manifestName: any = path.basename(manifestTarget.target);
        const media: any = await normalizeMedia(input?.media);
        const pages: any = buildPages(project, new Set(media.map((item: any): any => item.name)));
        if (project.requestedSlideCount != null && project.requestedSlideCount !== pages.length) {
            throw pptError(`要求 ${project.requestedSlideCount} 页，但当前有效提纲只能生成 ${pages.length} 页；请补齐逐页提纲。`, 'presentation_outline_mismatch');
        }
        const pageEntries: any = pages.map((page: any, index: any): any => ({
            relativePath: `pages/${String(index + 1).padStart(2, '0')}-${page.pageType || 'content'}.page`,
            contents: jsonDocument(page),
        }));
        const manifest: Record<string, any> = {
            version: 'v2',
            title: project.title,
            size: [960, 540],
            theme: presentationTheme(project.design),
            pages: pageEntries.map((item: any): any => item.relativePath),
        };
        const validation: any = validatePptdProject({ manifest, pages, mediaNames: new Set(media.map((item: any): any => item.name)) });
        const qaRelativePath: any = 'qa/structural-validation.json';
        const targets: any[] = [
            ...pageEntries.map((item: any): any => ({ ...item, target: path.join(projectRoot, item.relativePath) })),
            ...media.map((item: any): any => ({ ...item, target: path.join(projectRoot, 'media', item.name), relativePath: `media/${item.name}` })),
            {
                relativePath: qaRelativePath,
                target: path.join(projectRoot, qaRelativePath),
                contents: jsonDocument({
                    schemaVersion: 'agent.army/presentation-qa/v1',
                    status: 'structural_passed',
                    pageCount: pages.length,
                    checks: validation,
                    visualReview: { status: 'not_run', reason: 'PPTX 外部导出能力尚未执行。' },
                }),
            },
            { relativePath: manifestName, target: manifestTarget.target, contents: jsonDocument(manifest) },
        ];
        await workspace.assertTargetsNew(projectRoot, targets);
        for (const item of targets) {
            await fs.mkdir(path.dirname(item.target), { recursive: true, mode: 0o700 });
            const contents: any = item.bytes || Buffer.from(item.contents, 'utf8');
            await fs.writeFile(item.target, contents, { flag: 'wx', mode: 0o600 });
        }
        const checksum: any = aggregateChecksum(targets);
        return Object.freeze({
            projectPath: projectRoot,
            projectRelativePath: path.posix.dirname(access.relativePath),
            manifestPath: manifestTarget.target,
            manifestRelativePath: access.relativePath,
            pagePaths: Object.freeze(pageEntries.map((item: any): any => path.join(projectRoot, item.relativePath))),
            mediaPaths: Object.freeze(media.map((item: any): any => path.join(projectRoot, 'media', item.name))),
            qaPath: path.join(projectRoot, qaRelativePath),
            qaRelativePath: path.posix.join(path.posix.dirname(access.relativePath), qaRelativePath),
            checksum,
            bytes: targets.reduce((sum: any, item: any): any => sum + (item.bytes?.length || Buffer.byteLength(item.contents)), 0),
            mimeType: 'application/vnd.open-kimi.pptd+yaml',
            validation: Object.freeze({
                ...validation,
                exists: true,
                readable: true,
                nonEmpty: true,
                selfContained: true,
                workspaceRestricted: true,
                remoteResources: 0,
                structuralQaPassed: true,
                visualQaPassed: false,
            }),
            source: Object.freeze({
                skillVersion: readiness.source?.packageVersion || this.expectedPackageVersion,
                sourceHash: readiness.source?.sourceHash || this.expectedSourceHash,
            }),
        });
    }
    async exportPptx({ access, input, workspaceRoot }: any): Promise<any> {
        assertExternalProcessing(input);
        const readiness: any = await this.readiness();
        if (readiness.modes?.export?.status !== 'ready') {
            const error: any = pptError(readiness.recovery || 'PPTX 导出依赖尚未就绪。', 'presentation_export_needs_capability');
            error.readiness = readiness;
            throw error;
        }
        const workspace: any = new PresentationWorkspace(workspaceRoot);
        const manifest: any = await workspace.existingFile(input?.manifestRelativePath, '.pptd');
        const output: any = await workspace.newTarget(access?.relativePath, '.pptx');
        const projectRoot: any = path.dirname(manifest.target);
        const qaDirectory: any = path.join(projectRoot, '.qa-images');
        await workspace.assertPathMissing(qaDirectory);
        const startedAt: any = this.now();
        const executionEnvironment: any = await this.prepareExecutionEnvironment({
            projectRoot,
            pythonBinary: this.pythonBinary,
            nodeBinary: this.nodeBinary,
            agentBrowserBinary: this.agentBrowserBinary,
        });
        let exportOutput: any;
        let attempts: any = 0;
        try {
            while (attempts < 2) {
                attempts += 1;
                try {
                    await Reflect.apply(this.run, this, [
                        executionEnvironment.pythonBinary,
                        [path.join(this.skillRoot, EXPORT_IMAGES), manifest.target, '--output', qaDirectory],
                        this.commands.options(180000, executionEnvironment.env),
                    ]);
                    exportOutput = await Reflect.apply(this.run, this, [
                        executionEnvironment.pythonBinary,
                        [path.join(this.skillRoot, EXPORT_PPTX), manifest.target, '--output', output.target],
                        this.commands.options(240000, executionEnvironment.env),
                    ]);
                    break;
                }
                catch (error: any) {
                    if (attempts >= 2 || !isRetryableExportError(error))
                        throw error;
                    await Promise.all([
                        fs.rm(qaDirectory, { recursive: true, force: true }),
                        fs.rm(output.target, { force: true }),
                    ]);
                }
            }
        }
        finally {
            await executionEnvironment.cleanup();
        }
        const exportSummary: any = workspace.parseExportSummary(exportOutput, 'open-kimi');
        const { pptx, overview } = await workspace.verifyPptxExport({
            profile: 'open-kimi',
            manifestPath: manifest.target,
            outputPath: output.target,
            qaDirectory,
            summary: exportSummary,
        });
        return Object.freeze({
            filePath: output.target,
            relativePath: access.relativePath,
            qaDirectory,
            qaOverviewPath: overview,
            qaOverviewRelativePath: path.relative(workspaceRoot, overview).split(path.sep).join('/'),
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            bytes: pptx.length,
            checksum: crypto.createHash('sha256').update(pptx).digest('hex'),
            durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
            attempts,
            validation: Object.freeze({
                exists: true,
                readable: true,
                nonEmpty: true,
                workspaceRestricted: true,
                structuralQaPassed: true,
                visualQaPassed: true,
                zipSignatureValid: true,
                zipIntegrityValid: true,
                pageCount: exportSummary.slides,
                fadeTransitions: exportSummary.fadeTransitions,
                transitionPatchedSlides: exportSummary.transitionPatchedSlides,
                transitionXmlOrderValid: true,
                fontParts: exportSummary.fontParts,
                fontEmbeddingVerified: exportSummary.fontParts > 0,
                humanOfficeReviewRequired: true,
            }),
        });
    }
    async #sourceReadiness(): Promise<any> {
        const packagePath: any = path.join(this.skillRoot, 'package.json');
        const files: any = [SKILL_ENTRY, EXPORT_PPTX, EXPORT_IMAGES, EXPORT_HOST]
            .map((item: any): any => path.join(this.skillRoot, item));
        const issues: any[] = [];
        let packageVersion: any = null;
        try {
            packageVersion = JSON.parse(await fs.readFile(packagePath, 'utf8')).version || null;
        }
        catch {
            issues.push('共享技能 package.json 不可读');
        }
        let sourceHash: any = null;
        try {
            const hashes: any[] = [];
            for (const file of files)
                hashes.push(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'));
            sourceHash = crypto.createHash('sha256').update(`${hashes.join('\n')}\n`).digest('hex');
        }
        catch {
            issues.push('技能入口或导出脚本不完整');
        }
        if (packageVersion && packageVersion !== this.expectedPackageVersion) {
            issues.push(`技能版本漂移：${packageVersion} != ${this.expectedPackageVersion}`);
        }
        if (sourceHash && this.expectedSourceHash && sourceHash !== this.expectedSourceHash) {
            issues.push('技能源码校验和漂移');
        }
        try {
            const hostTemplate: any = await fs.readFile(path.join(this.skillRoot, EXPORT_HOST), 'utf8');
            const remoteHosts: any = [...hostTemplate.matchAll(/https?:\/\/[^\s"'`<>]+/g)]
                .map(([url]: any): any => new URL(url).hostname);
            if (remoteHosts.length !== 2
                || new Set(remoteHosts).size !== 2
                || remoteHosts.some((host: any): any => !['www.kimi.com', 'statics.moonshot.cn'].includes(host))) {
                issues.push('导出页面远程主机白名单漂移');
            }
        }
        catch {
            issues.push('导出页面远程主机白名单不可验证');
        }
        return Object.freeze({
            ready: issues.length === 0,
            packageVersion,
            sourceHash,
            entryPath: path.join(SKILL_RELATIVE_ROOT, SKILL_ENTRY),
            issues: Object.freeze(issues),
        });
    }
    async #dependencyReadiness(): Promise<any> {
        const issues: any[] = [];
        const versions: Record<string, any> = {};
        const node: any = await this.commands.probeVersion(this.run, this, this.nodeBinary, ['--version']);
        versions.node = node.version;
        if (!node.ok || majorVersion(node.version) < 24)
            issues.push('隔离 Node 24+ 未配置');
        const python: any = await this.commands.probeVersion(this.run, this, this.pythonBinary, ['--version']);
        versions.python = python.version;
        if (!python.ok)
            issues.push('Python 3 不可用');
        if (python.ok) {
            const modules: any = await this.commands.probeVersion(this.run, this, this.pythonBinary, ['-c', 'import yaml, PIL, websocket; print("ok")']);
            if (!modules.ok)
                issues.push('PyYAML、Pillow 或 websocket-client 未预装');
        }
        const browser: any = await this.commands.probeVersion(this.run, this, this.agentBrowserBinary, ['--version']);
        versions.agentBrowser = browser.version;
        if (!browser.ok || compareVersions(parseVersion(browser.version), MIN_AGENT_BROWSER_VERSION) < 0) {
            issues.push(`agent-browser ${versionText(browser.version)} 低于 0.33.2 或未安装`);
        }
        const chrome: any = await fs.access(this.chromeBinary).then((): any => true).catch((): any => false);
        if (!chrome)
            issues.push('Chromium 浏览器未配置');
        return Object.freeze({
            ready: issues.length === 0,
            versions: Object.freeze(versions),
            chromeBinary: chrome ? this.chromeBinary : null,
            autoInstall: false,
            allowedHosts: Object.freeze(['www.kimi.com', 'statics.moonshot.cn']),
            issues: Object.freeze(issues),
        });
    }
}
export async function openKimiPptReadiness(options: any = {}): Promise<any> {
    return new OpenKimiPptAdapter(options).readiness();
}
function normalizePresentation(input: any = {}): any {
    const title: any = requiredText(input.title, '演示文稿标题');
    const designMode: any = String(input.designMode || 'self_directed').trim();
    if (!ALLOWED_DESIGN_MODES.has(designMode)) {
        throw pptError('designMode 只能是 self_directed、design_system、template 或 style_transfer。', 'presentation_input_invalid');
    }
    const classification: any = String(input.dataClassification || 'internal').trim();
    if (!ALLOWED_CLASSIFICATIONS.has(classification)) {
        throw pptError('dataClassification 无效。', 'presentation_input_invalid');
    }
    const requestedSlideCount: any = input.slideCount == null ? null : Number(input.slideCount);
    if (requestedSlideCount != null && (!Number.isInteger(requestedSlideCount) || requestedSlideCount < 1 || requestedSlideCount > 30)) {
        throw pptError('slideCount 必须是 1–30 的整数。', 'presentation_input_invalid');
    }
    const rawSlides: any = Array.isArray(input.slides) ? input.slides : Array.isArray(input.outline) ? input.outline : [];
    if (rawSlides.length > 29)
        throw pptError('首版最多接受 29 页正文提纲。', 'presentation_input_invalid');
    const slides: any = rawSlides.map((slide: any, index: any): any => normalizeSlide(slide, index));
    return Object.freeze({
        title,
        purpose: cleanText(input.purpose || input.description, 1000),
        audience: cleanText(input.audience, 300),
        designMode,
        design: normalizeDesign(input, designMode),
        classification,
        requestedSlideCount,
        slides,
        sourceSummaries: stringList(input.sourceSummaries, 20, 300),
    });
}
function normalizeDesign(input: any, designMode: any): any {
    const sourceRef: any = cleanText(input.designSourceRef || input.templateArtifactRef || input.styleArtifactRef, 240);
    const raw: any = input.designTokens;
    if (designMode !== 'self_directed' && !plainObject(raw)) {
        throw pptError(`${designMode} 需要提供结构化 designTokens。`, 'presentation_design_input_required');
    }
    if (['template', 'style_transfer'].includes(designMode) && !sourceRef) {
        throw pptError(`${designMode} 需要提供当前任务允许的设计来源产物引用。`, 'presentation_design_input_required');
    }
    const colors: Record<string, any> = {};
    const allowedColors: any = new Set(['navy', 'primary', 'accent', 'text', 'muted', 'paper', 'line']);
    for (const [key, value] of Object.entries(plainObject(raw?.colors) ? raw.colors : {})) {
        if (!allowedColors.has(key) || !/^#[0-9a-f]{6}$/i.test(String(value || ''))) {
            throw pptError('designTokens.colors 只能覆盖允许的六位十六进制主题颜色。', 'presentation_design_input_invalid');
        }
        colors[key] = String(value).toUpperCase();
    }
    const fonts: Record<string, any> = {};
    for (const key of ['heading', 'body']) {
        const value: any = cleanText(raw?.fonts?.[key], 80);
        if (value && !/^[\p{L}\p{N} ._-]+$/u.test(value)) {
            throw pptError('designTokens.fonts 只接受本地字体名称，不接受 URL 或路径。', 'presentation_design_input_invalid');
        }
        if (value)
            fonts[key] = value;
    }
    return Object.freeze({
        mode: designMode,
        sourceRef: sourceRef || null,
        colors: Object.freeze(colors),
        fonts: Object.freeze(fonts),
    });
}
function normalizeSlide(value: any, index: any): any {
    if (typeof value === 'string')
        return Object.freeze({ title: `第 ${index + 1} 部分`, bullets: [cleanText(value, 800)] });
    if (!plainObject(value))
        throw pptError('逐页提纲必须是文字或对象。', 'presentation_input_invalid');
    const title: any = requiredText(value.title || `第 ${index + 1} 部分`, '页面标题');
    return Object.freeze({
        title,
        bullets: stringList(value.bullets || value.points || (value.body ? [value.body] : []), 8, 500),
        notes: cleanText(value.notes, 1000),
        image: cleanMediaName(value.image),
        table: normalizeTable(value.table),
        chart: normalizeChart(value.chart),
    });
}
async function normalizeMedia(value: any): Promise<any> {
    if (value == null)
        return [];
    if (!Array.isArray(value) || value.length > 12)
        throw pptError('media 必须是不超过 12 项的数组。', 'presentation_input_invalid');
    let total: any = 0;
    const names: any = new Set();
    return value.map((item: any): any => {
        if (!plainObject(item))
            throw pptError('媒体项格式无效。', 'presentation_input_invalid');
        const name: any = cleanMediaName(item.name);
        if (!name || names.has(name))
            throw pptError('媒体文件名为空或重复。', 'presentation_input_invalid');
        names.add(name);
        const extension: any = path.extname(name).slice(1).toLowerCase();
        const type: any = ALLOWED_IMAGE_TYPES[extension];
        if (!type)
            throw pptError('首版媒体只允许 PNG、JPEG、GIF 或 SVG。', 'presentation_media_denied');
        const encoded: any = String(item.dataBase64 || '').trim();
        if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded))
            throw pptError('媒体必须以内嵌 base64 提供。', 'presentation_media_denied');
        const bytes: any = Buffer.from(encoded, 'base64');
        total += bytes.length;
        if (bytes.length < 4 || bytes.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) {
            throw pptError('单个媒体不能超过 5MB，总媒体不能超过 20MB。', 'presentation_media_denied');
        }
        if (extension === 'svg') {
            const text: any = bytes.toString('utf8').trim();
            if (!/^<svg\b/i.test(text) || /<(?:script|foreignObject|iframe|image)\b|\b(?:href|src)\s*=|url\s*\(/i.test(text)) {
                throw pptError('SVG 包含外部资源或可执行内容。', 'presentation_media_denied');
            }
        }
        else if (!type.signatures.some((signature: any): any => bytes.subarray(0, signature.length).equals(signature))) {
            throw pptError(`媒体 ${name} 的文件签名与扩展名不一致。`, 'presentation_media_denied');
        }
        return Object.freeze({ name, bytes, mimeType: type.mimeType });
    });
}
function normalizeTable(value: any): any {
    if (value == null)
        return null;
    const rows: any = Array.isArray(value) ? value : value?.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12)
        throw pptError('表格需要 1–12 行。', 'presentation_input_invalid');
    const width: any = Array.isArray(rows[0]) ? rows[0].length : 0;
    if (width < 1 || width > 8 || rows.some((row: any): any => !Array.isArray(row) || row.length !== width)) {
        throw pptError('表格需要 1–8 列且每行列数一致。', 'presentation_input_invalid');
    }
    return Object.freeze(rows.map((row: any): any => Object.freeze(row.map((cell: any): any => cleanText(cell, 300)))));
}
function normalizeChart(value: any): any {
    if (value == null)
        return null;
    if (!plainObject(value))
        throw pptError('图表格式无效。', 'presentation_input_invalid');
    const categories: any = stringList(value.categories, 12, 120);
    const values: any = Array.isArray(value.values) ? value.values.map(Number) : [];
    if (!categories.length || categories.length !== values.length || values.some((item: any): any => !Number.isFinite(item))) {
        throw pptError('图表需要等长的 categories 和数值 values。', 'presentation_input_invalid');
    }
    return Object.freeze({ title: cleanText(value.title, 160), categories, values: Object.freeze(values) });
}
function buildPages(project: any, mediaNames: any): any {
    const pages: any[] = [coverPage(project)];
    if (project.slides.length) {
        for (const slide of project.slides)
            pages.push(contentPage(slide, mediaNames));
    }
    else {
        const bullets: any = [
            project.purpose ? `目的：${project.purpose}` : '',
            project.audience ? `受众：${project.audience}` : '',
            ...project.sourceSummaries,
        ].filter(Boolean);
        pages.push(contentPage({ title: '汇报要点', bullets: bullets.length ? bullets : ['当前材料只包含标题，正文需要负责人补充。'] }, mediaNames));
    }
    return pages;
}
function coverPage(project: any): any {
    return {
        pageType: 'cover',
        background: { type: 'solid', color: '$navy' },
        elements: [
            { elementId: 'accent', elementType: 'shape', bounds: [72, 80, 12, 360], shapeName: 'roundRect', fill: { type: 'solid', color: '$accent' } },
            { elementId: 'title', elementType: 'text', bounds: [112, 150, 740, 150], content: { style: '$coverTitle', align: ['left', 'middle'], text: project.title } },
            { elementId: 'meta', elementType: 'text', bounds: [116, 320, 700, 80], content: { style: '$coverMeta', align: ['left', 'top'], text: [project.purpose, project.audience ? `受众：${project.audience}` : ''].filter(Boolean).join('\n') || '办公演示文稿' } },
        ],
    };
}
function contentPage(slide: any, mediaNames: any): any {
    const elements: any[] = [
        { elementId: 'header-line', elementType: 'shape', bounds: [56, 56, 8, 50], shapeName: 'rect', fill: { type: 'solid', color: '$accent' } },
        { elementId: 'title', elementType: 'text', bounds: [80, 48, 820, 72], content: { style: '$title', align: ['left', 'middle'], text: slide.title } },
    ];
    const hasSideVisual: any = Boolean(slide.image || slide.table || slide.chart);
    const bodyWidth: any = hasSideVisual ? 380 : 800;
    const bullets: any = Array.isArray(slide.bullets) && slide.bullets.length ? slide.bullets : ['本页内容需要负责人补充。'];
    elements.push({
        elementId: 'body', elementType: 'text', bounds: [80, 145, bodyWidth, 330],
        content: { style: '$body', align: ['left', 'top'], text: bullets.map((item: any): any => `<p>• ${escapeRichText(item)}</p>`).join('') },
    });
    if (slide.image) {
        if (!mediaNames.has(slide.image))
            throw pptError(`页面引用了未提供的媒体：${slide.image}`, 'presentation_media_missing');
        elements.push({ elementId: 'visual-image', elementType: 'image', bounds: [500, 150, 380, 300], src: `media/${slide.image}`, fit: { mode: 'contain' }, border: { style: 'solid', width: 1, color: '$line' } });
    }
    if (slide.table) {
        const columns: any = slide.table[0].length;
        const rows: any = slide.table.length;
        elements.push({
            elementId: 'visual-table', elementType: 'table', bounds: [480, 145, 410, 320],
            columnWidths: Array.from({ length: columns }, (): any => 1 / columns),
            rowHeights: Array.from({ length: rows }, (): any => 1 / rows),
            style: '$default', rows: slide.table.map((row: any): any => row.map((text: any): any => ({ text }))),
        });
    }
    if (slide.chart) {
        elements.push({
            elementId: 'visual-chart', elementType: 'chart', bounds: [480, 135, 420, 340],
            title: slide.chart.title || undefined,
            data: { cols: ['category', 'value'], rows: slide.chart.categories.map((category: any, index: any): any => [category, slide.chart.values[index]]) },
            series: [{ type: 'bar', encode: { x: 'category', y: 'value' }, fill: '$primary', dataLabels: { show: true } }],
            legend: false,
        });
    }
    return { pageType: 'content', ...(slide.notes ? { notes: slide.notes } : {}), background: { type: 'solid', color: '$paper' }, elements };
}
function presentationTheme(design: any): any {
    const colors: Record<string, any> = {
        navy: '#10243E', primary: '#2563EB', accent: '#F59E0B', text: '#1F2937',
        muted: '#64748B', paper: '#F8FAFC', line: '#CBD5E1',
        ...(design?.colors || {}),
    };
    const headingFont: any = design?.fonts?.heading || 'Arial Unicode MS';
    const bodyFont: any = design?.fonts?.body || headingFont;
    return {
        colors,
        textStyles: {
            coverTitle: { fontSize: 42, fontFamily: headingFont, bold: true, color: '#FFFFFF', lineHeight: 1.15 },
            coverMeta: { fontSize: 18, fontFamily: bodyFont, color: '#D7E2F0', lineHeight: 1.5 },
            title: { fontSize: 30, fontFamily: headingFont, bold: true, color: '$navy' },
            body: { fontSize: 19, fontFamily: bodyFont, color: '$text', lineHeight: 1.5 },
        },
        tableStyles: {
            default: {
                cellStyle: { color: '$text', fontSize: 14, fill: { type: 'solid', color: '#FFFFFF' }, border: { style: 'solid', width: 1, color: '$line' }, align: ['center', 'middle'] },
                firstRowStyle: { bold: true, color: '#FFFFFF', fill: { type: 'solid', color: '$navy' } },
                bodyStyles: [{ fill: { type: 'solid', color: '#F8FAFC' } }, { fill: { type: 'solid', color: '#FFFFFF' } }],
            },
        },
    };
}
function validatePptdProject({ manifest, pages, mediaNames }: any): any {
    if (manifest.version !== 'v2' || !Array.isArray(manifest.size) || manifest.size[0] !== 960 || manifest.size[1] !== 540) {
        throw pptError('PPTD 主入口版本或页面尺寸无效。', 'presentation_structure_invalid');
    }
    if (!manifest.pages.length || manifest.pages.length !== pages.length || new Set(manifest.pages).size !== manifest.pages.length) {
        throw pptError('PPTD 页面引用为空、重复或数量不一致。', 'presentation_structure_invalid');
    }
    const themeTokens: any = new Set(Object.keys(manifest.theme?.colors || {}));
    let elementCount: any = 0;
    for (const [pageIndex, page] of pages.entries()) {
        if (!Array.isArray(page.elements) || !page.elements.length)
            throw pptError(`第 ${pageIndex + 1} 页没有元素。`, 'presentation_structure_invalid');
        const ids: any = new Set();
        for (const element of page.elements) {
            elementCount += 1;
            if (!element.elementId || ids.has(element.elementId))
                throw pptError(`第 ${pageIndex + 1} 页元素 ID 为空或重复。`, 'presentation_structure_invalid');
            ids.add(element.elementId);
            if (!['text', 'shape', 'line', 'image', 'icon', 'table', 'chart'].includes(element.elementType))
                throw pptError('PPTD 含不支持的元素类型。', 'presentation_structure_invalid');
            if (!validBounds(element.bounds, manifest.size))
                throw pptError(`第 ${pageIndex + 1} 页元素越界。`, 'presentation_structure_invalid');
            if (element.elementType === 'image') {
                if (!/^media\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(element.src || '') || !mediaNames.has(element.src.slice(6))) {
                    throw pptError('图片必须引用项目 media 目录内已提供的文件。', 'presentation_media_denied');
                }
            }
            assertThemeTokens(element, themeTokens);
        }
    }
    return Object.freeze({
        requiredFields: true,
        pageReferences: true,
        uniqueElementIds: true,
        boundsValid: true,
        themeTokensValid: true,
        mediaReferencesValid: true,
        pageCount: pages.length,
        elementCount,
    });
}
function assertThemeTokens(value: any, available: any): any {
    if (typeof value === 'string' && value.startsWith('$') && !available.has(value.slice(1))) {
        throw pptError(`未知主题颜色：${value}`, 'presentation_structure_invalid');
    }
    if (Array.isArray(value)) {
        for (const item of value)
            assertThemeTokens(item, available);
    }
    else if (plainObject(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (key !== 'style' && key !== 'textStyle')
                assertThemeTokens(item, available);
        }
    }
}
function validBounds(value: any, [width, height]: any): any {
    return Array.isArray(value) && value.length === 4
        && value.every((item: any): any => Number.isFinite(item) && item >= 0)
        && value[2] > 0 && value[3] > 0
        && value[0] + value[2] <= width
        && value[1] + value[3] <= height;
}
function assertExternalProcessing(input: any): any {
    const classification: any = String(input?.dataClassification || '').trim();
    if (!EXTERNAL_CLASSIFICATIONS.has(classification)) {
        throw pptError('内部或敏感材料不能发送到 Kimi 公共编辑器；已保留 PPTD。', 'presentation_external_processing_denied');
    }
    if (input?.externalProcessingApproved !== true) {
        throw pptError('PPTX 导出需要负责人明确批准本次外部处理；已保留 PPTD。', 'presentation_external_processing_approval_required');
    }
}
function cleanMediaName(value: any): any {
    const name: any = String(value || '').trim();
    if (!name)
        return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || name.includes('..')) {
        throw pptError('媒体文件名只能包含字母、数字、点、下划线和短横线。', 'presentation_media_denied');
    }
    return name;
}
function jsonDocument(value: any): any {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function aggregateChecksum(targets: any): any {
    const hash: any = crypto.createHash('sha256');
    for (const item of targets)
        hash.update(item.relativePath).update('\0').update(item.bytes || Buffer.from(item.contents)).update('\0');
    return hash.digest('hex');
}
function requiredText(value: any, label: any): any {
    const text: any = cleanText(value, 300);
    if (!text)
        throw pptError(`${label}不能为空。`, 'presentation_input_invalid');
    return text;
}
function cleanText(value: any, max: any = 500): any {
    return String(value ?? '').replace(/\u0000/g, '').replace(/[\r\t]+/g, ' ').trim().slice(0, max);
}
function stringList(value: any, maxItems: any, maxLength: any): any {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, maxItems).map((item: any): any => cleanText(item, maxLength)).filter(Boolean);
}
function escapeRichText(value: any): any {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function plainObject(value: any): any {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}
function parseVersion(value: any): any {
    const match: any = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
}
function majorVersion(value: any): any {
    const match: any = String(value || '').match(/v?(\d+)/);
    return match ? Number(match[1]) : 0;
}
function compareVersions(left: any, right: any): any {
    for (let index: any = 0; index < 3; index += 1) {
        if ((left[index] || 0) !== (right[index] || 0))
            return (left[index] || 0) - (right[index] || 0);
    }
    return 0;
}
function versionText(value: any): any {
    return String(value || '未安装').replace(/^v/, '');
}
async function prepareNoInstallEnvironment({ projectRoot, pythonBinary, nodeBinary, agentBrowserBinary }: any): Promise<any> {
    const runtimeRoot: any = path.join(projectRoot, `.qa-runtime-${crypto.randomUUID()}`);
    const workspace: any = new PresentationWorkspace(projectRoot);
    await workspace.assertPathMissing(runtimeRoot);
    await fs.mkdir(path.join(runtimeRoot, 'bin'), { recursive: true, mode: 0o700 });
    try {
        const [pythonPath, nodePath, browserPath] = await Promise.all([
            resolveExecutable(pythonBinary),
            resolveExecutable(nodeBinary),
            resolveExecutable(agentBrowserBinary),
        ]);
        const bin: any = path.join(runtimeRoot, 'bin');
        await fs.symlink(nodePath, path.join(bin, 'node'));
        await fs.symlink(browserPath, path.join(bin, 'agent-browser'));
        const guardedPath: any = [bin, '/usr/bin', '/bin'].join(path.delimiter);
        if (await executableFromPath('npm', guardedPath)) {
            throw pptError('隔离导出 PATH 中出现 npm，拒绝运行带自动安装分支的上游脚本。', 'presentation_toolchain_unsafe');
        }
        return Object.freeze({
            pythonBinary: pythonPath,
            env: Object.freeze({
                PATH: guardedPath,
                PIP_DISABLE_PIP_VERSION_CHECK: '1',
                PIP_NO_INDEX: '1',
                PIP_REQUIRE_VIRTUALENV: '1',
                npm_config_offline: 'true',
                npm_config_update_notifier: 'false',
                npm_config_prefix: path.join(runtimeRoot, 'npm-prefix'),
            }),
            cleanup: (): any => fs.rm(runtimeRoot, { recursive: true, force: true }),
        });
    }
    catch (error: any) {
        await fs.rm(runtimeRoot, { recursive: true, force: true });
        throw error;
    }
}
async function resolveExecutable(command: any): Promise<any> {
    const value: any = String(command || '').trim();
    const resolved: any = value.includes('/')
        ? path.resolve(value)
        : await executableFromPath(value, process.env.PATH || '');
    if (!resolved)
        throw pptError(`隔离工具链找不到可执行文件：${value || 'empty'}`, 'presentation_export_needs_capability');
    const real: any = await fs.realpath(resolved).catch((): any => null);
    if (!real)
        throw pptError(`隔离工具链无法解析可执行文件：${value}`, 'presentation_export_needs_capability');
    await fs.access(real, fsConstants.X_OK).catch((): any => {
        throw pptError(`隔离工具链文件不可执行：${value}`, 'presentation_export_needs_capability');
    });
    return real;
}
async function executableFromPath(command: any, searchPath: any): Promise<any> {
    if (!command || command.includes('/'))
        return null;
    for (const directory of String(searchPath || '').split(path.delimiter).filter(Boolean)) {
        const candidate: any = path.join(directory, command);
        try {
            await fs.access(candidate, fsConstants.X_OK);
            return candidate;
        }
        catch { }
    }
    return null;
}
function isRetryableExportError(error: any): any {
    const code: any = String(error?.code || '').toUpperCase();
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code))
        return true;
    const message: any = String(error?.message || error || '').toLowerCase();
    return /\b(?:browser|network|socket|websocket|connection)\b/.test(message)
        && /\b(?:temporar|timeout|timed out|reset|refused|closed|unavailable|disconnected)\b/.test(message);
}
