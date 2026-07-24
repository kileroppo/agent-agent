import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class YtDlpGeneralMediaAdapter {
  constructor({ runCommand: runCommandImpl = defaultRunCommand } = {}) {
    this.id = 'yt-dlp-general-media';
    this.versionRef = 'builtin-v1';
    this.capabilities = ['basic_content', 'media', 'subtitles'];
    this.accessMode = 'either';
    this.priorityClass = 'general';
    this.healthStatus = 'healthy';
    this.runtimeRequirements = ['media_transcription'];
    this.runCommand = runCommandImpl;
  }

  matches(source) {
    try {
      const parsed = new URL(source);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch { return false; }
  }

  providerFor(source) {
    const host = new URL(source).hostname.toLowerCase();
    return host === 'youtu.be' || host.endsWith('.youtube.com') ? 'youtube' : 'public_media';
  }

  async acquire({ source, requestedCapabilities, connectionUse, workspace, onProgress }) {
    const authArgs = browserSessionArgs(connectionUse);
    const metadata = await this.readMetadata(source, authArgs);
    const wantsSubtitles = requestedCapabilities.includes('subtitles');
    const wantsMedia = requestedCapabilities.includes('media');
    const contentItems = metadata ? { basic_content: metadata } : {};

    if (wantsSubtitles) {
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
      const error = new Error('当前通道没有可用字幕，且任务未请求媒体转录。');
      error.code = 'capability_not_available';
      throw error;
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

  async readMetadata(source, authArgs) {
    const output = await this.runCommand('yt-dlp', [...authArgs, '--no-playlist', '--skip-download', '--print', '%(title)s', '--print', '%(description)s', source], { allowFailure: true });
    if (!output) return null;
    const [title = '', ...description] = String(output).replace(/\r/g, '').split('\n');
    return title.trim() ? { title: title.trim().slice(0, 500), description: description.join('\n').trim().slice(0, 8000) || null } : null;
  }
}

function result(contentItems, runtime, validation) {
  const providedCapabilities = [];
  if (contentItems.basic_content) providedCapabilities.push('basic_content');
  if (contentItems.subtitles) providedCapabilities.push('subtitles');
  if (contentItems.media) providedCapabilities.push('media');
  return {
    providedCapabilities,
    contentItems,
    runtime,
    validation,
    capabilityNotes: providedCapabilities.includes('subtitles')
      ? '已获取可用字幕。'
      : '未找到可用字幕，已按允许范围获取音频供本地转录。'
  };
}

function accessValidation(authArgs) {
  return { exists:true, readable:true, accessScope:authArgs.length ? 'authorized_read' : 'public_read' };
}

export function browserSessionArgs(connectionUse) {
  if (!connectionUse) return [];
  if (connectionUse.credentialKind === 'browser_session') {
    const error = new Error('旧浏览器连接不能读取浏览器 Cookie；请改用公开视频读取或已批准的受控连接器。');
    error.code = 'browser_session_forbidden';
    throw error;
  }
  throw new Error('受控连接类型不受当前媒体适配器支持。');
}

async function findFirst(directory, predicate) {
  const files = await fs.readdir(directory);
  const name = files.find(predicate);
  return name ? path.join(directory, name) : null;
}

function defaultRunCommand(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', (error) => {
      const failure = new Error(`${command} 无法启动：${error.message}`);
      failure.code = error.code === 'ENOENT' ? 'tool_unavailable' : 'adapter_unavailable';
      reject(failure);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(output.trim());
      if (allowFailure) return resolve('');
      const failure = new Error(`${command} 执行失败（退出码 ${code}）。`);
      failure.code = commandFailureCode(errorOutput);
      reject(failure);
    });
  });
}

function commandFailureCode(errorOutput) {
  if (/\b429\b|too many requests|rate limit/i.test(errorOutput)) return 'source_rate_limited';
  if (/\b401\b|\b403\b|private|login|sign in|cookies|authorization/i.test(errorOutput)) return 'authorization_required';
  return 'adapter_unavailable';
}
