import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConnectionUse } from './connection-broker.ts';
import type {
  AdapterAcquireInput,
  AdapterAcquireResult,
  AdapterMetricsInput,
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

  async collectMetrics({ source, connectionUse, historyLimit = 20 }: AdapterMetricsInput): Promise<unknown> {
    if (this.providerFor(source) !== 'youtube') {
      throw codedError('当前通用指标通道只支持 YouTube 作品链接。', 'capability_not_available');
    }
    const authArgs = browserSessionArgs(connectionUse);
    const currentPayload = await this.readRawMetadata(source, authArgs);
    if (!currentPayload?.id) {
      throw codedError('YouTube 没有返回可识别的作品信息。', 'adapter_unavailable');
    }
    const currentWork = youtubeMetricWork(currentPayload, source);
    const creator = youtubeMetricCreator(currentPayload);
    const limit = Math.max(5, Math.min(Number(historyLimit) || 20, 20));
    const historyWorks = await this.readYoutubeHistory({
      currentId:currentWork.id,
      channelUrl:creator.profileUrl,
      authArgs,
      limit,
    });
    const unavailableReasons: string[] = [];
    if (!creator.id) unavailableReasons.push('creator_identity_unavailable');
    if (!creator.followerCount || creator.followerCount <= 0) unavailableReasons.push('follower_count_unavailable');
    if (!Number.isInteger(currentWork.likes)) unavailableReasons.push('current_work_metric_unavailable');
    return {
      schemaVersion:'agent.army/boom-metrics-bundle/v1',
      status:unavailableReasons.length ? 'metrics_unavailable' : historyWorks.length < 5 ? 'insufficient_history' : 'collected',
      ...(unavailableReasons.length ? { unavailableReasons } : {}),
      platform:'youtube',
      sourceUrl:currentWork.sourceUrl || source,
      observedAt:new Date().toISOString(),
      creator,
      currentWork,
      historyWorks,
      historyOrder:'creator_feed_desc',
      sampleCount:historyWorks.length,
      acquisition:{
        adapterId:this.id,
        versionRef:this.versionRef,
        source:'yt-dlp-public-metadata',
      },
    };
  }

  private async readYoutubeHistory({ currentId, channelUrl, authArgs, limit }: Readonly<{
    currentId: string | null;
    channelUrl: string | null;
    authArgs: readonly string[];
    limit: number;
  }>): Promise<Array<ReturnType<typeof youtubeMetricWork>>> {
    if (!channelUrl) return [];
    const playlistUrl = youtubeVideosUrl(channelUrl);
    const candidateLimit = Math.min(limit, 12);
    const output = await this.runCommand('yt-dlp', [
      ...authArgs,
      '--flat-playlist',
      '--playlist-end', String(candidateLimit + 1),
      '--dump-single-json',
      playlistUrl,
    ], { allowFailure:true });
    const playlist = parseJsonObject(output);
    const candidates = (Array.isArray(playlist?.entries) ? playlist.entries : [])
      .filter((entry) => !entry || typeof entry !== 'object' || String((entry as Record<string, any>).id || '') !== currentId)
      .map((entry) => youtubeEntryUrl(entry))
      .filter((url): url is string => Boolean(url))
      .slice(0, candidateLimit + 1);
    const works: Array<ReturnType<typeof youtubeMetricWork>> = [];
    for (let offset = 0; offset < candidates.length && works.length < candidateLimit; offset += 4) {
      const beforeBatch = works.length;
      const payloads = await Promise.all(candidates.slice(offset, offset + 4)
        .map((url) => this.readRawMetadata(url, authArgs)));
      for (const payload of payloads) {
        if (!payload?.id || String(payload.id) === currentId) continue;
        const work = youtubeMetricWork(payload, youtubeEntryUrl(payload));
        if (Number.isInteger(work.likes)) works.push(work);
        if (works.length >= candidateLimit) break;
      }
      if (works.length === beforeBatch) break;
    }
    return works;
  }

  private async readRawMetadata(source: string, authArgs: readonly string[]): Promise<Record<string, any> | null> {
    const output = await this.runCommand('yt-dlp', [...authArgs, '--no-playlist', '--skip-download', '--dump-single-json', source], { allowFailure: true });
    return parseJsonObject(output);
  }

  async readMetadata(source: string, authArgs: readonly string[]): Promise<Record<string, unknown> | null> {
    const payload = await this.readRawMetadata(source, authArgs);
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

function youtubeMetricCreator(payload: Record<string, any>): Readonly<{
  id: string | null;
  name: string | null;
  followerCount: number | null;
  profileUrl: string | null;
}> {
  const id = cleanString(payload.channel_id || payload.uploader_id);
  const profileUrl = publicHttpUrl(payload.channel_url || payload.uploader_url)
    || (id ? `https://www.youtube.com/channel/${encodeURIComponent(id)}` : null);
  return {
    id,
    name:cleanString(payload.channel || payload.uploader || payload.creator),
    followerCount:exactCount(payload.channel_follower_count),
    profileUrl,
  };
}

function youtubeMetricWork(payload: Record<string, any>, sourceFallback: string | null): Readonly<{
  id: string | null;
  title: string;
  sourceUrl: string | null;
  publishedAt?: string;
  likes: number | null;
  favorites: number;
  plays: number | null;
  comments: number | null;
  shares: null;
}> {
  const timestamp = Number(payload.timestamp || payload.release_timestamp);
  const publishedAt = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : null;
  return {
    id:cleanString(payload.id),
    title:String(payload.title || '').trim().slice(0, 500),
    sourceUrl:publicHttpUrl(payload.webpage_url || payload.original_url || payload.url) || publicHttpUrl(sourceFallback),
    ...(publishedAt ? { publishedAt } : {}),
    likes:exactCount(payload.like_count),
    favorites:0,
    plays:exactCount(payload.view_count),
    comments:exactCount(payload.comment_count),
    shares:null,
  };
}

function youtubeVideosUrl(value: string): string {
  const parsed = new URL(value);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/videos`;
  return parsed.toString();
}

function youtubeEntryUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, any>;
  const direct = publicHttpUrl(entry.webpage_url || entry.original_url || entry.url);
  if (direct) return direct;
  const id = cleanString(entry.id);
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : null;
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    const youtubeVideoId = (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com'))
      ? parsed.searchParams.get('v')
      : null;
    parsed.search = '';
    if (youtubeVideoId) parsed.searchParams.set('v', youtubeVideoId);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function exactCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function cleanString(value: unknown): string | null {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return normalized || null;
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
