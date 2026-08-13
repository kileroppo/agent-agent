import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PresentationCommandRunner,
  PresentationWorkspace,
  DEFAULT_PRESENTATION_RUN,
  freezePresentationReadiness as freezeReadiness,
  presentationError as pptError,
} from './presentation-adapter-protocol.js';

const LOCAL_EXPORTER = fileURLToPath(new URL('./local-pptx-export.mjs', import.meta.url));
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
const DEFAULT_PRESENTATION_SKILL_ROOT = path.join(
  os.homedir(),
  '.codex/plugins/cache/openai-primary-runtime/presentations/26.805.11740/skills/presentations',
);
const EXPECTED_NODE_VERSION = '24.14.0';
const EXPECTED_ARTIFACT_VERSION = '2.8.39';
const EXPECTED_ARTIFACT_ENTRY_HASH = 'bb3a95a02b076e43fb29ee1b7bcd2f059b07a93a32bb6e49138c58b2c718b580';
const EXPECTED_JSZIP_VERSION = '3.10.1';
const EXPECTED_JSZIP_ENTRY_HASH = '0fdb844fcdd6fd8ce8ced5e20b37cdabb629b4c155a1d3fb5df29c69eeb4f228';
const EXPECTED_SHARP_VERSION = '0.34.5';
const EXPECTED_SHARP_ENTRY_HASH = '5e30578a16290fa0855c32fe3d544ce4f26c147de6bad69cffaf7bc416a2919a';
const EXPECTED_SETUP_HASH = '71b9c78550e04eb14942544ab1c55b969d1efaf6d011fe90ec9141745c49e1d5';
const EXPECTED_EXPORTER_HASH = '5d21ccf41310a3596da3121f7bd8cb21c604af62f9e817177e21ed4e431cc097';

export class LocalPptxAdapter {
  constructor({
    nodeBinary = process.env.AGENT_ARMY_LOCAL_PPTX_NODE
      || path.join(DEFAULT_RUNTIME_ROOT, 'node/bin/node'),
    artifactRoot = process.env.AGENT_ARMY_LOCAL_PPTX_ARTIFACT_ROOT
      || path.join(DEFAULT_RUNTIME_ROOT, 'node/node_modules/@oai/artifact-tool'),
    jszipRoot = process.env.AGENT_ARMY_LOCAL_PPTX_JSZIP_ROOT
      || path.join(DEFAULT_RUNTIME_ROOT, 'node/node_modules/jszip'),
    sharpRoot = process.env.AGENT_ARMY_LOCAL_PPTX_SHARP_ROOT
      || path.join(DEFAULT_RUNTIME_ROOT, 'node/node_modules/sharp'),
    setupScript = process.env.AGENT_ARMY_LOCAL_PPTX_SETUP_SCRIPT
      || path.join(DEFAULT_PRESENTATION_SKILL_ROOT, 'container_tools/setup_artifact_tool_workspace.mjs'),
    expectedNodeVersion = EXPECTED_NODE_VERSION,
    expectedArtifactVersion = EXPECTED_ARTIFACT_VERSION,
    expectedArtifactEntryHash = EXPECTED_ARTIFACT_ENTRY_HASH,
    expectedJszipVersion = EXPECTED_JSZIP_VERSION,
    expectedJszipEntryHash = EXPECTED_JSZIP_ENTRY_HASH,
    expectedSharpVersion = EXPECTED_SHARP_VERSION,
    expectedSharpEntryHash = EXPECTED_SHARP_ENTRY_HASH,
    expectedSetupHash = EXPECTED_SETUP_HASH,
    expectedExporterHash = EXPECTED_EXPORTER_HASH,
    readinessProbeImpl = null,
    runImpl = DEFAULT_PRESENTATION_RUN,
    now = () => new Date(),
  } = {}) {
    this.nodeBinary = path.resolve(nodeBinary);
    this.artifactRoot = path.resolve(artifactRoot);
    this.jszipRoot = path.resolve(jszipRoot);
    this.sharpRoot = path.resolve(sharpRoot);
    this.setupScript = path.resolve(setupScript);
    this.expectedNodeVersion = normalizedVersion(expectedNodeVersion);
    this.expectedArtifactVersion = normalizedVersion(expectedArtifactVersion);
    this.expectedArtifactEntryHash = normalizedHash(expectedArtifactEntryHash);
    this.expectedJszipVersion = normalizedVersion(expectedJszipVersion);
    this.expectedJszipEntryHash = normalizedHash(expectedJszipEntryHash);
    this.expectedSharpVersion = normalizedVersion(expectedSharpVersion);
    this.expectedSharpEntryHash = normalizedHash(expectedSharpEntryHash);
    this.expectedSetupHash = normalizedHash(expectedSetupHash);
    this.expectedExporterHash = normalizedHash(expectedExporterHash);
    this.readinessProbeImpl = readinessProbeImpl;
    this.commands = new PresentationCommandRunner({ profile:'local' });
    this.run = runImpl === DEFAULT_PRESENTATION_RUN
      ? this.commands.defaultRun.bind(this.commands)
      : runImpl;
    this.now = now;
  }

