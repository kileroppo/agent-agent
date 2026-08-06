#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compositionPlatforms = Object.freeze({
  M5Master:'master',
  M5Douyin:'douyin',
  M5Xiaohongshu:'xiaohongshu'
});

const args = parseArgs(process.argv.slice(2));
const publicRoot = await fs.realpath(args.publicDir);
const propsPath = await containedExistingPath(publicRoot, args.props);
const outputPath = await containedWritablePath(publicRoot, args.output);
const props = JSON.parse(await fs.readFile(propsPath, 'utf8'));
if (props?.platform !== compositionPlatforms[args.composition]) {
  fail('controlled_props_mismatch', 'props.platform 与固定 Composition 不匹配。');
}
assertRelativeAssets(props);
const remotionBinary = await fs.realpath(path.join(appRoot, 'node_modules/.bin/remotion')).catch(() => null);
if (!remotionBinary || !remotionBinary.startsWith(`${appRoot}${path.sep}`)) {
  fail('controlled_renderer_unavailable', '固定 Remotion CLI 不可用。');
}

await executeFile(remotionBinary, [
  'render',
  'src/index.ts',
  args.composition,
  outputPath,
  `--props=${propsPath}`,
  '--codec=h264',
  '--crf=25',
  '--concurrency=4',
  `--public-dir=${publicRoot}`,
  '--log=error'
], {
  cwd:appRoot,
  timeout:20 * 60_000,
  maxBuffer:2_000_000
});
process.stdout.write(`${JSON.stringify({ ok:true, composition:args.composition })}\n`);

function parseArgs(values) {
  const parsed = { composition:'', props:'', output:'', publicDir:'' };
  const mapping = {
    '--composition':'composition',
    '--props':'props',
    '--output':'output',
    '--public-dir':'publicDir'
  };
  for (let index = 0; index < values.length; index += 2) {
    const key = mapping[values[index]];
    const value = values[index + 1];
    if (!key || !value) fail('controlled_argument_denied', '受控渲染只接受固定参数。');
    parsed[key] = value;
  }
  if (!compositionPlatforms[parsed.composition]) fail('controlled_composition_denied', 'Composition 不在白名单。');
  if (!path.isAbsolute(parsed.props) || !path.isAbsolute(parsed.output) || !path.isAbsolute(parsed.publicDir)) {
    fail('controlled_path_required', '受控渲染路径必须由插件解析为绝对路径。');
  }
  return parsed;
}

async function containedExistingPath(root, value) {
  const resolved = await fs.realpath(value).catch(() => null);
  if (!resolved || !resolved.startsWith(`${root}${path.sep}`)) fail('controlled_path_denied', '输入路径逃逸工作区。');
  return resolved;
}

async function containedWritablePath(root, value) {
  if (!/\.mp4$/i.test(value)) fail('controlled_output_denied', '输出必须是 MP4。');
  await fs.mkdir(path.dirname(value), { recursive:true });
  const parent = await fs.realpath(path.dirname(value));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) fail('controlled_path_denied', '输出路径逃逸工作区。');
  return path.join(parent, path.basename(value));
}

function assertRelativeAssets(props) {
  const references = [
    props.voiceoverSrc,
    props.coverSrc,
    ...(Array.isArray(props.scenes) ? props.scenes.map((scene) => scene.imageSrc) : [])
  ].filter(Boolean);
  for (const value of references) {
    const text = String(value).replaceAll('\\', '/');
    if (!text || text.startsWith('/') || text.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('controlled_asset_denied', '素材引用必须是工作区相对路径。');
    }
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
