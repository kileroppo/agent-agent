import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConnectionUse } from './connection-broker.ts';
import type {
  AdapterAcquireInput,
  AdapterAcquireResult,
  ContentAcquisitionAdapter,
} from './content-acquisition-contracts.ts';

type RunCommandOptions = Readonly<{ allowFailure?: boolean }>;
type RunCommand = (command: string, args: readonly string[], options?: RunCommandOptions) => Promise<string>;
type MediaContentItems = Record<string, unknown> & {
  basic_content?: Record<string, unknown>;
  subtitles?: Array<Record<string, unknown>>;
  media?: Array<Record<string, unknown>>;
};

export class YtDlpGeneralMediaAdapter implements ContentAcquisitionAdapter {
  readonly id = 'yt-dlp-general-media';
  readonly versionRef = 'builtin-v1';
  readonly capabilities = ['basic_content', 'media', 'subtitles'] as const;
  readonly accessMode = 'either' as const;
  readonly priorityClass = 'general' as const;
  readonly healthStatus = 'healthy' as const;
  readonly runtimeRequirements = ['media_transcription', 'visual_analysis'] as const;
  private readonly runCommand: RunCommand;

  constructor({ runCommand: runCommandImpl = defaultRunCommand }: Readonly<{ runCommand?: RunCommand }> = {}) {
    this.runCommand = runCommandImpl;
  }

