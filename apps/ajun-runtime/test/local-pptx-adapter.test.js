import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalPptxAdapter, OfficePresentationAdapter } from '../src/local-pptx-adapter.js';

const READY = Object.freeze({
  status:'ready',
  source:{ ready:true, adapter:'local-pptx', version:'1.0.0', sourceHash:'fixture', issues:[] },
  dependencies:{ ready:true, versions:{ node:'24.14.0', artifactTool:'2.8.39', jszip:'3.10.1', sharp:'0.34.5' }, issues:[], autoInstall:false, networkAccess:false },
  modes:{
    visualQa:{ status:'ready', externalDataProcessing:false },
    export:{ status:'ready', externalDataProcessing:false },
  },
  recovery:null,
});

test('本地 PPTX 导出只写当前工作区，返回逐页渲染、ZIP、fade 和字体摘要', async (t) => {
  const workspace = await fixtureWorkspace('local-pptx-ready-');
  t.after(() => fs.rm(workspace, { recursive:true, force:true }));
  const calls = [];
  const adapter = new LocalPptxAdapter({
    readinessProbeImpl:async () => READY,
    runImpl:async (_command, args, options) => {
      calls.push({ args, options });
      if (args.includes('--workspace')) return 'ready';
      const output = args[args.indexOf('--output') + 1];
      const qa = args[args.indexOf('--qa-dir') + 1];
      await fs.mkdir(qa, { recursive:true });
      await fs.writeFile(path.join(qa, 'overview.jpg'), Buffer.alloc(32, 1));
      await fs.writeFile(output, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 2)]));
      return `internal setup output\n${JSON.stringify({
        schemaVersion:'agent.army/local-pptx-export/v1',
        status:'passed',
        slides:1,
        renderedSlides:1,
        fadeTransitions:1,
        transitionPatchedSlides:1,
        transitionXmlOrderValid:true,
        zipIntegrityValid:true,
        fontParts:0,
        referencedFonts:['Arial Unicode MS'],
        fontEmbeddingVerified:false,
        fontCompatibilityTypeface:'Arial Unicode MS',
        fontCompatibilityVerified:true,
      })}\n`;
    },
  });
  const result = await adapter.exportPptx({
    access:{ relativePath:'deck/deck.pptx' },
    workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd', dataClassification:'sensitive' },
  });
  assert.equal(result.validation.localOnly, true);
  assert.equal(result.validation.externalDataProcessing, false);
  assert.equal(result.validation.visualQaPassed, true);
  assert.equal(result.validation.pageCount, 1);
  assert.equal(result.validation.fadeTransitions, 1);
  assert.equal(result.validation.transitionXmlOrderValid, true);
  assert.equal(result.validation.fontEmbeddingVerified, false);
  assert.deepEqual(result.validation.referencedFonts, ['Arial Unicode MS']);
  assert.equal(result.validation.fontCompatibilityVerified, true);
  assert.equal(result.qaOverviewRelativePath, 'deck/qa/local-pptx/overview.jpg');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.env.npm_config_offline, 'true');
  assert.equal(calls[1].options.env.HTTP_PROXY, null);
  assert.equal((await fs.readdir(path.join(workspace, 'deck'))).some((name) => name.startsWith('.local-pptx-runtime-')), false);
});

test('本地 PPTX 导出拒绝路径逃逸、符号链接和目标覆盖', async (t) => {
  const workspace = await fixtureWorkspace('local-pptx-safe-');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'local-pptx-outside-'));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive:true, force:true }),
    fs.rm(outside, { recursive:true, force:true }),
  ]));
  const adapter = new LocalPptxAdapter({ readinessProbeImpl:async () => READY, runImpl:async () => '' });
  await assert.rejects(() => adapter.exportPptx({
    access:{ relativePath:'../outside.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd' },
  }), { code:'workspace_path_denied' });
  await fs.symlink(path.join(workspace, 'deck/deck.pptd'), path.join(workspace, 'deck/link.pptd'));
  await assert.rejects(() => adapter.exportPptx({
    access:{ relativePath:'deck/link-output.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/link.pptd' },
  }), { code:'presentation_source_invalid' });
  await fs.writeFile(path.join(workspace, 'deck/existing.pptx'), 'already');
  await assert.rejects(() => adapter.exportPptx({
    access:{ relativePath:'deck/existing.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd' },
  }), { code:'workspace_file_exists' });
});

