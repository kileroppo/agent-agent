import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPptxAdapter, OfficePresentationAdapter } from '../src/local-pptx-adapter.ts';
import { OpenKimiPptAdapter } from '../src/open-kimi-ppt-adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '../test/fixtures/open-kimi-ppt');
const evidencePath = String(process.env.AGENT_ARMY_LOCAL_PPTX_EVIDENCE_DIR || '').trim();
const persistent = Boolean(evidencePath);
const workspace = persistent
  ? await createEvidenceWorkspace(evidencePath)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-office-presentation-'));
const localAdapter = new LocalPptxAdapter();
const adapter = new OfficePresentationAdapter({
  pptdAdapter:new OpenKimiPptAdapter(),
  pptxAdapter:localAdapter,
});

try {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'presentation.json'), 'utf8'));
  const svg = await fs.readFile(path.join(fixtureRoot, 'agent-army.svg'));
  const readiness = await adapter.readiness();
  assert.equal(readiness.modes.compose.status, 'ready');
  assert.equal(readiness.modes.visualQa.status, 'ready');
  assert.equal(readiness.modes.export.status, 'ready');
  assert.equal(readiness.modes.export.externalDataProcessing, false);
  const pptd = await adapter.writePptd({
    access:{ relativePath:'work-products/smoke/presentation/deck.pptd' },
    workspaceRoot:workspace,
    input:{ ...fixture, media:[{ name:'agent-army.svg', dataBase64:svg.toString('base64') }] },
  });
  assert.equal(pptd.validation.structuralQaPassed, true);
  assert.equal(pptd.validation.selfContained, true);

  let fallbackCommands = 0;
  const unavailable = new LocalPptxAdapter({
    readinessProbeImpl:async () => ({
      status:'needs_capability',
      source:{ ready:false, issues:['fixture missing dependency'] },
      dependencies:{ ready:false, autoInstall:false, networkAccess:false, issues:['fixture missing dependency'] },
      modes:{
        visualQa:{ status:'needs_capability', externalDataProcessing:false },
        export:{ status:'needs_capability', externalDataProcessing:false },
      },
      recovery:'fixture missing dependency；不会自动安装或升级。',
    }),
    runImpl:async () => { fallbackCommands += 1; throw new Error('不应执行'); },
  });
  let fallbackCode = null;
  try {
    await unavailable.exportPptx({
      access:{ relativePath:'work-products/smoke/presentation/blocked.pptx' },
      workspaceRoot:workspace,
      input:{ manifestRelativePath:pptd.manifestRelativePath, dataClassification:'sensitive' },
    });
  } catch (error) {
    fallbackCode = error?.code;
  }
  assert.equal(fallbackCode, 'presentation_export_needs_capability');
  assert.equal(fallbackCommands, 0);

  const exported = await adapter.exportPptx({
    access:{ relativePath:'work-products/smoke/presentation/deck.pptx' },
    workspaceRoot:workspace,
    input:{
      manifestRelativePath:pptd.manifestRelativePath,
      dataClassification:'sensitive',
      externalProcessingApproved:false,
    },
  });
  assert.equal(exported.validation.localOnly, true);
  assert.equal(exported.validation.externalDataProcessing, false);
  assert.equal(exported.validation.visualQaPassed, true);
  assert.equal(exported.validation.zipIntegrityValid, true);
  assert.equal(exported.validation.pageCount, 4);
  assert.equal(exported.validation.renderedSlides, 4);
  assert.equal(exported.validation.fadeTransitions, 4);
  assert.equal(exported.validation.transitionXmlOrderValid, true);
  assert.equal(exported.validation.fontCompatibilityVerified, true);
  assert.ok(Array.isArray(exported.validation.referencedFonts));

  const record = {
    schemaVersion:'agent.army/local-pptx-verification/v1',
    status:'passed',
    verifiedAt:new Date().toISOString(),
    adapter:{
      version:readiness.localExport?.version,
      sourceHash:readiness.localExport?.sourceHash,
    },
    dependencies:readiness.dependencies?.versions,
    dependencyHashes:readiness.dependencies?.sourceHashes,
    networkAccess:false,
    externalDataProcessing:false,
    artifactHash:exported.checksum,
    pptdHash:pptd.checksum,
    validation:{
      structuralQaPassed:pptd.validation.structuralQaPassed,
      selfContained:pptd.validation.selfContained,
      visualQaPassed:exported.validation.visualQaPassed,
      zipIntegrityValid:exported.validation.zipIntegrityValid,
      transitionXmlOrderValid:exported.validation.transitionXmlOrderValid,
      pageCount:exported.validation.pageCount,
      renderedSlides:exported.validation.renderedSlides,
      fadeTransitions:exported.validation.fadeTransitions,
      fontParts:exported.validation.fontParts,
      referencedFonts:exported.validation.referencedFonts,
      fontEmbeddingVerified:exported.validation.fontEmbeddingVerified,
      fontCompatibilityTypeface:exported.validation.fontCompatibilityTypeface,
      fontCompatibilityVerified:exported.validation.fontCompatibilityVerified,
    },
  };
  const recordPath = await writeVerificationRecord(record);

  process.stdout.write(`${JSON.stringify({
    schemaVersion:'agent.army/office-presentation-smoke/v2',
    modes:['offline', 'fallback', 'local-export'],
    source:readiness.source,
    localExportSource:readiness.localExport,
    dependencies:readiness.dependencies,
    readiness:readiness.modes,
    offline:{
      status:'passed',
      pageCount:pptd.validation.pageCount,
      structuralQaPassed:pptd.validation.structuralQaPassed,
      selfContained:pptd.validation.selfContained,
      artifactHash:pptd.checksum,
    },
    fallback:{ status:'passed', code:fallbackCode, commands:fallbackCommands, autoInstall:false, networkAccess:false },
    localExport:{
      status:'passed',
      bytes:exported.bytes,
      artifactHash:exported.checksum,
      visualQaPassed:exported.validation.visualQaPassed,
      zipIntegrityValid:exported.validation.zipIntegrityValid,
      pageCount:exported.validation.pageCount,
      renderedSlides:exported.validation.renderedSlides,
      fadeTransitions:exported.validation.fadeTransitions,
      fontParts:exported.validation.fontParts,
      fontEmbeddingVerified:exported.validation.fontEmbeddingVerified,
      fontCompatibilityTypeface:exported.validation.fontCompatibilityTypeface,
      fontCompatibilityVerified:exported.validation.fontCompatibilityVerified,
      evidenceRoot:persistent ? workspace : null,
      projectPath:persistent ? pptd.projectPath : null,
      manifestPath:persistent ? pptd.manifestPath : null,
      qaOverviewPath:persistent ? exported.qaOverviewPath : null,
      pptxPath:persistent ? exported.filePath : null,
      verificationRecord:recordPath,
    },
  }, null, 2)}\n`);
} finally {
  if (!persistent) await fs.rm(workspace, { recursive:true, force:true });
}