  matches(source: string): boolean {
    try {
      const parsed = new URL(source);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch { return false; }
  }

  providerFor(source: string): string {
    const host = new URL(source).hostname.toLowerCase();
    return host === 'youtu.be' || host.endsWith('.youtube.com') ? 'youtube' : 'public_media';
  }

  async acquire({ source, requestedCapabilities, connectionUse, workspace, runtimeRequirement, onProgress }: AdapterAcquireInput): Promise<AdapterAcquireResult> {
    const authArgs = browserSessionArgs(connectionUse);
    const metadata = await this.readMetadata(source, authArgs);
    const wantsSubtitles = requestedCapabilities.includes('subtitles');
    const wantsMedia = requestedCapabilities.includes('media');
    const wantsVisualMedia = runtimeRequirement === 'visual_analysis';
    const contentItems: MediaContentItems = metadata ? { basic_content: metadata } : {};

    if (wantsSubtitles && !wantsVisualMedia) {
      await onProgress?.({ stage: 'acquiring', progress: 22, message: '正在优先查找可用字幕' });
      const subtitleTemplate = path.join(workspace, 'subtitle.%(ext)s');
      // Ask for the useful originals first. Wildcards make yt-dlp request every
      // translated variant, which is slow and can make a public video look
      // unavailable when one surplus subtitle request is rate-limited.
      await this.runCommand('yt-dlp', [...authArgs, '--no-playlist', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-Hant,en', '--skip-download', '-o', subtitleTemplate, source], { allowFailure: true });
      const subtitlePath = await findFirst(workspace, (name) => /\.vtt$|\.srt$/i.test(name));
      if (subtitlePath) {
        contentItems.subtitles = [{ localRef: path.basename(subtitlePath), mimeType: subtitlePath.endsWith('.srt') ? 'application/x-subrip' : 'text/vtt' }];
        return result(contentItems, { kind: 'subtitle', path: subtitlePath }, accessValidation(authArgs));
      }
    }

    if (!wantsMedia) {
      throw codedError('当前通道没有可用字幕，且任务未请求媒体转录。', 'capability_not_available');
    }
    if (wantsVisualMedia) {
      await onProgress?.({ stage: 'acquiring', progress: 32, message: '正在获取受控低分辨率视频用于关键帧分析' });
      const videoTemplate = path.join(workspace, 'source-video.%(ext)s');
      await this.runCommand('yt-dlp', [
        ...authArgs,
        '--no-playlist',
        '-f', 'bv*[height<=720]/b[height<=720]/bv*/b',
        '-o', videoTemplate,
        source
      ]);
      const downloadedVideo = await findFirst(workspace, (name) => /^source-video\./.test(name));
      if (!downloadedVideo) throw new Error('下载结束但没有找到视频文件。');
      contentItems.media = [{ localRef:path.basename(downloadedVideo), mimeType:videoMimeType(downloadedVideo) }];
      return result(contentItems, { kind:'video', path:downloadedVideo }, accessValidation(authArgs), { visual:true });
    }
    await onProgress?.({ stage: 'acquiring', progress: 32, message: '未找到字幕，正在下载音频' });
    const audioTemplate = path.join(workspace, 'source.%(ext)s');
    await this.runCommand('yt-dlp', [...authArgs, '--no-playlist', '-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'mp3', '-o', audioTemplate, source]);
    const downloaded = await findFirst(workspace, (name) => /^source\./.test(name));
    if (!downloaded) throw new Error('下载结束但没有找到音频文件。');
    const normalized = path.join(workspace, 'audio.wav');
    await this.runCommand('ffmpeg', ['-y', '-i', downloaded, '-vn', '-ac', '1', '-ar', '16000', normalized]);
    contentItems.media = [{ localRef: path.basename(normalized), mimeType: 'audio/wav' }];
    return result(contentItems, { kind: 'audio', path: normalized }, accessValidation(authArgs));
  }

  async readMetadata(source: string, authArgs: readonly string[]): Promise<Record<string, unknown> | null> {
    const output = await this.runCommand('yt-dlp', [...authArgs, '--no-playlist', '--skip-download', '--dump-single-json', source], { allowFailure: true });
    if (!output) return null;
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(String(output)) as Record<string, unknown>; } catch { payload = null; }
    if (!payload?.title) return null;
    const timestamp = Number(payload.timestamp || payload.release_timestamp);
    return {
      title:String(payload.title).trim().slice(0, 500),
      description:String(payload.description || '').trim().slice(0, 8000) || null,
      author:String(payload.uploader || payload.channel || payload.creator || '').trim().slice(0, 300) || null,
      durationSeconds:Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : null,
      sourceUrl:String(payload.webpage_url || source).slice(0, 2000),
      ...(Number.isFinite(timestamp) && timestamp > 0 ? { publishedAt:new Date(timestamp * 1000).toISOString() } : {})
    };
  }
}

function result(
  contentItems: MediaContentItems,
  runtime: Readonly<Record<string, unknown>>,
  validation: Readonly<Record<string, unknown>>,
  { visual = false }: Readonly<{ visual?: boolean }> = {},
): AdapterAcquireResult {
  const providedCapabilities = [];
  if (contentItems.basic_content) providedCapabilities.push('basic_content');
  if (contentItems.subtitles) providedCapabilities.push('subtitles');
  if (contentItems.media) providedCapabilities.push('media');
  return {
    providedCapabilities,
    contentItems,
    runtime,
    validation,
    capabilityNotes: visual
      ? '已获取受控视频副本，仅用于本机关键帧分析。'
      : providedCapabilities.includes('subtitles')
      ? '已获取可用字幕。'
      : '未找到可用字幕，已按允许范围获取音频供本地转录。'
  };
}

function videoMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
}

function accessValidation(authArgs: readonly string[]): Readonly<Record<string, unknown>> {
  return { exists:true, readable:true, accessScope:authArgs.length ? 'authorized_read' : 'public_read' };
}

export function browserSessionArgs(connectionUse: ConnectionUse | null): string[] {
  if (!connectionUse) return [];
  if (connectionUse.credentialKind === 'browser_session') {
    throw codedError('旧浏览器连接不能读取浏览器 Cookie；请改用公开视频读取或已批准的受控连接器。', 'browser_session_forbidden');
  }
  throw new Error('受控连接类型不受当前媒体适配器支持。');
}

async function findFirst(directory: string, predicate: (name: string) => boolean): Promise<string | null> {
  const files = await fs.readdir(directory);
  const name = files.find(predicate);
  return name ? path.join(directory, name) : null;
}

function defaultRunCommand(command: string, args: readonly string[], { allowFailure = false }: RunCommandOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk; });
    child.on('error', (error) => {
      const spawnCode = 'code' in error ? String(error.code || '') : '';
      reject(codedError(`${command} 无法启动：${error.message}`, spawnCode === 'ENOENT' ? 'tool_unavailable' : 'adapter_unavailable'));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(output.trim());
      if (allowFailure) return resolve('');
      reject(codedError(`${command} 执行失败（退出码 ${code}）。`, commandFailureCode(errorOutput)));
    });
  });
}

function commandFailureCode(errorOutput: string): string {
  if (/\b429\b|too many requests|rate limit/i.test(errorOutput)) return 'source_rate_limited';
  if (/\b401\b|\b403\b|private|login|sign in|cookies|authorization/i.test(errorOutput)) return 'authorization_required';
  return 'adapter_unavailable';
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
