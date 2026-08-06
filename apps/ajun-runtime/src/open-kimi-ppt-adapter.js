import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkspaceFile } from './workspace-path-guard.js';

const SKILL_RELATIVE_ROOT = 'open-kimi-ppt-skill';
const SKILL_ENTRY = 'skills/open-kimi-ppt/SKILL.md';
const EXPORT_PPTX = 'skills/open-kimi-ppt/scripts/export_pptx.py';
const EXPORT_IMAGES = 'skills/open-kimi-ppt/scripts/export_images.py';
const EXPORT_HOST = 'skills/open-kimi-ppt/scripts/export_host.html';
const EXPECTED_PACKAGE_VERSION = '1.0.0';
const EXPECTED_SOURCE_HASH = '672358d16ef70aa907b8181d451e649465aded3ed1a9cf613b2de5771a70cb10';
const MIN_AGENT_BROWSER_VERSION = Object.freeze([0, 33, 2]);
const ALLOWED_DESIGN_MODES = new Set(['self_directed', 'design_system', 'template', 'style_transfer']);
const ALLOWED_CLASSIFICATIONS = new Set(['public', 'redacted', 'internal', 'sensitive']);
const EXTERNAL_CLASSIFICATIONS = new Set(['public', 'redacted']);
const ALLOWED_IMAGE_TYPES = Object.freeze({
  png:{ mimeType:'image/png', signatures:[Buffer.from([0x89, 0x50, 0x4e, 0x47])] },
  jpg:{ mimeType:'image/jpeg', signatures:[Buffer.from([0xff, 0xd8, 0xff])] },
  jpeg:{ mimeType:'image/jpeg', signatures:[Buffer.from([0xff, 0xd8, 0xff])] },
  gif:{ mimeType:'image/gif', signatures:[Buffer.from('GIF87a'), Buffer.from('GIF89a')] },
  svg:{ mimeType:'image/svg+xml', signatures:[] },
});

export class OpenKimiPptAdapter {
  constructor({
    sharedSkillsRoot = process.env.AGENT_ARMY_SHARED_SKILLS_ROOT
      || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib'),
    pythonBinary = process.env.AGENT_ARMY_OPEN_KIMI_PYTHON || 'python3',
    nodeBinary = process.env.AGENT_ARMY_OPEN_KIMI_NODE || 'node',
    agentBrowserBinary = process.env.AGENT_ARMY_OPEN_KIMI_AGENT_BROWSER || 'agent-browser',
    chromeBinary = process.env.AGENT_ARMY_OPEN_KIMI_CHROME
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    expectedPackageVersion = EXPECTED_PACKAGE_VERSION,
    expectedSourceHash = EXPECTED_SOURCE_HASH,
    readinessProbeImpl = null,
    runImpl = runCommand,
    prepareExecutionEnvironmentImpl = prepareNoInstallEnvironment,
    now = () => new Date(),
  } = {}) {
    this.sharedSkillsRoot = path.resolve(sharedSkillsRoot);
    this.skillRoot = path.join(this.sharedSkillsRoot, SKILL_RELATIVE_ROOT);
    this.pythonBinary = pythonBinary;
    this.nodeBinary = nodeBinary;
    this.agentBrowserBinary = agentBrowserBinary;
    this.chromeBinary = chromeBinary;
    this.expectedPackageVersion = expectedPackageVersion;
    this.expectedSourceHash = expectedSourceHash;
    this.readinessProbeImpl = readinessProbeImpl;
    this.run = runImpl;
    this.prepareExecutionEnvironment = prepareExecutionEnvironmentImpl;
    this.now = now;
  }

  async readiness() {
    if (typeof this.readinessProbeImpl === 'function') {
      return freezeReadiness(await this.readinessProbeImpl());
    }
    const source = await this.#sourceReadiness();
    const dependencies = await this.#dependencyReadiness();
    const composeStatus = source.ready ? 'ready' : 'needs_capability';
    const missing = [
      ...(source.ready ? [] : source.issues),
      ...dependencies.issues,
    ];
    const exportStatus = source.ready && dependencies.ready ? 'ready' : 'needs_capability';
    return freezeReadiness({
      status:composeStatus === 'ready' && exportStatus === 'ready' ? 'ready' : composeStatus === 'ready' ? 'partial' : 'needs_capability',
      source,
      dependencies,
      modes:{
        compose:{ status:composeStatus, externalDataProcessing:false },
        visualQa:{ status:exportStatus, externalDataProcessing:true },
        export:{ status:exportStatus, externalDataProcessing:true },
      },
      recovery:missing.length
        ? `缺少兼容的演示文稿导出能力：${missing.join('；')}。运行时不会自动安装或升级。`
        : null,
    });
  }

