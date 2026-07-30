import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  renderM5Composition,
  writeM5RenderProps,
  validateSubtitleLayout
} from '../src/remotion-tools.js';
import { sha256 } from '../src/policy.js';

const run = {
  agentId:'11111111-1111-4111-8111-111111111111',
  runId:'22222222-2222-4222-8222-222222222222',
  companyId:'33333333-3333-4333-8333-333333333333',
  projectId:'44444444-4444-4444-8444-444444444444'
};

test('受控Remotion工具只调用固定脚本与Composition并写回工作区', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-tool-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'day-1'), { recursive:true });
  await writeVerifiedFrame(root);
  await fs.writeFile(path.join(root, 'day-1/master.props.json'), JSON.stringify(validProps('master')));
  const calls = [];
  const result = await renderM5Composition(workspaceContext(root), {
    composition:'M5Master',
    propsPath:'day-1/master.props.json',
    outputPath:'day-1/master.mp4'
  }, run, {
    executeFile:async (executable, args) => {
      calls.push({ executable, args });
      const output = args[args.indexOf('--output') + 1];
      await fs.writeFile(output, 'controlled-render');
      return { stdout:'', stderr:'' };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.match(calls[0].args[0], /apps\/animated-chart\/scripts\/render-m5-controlled\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1, 3), ['--composition', 'M5Master']);
  assert.equal(calls[0].args.includes('; rm -rf'), false);
  assert.equal(result.data.outputPath, 'day-1/master.mp4');
  assert.equal(result.data.checksum, sha256(Buffer.from('controlled-render')));
  assert.deepEqual(result.data.command, {
    executable:'node',
    profile:'m5-remotion-controlled-v1',
    composition:'M5Master'
  });
});

test('受控 props 写入先校验固定 schema、相对素材与写回哈希', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-props-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeVerifiedFrame(root);
  const result = await writeM5RenderProps(workspaceContext(root), {
    composition:'M5Master',
    outputPath:'day-1/master.props.json',
    props:validProps('master'),
  }, run);
  const bytes = await fs.readFile(path.join(root, result.data.propsPath));
  assert.equal(result.data.checksum, sha256(bytes));
  assert.equal(result.data.subtitleLayout.passed, true);
  await assert.rejects(
    writeM5RenderProps(workspaceContext(root), {
      composition:'M5Master',
      outputPath:'../escape.props.json',
      props:validProps('master'),
    }, run),
    { code:'invalid_relative_path' },
  );
});

test('受控 props 写入替换末级软链且不改写工作区外目标', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-props-link-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-props-outside-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  context.after(() => fs.rm(outsideRoot, { recursive:true, force:true }));
  await writeVerifiedFrame(root);
  await fs.mkdir(path.join(root, 'day-1'), { recursive:true });
  const outsideTarget = path.join(outsideRoot, 'must-not-change.json');
  await fs.writeFile(outsideTarget, 'outside-unchanged');
  const destination = path.join(root, 'day-1/master.props.json');
  await fs.symlink(outsideTarget, destination);

  await writeM5RenderProps(workspaceContext(root), {
    composition:'M5Master',
    outputPath:'day-1/master.props.json',
    props:validProps('master'),
  }, run);

  assert.equal(await fs.readFile(outsideTarget, 'utf8'), 'outside-unchanged');
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
});

test('受控Remotion工具拒绝 props 写入后被替换的素材', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-tampered-asset-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'day-1'), { recursive:true });
  await writeVerifiedFrame(root);
  await fs.writeFile(path.join(root, 'day-1/master.props.json'), JSON.stringify(validProps('master')));
  await fs.writeFile(path.join(root, 'assets/frame-001.png'), 'tampered-frame');

  await assert.rejects(
    renderM5Composition(workspaceContext(root), {
      composition:'M5Master',
      propsPath:'day-1/master.props.json',
      outputPath:'day-1/master.mp4',
    }, run, {
      executeFile:async () => {
        throw new Error('素材哈希不一致时不应启动渲染器');
      },
    }),
    { code:'remotion_asset_checksum_mismatch' },
  );
});

