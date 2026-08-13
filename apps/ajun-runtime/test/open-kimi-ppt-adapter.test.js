import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenKimiPptAdapter } from '../src/open-kimi-ppt-adapter.js';

const READY = Object.freeze({
  status:'ready',
  source:{ ready:true, packageVersion:'1.0.0', sourceHash:'fixture-hash', issues:[] },
  dependencies:{ ready:true, issues:[], versions:{ node:'v24.0.0', agentBrowser:'0.33.2' } },
  modes:{
    compose:{ status:'ready', externalDataProcessing:false },
    visualQa:{ status:'ready', externalDataProcessing:true },
    export:{ status:'ready', externalDataProcessing:true },
  },
  recovery:null,
});

const PARTIAL = Object.freeze({
  ...READY,
  status:'partial',
  dependencies:{ ready:false, issues:['agent-browser 未安装'], versions:{ node:'v22.0.0', agentBrowser:null } },
  modes:{
    compose:{ status:'ready', externalDataProcessing:false },
    visualQa:{ status:'needs_capability', externalDataProcessing:true },
    export:{ status:'needs_capability', externalDataProcessing:true },
  },
  recovery:'缺少兼容的演示文稿导出能力：agent-browser 未安装。运行时不会自动安装或升级。',
});

test('PPTD 写入生成自包含多页工程，并覆盖中文、表格、图表和本地图片', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptd-'));
  const adapter = adapterWithReadiness(READY);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(24, 1)]);
  const written = await adapter.writePptd({
    access:{ relativePath:'work-products/task-1/presentation/deck.pptd' },
    workspaceRoot:workspace,
    input:{
      title:'季度经营复盘',
      purpose:'向负责人汇报本季度进展',
      audience:'管理层',
      slideCount:4,
      dataClassification:'internal',
      media:[{ name:'trend.png', dataBase64:png.toString('base64') }],
      slides:[
        { title:'关键结论', bullets:['收入增长 12%', '风险仍需跟踪'], image:'trend.png' },
        { title:'指标明细', bullets:['口径一致'], table:[['指标', '结果'], ['收入', '112']] },
        { title:'趋势', bullets:['连续三个周期增长'], chart:{ title:'季度趋势', categories:['Q1', 'Q2', 'Q3'], values:[80, 96, 112] } },
      ],
    },
  });

  assert.equal(written.validation.selfContained, true);
  assert.equal(written.validation.pageCount, 4);
  assert.equal(written.validation.remoteResources, 0);
  const manifest = JSON.parse(await fs.readFile(written.manifestPath, 'utf8'));
  assert.equal(manifest.version, 'v2');
  assert.equal(manifest.pages.length, 4);
  assert.equal((await fs.stat(path.join(path.dirname(written.manifestPath), 'media/trend.png'))).isFile(), true);
  const pages = await Promise.all(written.pagePaths.map((file) => fs.readFile(file, 'utf8')));
  assert.match(pages.join('\n'), /季度经营复盘/);
  assert.match(pages.join('\n'), /"elementType": "table"/);
  assert.match(pages.join('\n'), /"elementType": "chart"/);
  assert.match(await fs.readFile(written.qaPath, 'utf8'), /structural_passed/);
});

test('design_system 应用受控主题令牌，template 缺少来源引用时失败关闭', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptd-design-'));
  const adapter = adapterWithReadiness(READY);
  const written = await adapter.writePptd({
    access:{ relativePath:'design-system/deck.pptd' },
    workspaceRoot:workspace,
    input:{
      title:'品牌汇报',
      designMode:'design_system',
      designTokens:{
        colors:{ primary:'#112233', accent:'#ABCDEF' },
        fonts:{ heading:'PingFang SC', body:'MiSans' },
      },
    },
  });
  const manifest = JSON.parse(await fs.readFile(written.manifestPath, 'utf8'));
  assert.equal(manifest.theme.colors.primary, '#112233');
  assert.equal(manifest.theme.colors.accent, '#ABCDEF');
  assert.equal(manifest.theme.textStyles.title.fontFamily, 'PingFang SC');
  await assert.rejects(
    () => adapter.writePptd({
      access:{ relativePath:'template/deck.pptd' },
      workspaceRoot:workspace,
      input:{ title:'模板汇报', designMode:'template', designTokens:{ colors:{ primary:'#112233' } } },
    }),
    { code:'presentation_design_input_required' },
  );
});

