import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FAST_FRAME_LIMIT = 12;
const FULL_FRAME_LIMIT = 48;
const STORYBOARD_SIZE = 12;

export class VisualEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualEvidenceError';
    this.code = code;
  }
}

export async function createVisualEvidencePackage({
  videoPath,
  outputDir,
  depth = 'fast',
  transcriptSegments = [],
  sourceMetadata = null,
  run = runCommand
} = {}) {
  const startedAt = Date.now();
  const resolvedVideo = path.resolve(String(videoPath || ''));
  const resolvedOutput = path.resolve(String(outputDir || ''));
  if (!resolvedVideo || !resolvedOutput) throw new VisualEvidenceError('visual_input_required', '缺少视频或输出目录。');
  await fs.access(resolvedVideo);
  await fs.mkdir(resolvedOutput, { recursive:true, mode:0o700 });
  const probe = await probeVideo(resolvedVideo, run);
  if (!probe.hasVideo || !Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw new VisualEvidenceError('visual_video_stream_required', '素材没有可分析的视频画面。');
  }

  const maxFrames = depth === 'full' ? FULL_FRAME_LIMIT : FAST_FRAME_LIMIT;
  const sceneTimes = await detectSceneTimes(resolvedVideo, run);
  const candidates = selectFrameCandidates({
    durationSeconds:probe.durationSeconds,
    transcriptSegments,
    sceneTimes,
    maxFrames
  });
  const framesDir = path.join(resolvedOutput, 'frames');
  const storyboardsDir = path.join(resolvedOutput, 'storyboards');
  await fs.mkdir(framesDir, { recursive:true, mode:0o700 });
  await fs.mkdir(storyboardsDir, { recursive:true, mode:0o700 });

  const frames = [];
  const hashes = [];
  const minimumCoverageFrames = Math.min(maxFrames, depth === 'full' ? 12 : 6);
  for (const candidate of candidates) {
    if (frames.length >= maxFrames) break;
    const perceptualHash = await framePerceptualHash(resolvedVideo, candidate.timestampSeconds, run);
    if (
      frames.length >= minimumCoverageFrames
      && perceptualHash
      && hashes.some((hash) => hammingDistance(hash, perceptualHash) <= 5)
    ) continue;
    const index = frames.length + 1;
    const fileName = `frame-${String(index).padStart(3, '0')}-${timestampSlug(candidate.timestampSeconds)}.jpg`;
    const framePath = path.join(framesDir, fileName);
    await renderTimestampedFrame(resolvedVideo, candidate.timestampSeconds, framePath, run);
    const checksum = await fileSha256(framePath);
    frames.push({
      frameId:`frame-${String(index).padStart(3, '0')}`,
      timestamp:formatTimestamp(candidate.timestampSeconds),
      timestampSeconds:round(candidate.timestampSeconds),
      reason:candidate.reason,
      localRef:path.relative(resolvedOutput, framePath),
      checksum:`sha256:${checksum}`
    });
    if (perceptualHash) hashes.push(perceptualHash);
  }
  if (!frames.length) throw new VisualEvidenceError('visual_frames_empty', '视频可读取，但没有生成有效关键帧。');
  frames.sort((left, right) => left.timestampSeconds - right.timestampSeconds);
  frames.forEach((frame, index) => {
    frame.frameId = `frame-${String(index + 1).padStart(3, '0')}`;
  });

  const storyboards = [];
  for (let index = 0; index < frames.length; index += STORYBOARD_SIZE) {
    const group = frames.slice(index, index + STORYBOARD_SIZE);
    const boardNumber = storyboards.length + 1;
    const boardPath = path.join(storyboardsDir, `storyboard-${String(boardNumber).padStart(2, '0')}.jpg`);
    await renderStoryboard(group.map((frame) => path.join(resolvedOutput, frame.localRef)), boardPath, resolvedOutput, run);
    storyboards.push({
      storyboardId:`storyboard-${String(boardNumber).padStart(2, '0')}`,
      localRef:path.relative(resolvedOutput, boardPath),
      frameRefs:group.map((frame) => frame.frameId),
      checksum:`sha256:${await fileSha256(boardPath)}`
    });
  }

  const sourceVideoChecksum = await fileSha256(resolvedVideo);
  const payload = {
    schemaVersion:'agent.army/visual-evidence/v1',
    sourceVideoChecksum:`sha256:${sourceVideoChecksum}`,
    durationSeconds:round(probe.durationSeconds),
    selection:{
      depth:depth === 'full' ? 'full' : 'fast',
      maxFrames,
      selectedFrames:frames.length,
      sceneThreshold:0.2,
      duplicateHammingThreshold:5,
      frameWidth:512,
      storyboardSize:STORYBOARD_SIZE,
      processingDurationMs:Math.max(0, Date.now() - startedAt)
    },
    sourceMetadata:sourceMetadata || null,
    frames,
    storyboards,
    coverage:{
      status:'available',
      firstFrameAt:frames[0]?.timestamp || null,
      lastFrameAt:frames.at(-1)?.timestamp || null,
      sceneFrameCount:frames.filter((frame) => frame.reason === 'scene_change').length,
      transcriptCueFrameCount:frames.filter((frame) => frame.reason === 'transcript_cue').length
    },
    createdAt:new Date().toISOString()
  };
  const manifestPath = path.join(resolvedOutput, 'visual-evidence.json');
  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), { mode:0o600 });
  return {
    manifestPath,
    framePaths:frames.map((frame) => path.join(resolvedOutput, frame.localRef)),
    storyboardPaths:storyboards.map((board) => path.join(resolvedOutput, board.localRef)),
    payload
  };
}

