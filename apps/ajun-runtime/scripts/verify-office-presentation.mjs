import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenKimiPptAdapter } from '../src/open-kimi-ppt-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '../test/fixtures/open-kimi-ppt');
const live = process.argv.includes('--live');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-office-presentation-'));
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
      input:{
        manifestRelativePath:pptd.manifestRelativePath,
        dataClassification:'public',
        externalProcessingApproved:true,
      },
    });
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion:'agent.army/office-presentation-smoke/v1',
    modes:live ? ['offline', 'fallback', 'live-opt-in'] : ['offline', 'fallback'],
    source:readiness.source,
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
    } : { status:'not_run', reason:readiness.modes.export.status },
  }, null, 2)}\n`);
} finally {
  await fs.rm(workspace, { recursive:true, force:true });
}