  async readiness() {
    if (typeof this.readinessProbeImpl === 'function') return freezeReadiness(await this.readinessProbeImpl());
    const issues = [];
    const versions = {};
    const sourceHashes = {};
    const node = await this.commands.probeVersion(this.run, this, this.nodeBinary, ['--version']);
    versions.node = normalizedVersion(node.version);
    if (!node.ok) issues.push('隔离 Node 不可用');
    else if (this.expectedNodeVersion && versions.node !== this.expectedNodeVersion) {
      issues.push(`隔离 Node 版本漂移：${versions.node || 'unknown'} != ${this.expectedNodeVersion}`);
    }
    const artifact = await packageReadiness(this.artifactRoot, {
      name:'@oai/artifact-tool',
      entryRelativePath:'dist/artifact_tool.mjs',
      expectedVersion:this.expectedArtifactVersion,
      expectedEntryHash:this.expectedArtifactEntryHash,
    });
    versions.artifactTool = artifact.version;
    sourceHashes.artifactTool = artifact.entryHash;
    issues.push(...artifact.issues);
    const jszip = await packageReadiness(this.jszipRoot, {
      name:'jszip',
      entryRelativePath:'lib/index.js',
      expectedVersion:this.expectedJszipVersion,
      expectedEntryHash:this.expectedJszipEntryHash,
    });
    versions.jszip = jszip.version;
    sourceHashes.jszip = jszip.entryHash;
    issues.push(...jszip.issues);
    const sharp = await packageReadiness(this.sharpRoot, {
      name:'sharp',
      entryRelativePath:'lib/index.js',
      expectedVersion:this.expectedSharpVersion,
      expectedEntryHash:this.expectedSharpEntryHash,
    });
    versions.sharp = sharp.version;
    sourceHashes.sharp = sharp.entryHash;
    issues.push(...sharp.issues);
    const setupHash = await regularFileHash(this.setupScript);
    sourceHashes.setup = setupHash;
    if (!setupHash) issues.push('Artifact Tool 工作区初始化脚本不可用');
    else if (this.expectedSetupHash && setupHash !== this.expectedSetupHash) issues.push('Artifact Tool 工作区初始化脚本校验和漂移');
    const exporterHash = await regularFileHash(LOCAL_EXPORTER);
    sourceHashes.exporter = exporterHash;
    if (!exporterHash) issues.push('本地 PPTX 导出器不可用');
    else if (this.expectedExporterHash && exporterHash !== this.expectedExporterHash) issues.push('本地 PPTX 导出器校验和漂移');
    const ready = issues.length === 0;
    return freezeReadiness({
      status:ready ? 'ready' : 'needs_capability',
      source:{
        ready,
        adapter:'local-pptx',
        version:'1.0.0',
        sourceHash:exporterHash,
        issues:Object.freeze([...issues]),
      },
      dependencies:{
        ready,
        versions:Object.freeze(versions),
        sourceHashes:Object.freeze(sourceHashes),
        autoInstall:false,
        networkAccess:false,
        issues:Object.freeze([...issues]),
      },
      modes:{
        visualQa:{ status:ready ? 'ready' : 'needs_capability', externalDataProcessing:false },
        export:{ status:ready ? 'ready' : 'needs_capability', externalDataProcessing:false },
      },
      recovery:ready ? null : `本地 PPTX 工具链不可用：${issues.join('；')}。运行时不会自动安装或升级。`,
    });
  }