test('受控Remotion工具把旁白路径和StepFun TTS哈希绑定到渲染', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-voiceover-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'day-1'), { recursive:true });
  await writeVerifiedFrame(root);
  const voiceover = Buffer.from('verified-voiceover');
  await fs.writeFile(path.join(root, 'voice.mp3'), voiceover);
  const props = {
    ...validProps('master'),
    voiceoverSrc:'voice.mp3',
    voiceoverChecksum:sha256(voiceover),
  };
  await fs.writeFile(path.join(root, 'day-1/master.props.json'), JSON.stringify(props));
  await fs.writeFile(path.join(root, 'voice.mp3'), 'tampered-voiceover');

  await assert.rejects(
    renderM5Composition(workspaceContext(root), {
      composition:'M5Master',
      propsPath:'day-1/master.props.json',
      outputPath:'day-1/master.mp4',
    }, run, {
      executeFile:async () => {
        throw new Error('旁白哈希不一致时不应启动渲染器');
      },
    }),
    { code:'remotion_asset_checksum_mismatch' },
  );
});

test('受控Remotion工具拒绝任意Composition、越界输出和缺失固定渲染器', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-remotion-deny-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'day-1'), { recursive:true });
  await writeVerifiedFrame(root);
  await fs.writeFile(path.join(root, 'day-1/master.props.json'), JSON.stringify(validProps('master')));
  const ctx = workspaceContext(root);
  const base = { propsPath:'day-1/master.props.json', outputPath:'day-1/master.mp4' };
  await assert.rejects(
    renderM5Composition(ctx, { ...base, composition:'UserSuppliedComposition' }, run),
    { code:'remotion_composition_denied' }
  );
  await assert.rejects(
    renderM5Composition(ctx, { ...base, composition:'M5Master', outputPath:'../master.mp4' }, run),
    { code:'invalid_relative_path' }
  );
  await assert.rejects(
    renderM5Composition(ctx, { ...base, composition:'M5Master' }, run, {
      rendererScript:path.join(root, 'missing-renderer.mjs')
    }),
    { code:'remotion_renderer_unavailable' }
  );
});

test('字幕布局门禁拒绝重叠、超过三行和单行溢出', () => {
  const valid = validateSubtitleLayout([{
    startFrame:0,
    endFrame:90,
    text:'真实工具结果必须进入下一步。'
  }]);
  assert.equal(valid.passed, true);
  const invalid = validateSubtitleLayout([
    {
      startFrame:0,
      endFrame:90,
      text:'这是一条明显超过竖屏字幕安全宽度而且没有主动换行的超长字幕内容'
    },
    {
      startFrame:80,
      endFrame:150,
      text:'第一行\n第二行\n第三行\n第四行'
    },
    {
      startFrame:150,
      endFrame:1400,
      text:'这条字幕超过固定四十五秒成片。'
    }
  ]);
  assert.equal(invalid.passed, false);
  assert.match(invalid.errors.join('\n'), /安全宽度/);
  assert.match(invalid.errors.join('\n'), /重叠/);
  assert.match(invalid.errors.join('\n'), /超过 3 行/);
  assert.match(invalid.errors.join('\n'), /成片范围/);
});

function validProps(platform) {
  return {
    platform,
    title:'AI Agent 实战',
    subtitle:'从目标到真实产物',
    coverSrc:'assets/frame-001.png',
    assetLedger:[{
      relativePath:'assets/frame-001.png',
      checksum:sha256(Buffer.from('verified-frame')),
    }],
    scenes:[{
      id:'hook',
      startFrame:0,
      durationInFrames:450,
      headline:'Agent 不只会说',
      body:'真实工具结果必须进入下一步。',
      evidenceRef:'M5 / Observation',
      imageSrc:'assets/frame-001.png',
    }],
    captions:[{
      startFrame:0,
      endFrame:450,
      text:'真实工具结果必须进入下一步。'
    }],
    sourceLabel:'Agent军团 · M5'
  };
}

async function writeVerifiedFrame(root) {
  await fs.mkdir(path.join(root, 'assets'), { recursive:true });
  await fs.writeFile(path.join(root, 'assets/frame-001.png'), 'verified-frame');
}

function workspaceContext(root) {
  return {
    localFolders:{
      status:async () => ({ healthy:true, writable:true, realPath:root })
    }
  };
}