  async writePptd({ access, input, workspaceRoot }) {
    const readiness = await this.readiness();
    if (readiness.modes?.compose?.status !== 'ready') {
      throw pptError(readiness.recovery || 'OpenKimi PPTD 能力当前不可用。', 'presentation_compose_needs_capability');
    }
    const manifestTarget = await newWorkspaceTarget(workspaceRoot, access?.relativePath, '.pptd');
    const project = normalizePresentation(input);
    const projectRoot = manifestTarget.parent;
    const manifestName = path.basename(manifestTarget.target);
    const media = await normalizeMedia(input?.media);
    const pages = buildPages(project, new Set(media.map((item) => item.name)));
    if (project.requestedSlideCount != null && project.requestedSlideCount !== pages.length) {
      throw pptError(
        `要求 ${project.requestedSlideCount} 页，但当前有效提纲只能生成 ${pages.length} 页；请补齐逐页提纲。`,
        'presentation_outline_mismatch',
      );
    }
    const pageEntries = pages.map((page, index) => ({
      relativePath:`pages/${String(index + 1).padStart(2, '0')}-${page.pageType || 'content'}.page`,
      contents:jsonDocument(page),
    }));
    const manifest = {
      version:'v2',
      title:project.title,
      size:[960, 540],
      theme:presentationTheme(project.design),
      pages:pageEntries.map((item) => item.relativePath),
    };
    const validation = validatePptdProject({ manifest, pages, mediaNames:new Set(media.map((item) => item.name)) });
    const qaRelativePath = 'qa/structural-validation.json';
    const targets = [
      ...pageEntries.map((item) => ({ ...item, target:path.join(projectRoot, item.relativePath) })),
      ...media.map((item) => ({ ...item, target:path.join(projectRoot, 'media', item.name), relativePath:`media/${item.name}` })),
      {
        relativePath:qaRelativePath,
        target:path.join(projectRoot, qaRelativePath),
        contents:jsonDocument({
          schemaVersion:'agent.army/presentation-qa/v1',
          status:'structural_passed',
          pageCount:pages.length,
          checks:validation,
          visualReview:{ status:'not_run', reason:'PPTX 外部导出能力尚未执行。' },
        }),
      },
      { relativePath:manifestName, target:manifestTarget.target, contents:jsonDocument(manifest) },
    ];
    await assertTargetsNew(projectRoot, targets);
    for (const item of targets) {
      await fs.mkdir(path.dirname(item.target), { recursive:true, mode:0o700 });
      const contents = item.bytes || Buffer.from(item.contents, 'utf8');
      await fs.writeFile(item.target, contents, { flag:'wx', mode:0o600 });
    }
    const checksum = aggregateChecksum(targets);
    return Object.freeze({
      projectPath:projectRoot,
      projectRelativePath:path.posix.dirname(access.relativePath),
      manifestPath:manifestTarget.target,
      manifestRelativePath:access.relativePath,
      pagePaths:Object.freeze(pageEntries.map((item) => path.join(projectRoot, item.relativePath))),
      mediaPaths:Object.freeze(media.map((item) => path.join(projectRoot, 'media', item.name))),
      qaPath:path.join(projectRoot, qaRelativePath),
      qaRelativePath:path.posix.join(path.posix.dirname(access.relativePath), qaRelativePath),
      checksum,
      bytes:targets.reduce((sum, item) => sum + (item.bytes?.length || Buffer.byteLength(item.contents)), 0),
      mimeType:'application/vnd.open-kimi.pptd+yaml',
      validation:Object.freeze({
        ...validation,
        exists:true,
        readable:true,
        nonEmpty:true,
        selfContained:true,
        workspaceRestricted:true,
        remoteResources:0,
        structuralQaPassed:true,
        visualQaPassed:false,
      }),
      source:Object.freeze({
        skillVersion:readiness.source?.packageVersion || this.expectedPackageVersion,
        sourceHash:readiness.source?.sourceHash || this.expectedSourceHash,
      }),
    });
  }