  async exportPptx({ access, input, workspaceRoot }) {
    const readiness = await this.readiness();
    if (readiness.modes.export.status !== 'ready') {
      const error = pptError(readiness.recovery || '本地 PPTX 导出能力不可用。', 'presentation_export_needs_capability');
      error.readiness = readiness;
      throw error;
    }
    const workspace = new PresentationWorkspace(workspaceRoot);
    const manifest = await workspace.existingFile(input?.manifestRelativePath, '.pptd');
    const output = await workspace.newTarget(access?.relativePath, '.pptx');
    const projectRoot = path.dirname(manifest.target);
    const qaDirectory = path.join(projectRoot, 'qa', 'local-pptx');
    const runtimeRoot = path.join(projectRoot, `.local-pptx-runtime-${crypto.randomUUID()}`);
    await Promise.all([workspace.assertPathMissing(qaDirectory), workspace.assertPathMissing(runtimeRoot)]);
    const startedAt = this.now();
    let summary;
    try {
      await fs.mkdir(runtimeRoot, { recursive:true, mode:0o700 });
      await Reflect.apply(this.run, this, [
        this.nodeBinary,
        [this.setupScript, '--workspace', runtimeRoot],
        this.commands.options(30_000),
      ]);
      const outputText = await Reflect.apply(this.run, this, [this.nodeBinary, [
        LOCAL_EXPORTER,
        '--manifest', manifest.target,
        '--output', output.target,
        '--qa-dir', qaDirectory,
        '--artifact-entry', path.join(this.artifactRoot, 'dist/artifact_tool.mjs'),
        '--jszip-entry', path.join(this.jszipRoot, 'lib/index.js'),
        '--sharp-entry', path.join(this.sharpRoot, 'lib/index.js'),
      ], this.commands.options(180_000, safeExecutionEnvironment())]);
      summary = workspace.parseExportSummary(outputText, 'local');
    } catch (error) {
      await Promise.all([
        fs.rm(output.target, { force:true }),
        fs.rm(qaDirectory, { recursive:true, force:true }),
      ]);
      throw classifyLocalExportFailure(error);
    } finally {
      await fs.rm(runtimeRoot, { recursive:true, force:true });
    }
    const { pptx, overview } = await workspace.verifyPptxExport({
      profile:'local',
      manifestPath:manifest.target,
      outputPath:output.target,
      qaDirectory,
      summary,
    });
    return Object.freeze({
      filePath:output.target,
      relativePath:access.relativePath,
      qaDirectory,
      qaOverviewPath:overview,
      qaOverviewRelativePath:path.relative(manifest.root, overview).split(path.sep).join('/'),
      mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes:pptx.length,
      checksum:crypto.createHash('sha256').update(pptx).digest('hex'),
      durationMs:Math.max(0, this.now().getTime() - startedAt.getTime()),
      attempts:1,
      verificationMode:false,
      validation:Object.freeze({
        exists:true,
        readable:true,
        nonEmpty:true,
        workspaceRestricted:true,
        structuralQaPassed:true,
        visualQaPassed:true,
        zipSignatureValid:true,
        zipIntegrityValid:true,
        pageCount:summary.slides,
        renderedSlides:summary.renderedSlides,
        fadeTransitions:summary.fadeTransitions,
        transitionPatchedSlides:summary.transitionPatchedSlides,
        transitionXmlOrderValid:true,
        fontParts:summary.fontParts,
        referencedFonts:Object.freeze([...summary.referencedFonts]),
        fontEmbeddingVerified:summary.fontEmbeddingVerified === true,
        fontCompatibilityTypeface:summary.fontCompatibilityTypeface,
        fontCompatibilityVerified:true,
        humanOfficeReviewRequired:true,
        localOnly:true,
        externalDataProcessing:false,
      }),
    });
  }
}

