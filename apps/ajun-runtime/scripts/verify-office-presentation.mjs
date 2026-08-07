import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenKimiPptAdapter } from '../src/open-kimi-ppt-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '../test/fixtures/open-kimi-ppt');
const live = process.argv.includes('--live');
const workspace = live
  ? await createLiveEvidenceWorkspace()
  : await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-office-presentation-'));
const adapter = new OpenKimiPptAdapter();

try {
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'presentation.json'), 'utf8'));
  const svg = await fs.readFile(path.join(fixtureRoot, 'agent-army.svg'));
  const readiness = await adapter.readiness();
  assert.equal(readiness.modes.compose.status, 'ready');
  const pptd = await adapter.writePptd({
    access:{ relativePath:'work-products/smoke/presentation/deck.pptd' },
    workspaceRoot:workspace,
    input:{ ...fixture, media:[{ name:'agent-army.svg', dataBase64:svg.toString('base64') }] },
  });
  assert.equal(pptd.validation.structuralQaPassed, true);
  assert.equal(pptd.validation.selfContained, true);

  let fallbackCode = null;
  try {
    await adapter.exportPptx({
      access:{ relativePath:'work-products/smoke/presentation/blocked.pptx' },
      workspaceRoot:workspace,
      input:{
        manifestRelativePath:pptd.manifestRelativePath,
        dataClassification:'sensitive',
        externalProcessingApproved:true,
      },
    });
  } catch (error) {
    fallbackCode = error?.code;
  }
  assert.equal(fallbackCode, 'presentation_external_processing_denied');

  let liveResult = null;
  if (live) {
    if (process.env.AGENT_ARMY_OPEN_KIMI_LIVE_APPROVED !== 'true') {
      throw new Error('--live 需要显式设置 AGENT_ARMY_OPEN_KIMI_LIVE_APPROVED=true；固定样例才会进入 Kimi 公共编辑器。');
    }
    liveResult = await adapter.exportPptx({
      access:{ relativePath:'work-products/smoke/presentation/deck.pptx' },
      workspaceRoot:workspace,
      verificationMode:true,
      input:{
        manifestRelativePath:pptd.manifestRelativePath,
        dataClassification:'public',
        externalProcessingApproved:true,
      },
    });
    await writeLiveVerificationRecord({ readiness, liveResult });
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion:'agent.army/office-presentation-smoke/v1',
    modes:live ? ['offline', 'fallback', 'live-opt-in'] : ['offline', 'fallback'],
    source:readiness.source,
    dependencies:readiness.dependencies,
    liveVerification:readiness.liveVerification,
    readiness:readiness.modes,
    offline:{
      status:'passed',
      pageCount:pptd.validation.pageCount,
      structuralQaPassed:pptd.validation.structuralQaPassed,
      selfContained:pptd.validation.selfContained,
      artifactHash:pptd.checksum,
    },
    fallback:{ status:'passed', code:fallbackCode, autoInstall:false },
    live:liveResult ? {
      status:'passed',
      bytes:liveResult.bytes,
      artifactHash:liveResult.checksum,
      visualQaPassed:liveResult.validation.visualQaPassed,
      evidenceRoot:workspace,
      projectPath:pptd.projectPath,
      manifestPath:pptd.manifestPath,
      qaOverviewPath:liveResult.qaOverviewPath,
      pptxPath:liveResult.filePath,
    } : { status:'not_run', reason:readiness.modes.export.status },
  }, null, 2)}\n`);
} finally {
  if (!live) await fs.rm(workspace, { recursive:true, force:true });
}

async function createLiveEvidenceWorkspace() {
  const workspacePath = String(process.env.AGENT_ARMY_OPEN_KIMI_LIVE_EVIDENCE_DIR || '').trim();
  if (!path.isAbsolute(workspacePath)) {
    throw new Error('--live 需要设置绝对路径 AGENT_ARMY_OPEN_KIMI_LIVE_EVIDENCE_DIR，用于保留公开固定样例证据。');
  }
  const allowedRoot = path.join(os.homedir(), '.agent-army', 'toolchains', 'open-kimi-ppt');
  const parent = path.dirname(workspacePath);
  const [realRoot, realParent] = await Promise.all([fs.realpath(allowedRoot), fs.realpath(parent)]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('live 证据目录只能创建在私有 OpenKimi PPT 工具链目录。');
  }
  await fs.mkdir(workspacePath, { recursive:false, mode:0o700 });
  return workspacePath;
}

async function writeLiveVerificationRecord({ readiness, liveResult }) {
  const recordPath = String(process.env.AGENT_ARMY_OPEN_KIMI_LIVE_VERIFICATION_RECORD || '').trim();
  if (!path.isAbsolute(recordPath)) {
    throw new Error('--live 需要设置绝对路径 AGENT_ARMY_OPEN_KIMI_LIVE_VERIFICATION_RECORD，用于保存不含正文的验证记录。');
  }
  const allowedRoot = path.join(os.homedir(), '.agent-army', 'toolchains', 'open-kimi-ppt');
  const parent = path.dirname(recordPath);
  const [realRoot, realParent] = await Promise.all([fs.realpath(allowedRoot), fs.realpath(parent)]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('live 验证记录只能写入私有 OpenKimi PPT 工具链目录。');
  }
  const document = {
    schemaVersion:'agent.army/open-kimi-ppt-live-verification/v2',
    status:'passed',
    verifiedAt:new Date().toISOString(),
    source:{
      packageVersion:readiness.source?.packageVersion,
      sourceHash:readiness.source?.sourceHash,
    },
    dependencies:{
      node:readiness.dependencies?.versions?.node,
      python:readiness.dependencies?.versions?.python,
      playwright:readiness.dependencies?.versions?.playwright,
      chrome:readiness.dependencies?.versions?.chrome,
    },
    allowedHosts:['www.kimi.com', 'statics.moonshot.cn'],
    artifactHash:liveResult.checksum,
    bytes:liveResult.bytes,
    attempts:liveResult.attempts,
    validation:{
      visualQaPassed:liveResult.validation?.visualQaPassed === true,
      zipIntegrityValid:liveResult.validation?.zipIntegrityValid === true,
      transitionXmlOrderValid:liveResult.validation?.transitionXmlOrderValid === true,
      pageCount:liveResult.validation?.pageCount,
      fadeTransitions:liveResult.validation?.fadeTransitions,
      fontParts:liveResult.validation?.fontParts,
    },
  };
  await fs.writeFile(recordPath, `${JSON.stringify(document, null, 2)}\n`, { flag:'wx', mode:0o600 });
}
