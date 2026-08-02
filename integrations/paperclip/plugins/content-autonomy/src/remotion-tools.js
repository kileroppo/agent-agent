import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { M5_PLATFORM_IDS } from '@agent-army/m5-contracts';
import { coded, safeRelativePath, sha256 } from './policy.js';

const defaultExecuteFile = promisify(execFile);
const M5_DURATION_FRAMES = 45 * 30;
const COMPOSITIONS = Object.freeze({
  M5Master:{ platform:'master', fileName:'master.mp4' },
  M5Douyin:{ platform:M5_PLATFORM_IDS.DOUYIN, fileName:'douyin.mp4' },
  M5Xiaohongshu:{ platform:M5_PLATFORM_IDS.XIAOHONGSHU, fileName:'xiaohongshu.mp4' }
});
const DEFAULT_RENDERER_SCRIPT = fileURLToPath(new URL(
  '../../../../../apps/animated-chart/scripts/render-m5-controlled.mjs',
  import.meta.url
));

export async function writeM5RenderProps(ctx, params, run) {
  const definition = COMPOSITIONS[params.composition];
  if (!definition) throw coded('remotion_composition_denied', '只允许 M5Master、M5Douyin 或 M5Xiaohongshu。');
  const output = await writableWorkspacePath(ctx, run.companyId, params.outputPath);
  if (!/\.props\.json$/i.test(output.relative)) {
    throw coded('remotion_props_output_denied', 'Remotion props 只能写入 .props.json。');
  }
  const props = structuredClone(params.props);
  const validation = validateM5RenderProps(props, params.composition);
  if (!validation.passed) throw coded('remotion_props_invalid', validation.errors.join(' '));
  await validateReferencedAssets(output.root, props);
  const encoded = Buffer.from(`${JSON.stringify(props, null, 2)}\n`, 'utf8');
  await atomicWriteFile(output.absolute, encoded);
  const readBack = await fs.readFile(output.absolute);
  if (!readBack.equals(encoded)) throw coded('remotion_props_write_failed', 'Remotion props 写回校验失败。');
  return {
    content:'受控 Remotion props 已写入内容工作区。',
    data:{
      composition:params.composition,
      propsPath:output.relative,
      checksum:sha256(readBack),
      bytes:readBack.length,
      subtitleLayout:validation.subtitleLayout,
    },
  };
}

export async function renderM5Composition(ctx, params, _run, options = {}) {
  const definition = COMPOSITIONS[params.composition];
  if (!definition) throw coded('remotion_composition_denied', '只允许 M5Master、M5Douyin 或 M5Xiaohongshu。');
  const input = await existingWorkspacePath(ctx, _run.companyId, params.propsPath);
  const output = await writableWorkspacePath(ctx, _run.companyId, params.outputPath);
  if (path.basename(output.relative) !== definition.fileName) {
    throw coded('remotion_output_denied', `${params.composition} 只能输出 ${definition.fileName}。`);
  }
  const props = parseJson(await fs.readFile(input.absolute, 'utf8'), 'remotion_props_invalid', 'Remotion props 不是有效 JSON。');
  const validation = validateM5RenderProps(props, params.composition);
  if (!validation.passed) throw coded('remotion_props_invalid', validation.errors.join(' '));
  await validateReferencedAssets(input.root, props);

  const rendererScript = await resolveRendererScript(options.rendererScript || DEFAULT_RENDERER_SCRIPT);
  const temporary = `${output.absolute}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`;
  const execute = options.executeFile || defaultExecuteFile;
  try {
    await execute(process.execPath, [
      rendererScript,
      '--composition', params.composition,
      '--props', input.absolute,
      '--output', temporary,
      '--public-dir', input.root
    ], {
      cwd:path.dirname(path.dirname(rendererScript)),
      timeout:20 * 60_000,
      maxBuffer:2_000_000
    });
    const bytes = await fs.readFile(temporary);
    if (!bytes.length) throw coded('remotion_render_empty', 'Remotion 没有生成视频数据。');
    await replaceFile(temporary, output.absolute);
    return {
      content:'受控 Remotion 成片已写入内容工作区。',
      data:{
        composition:params.composition,
        propsPath:input.relative,
        outputPath:output.relative,
        checksum:sha256(bytes),
        bytes:bytes.length,
        subtitleLayout:validation.subtitleLayout,
        command:{
          executable:'node',
          profile:'m5-remotion-controlled-v1',
          composition:params.composition
        }
      }
    };
  } catch (error) {
    await fs.rm(temporary, { force:true });
    if (error?.code && String(error.code).startsWith('remotion_')) throw error;
    throw coded('remotion_render_failed', `受控 Remotion 渲染失败：${String(error?.code || 'renderer_error')}。`);
  }
}