export class OfficePresentationAdapter {
  constructor({ pptdAdapter, pptxAdapter = new LocalPptxAdapter() } = {}) {
    if (!pptdAdapter || typeof pptdAdapter.writePptd !== 'function' || typeof pptdAdapter.readiness !== 'function') {
      throw new TypeError('OfficePresentationAdapter 需要受控 PPTD 适配器。');
    }
    this.pptdAdapter = pptdAdapter;
    this.pptxAdapter = pptxAdapter;
  }

  async readiness() {
    const [pptd, local] = await Promise.all([this.pptdAdapter.readiness(), this.pptxAdapter.readiness()]);
    const compose = pptd.modes?.compose?.status || 'needs_capability';
    const exportStatus = local.modes?.export?.status || 'needs_capability';
    return freezeReadiness({
      status:compose === 'ready' && exportStatus === 'ready' ? 'ready' : compose === 'ready' ? 'partial' : 'needs_capability',
      source:pptd.source,
      dependencies:local.dependencies,
      localExport:local.source,
      modes:{
        compose:{ status:compose, externalDataProcessing:false },
        visualQa:{ status:local.modes?.visualQa?.status || 'needs_capability', externalDataProcessing:false },
        export:{ status:exportStatus, externalDataProcessing:false },
      },
      recovery:[pptd.modes?.compose?.status === 'ready' ? null : pptd.recovery, exportStatus === 'ready' ? null : local.recovery]
        .filter(Boolean)
        .join('；') || null,
    });
  }

  writePptd(context) {
    return this.pptdAdapter.writePptd(context);
  }

  exportPptx(context) {
    return this.pptxAdapter.exportPptx(context);
  }
}

async function packageReadiness(root, { name, entryRelativePath, expectedVersion, expectedEntryHash }) {
  const issues = [];
  let version = null;
  let entryHash = null;
  try {
    const realRoot = await fs.realpath(root);
    const stat = await fs.lstat(realRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid root');
    const document = JSON.parse(await fs.readFile(path.join(realRoot, 'package.json'), 'utf8'));
    if (document?.name !== name) throw new Error('wrong package');
    version = normalizedVersion(document.version);
    entryHash = await regularFileHash(path.join(realRoot, entryRelativePath));
  } catch {
    issues.push(`${name} 未安装或不可验证`);
  }
  if (version && expectedVersion && version !== expectedVersion) issues.push(`${name} 版本漂移：${version} != ${expectedVersion}`);
  if (entryHash && expectedEntryHash && entryHash !== expectedEntryHash) issues.push(`${name} 源码校验和漂移`);
  return Object.freeze({ version, entryHash, issues:Object.freeze(issues) });
}

async function regularFileHash(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function safeExecutionEnvironment() {
  return Object.freeze({
    PATH:'/usr/bin:/bin',
    npm_config_offline:'true',
    npm_config_update_notifier:'false',
    PIP_NO_INDEX:'1',
    AGENT_ARMY_LOCAL_PPTX_DEBUG:null,
    HTTP_PROXY:null,
    HTTPS_PROXY:null,
    ALL_PROXY:null,
  });
}

function classifyLocalExportFailure(error) {
  if (error?.code && String(error.code).startsWith('presentation_')) return error;
  if (error?.code === 'ETIMEDOUT') return pptError('本地 PPTX 导出超时。', 'presentation_export_timeout');
  return pptError('本地 PPTX 导出失败；未写入不完整产物。', 'presentation_export_failed');
}

function normalizedVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return match?.[1] || null;
}

function normalizedHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}