  async exportPptx({ access, input, workspaceRoot }) {
    assertExternalProcessing(input);
    const readiness = await this.readiness();
    if (readiness.modes?.export?.status !== 'ready') {
      const error = pptError(readiness.recovery || 'PPTX 导出依赖尚未就绪。', 'presentation_export_needs_capability');
      error.readiness = readiness;
      throw error;
    }
    const manifest = await existingWorkspaceFile(workspaceRoot, input?.manifestRelativePath, '.pptd');
    const output = await newWorkspaceTarget(workspaceRoot, access?.relativePath, '.pptx');
    const projectRoot = path.dirname(manifest.target);
    const qaDirectory = path.join(projectRoot, '.qa-images');
    await assertPathMissing(qaDirectory);
    const startedAt = this.now();
    const executionEnvironment = await this.prepareExecutionEnvironment({
      projectRoot,
      pythonBinary:this.pythonBinary,
      nodeBinary:this.nodeBinary,
      agentBrowserBinary:this.agentBrowserBinary,
    });
    let exportOutput;
    let attempts = 0;
    try {
      while (attempts < 2) {
        attempts += 1;
        try {
          await this.run(
            executionEnvironment.pythonBinary,
            [path.join(this.skillRoot, EXPORT_IMAGES), manifest.target, '--output', qaDirectory],
            commandOptions(180_000, executionEnvironment.env),
          );
          exportOutput = await this.run(
            executionEnvironment.pythonBinary,
            [path.join(this.skillRoot, EXPORT_PPTX), manifest.target, '--output', output.target],
            commandOptions(240_000, executionEnvironment.env),
          );
          break;
        } catch (error) {
          if (attempts >= 2 || !isRetryableExportError(error)) throw error;
          await Promise.all([
            fs.rm(qaDirectory, { recursive:true, force:true }),
            fs.rm(output.target, { force:true }),
          ]);
        }
      }
    } finally {
      await executionEnvironment.cleanup();
    }
    const exportSummary = parseExportSummary(exportOutput);
    const expectedPageCount = await pptdPageCount(manifest.target);
    if (
      exportSummary.slides !== expectedPageCount
      || exportSummary.fadeTransitions !== expectedPageCount
      || exportSummary.transitionPatchedSlides !== expectedPageCount
    ) {
      throw pptError('PPTX 页数或每页唯一 fade 转场校验不一致。', 'presentation_export_validation_failed');
    }
    const pptx = await fs.readFile(output.target);
    if (pptx.length < 16 || pptx.subarray(0, 2).toString() !== 'PK') {
      throw pptError('PPTX 导出文件签名无效。', 'presentation_export_invalid');
    }
    const overview = path.join(qaDirectory, 'overview.jpg');
    const overviewStat = await fs.stat(overview).catch(() => null);
    if (!overviewStat?.isFile() || overviewStat.size < 1) {
      throw pptError('PPTX 导出前的页面图片质检产物缺失。', 'presentation_visual_qa_missing');
    }
    return Object.freeze({
      filePath:output.target,
      relativePath:access.relativePath,
      qaDirectory,
      qaOverviewPath:overview,
      qaOverviewRelativePath:path.relative(workspaceRoot, overview).split(path.sep).join('/'),
      mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes:pptx.length,
      checksum:crypto.createHash('sha256').update(pptx).digest('hex'),
      durationMs:Math.max(0, this.now().getTime() - startedAt.getTime()),
      attempts,
      validation:Object.freeze({
        exists:true,
        readable:true,
        nonEmpty:true,
        workspaceRestricted:true,
        structuralQaPassed:true,
        visualQaPassed:true,
        zipSignatureValid:true,
        zipIntegrityValid:true,
        pageCount:exportSummary.slides,
        fadeTransitions:exportSummary.fadeTransitions,
        transitionPatchedSlides:exportSummary.transitionPatchedSlides,
        transitionXmlOrderValid:true,
        fontParts:exportSummary.fontParts,
        fontEmbeddingVerified:exportSummary.fontParts > 0,
        humanOfficeReviewRequired:true,
      }),
    });
  }