export async function validateSubtitleLayoutFromProps(ctx, params, run) {
  const input = await existingWorkspacePath(ctx, run.companyId, params.propsPath);
  const props = parseJson(await fs.readFile(input.absolute, 'utf8'), 'remotion_props_invalid', 'Remotion props 不是有效 JSON。');
  const result = validateSubtitleLayout(props.captions);
  return {
    content:result.passed ? '字幕布局门禁通过。' : '字幕布局门禁未通过。',
    data:{ ...result, propsPath:input.relative }
  };
}

export function validateM5RenderProps(props, composition) {
  const errors = [];
  const definition = COMPOSITIONS[composition];
  if (!definition) return { passed:false, errors:['Composition 不在白名单。'], subtitleLayout:null };
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return { passed:false, errors:['Remotion props 必须是对象。'], subtitleLayout:null };
  }
  if (props.platform !== definition.platform) errors.push('props.platform 与 Composition 不匹配。');
  if (!boundedText(props.title, 1, 80)) errors.push('标题长度必须是 1–80 个字符。');
  if (!boundedText(props.subtitle, 1, 120)) errors.push('副标题长度必须是 1–120 个字符。');
  if (!boundedText(props.sourceLabel, 1, 80)) errors.push('来源标签长度必须是 1–80 个字符。');
  const assetLedger = Array.isArray(props.assetLedger) ? props.assetLedger : [];
  if (
    assetLedger.length < 1
    || assetLedger.length > 12
    || assetLedger.some((asset) =>
      !safeAssetPath(asset?.relativePath)
      || !/^sha256:[0-9a-f]{64}$/i.test(String(asset?.checksum || '')),
    )
  ) {
    errors.push('真实画面素材账本必须包含 1–12 个相对路径和 sha256。');
  }
  const assetPaths = new Set(assetLedger.map((asset) => String(asset.relativePath || '')));
  if (!safeAssetPath(props.coverSrc) || !assetPaths.has(props.coverSrc)) {
    errors.push('封面必须绑定真实画面素材账本。');
  }
  if (props.voiceoverSrc != null) {
    if (
      !safeAudioPath(props.voiceoverSrc)
      || !/^sha256:[0-9a-f]{64}$/i.test(String(props.voiceoverChecksum || ''))
    ) {
      errors.push('旁白必须包含受控工作区内的音频相对路径和 sha256。');
    }
  } else if (props.voiceoverChecksum != null) {
    errors.push('未提供旁白时不能单独提供 voiceoverChecksum。');
  }
  if (!Array.isArray(props.scenes) || props.scenes.length < 1 || props.scenes.length > 12) {
    errors.push('场景数量必须是 1–12。');
  } else {
    for (const [index, scene] of props.scenes.entries()) {
      if (!boundedText(scene?.id, 1, 80) || !Number.isInteger(scene?.startFrame) || scene.startFrame < 0
        || !Number.isInteger(scene?.durationInFrames) || scene.durationInFrames < 1
        || scene.startFrame + scene.durationInFrames > M5_DURATION_FRAMES
        || !boundedText(scene?.headline, 1, 80) || !boundedText(scene?.body, 1, 240)
        || !safeAssetPath(scene?.imageSrc) || !assetPaths.has(scene.imageSrc)) {
        errors.push(`第 ${index + 1} 个场景字段无效。`);
      }
    }
  }
  const subtitleLayout = validateSubtitleLayout(props.captions);
  if (!subtitleLayout.passed) errors.push(...subtitleLayout.errors);
  return { passed:errors.length === 0, errors, subtitleLayout };
}

export function validateSubtitleLayout(captions) {
  const errors = [];
  if (!Array.isArray(captions) || captions.length < 1 || captions.length > 100) {
    return { passed:false, errors:['字幕数量必须是 1–100。'], checkedCaptions:0 };
  }
  let previousEnd = 0;
  for (const [index, caption] of captions.entries()) {
    const text = String(caption?.text || '');
    const lines = text.split('\n');
    if (!Number.isInteger(caption?.startFrame) || !Number.isInteger(caption?.endFrame)
      || caption.startFrame < 0 || caption.endFrame <= caption.startFrame) {
      errors.push(`第 ${index + 1} 条字幕时间范围无效。`);
    }
    if (caption.endFrame > M5_DURATION_FRAMES) errors.push(`第 ${index + 1} 条字幕超出固定成片范围。`);
    if (caption.startFrame < previousEnd) errors.push(`第 ${index + 1} 条字幕与上一条重叠。`);
    previousEnd = Number.isInteger(caption?.endFrame) ? caption.endFrame : previousEnd;
    if (!text.trim()) errors.push(`第 ${index + 1} 条字幕为空。`);
    if (lines.length > 3) errors.push(`第 ${index + 1} 条字幕超过 3 行。`);
    if (lines.some((line) => displayUnits(line) > 28)) errors.push(`第 ${index + 1} 条字幕单行超过安全宽度。`);
    if (displayUnits(text.replaceAll('\n', '')) > 72) errors.push(`第 ${index + 1} 条字幕总长度超过安全区域。`);
  }
  return { passed:errors.length === 0, errors, checkedCaptions:captions.length };
}