test('PPTD 写入拒绝路径逃逸、远程或伪造媒体、提纲页数漂移和静默覆盖', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptd-safe-'));
  const adapter = adapterWithReadiness(READY);
  await assert.rejects(
    () => adapter.writePptd({ access:{ relativePath:'../deck.pptd' }, workspaceRoot:workspace, input:{ title:'越界' } }),
    { code:'workspace_path_denied' },
  );
  await assert.rejects(
    () => adapter.writePptd({
      access:{ relativePath:'bad-media/deck.pptd' }, workspaceRoot:workspace,
      input:{ title:'媒体', media:[{ name:'remote.png', dataBase64:Buffer.from('not-png').toString('base64') }] },
    }),
    { code:'presentation_media_denied' },
  );
  await assert.rejects(
    () => adapter.writePptd({
      access:{ relativePath:'bad-count/deck.pptd' }, workspaceRoot:workspace,
      input:{ title:'页数', slideCount:6, slides:[{ title:'只有一页' }] },
    }),
    { code:'presentation_outline_mismatch' },
  );
  await adapter.writePptd({ access:{ relativePath:'existing/deck.pptd' }, workspaceRoot:workspace, input:{ title:'第一版' } });
  await assert.rejects(
    () => adapter.writePptd({ access:{ relativePath:'existing/deck.pptd' }, workspaceRoot:workspace, input:{ title:'覆盖版' } }),
    { code:'workspace_file_exists' },
  );
});

test('PPTX 外部处理在分类、批准和兼容依赖门禁前不启动浏览器或安装命令', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-gate-'));
  let commands = 0;
  const adapter = new OpenKimiPptAdapter({
    readinessProbeImpl:async () => PARTIAL,
    runImpl:async () => { commands += 1; throw new Error('不应执行'); },
  });
  await fs.mkdir(path.join(workspace, 'deck'), { recursive:true });
  await fs.writeFile(path.join(workspace, 'deck/deck.pptd'), '{"version":"v2","pages":["pages/01.page"]}\n');
  for (const [input, code] of [
    [{ manifestRelativePath:'deck/deck.pptd', dataClassification:'sensitive', externalProcessingApproved:true }, 'presentation_external_processing_denied'],
    [{ manifestRelativePath:'deck/deck.pptd', dataClassification:'public', externalProcessingApproved:false }, 'presentation_external_processing_approval_required'],
    [{ manifestRelativePath:'deck/deck.pptd', dataClassification:'redacted', externalProcessingApproved:true }, 'presentation_export_needs_capability'],
  ]) {
    await assert.rejects(
      () => adapter.exportPptx({ access:{ relativePath:`deck/${code}.pptx` }, workspaceRoot:workspace, input }),
      { code },
    );
  }
  assert.equal(commands, 0);
});