  async #sourceReadiness() {
    const packagePath = path.join(this.skillRoot, 'package.json');
    const files = [SKILL_ENTRY, EXPORT_PPTX, EXPORT_IMAGES, EXPORT_HOST]
      .map((item) => path.join(this.skillRoot, item));
    const issues = [];
    let packageVersion = null;
    try {
      packageVersion = JSON.parse(await fs.readFile(packagePath, 'utf8')).version || null;
    } catch {
      issues.push('共享技能 package.json 不可读');
    }
    let sourceHash = null;
    try {
      const hashes = [];
      for (const file of files) hashes.push(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'));
      sourceHash = crypto.createHash('sha256').update(`${hashes.join('\n')}\n`).digest('hex');
    } catch {
      issues.push('技能入口或导出脚本不完整');
    }
    if (packageVersion && packageVersion !== this.expectedPackageVersion) {
      issues.push(`技能版本漂移：${packageVersion} != ${this.expectedPackageVersion}`);
    }
    if (sourceHash && this.expectedSourceHash && sourceHash !== this.expectedSourceHash) {
      issues.push('技能源码校验和漂移');
    }
    try {
      const hostTemplate = await fs.readFile(path.join(this.skillRoot, EXPORT_HOST), 'utf8');
      const remoteHosts = [...hostTemplate.matchAll(/https?:\/\/[^\s"'`<>]+/g)]
        .map(([url]) => new URL(url).hostname);
      if (
        remoteHosts.length !== 2
        || new Set(remoteHosts).size !== 2
        || remoteHosts.some((host) => !['www.kimi.com', 'statics.moonshot.cn'].includes(host))
      ) {
        issues.push('导出页面远程主机白名单漂移');
      }
    } catch {
      issues.push('导出页面远程主机白名单不可验证');
    }
    return Object.freeze({
      ready:issues.length === 0,
      packageVersion,
      sourceHash,
      entryPath:path.join(SKILL_RELATIVE_ROOT, SKILL_ENTRY),
      issues:Object.freeze(issues),
    });
  }

  async #dependencyReadiness() {
    const issues = [];
    const versions = {};
    const node = await probeVersion(this.run, this.nodeBinary, ['--version']);
    versions.node=node.version;
    if (!node.ok || majorVersion(node.version) < 24) issues.push('隔离 Node 24+ 未配置');
    const python = await probeVersion(this.run, this.pythonBinary, ['--version']);
    versions.python=python.version;
    if (!python.ok) issues.push('Python 3 不可用');
    if (python.ok) {
      const modules = await probeVersion(this.run, this.pythonBinary, ['-c', 'import yaml, PIL, websocket; print("ok")']);
      if (!modules.ok) issues.push('PyYAML、Pillow 或 websocket-client 未预装');
    }
    const browser = await probeVersion(this.run, this.agentBrowserBinary, ['--version']);
    versions.agentBrowser=browser.version;
    if (!browser.ok || compareVersions(parseVersion(browser.version), MIN_AGENT_BROWSER_VERSION) < 0) {
      issues.push(`agent-browser ${versionText(browser.version)} 低于 0.33.2 或未安装`);
    }
    const chrome = await fs.access(this.chromeBinary).then(() => true).catch(() => false);
    if (!chrome) issues.push('Chromium 浏览器未配置');
    return Object.freeze({
      ready:issues.length === 0,
      versions:Object.freeze(versions),
      chromeBinary:chrome ? this.chromeBinary : null,
      autoInstall:false,
      allowedHosts:Object.freeze(['www.kimi.com', 'statics.moonshot.cn']),
      issues:Object.freeze(issues),
    });
  }
}

export async function openKimiPptReadiness(options = {}) {
  return new OpenKimiPptAdapter(options).readiness();
}

function normalizePresentation(input = {}) {
  const title = requiredText(input.title, '演示文稿标题');
  const designMode = String(input.designMode || 'self_directed').trim();
  if (!ALLOWED_DESIGN_MODES.has(designMode)) {
    throw pptError('designMode 只能是 self_directed、design_system、template 或 style_transfer。', 'presentation_input_invalid');
  }
  const classification = String(input.dataClassification || 'internal').trim();
  if (!ALLOWED_CLASSIFICATIONS.has(classification)) {
    throw pptError('dataClassification 无效。', 'presentation_input_invalid');
  }
  const requestedSlideCount = input.slideCount == null ? null : Number(input.slideCount);
  if (requestedSlideCount != null && (!Number.isInteger(requestedSlideCount) || requestedSlideCount < 1 || requestedSlideCount > 30)) {
    throw pptError('slideCount 必须是 1–30 的整数。', 'presentation_input_invalid');
  }
  const rawSlides = Array.isArray(input.slides) ? input.slides : Array.isArray(input.outline) ? input.outline : [];
  if (rawSlides.length > 29) throw pptError('首版最多接受 29 页正文提纲。', 'presentation_input_invalid');
  const slides = rawSlides.map((slide, index) => normalizeSlide(slide, index));
  return Object.freeze({
    title,
    purpose:cleanText(input.purpose || input.description, 1000),
    audience:cleanText(input.audience, 300),
    designMode,
    design:normalizeDesign(input, designMode),
    classification,
    requestedSlideCount,
    slides,
    sourceSummaries:stringList(input.sourceSummaries, 20, 300),
  });
}

function normalizeDesign(input, designMode) {
  const sourceRef = cleanText(
    input.designSourceRef || input.templateArtifactRef || input.styleArtifactRef,
    240,
  );
  const raw = input.designTokens;
  if (designMode !== 'self_directed' && !plainObject(raw)) {
    throw pptError(`${designMode} 需要提供结构化 designTokens。`, 'presentation_design_input_required');
  }
  if (['template', 'style_transfer'].includes(designMode) && !sourceRef) {
    throw pptError(`${designMode} 需要提供当前任务允许的设计来源产物引用。`, 'presentation_design_input_required');
  }
  const colors = {};
  const allowedColors = new Set(['navy', 'primary', 'accent', 'text', 'muted', 'paper', 'line']);
  for (const [key, value] of Object.entries(plainObject(raw?.colors) ? raw.colors : {})) {
    if (!allowedColors.has(key) || !/^#[0-9a-f]{6}$/i.test(String(value || ''))) {
      throw pptError('designTokens.colors 只能覆盖允许的六位十六进制主题颜色。', 'presentation_design_input_invalid');
    }
    colors[key] = String(value).toUpperCase();
  }
  const fonts = {};
  for (const key of ['heading', 'body']) {
    const value = cleanText(raw?.fonts?.[key], 80);
    if (value && !/^[\p{L}\p{N} ._-]+$/u.test(value)) {
      throw pptError('designTokens.fonts 只接受本地字体名称，不接受 URL 或路径。', 'presentation_design_input_invalid');
    }
    if (value) fonts[key] = value;
  }
  return Object.freeze({
    mode:designMode,
    sourceRef:sourceRef || null,
    colors:Object.freeze(colors),
    fonts:Object.freeze(fonts),
  });
}

function normalizeSlide(value, index) {
  if (typeof value === 'string') return Object.freeze({ title:`第 ${index + 1} 部分`, bullets:[cleanText(value, 800)] });
  if (!plainObject(value)) throw pptError('逐页提纲必须是文字或对象。', 'presentation_input_invalid');
  const title = requiredText(value.title || `第 ${index + 1} 部分`, '页面标题');
  return Object.freeze({
    title,
    bullets:stringList(value.bullets || value.points || (value.body ? [value.body] : []), 8, 500),
    notes:cleanText(value.notes, 1000),
    image:cleanMediaName(value.image),
    table:normalizeTable(value.table),
    chart:normalizeChart(value.chart),
  });
}

async function normalizeMedia(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw pptError('media 必须是不超过 12 项的数组。', 'presentation_input_invalid');
  let total = 0;
  const names = new Set();
  return value.map((item) => {
    if (!plainObject(item)) throw pptError('媒体项格式无效。', 'presentation_input_invalid');
    const name = cleanMediaName(item.name);
    if (!name || names.has(name)) throw pptError('媒体文件名为空或重复。', 'presentation_input_invalid');
    names.add(name);
    const extension = path.extname(name).slice(1).toLowerCase();
    const type = ALLOWED_IMAGE_TYPES[extension];
    if (!type) throw pptError('首版媒体只允许 PNG、JPEG、GIF 或 SVG。', 'presentation_media_denied');
    const encoded = String(item.dataBase64 || '').trim();
    if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw pptError('媒体必须以内嵌 base64 提供。', 'presentation_media_denied');
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    if (bytes.length < 4 || bytes.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) {
      throw pptError('单个媒体不能超过 5MB，总媒体不能超过 20MB。', 'presentation_media_denied');
    }
    if (extension === 'svg') {
      const text = bytes.toString('utf8').trim();
      if (!/^<svg\b/i.test(text) || /<(?:script|foreignObject|iframe|image)\b|\b(?:href|src)\s*=|url\s*\(/i.test(text)) {
        throw pptError('SVG 包含外部资源或可执行内容。', 'presentation_media_denied');
      }
    } else if (!type.signatures.some((signature) => bytes.subarray(0, signature.length).equals(signature))) {
      throw pptError(`媒体 ${name} 的文件签名与扩展名不一致。`, 'presentation_media_denied');
    }
    return Object.freeze({ name, bytes, mimeType:type.mimeType });
  });
}

function normalizeTable(value) {
  if (value == null) return null;
  const rows = Array.isArray(value) ? value : value?.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12) throw pptError('表格需要 1–12 行。', 'presentation_input_invalid');
  const width = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (width < 1 || width > 8 || rows.some((row) => !Array.isArray(row) || row.length !== width)) {
    throw pptError('表格需要 1–8 列且每行列数一致。', 'presentation_input_invalid');
  }
  return Object.freeze(rows.map((row) => Object.freeze(row.map((cell) => cleanText(cell, 300)))));
}

function normalizeChart(value) {
  if (value == null) return null;
  if (!plainObject(value)) throw pptError('图表格式无效。', 'presentation_input_invalid');
  const categories = stringList(value.categories, 12, 120);
  const values = Array.isArray(value.values) ? value.values.map(Number) : [];
  if (!categories.length || categories.length !== values.length || values.some((item) => !Number.isFinite(item))) {
    throw pptError('图表需要等长的 categories 和数值 values。', 'presentation_input_invalid');
  }
  return Object.freeze({ title:cleanText(value.title, 160), categories, values:Object.freeze(values) });
}

function buildPages(project, mediaNames) {
  const pages = [coverPage(project)];
  if (project.slides.length) {
    for (const slide of project.slides) pages.push(contentPage(slide, mediaNames));
  } else {
    const bullets = [
      project.purpose ? `目的：${project.purpose}` : '',
      project.audience ? `受众：${project.audience}` : '',
      ...project.sourceSummaries,
    ].filter(Boolean);
    pages.push(contentPage({ title:'汇报要点', bullets:bullets.length ? bullets : ['当前材料只包含标题，正文需要负责人补充。'] }, mediaNames));
  }
  return pages;
}

function coverPage(project) {
  return {
    pageType:'cover',
    background:{ type:'solid', color:'$navy' },
    elements:[
      { elementId:'accent', elementType:'shape', bounds:[72, 80, 12, 360], shapeName:'roundRect', fill:{ type:'solid', color:'$accent' } },
      { elementId:'title', elementType:'text', bounds:[112, 150, 740, 150], content:{ style:'$coverTitle', align:['left', 'middle'], text:project.title } },
      { elementId:'meta', elementType:'text', bounds:[116, 320, 700, 80], content:{ style:'$coverMeta', align:['left', 'top'], text:[project.purpose, project.audience ? `受众：${project.audience}` : ''].filter(Boolean).join('\n') || '办公演示文稿' } },
    ],
  };
}

function contentPage(slide, mediaNames) {
  const elements = [
    { elementId:'header-line', elementType:'shape', bounds:[56, 56, 8, 50], shapeName:'rect', fill:{ type:'solid', color:'$accent' } },
    { elementId:'title', elementType:'text', bounds:[80, 48, 820, 72], content:{ style:'$title', align:['left', 'middle'], text:slide.title } },
  ];
  const hasSideVisual = Boolean(slide.image || slide.table || slide.chart);
  const bodyWidth = hasSideVisual ? 380 : 800;
  const bullets = Array.isArray(slide.bullets) && slide.bullets.length ? slide.bullets : ['本页内容需要负责人补充。'];
  elements.push({
    elementId:'body', elementType:'text', bounds:[80, 145, bodyWidth, 330],
    content:{ style:'$body', align:['left', 'top'], text:bullets.map((item) => `<p>• ${escapeRichText(item)}</p>`).join('') },
  });
  if (slide.image) {
    if (!mediaNames.has(slide.image)) throw pptError(`页面引用了未提供的媒体：${slide.image}`, 'presentation_media_missing');
    elements.push({ elementId:'visual-image', elementType:'image', bounds:[500, 150, 380, 300], src:`media/${slide.image}`, fit:{ mode:'contain' }, border:{ style:'solid', width:1, color:'$line' } });
  }
  if (slide.table) {
    const columns = slide.table[0].length;
    const rows = slide.table.length;
    elements.push({
      elementId:'visual-table', elementType:'table', bounds:[480, 145, 410, 320],
      columnWidths:Array.from({ length:columns }, () => 1 / columns),
      rowHeights:Array.from({ length:rows }, () => 1 / rows),
      style:'$default', rows:slide.table.map((row) => row.map((text) => ({ text }))),
    });
  }
  if (slide.chart) {
    elements.push({
      elementId:'visual-chart', elementType:'chart', bounds:[480, 135, 420, 340],
      title:slide.chart.title || undefined,
      data:{ cols:['category', 'value'], rows:slide.chart.categories.map((category, index) => [category, slide.chart.values[index]]) },
      series:[{ type:'bar', encode:{ x:'category', y:'value' }, fill:'$primary', dataLabels:{ show:true } }],
      legend:false,
    });
  }
  return { pageType:'content', ...(slide.notes ? { notes:slide.notes } : {}), background:{ type:'solid', color:'$paper' }, elements };
}

function presentationTheme(design) {
  const colors = {
    navy:'#10243E', primary:'#2563EB', accent:'#F59E0B', text:'#1F2937',
    muted:'#64748B', paper:'#F8FAFC', line:'#CBD5E1',
    ...(design?.colors || {}),
  };
  const headingFont = design?.fonts?.heading || 'MiSans';
  const bodyFont = design?.fonts?.body || headingFont;
  return {
    colors,
    textStyles:{
      coverTitle:{ fontSize:42, fontFamily:headingFont, bold:true, color:'#FFFFFF', lineHeight:1.15 },
      coverMeta:{ fontSize:18, fontFamily:bodyFont, color:'#D7E2F0', lineHeight:1.5 },
      title:{ fontSize:30, fontFamily:headingFont, bold:true, color:'$navy' },
      body:{ fontSize:19, fontFamily:bodyFont, color:'$text', lineHeight:1.5 },
    },
    tableStyles:{
      default:{
        cellStyle:{ color:'$text', fontSize:14, fill:{ type:'solid', color:'#FFFFFF' }, border:{ style:'solid', width:1, color:'$line' }, align:['center', 'middle'] },
        firstRowStyle:{ bold:true, color:'#FFFFFF', fill:{ type:'solid', color:'$navy' } },
        bodyStyles:[{ fill:{ type:'solid', color:'#F8FAFC' } }, { fill:{ type:'solid', color:'#FFFFFF' } }],
      },
    },
  };
}

function validatePptdProject({ manifest, pages, mediaNames }) {
  if (manifest.version !== 'v2' || !Array.isArray(manifest.size) || manifest.size[0] !== 960 || manifest.size[1] !== 540) {
    throw pptError('PPTD 主入口版本或页面尺寸无效。', 'presentation_structure_invalid');
  }
  if (!manifest.pages.length || manifest.pages.length !== pages.length || new Set(manifest.pages).size !== manifest.pages.length) {
    throw pptError('PPTD 页面引用为空、重复或数量不一致。', 'presentation_structure_invalid');
  }
  const themeTokens = new Set(Object.keys(manifest.theme?.colors || {}));
  let elementCount = 0;
  for (const [pageIndex, page] of pages.entries()) {
    if (!Array.isArray(page.elements) || !page.elements.length) throw pptError(`第 ${pageIndex + 1} 页没有元素。`, 'presentation_structure_invalid');
    const ids = new Set();
    for (const element of page.elements) {
      elementCount += 1;
      if (!element.elementId || ids.has(element.elementId)) throw pptError(`第 ${pageIndex + 1} 页元素 ID 为空或重复。`, 'presentation_structure_invalid');
      ids.add(element.elementId);
      if (!['text', 'shape', 'line', 'image', 'icon', 'table', 'chart'].includes(element.elementType)) throw pptError('PPTD 含不支持的元素类型。', 'presentation_structure_invalid');
      if (!validBounds(element.bounds, manifest.size)) throw pptError(`第 ${pageIndex + 1} 页元素越界。`, 'presentation_structure_invalid');
      if (element.elementType === 'image') {
        if (!/^media\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(element.src || '') || !mediaNames.has(element.src.slice(6))) {
          throw pptError('图片必须引用项目 media 目录内已提供的文件。', 'presentation_media_denied');
        }
      }
      assertThemeTokens(element, themeTokens);
    }
  }
  return Object.freeze({
    requiredFields:true,
    pageReferences:true,
    uniqueElementIds:true,
    boundsValid:true,
    themeTokensValid:true,
    mediaReferencesValid:true,
    pageCount:pages.length,
    elementCount,
  });
}

function assertThemeTokens(value, available) {
  if (typeof value === 'string' && value.startsWith('$') && !available.has(value.slice(1))) {
    throw pptError(`未知主题颜色：${value}`, 'presentation_structure_invalid');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertThemeTokens(item, available);
  } else if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'style' && key !== 'textStyle') assertThemeTokens(item, available);
    }
  }
}