async function validateReferencedAssets(root, props) {
  const references = [
    props.voiceoverSrc,
    props.coverSrc,
    ...(props.scenes || []).map((scene) => scene.imageSrc)
  ].filter(Boolean);
  for (const reference of references) {
    const relative = safeRelativePath(reference);
    const absolute = await fs.realpath(path.resolve(root, relative)).catch(() => null);
    if (!absolute || !absolute.startsWith(`${root}${path.sep}`)) {
      throw coded('remotion_asset_denied', 'Remotion 素材不存在或通过符号链接逃逸工作区。');
    }
  }
  for (const asset of props.assetLedger || []) {
    const relative = safeRelativePath(asset.relativePath);
    const absolute = await fs.realpath(path.resolve(root, relative)).catch(() => null);
    if (!absolute || !absolute.startsWith(`${root}${path.sep}`)) {
      throw coded('remotion_asset_denied', 'Remotion 素材账本路径不存在或逃逸工作区。');
    }
    const bytes = await fs.readFile(absolute);
    if (sha256(bytes) !== String(asset.checksum || '').toLowerCase()) {
      throw coded('remotion_asset_checksum_mismatch', 'Remotion 画面素材哈希与 AssetPackage 不一致。');
    }
  }
  if (props.voiceoverSrc) {
    const relative = safeRelativePath(props.voiceoverSrc);
    const absolute = await fs.realpath(path.resolve(root, relative)).catch(() => null);
    if (!absolute || !absolute.startsWith(`${root}${path.sep}`)) {
      throw coded('remotion_asset_denied', 'Remotion 旁白不存在或逃逸工作区。');
    }
    const bytes = await fs.readFile(absolute);
    if (sha256(bytes) !== String(props.voiceoverChecksum || '').toLowerCase()) {
      throw coded('remotion_asset_checksum_mismatch', 'Remotion 旁白哈希与 StepFun TTS 产物不一致。');
    }
  }
}

async function resolveRendererScript(configured) {
  const script = await fs.realpath(configured).catch(() => null);
  if (!script || script !== path.resolve(configured)) {
    throw coded('remotion_renderer_unavailable', '固定 Remotion 渲染脚本不可用；禁止复制或回退到任意命令。');
  }
  return script;
}

async function workspaceRoot(ctx, companyId, writable = false) {
  const status = await ctx.localFolders.status(companyId, 'content-workspace');
  if (!status.healthy || !status.realPath || (writable && !status.writable)) {
    throw coded('content_workspace_unavailable', writable ? '内容生产工作区不可写。' : '内容生产工作区尚未配置。');
  }
  return fs.realpath(status.realPath);
}

async function existingWorkspacePath(ctx, companyId, relativePath) {
  const root = await workspaceRoot(ctx, companyId);
  const relative = safeRelativePath(relativePath);
  const absolute = await fs.realpath(path.resolve(root, relative));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw coded('symlink_escape', 'Remotion 输入路径逃逸工作区。');
  return { root, absolute, relative };
}

async function writableWorkspacePath(ctx, companyId, relativePath) {
  const root = await workspaceRoot(ctx, companyId, true);
  const relative = safeRelativePath(relativePath);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw coded('path_escape', 'Remotion 输出路径逃逸工作区。');
  await fs.mkdir(path.dirname(candidate), { recursive:true });
  const parent = await fs.realpath(path.dirname(candidate));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw coded('symlink_escape', 'Remotion 输出目录逃逸工作区。');
  return { root, absolute:path.join(parent, path.basename(candidate)), relative };
}

async function atomicWriteFile(destination, bytes) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode:0o600, flag:'wx' });
    await replaceFile(temporary, destination);
  } finally {
    await fs.rm(temporary, { force:true });
  }
}

async function replaceFile(source, destination) {
  await fs.rename(source, destination);
  await fs.chmod(destination, 0o600);
}

function parseJson(text, code, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw coded(code, message);
  }
}

function boundedText(value, minimum, maximum) {
  const text = String(value || '').trim();
  return [...text].length >= minimum && [...text].length <= maximum;
}

function safeAssetPath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(text)
    && !text.startsWith('/')
    && text.split('/').every((part) => part && part !== '.' && part !== '..')
    && /\.(?:jpe?g|png|webp)$/i.test(text);
}

function safeAudioPath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(text)
    && !text.startsWith('/')
    && text.split('/').every((part) => part && part !== '.' && part !== '..')
    && /\.(?:mp3|wav|m4a|aac)$/i.test(text);
}

function displayUnits(value) {
  return [...String(value || '')].reduce((sum, character) =>
    sum + (/[\u0000-\u00ff]/.test(character) ? 0.55 : 1), 0);
}