test('技能导出页面出现白名单外主机时 source readiness 失败关闭', async (t) => {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-ppt-source-'));
  t.after(() => fs.rm(sharedRoot, { recursive:true, force:true }));
  const skillRoot = path.join(sharedRoot, 'open-kimi-ppt-skill');
  await fs.mkdir(path.join(skillRoot, 'skills/open-kimi-ppt/scripts'), { recursive:true });
  await fs.writeFile(path.join(skillRoot, 'package.json'), '{"version":"1.0.0"}\n');
  await fs.writeFile(path.join(skillRoot, 'skills/open-kimi-ppt/SKILL.md'), '# fixture\n');
  await fs.writeFile(path.join(skillRoot, 'skills/open-kimi-ppt/scripts/export_pptx.py'), '# fixture\n');
  await fs.writeFile(path.join(skillRoot, 'skills/open-kimi-ppt/scripts/export_images.py'), '# fixture\n');
  await fs.writeFile(
    path.join(skillRoot, 'skills/open-kimi-ppt/scripts/export_host.html'),
    '<script src="https://statics.moonshot.cn/sdk.js"></script><iframe src="https://www.kimi.com"></iframe><script src="https://evil.example/sdk.js"></script>',
  );
  const adapter = new OpenKimiPptAdapter({
    sharedSkillsRoot:sharedRoot,
    expectedSourceHash:'',
    chromeBinary:'/bin/sh',
    runImpl:async (command, args) => {
      if (args[0] === '--version' && command === 'node') return 'v24.1.0';
      if (args[0] === '--version' && command === 'python3') return 'Python 3.14.0';
      if (args[0] === '-c') return 'ok';
      if (args[0] === '--version' && command === 'agent-browser') return '0.33.2';
      throw new Error('unexpected probe');
    },
  });
  const readiness = await adapter.readiness();
  assert.equal(readiness.source.ready, false);
  assert.equal(readiness.modes.compose.status, 'needs_capability');
  assert.match(readiness.source.issues.join('\n'), /远程主机白名单漂移/);
});

test('兼容依赖就绪时导出只调用固定图片质检和 PPTX 脚本，不使用 force', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-ready-'));
  await fs.mkdir(path.join(workspace, 'deck'), { recursive:true });
  await fs.writeFile(path.join(workspace, 'deck/deck.pptd'), '{"version":"v2","pages":["pages/01.page"]}\n');
  const calls = [];
  let cleaned = false;
  const adapter = new OpenKimiPptAdapter({
    readinessProbeImpl:async () => READY,
    prepareExecutionEnvironmentImpl:async () => ({
      pythonBinary:'/isolated/python3',
      env:{ PATH:'/isolated/bin', PIP_NO_INDEX:'1', PIP_REQUIRE_VIRTUALENV:'1' },
      cleanup:async () => { cleaned = true; },
    }),
    runImpl:async (command, args, options) => {
      calls.push({ command, args, options });
      if (String(args[0]).endsWith('export_images.py')) {
        const output = args[args.indexOf('--output') + 1];
        await fs.mkdir(output, { recursive:true });
        await fs.writeFile(path.join(output, 'overview.jpg'), Buffer.alloc(32, 1));
      }
      if (String(args[0]).endsWith('export_pptx.py')) {
        const output = args[args.indexOf('--output') + 1];
        await fs.writeFile(output, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 2)]));
        return JSON.stringify({ slides:1, fadeTransitions:1, transitionPatchedSlides:1, fontParts:1, bytes:66 });
      }
      return '';
    },
  });
  const result = await adapter.exportPptx({
    access:{ relativePath:'deck/deck.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd', dataClassification:'public', externalProcessingApproved:true },
  });
  assert.equal(result.validation.visualQaPassed, true);
  assert.equal(result.validation.pageCount, 1);
  assert.equal(result.validation.transitionXmlOrderValid, true);
  assert.equal(result.validation.fontEmbeddingVerified, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ command }) => command === '/isolated/python3'), true);
  assert.equal(calls.every(({ options }) => options.env.PIP_REQUIRE_VIRTUALENV === '1'), true);
  assert.equal(calls.flatMap(({ args }) => args).includes('--force'), false);
  assert.equal(cleaned, true);
});