function validBounds(value, [width, height]) {
  return Array.isArray(value) && value.length === 4
    && value.every((item) => Number.isFinite(item) && item >= 0)
    && value[2] > 0 && value[3] > 0
    && value[0] + value[2] <= width
    && value[1] + value[3] <= height;
}

function assertExternalProcessing(input) {
  const classification = String(input?.dataClassification || '').trim();
  if (!EXTERNAL_CLASSIFICATIONS.has(classification)) {
    throw pptError('内部或敏感材料不能发送到 Kimi 公共编辑器；已保留 PPTD。', 'presentation_external_processing_denied');
  }
  if (input?.externalProcessingApproved !== true) {
    throw pptError('PPTX 导出需要负责人明确批准本次外部处理；已保留 PPTD。', 'presentation_external_processing_approval_required');
  }
}

async function newWorkspaceTarget(workspaceRoot, relativePath, extension) {
  const relative = String(relativePath || '').trim().replaceAll('\\', '/');
  if (path.posix.extname(relative).toLowerCase() !== extension) throw pptError(`目标必须使用 ${extension} 扩展名。`, 'presentation_path_invalid');
  const target = await prepareWorkspaceFile(workspaceRoot, relative);
  await assertPathMissing(target.target);
  return target;
}

async function existingWorkspaceFile(workspaceRoot, relativePath, extension) {
  const relative = String(relativePath || '').trim().replaceAll('\\', '/');
  if (path.posix.extname(relative).toLowerCase() !== extension) throw pptError(`输入必须使用 ${extension} 扩展名。`, 'presentation_path_invalid');
  const { root, target } = await prepareWorkspaceFile(workspaceRoot, relative);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw pptError('输入文件不存在或不是普通文件。', 'presentation_source_invalid');
  const real = await fs.realpath(target);
  if (!real.startsWith(`${root}${path.sep}`)) throw pptError('输入文件越出工作区。', 'workspace_path_denied');
  return { root, target:real };
}