export function selectFrameCandidates({ durationSeconds, transcriptSegments = [], sceneTimes = [], maxFrames = FAST_FRAME_LIMIT } = {}) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const safeEnd = Math.max(0, duration - Math.min(0.5, duration / 2));
  const anchors = [0.5, 1.5, 3]
    .filter((value) => value <= safeEnd)
    .map((timestampSeconds) => ({ timestampSeconds, reason:'opening_anchor', priority:0 }));
  if (!anchors.length) anchors.push({ timestampSeconds:Math.min(safeEnd, duration / 2), reason:'opening_anchor', priority:0 });

  const cuePool = transcriptSegments
    .map((segment) => Number(segment?.startSeconds))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= safeEnd);
  const cues = spreadValues(cuePool, Math.max(2, Math.ceil(maxFrames / 3)))
    .map((timestampSeconds) => ({ timestampSeconds, reason:'transcript_cue', priority:1 }));
  const scenes = spreadValues(
    sceneTimes.map(Number).filter((value) => Number.isFinite(value) && value >= 0 && value <= safeEnd),
    Math.max(3, maxFrames)
  ).map((timestampSeconds) => ({ timestampSeconds, reason:'scene_change', priority:2 }));
  const uniformCount = Math.max(maxFrames, Math.ceil(maxFrames * 1.5));
  const uniform = Array.from({ length:uniformCount }, (_, index) => ({
    timestampSeconds:Math.min(safeEnd, ((index + 0.5) / uniformCount) * duration),
    reason:'uniform_fallback',
    priority:3
  }));

  const byTime = new Map();
  for (const candidate of [...anchors, ...cues, ...scenes, ...uniform]) {
    const key = Math.round(candidate.timestampSeconds * 4) / 4;
    const existing = byTime.get(key);
    if (!existing || candidate.priority < existing.priority) byTime.set(key, { ...candidate, timestampSeconds:key });
  }
  const ordered = [...byTime.values()].sort((left, right) => left.timestampSeconds - right.timestampSeconds);
  const firstPass = coveragePriorityOrder(
    spreadCandidatesByTime(ordered, Math.min(maxFrames, ordered.length), safeEnd)
  );
  const selectedKeys = new Set(firstPass.map((item) => `${item.timestampSeconds}:${item.reason}`));
  const remaining = ordered.filter((item) => !selectedKeys.has(`${item.timestampSeconds}:${item.reason}`));
  return [...firstPass, ...spreadValues(remaining, maxFrames * 2)];
}

export function hammingDistance(left, right) {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') return Number.POSITIVE_INFINITY;
  let value = left ^ right;
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

async function probeVideo(videoPath, run) {
  const output = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json',
    videoPath
  ], { encoding:'utf8' });
  let payload = {};
  try { payload = JSON.parse(String(output.stdout || output || '{}')); } catch { payload = {}; }
  return {
    hasVideo:Array.isArray(payload.streams) && payload.streams.some((stream) => stream.codec_type === 'video'),
    durationSeconds:Number(payload?.format?.duration)
  };
}

async function detectSceneTimes(videoPath, run) {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-i', videoPath,
    '-vf', "select='gt(scene,0.20)',showinfo",
    '-vsync', 'vfr',
    '-f', 'null',
    '-'
  ], { encoding:'utf8', allowFailure:true });
  return [...String(result.stderr || '').matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
}

async function framePerceptualHash(videoPath, timestampSeconds, run) {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(timestampSeconds),
    '-i', videoPath,
    '-vf', 'scale=9:8,format=gray',
    '-frames:v', '1',
    '-f', 'rawvideo',
    'pipe:1'
  ], { encoding:null, allowFailure:true });
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  if (bytes.length < 72) return null;
  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (bytes[row * 9 + column] > bytes[row * 9 + column + 1]) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