test('临时浏览器故障只安全重试一次并重建适配器自己的 QA 目录', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-retry-'));
  await fs.mkdir(path.join(workspace, 'deck'), { recursive:true });
  await fs.writeFile(path.join(workspace, 'deck/deck.pptd'), '{"version":"v2","pages":["pages/01.page"]}\n');
  let imageAttempts = 0;
  const adapter = new OpenKimiPptAdapter({
    readinessProbeImpl:async () => READY,
    prepareExecutionEnvironmentImpl:async () => ({
      pythonBinary:'/isolated/python3', env:{ PATH:'/isolated/bin' }, cleanup:async () => {},
    }),
    runImpl:async (_command, args) => {
      if (String(args[0]).endsWith('export_images.py')) {
        imageAttempts += 1;
        const directory = args[args.indexOf('--output') + 1];
        await fs.mkdir(directory, { recursive:true });
        if (imageAttempts === 1) {
          await fs.writeFile(path.join(directory, 'partial.tmp'), 'partial');
          throw Object.assign(new Error('browser connection temporarily closed'), { code:'ECONNRESET' });
        }
        assert.equal(await fs.access(path.join(directory, 'partial.tmp')).then(() => true).catch(() => false), false);
        await fs.writeFile(path.join(directory, 'overview.jpg'), Buffer.alloc(32, 1));
        return '';
      }
      const output = args[args.indexOf('--output') + 1];
      await fs.writeFile(output, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 2)]));
      return JSON.stringify({ slides:1, fadeTransitions:1, transitionPatchedSlides:1, fontParts:1 });
    },
  });
  const result = await adapter.exportPptx({
    access:{ relativePath:'deck/deck.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd', dataClassification:'redacted', externalProcessingApproved:true },
  });
  assert.equal(imageAttempts, 2);
  assert.equal(result.attempts, 2);
});

test('结构和权限类导出错误不重试', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-pptx-no-retry-'));
  await fs.mkdir(path.join(workspace, 'deck'), { recursive:true });
  await fs.writeFile(path.join(workspace, 'deck/deck.pptd'), '{"version":"v2","pages":["pages/01.page"]}\n');
  let calls = 0;
  const adapter = new OpenKimiPptAdapter({
    readinessProbeImpl:async () => READY,
    prepareExecutionEnvironmentImpl:async () => ({
      pythonBinary:'/isolated/python3', env:{ PATH:'/isolated/bin' }, cleanup:async () => {},
    }),
    runImpl:async () => {
      calls += 1;
      throw Object.assign(new Error('presentation structure invalid'), { code:'presentation_structure_invalid' });
    },
  });
  await assert.rejects(() => adapter.exportPptx({
    access:{ relativePath:'deck/deck.pptx' }, workspaceRoot:workspace,
    input:{ manifestRelativePath:'deck/deck.pptd', dataClassification:'public', externalProcessingApproved:true },
  }), { code:'presentation_structure_invalid' });
  assert.equal(calls, 1);
});

test('显式空 run 失败关闭，构造后覆写仍由 Adapter 身份动态调用', async () => {
  const disabled = new OpenKimiPptAdapter({ runImpl:null, chromeBinary:'/bin/sh' });
  const disabledReadiness = await disabled.readiness();
  assert.equal(disabledReadiness.dependencies.ready, false);
  assert.match(disabledReadiness.dependencies.issues.join('\n'), /隔离 Node 24\+ 未配置/);

  const adapter = new OpenKimiPptAdapter({ runImpl:async () => { throw new Error('旧实现'); }, chromeBinary:'/bin/sh' });
  const receivers = [];
  adapter.run = async function (command, args) {
    receivers.push(this);
    if (args[0] === '--version' && command === 'node') return 'v24.1.0';
    if (args[0] === '--version' && command === 'python3') return 'Python 3.14.0';
    if (args[0] === '-c') return 'ok';
    if (args[0] === '--version' && command === 'agent-browser') return '0.33.2';
    throw new Error('unexpected probe');
  };
  await adapter.readiness();
  assert.equal(receivers.length, 4);
  assert.equal(receivers.every((receiver) => receiver === adapter), true);
});

function adapterWithReadiness(readiness) {
  return new OpenKimiPptAdapter({ readinessProbeImpl:async () => readiness });
}