async function assertTargetsNew(projectRoot, targets) {
  const root = await fs.realpath(projectRoot);
  for (const item of targets) {
    const target = path.resolve(item.target);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) throw pptError('演示文稿产物越出项目目录。', 'workspace_path_denied');
    await assertPathMissing(target);
  }
}

async function assertPathMissing(target) {
  const stat = await fs.lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (stat) throw pptError('演示文稿目标已存在；请使用新的版本路径，禁止静默覆盖。', 'workspace_file_exists');
}

function cleanMediaName(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || name.includes('..')) {
    throw pptError('媒体文件名只能包含字母、数字、点、下划线和短横线。', 'presentation_media_denied');
  }
  return name;
}

function jsonDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function aggregateChecksum(targets) {
  const hash = crypto.createHash('sha256');
  for (const item of targets) hash.update(item.relativePath).update('\0').update(item.bytes || Buffer.from(item.contents)).update('\0');
  return hash.digest('hex');
}

function requiredText(value, label) {
  const text = cleanText(value, 300);
  if (!text) throw pptError(`${label}不能为空。`, 'presentation_input_invalid');
  return text;
}

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/[\r\t]+/g, ' ').trim().slice(0, max);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanText(item, maxLength)).filter(Boolean);
}

function escapeRichText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function freezeReadiness(value = {}) {
  return Object.freeze({
    ...value,
    modes:Object.freeze(Object.fromEntries(Object.entries(value.modes || {}).map(([key, item]) => [key, Object.freeze({ ...item })]))),
  });
}