test('本地导出失败会清理适配器创建的临时目录和不完整产物且不重试', async (t) => {
  const workspace = await fixtureWorkspace('local-pptx-failure-');
  t.after(() => fs.rm(workspace, { recursive:true, force:true }));
  let calls = 0;
  const adapter = new LocalPptxAdapter({
    readinessProbeImpl:async () => READY,
    runImpl:async (_command, args) => {
      calls += 1;
      if (args.includes('--workspace')) return 'ready';
      const output = args[args.indexOf('--output') + 1];
      const qa = args[args.indexOf('--qa-dir') + 1];
      await fs.mkdir(qa, { recursive:true });
      await fs.writeFile(output, 'partial');
      throw Object.assign(new Error('failed'), { code:'local_pptx_command_failed' });
    },
  });
  await assert.rejects(() => adapter.exportPptx({
    access:{ relativePath:'deck/deck.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd' },
  }), { code:'presentation_export_failed' });
  assert.equal(calls, 2);
  assert.equal(await fs.access(path.join(workspace, 'deck/deck.pptx')).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(path.join(workspace, 'deck/qa/local-pptx')).then(() => true).catch(() => false), false);
  assert.equal((await fs.readdir(path.join(workspace, 'deck'))).some((name) => name.startsWith('.local-pptx-runtime-')), false);
});

test('组合适配器保持 PPTD 来源并把本地 visualQa/export 标为无外部处理 ready', async () => {
  const pptdAdapter = {
    async readiness() {
      return {
        status:'partial',
        source:{ ready:true, packageVersion:'1.0.0', sourceHash:'pptd-source' },
        modes:{ compose:{ status:'ready', externalDataProcessing:false }, visualQa:{ status:'needs_capability' }, export:{ status:'needs_capability' } },
        recovery:'Kimi 不可用',
      };
    },
    async writePptd() { return { ok:true }; },
  };
  const combined = new OfficePresentationAdapter({
    pptdAdapter,
    pptxAdapter:new LocalPptxAdapter({ readinessProbeImpl:async () => READY }),
  });
  const readiness = await combined.readiness();
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.source.sourceHash, 'pptd-source');
  assert.equal(readiness.modes.compose.status, 'ready');
  assert.equal(readiness.modes.visualQa.status, 'ready');
  assert.equal(readiness.modes.export.status, 'ready');
  assert.equal(readiness.modes.export.externalDataProcessing, false);
  assert.equal(readiness.recovery, null);
});

test('显式非函数 run 失败关闭，构造后覆写仍由 Adapter 身份动态调用', async () => {
  const disabled = new LocalPptxAdapter({ runImpl:null });
  const disabledReadiness = await disabled.readiness();
  assert.equal(disabledReadiness.dependencies.ready, false);
  assert.match(disabledReadiness.dependencies.issues.join('\n'), /隔离 Node 不可用/);

  const adapter = new LocalPptxAdapter({ runImpl:'disabled' });
  const receivers = [];
  adapter.run = async function () {
    receivers.push(this);
    return 'v24.14.0';
  };
  await adapter.readiness();
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0], adapter);
});

async function fixtureWorkspace(prefix) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(workspace, 'deck'), { recursive:true });
  await fs.writeFile(path.join(workspace, 'deck/deck.pptd'), `${JSON.stringify({
    version:'v2', size:[960, 540], pages:['pages/01.page'],
  })}\n`);
  return workspace;
}