async function renderTimestampedFrame(videoPath, timestampSeconds, outputPath, run) {
  const labelPath = path.join(path.dirname(outputPath), `.timestamp-${crypto.randomUUID()}.ppm`);
  await writeTimestampLabel(labelPath, formatTimestamp(timestampSeconds));
  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(timestampSeconds),
      '-i', videoPath,
      '-i', labelPath,
      '-filter_complex', '[0:v]scale=512:-2[base];[base][1:v]overlay=12:H-h-12',
      '-frames:v', '1',
      '-q:v', '3',
      outputPath
    ], { encoding:'utf8' });
  } finally {
    await fs.rm(labelPath, { force:true });
  }
}

async function writeTimestampLabel(filePath, text) {
  const glyphs = {
    '0':['01110','10001','10011','10101','11001','10001','01110'],
    '1':['00100','01100','00100','00100','00100','00100','01110'],
    '2':['01110','10001','00001','00010','00100','01000','11111'],
    '3':['11110','00001','00001','01110','00001','00001','11110'],
    '4':['00010','00110','01010','10010','11111','00010','00010'],
    '5':['11111','10000','10000','11110','00001','00001','11110'],
    '6':['01110','10000','10000','11110','10001','10001','01110'],
    '7':['11111','00001','00010','00100','01000','01000','01000'],
    '8':['01110','10001','10001','01110','10001','10001','01110'],
    '9':['01110','10001','10001','01111','00001','00001','01110'],
    ':':['00000','00100','00100','00000','00100','00100','00000']
  };
  const scale = 3;
  const padding = 7;
  const spacing = 2 * scale;
  const characters = [...String(text)].map((character) => glyphs[character] || glyphs['0']);
  const width = padding * 2 + characters.length * 5 * scale + Math.max(0, characters.length - 1) * spacing;
  const height = padding * 2 + 7 * scale;
  const pixels = Buffer.alloc(width * height * 3, 0);
  characters.forEach((glyph, characterIndex) => {
    const originX = padding + characterIndex * (5 * scale + spacing);
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel !== '1') return;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const offset = ((padding + rowIndex * scale + y) * width + originX + columnIndex * scale + x) * 3;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
          }
        }
      });
    });
  });
  await fs.writeFile(filePath, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]), { mode:0o600 });
}

async function renderStoryboard(framePaths, outputPath, workspace, run) {
  const listPath = path.join(workspace, `.storyboard-${crypto.randomUUID()}.txt`);
  const list = framePaths.map((filePath) => `file '${String(filePath).replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, `${list}\n`, { mode:0o600 });
  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', `tile=4x3:nb_frames=${framePaths.length}:padding=8:margin=8:color=black`,
      '-frames:v', '1',
      '-q:v', '3',
      outputPath
    ], { encoding:'utf8' });
  } finally {
    await fs.rm(listPath, { force:true });
  }
}

function spreadValues(values, limit) {
  if (!Array.isArray(values) || limit <= 0) return [];
  if (values.length <= limit) return [...values];
  if (limit === 1) return [values[Math.floor(values.length / 2)]];
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(values[Math.round((index / (limit - 1)) * (values.length - 1))]);
  }
  return selected;
}

function spreadCandidatesByTime(values, limit, endSeconds) {
  if (!Array.isArray(values) || !values.length || limit <= 0) return [];
  const remaining = [...values];
  const selected = [];
  for (let index = 0; index < limit && remaining.length; index += 1) {
    const target = limit === 1 ? endSeconds / 2 : (index / (limit - 1)) * endSeconds;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((candidate, candidateIndex) => {
      const distance = Math.abs(Number(candidate.timestampSeconds) - target);
      if (distance < bestDistance) {
        bestIndex = candidateIndex;
        bestDistance = distance;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function coveragePriorityOrder(values) {
  if (!Array.isArray(values) || values.length <= 2) return [...(values || [])];
  const remaining = [...values].sort((left, right) => left.timestampSeconds - right.timestampSeconds);
  const selected = [remaining.shift()];
  if (remaining.length) selected.push(remaining.pop());
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = -1;
    remaining.forEach((candidate, index) => {
      const distance = Math.min(...selected.map((picked) => Math.abs(candidate.timestampSeconds - picked.timestampSeconds)));
      if (distance > bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function timestampSlug(value) {
  return formatTimestamp(value).replace(/:/g, '-');
}

function formatTimestamp(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function runCommand(command, args, { encoding = 'utf8', allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        stdout:encoding === null ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(encoding),
        stderr:Buffer.concat(stderr).toString('utf8'),
        code
      };
      if (code === 0 || allowFailure) return resolve(result);
      const error = new Error(`${command} 执行失败（退出码 ${code}）：${result.stderr.slice(-500)}`);
      error.code = command === 'ffmpeg' || command === 'ffprobe' ? 'visual_tool_failed' : 'tool_failed';
      reject(error);
    });
  });
}