async function probeVersion(run, command, args) {
  try {
    const output = await run(command, args, { timeoutMs:10_000, maxBuffer:256 * 1024 });
    return { ok:true, version:String(output || '').trim().split('\n')[0] };
  } catch (error) {
    return { ok:false, version:null, code:error?.code || 'command_failed' };
  }
}

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function majorVersion(value) {
  const match = String(value || '').match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  }
  return 0;
}

function versionText(value) {
  return String(value || '未安装').replace(/^v/, '');
}

function commandOptions(timeoutMs = 180_000, env = null) {
  return { timeoutMs, maxBuffer:2 * 1024 * 1024, ...(env ? { env } : {}) };
}

async function prepareNoInstallEnvironment({ projectRoot, pythonBinary, nodeBinary, agentBrowserBinary }) {
  const runtimeRoot = path.join(projectRoot, `.qa-runtime-${crypto.randomUUID()}`);
  await assertPathMissing(runtimeRoot);
  await fs.mkdir(path.join(runtimeRoot, 'bin'), { recursive:true, mode:0o700 });
  try {
    const [pythonPath, nodePath, browserPath] = await Promise.all([
      resolveExecutable(pythonBinary),
      resolveExecutable(nodeBinary),
      resolveExecutable(agentBrowserBinary),
    ]);
    const bin = path.join(runtimeRoot, 'bin');
    await fs.symlink(nodePath, path.join(bin, 'node'));
    await fs.symlink(browserPath, path.join(bin, 'agent-browser'));
    const guardedPath = [bin, '/usr/bin', '/bin'].join(path.delimiter);
    if (await executableFromPath('npm', guardedPath)) {
      throw pptError('隔离导出 PATH 中出现 npm，拒绝运行带自动安装分支的上游脚本。', 'presentation_toolchain_unsafe');
    }
    return Object.freeze({
      pythonBinary:pythonPath,
      env:Object.freeze({
        PATH:guardedPath,
        PIP_DISABLE_PIP_VERSION_CHECK:'1',
        PIP_NO_INDEX:'1',
        PIP_REQUIRE_VIRTUALENV:'1',
        npm_config_offline:'true',
        npm_config_update_notifier:'false',
        npm_config_prefix:path.join(runtimeRoot, 'npm-prefix'),
      }),
      cleanup:() => fs.rm(runtimeRoot, { recursive:true, force:true }),
    });
  } catch (error) {
    await fs.rm(runtimeRoot, { recursive:true, force:true });
    throw error;
  }
}