async function createEvidenceWorkspace(workspacePath) {
  if (!path.isAbsolute(workspacePath)) throw new Error('本地 PPTX 证据目录必须是绝对路径。');
  const allowedRoot = path.join(os.homedir(), '.agent-army', 'toolchains', 'local-pptx');
  await fs.mkdir(allowedRoot, { recursive:true, mode:0o700 });
  const parent = path.dirname(workspacePath);
  const [realRoot, realParent] = await Promise.all([fs.realpath(allowedRoot), fs.realpath(parent)]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('本地 PPTX 证据目录只能创建在私有 local-pptx 工具链目录。');
  }
  await fs.mkdir(workspacePath, { recursive:false, mode:0o700 });
  return workspacePath;
}

async function writeVerificationRecord(document) {
  const recordPath = String(process.env.AGENT_ARMY_LOCAL_PPTX_VERIFICATION_RECORD || '').trim();
  if (!recordPath) return null;
  if (!path.isAbsolute(recordPath)) throw new Error('本地 PPTX 验证记录必须是绝对路径。');
  const allowedRoot = path.join(os.homedir(), '.agent-army', 'toolchains', 'local-pptx');
  const parent = path.dirname(recordPath);
  const [realRoot, realParent] = await Promise.all([fs.realpath(allowedRoot), fs.realpath(parent)]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('本地 PPTX 验证记录只能写入私有 local-pptx 工具链目录。');
  }
  await fs.writeFile(recordPath, `${JSON.stringify(document, null, 2)}\n`, { flag:'wx', mode:0o600 });
  return recordPath;
}