async function resolveExecutable(command) {
  const value = String(command || '').trim();
  const resolved = value.includes('/')
    ? path.resolve(value)
    : await executableFromPath(value, process.env.PATH || '');
  if (!resolved) throw pptError(`隔离工具链找不到可执行文件：${value || 'empty'}`, 'presentation_export_needs_capability');
  const real = await fs.realpath(resolved).catch(() => null);
  if (!real) throw pptError(`隔离工具链无法解析可执行文件：${value}`, 'presentation_export_needs_capability');
  await fs.access(real, fsConstants.X_OK).catch(() => {
    throw pptError(`隔离工具链文件不可执行：${value}`, 'presentation_export_needs_capability');
  });
  return real;
}

async function executableFromPath(command, searchPath) {
  if (!command || command.includes('/')) return null;
  for (const directory of String(searchPath || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function parseExportSummary(output) {
  let summary;
  try {
    summary = JSON.parse(String(output || '').trim());
  } catch {
    throw pptError('PPTX 导出器没有返回可验证的结构摘要。', 'presentation_export_validation_failed');
  }
  for (const field of ['slides', 'fadeTransitions', 'transitionPatchedSlides', 'fontParts']) {
    if (!Number.isInteger(summary?.[field]) || summary[field] < 0) {
      throw pptError(`PPTX 导出器缺少有效的 ${field} 校验结果。`, 'presentation_export_validation_failed');
    }
  }
  if (summary.slides < 1) {
    throw pptError('PPTX 导出结果不包含页面。', 'presentation_export_validation_failed');
  }
  return summary;
}

async function pptdPageCount(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw pptError('受控适配器只能导出自己生成的 JSON 兼容 PPTD 清单。', 'presentation_source_invalid');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length < 1) {
    throw pptError('PPTD 清单没有有效页面引用。', 'presentation_source_invalid');
  }
  return manifest.pages.length;
}

function runCommand(command, args, { timeoutMs = 30_000, maxBuffer = 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {
    timeout:timeoutMs,
    maxBuffer,
    encoding:'utf8',
    env:{ ...process.env, ...env },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function isRetryableExportError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return /\b(?:browser|network|socket|websocket|connection)\b/.test(message)
    && /\b(?:temporar|timeout|timed out|reset|refused|closed|unavailable|disconnected)\b/.test(message);
}

function pptError(message, code) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}
