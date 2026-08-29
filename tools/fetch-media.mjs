#!/usr/bin/env node
/**
 * tools/fetch-media.mjs
 * 
 * Standalone media & subtitle extractor CLI for Skill-Driven Agent.
 * 
 * Usage:
 *   node tools/fetch-media.mjs --url "https://www.bilibili.com/video/BV1xx411c7mD"
 *   node tools/fetch-media.mjs --url "https://www.youtube.com/watch?v=xxx"
 *   node tools/fetch-media.mjs --file "/path/to/local/video.mp4"
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/'
};

function parseArgs(args) {
  const options = {
    url: '',
    file: '',
    outputDir: path.join(os.tmpdir(), 'agent-media', `${Date.now()}`),
    preferSubtitles: true,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      options.url = args[++i];
    } else if (args[i] === '--file' && args[i + 1]) {
      options.file = args[++i];
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      options.outputDir = path.resolve(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
      options.help = true;
    }
  }
  return options;
}

function runCmd(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Command ${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    proc.on('error', reject);
  });
}

function extractBvid(urlString) {
  try {
    const parsed = new URL(urlString);
    const m = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    return m ? m[1] : parsed.searchParams.get('bvid') || null;
  } catch {
    return null;
  }
}

async function handleBilibili(bvid, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });

  // 1. Fetch video metadata
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers: BILIBILI_HEADERS });
  const viewJson = await viewRes.json();
  if (viewJson.code !== 0 || !viewJson.data) {
    throw new Error(viewJson.message || '无法获取B站视频详情');
  }

  const title = viewJson.data.title || '';
  const desc = viewJson.data.desc || '';
  const author = viewJson.data.owner?.name || '';
  const cid = viewJson.data.cid;
  const duration = viewJson.data.duration || 0;

  // 2. Check subtitles
  try {
    const playerRes = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { headers: BILIBILI_HEADERS });
    const playerJson = await playerRes.json();
    const subtitles = playerJson.data?.subtitle?.subtitles || [];

    if (subtitles.length > 0) {
      const subCandidate = subtitles.find(s => s.lan?.startsWith('zh') || s.lan_doc?.includes('中')) || subtitles[0];
      const subUrl = subCandidate?.subtitle_url?.startsWith('//') ? `https:${subCandidate.subtitle_url}` : subCandidate?.subtitle_url;

      if (subUrl) {
        const subRes = await fetch(subUrl, { headers: BILIBILI_HEADERS });
        const subBody = await subRes.json();
        const cues = (subBody.body || []).map(b => ({
          from: b.from,
          to: b.to,
          content: (b.content || '').trim()
        })).filter(b => b.content);

        if (cues.length >= 5) {
          const fullText = cues.map(c => c.content).join('\n');
          const txtPath = path.join(outputDir, 'subtitles.txt');
          const jsonPath = path.join(outputDir, 'subtitles.json');

          await fs.writeFile(txtPath, fullText, 'utf-8');
          await fs.writeFile(jsonPath, JSON.stringify({ title, author, desc, cues }, null, 2), 'utf-8');

          return {
            hasSubtitles: true,
            title,
            author,
            desc,
            duration,
            cuesCount: cues.length,
            subtitlesTextFile: txtPath,
            subtitlesJsonFile: jsonPath,
            preview: fullText.slice(0, 300)
          };
        }
      }
    }
  } catch (e) {
    console.error(`[fetch-media] 字幕检查异常: ${e.message}，将下载原生音频...`);
  }

  // 3. Fallback: Download audio track directly from Bilibili PlayURL API
  console.error(`[fetch-media] 获取B站原生高音质音频流...`);
  const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16`, {
    headers: { ...BILIBILI_HEADERS, Referer: `https://www.bilibili.com/video/${bvid}` }
  });
  const playJson = await playRes.json();
  const audioCandidates = playJson.data?.dash?.audio || [];
  if (!audioCandidates.length) {
    throw new Error('未能获取到 B站 音频流地址');
  }

  const selectedAudio = audioCandidates[0];
  const streamUrl = selectedAudio.baseUrl || selectedAudio.backupUrl?.[0];
  if (!streamUrl) throw new Error('音频流链接无效');

  const rawAudioPath = path.join(outputDir, 'bili_audio.m4a');
  console.error(`[fetch-media] 下载音频流到 ${rawAudioPath}...`);
  const audioStreamRes = await fetch(streamUrl, {
    headers: { ...BILIBILI_HEADERS, Referer: `https://www.bilibili.com/video/${bvid}` }
  });
  if (!audioStreamRes.ok) throw new Error(`音频流下载失败: HTTP ${audioStreamRes.status}`);

  const fileOut = createWriteStream(rawAudioPath);
  await pipeline(audioStreamRes.body, fileOut);

  // Convert/ensure mp3 format
  const finalMp3Path = path.join(outputDir, 'audio.mp3');
  console.error(`[fetch-media] 转换为标准 MP3 音频...`);
  await runCmd('ffmpeg', ['-y', '-i', rawAudioPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', finalMp3Path]);

  return {
    hasSubtitles: false,
    title,
    author,
    desc,
    duration,
    audioFile: finalMp3Path
  };
}

async function downloadAudioWithYtDlp(url, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, 'audio.%(ext)s');

  console.error(`[fetch-media] 正在使用 yt-dlp 提取音频...`);
  await runCmd('yt-dlp', [
    '--no-playlist',
    '-f', 'ba[ext=m4a]/ba/b',
    '-x',
    '--audio-format', 'mp3',
    '-o', outputTemplate,
    url
  ]);

  const files = await fs.readdir(outputDir);
  const audioFile = files.find(f => f.startsWith('audio.') && !f.endsWith('.part'));
  if (!audioFile) {
    throw new Error('yt-dlp 完成但未找到音频文件');
  }

  const audioPath = path.join(outputDir, audioFile);
  return audioPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || (!options.url && !options.file)) {
    console.log(`
Usage:
  node tools/fetch-media.mjs --url <URL> [--output-dir <DIR>]
  node tools/fetch-media.mjs --file <PATH> [--output-dir <DIR>]

Options:
  --url         Web video/audio URL (Bilibili, YouTube, Podcasts, etc.)
  --file        Local video or audio file path
  --output-dir  Directory to store extracted media/subtitles (default: /tmp/agent-media/<timestamp>)
  --help, -h    Show this help message
`);
    process.exit(options.help ? 0 : 1);
  }

  try {
    if (options.file) {
      const filePath = path.resolve(options.file);
      await fs.access(filePath);
      const ext = path.extname(filePath).toLowerCase();
      
      console.log(JSON.stringify({
        status: 'success',
        type: 'local_file',
        audioFile: filePath,
        mimeType: ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'video/mp4'
      }, null, 2));
      return;
    }

    if (options.url) {
      const bvid = extractBvid(options.url);
      if (bvid) {
        console.error(`[fetch-media] 识别到 B站 BV号: ${bvid}`);
        const result = await handleBilibili(bvid, options.outputDir);
        if (result.hasSubtitles) {
          console.log(JSON.stringify({
            status: 'success',
            type: 'subtitles',
            source: options.url,
            title: result.title,
            author: result.author,
            duration: result.duration,
            subtitlesFile: result.subtitlesTextFile,
            subtitlesJson: result.subtitlesJsonFile,
            cuesCount: result.cuesCount,
            preview: result.preview
          }, null, 2));
          return;
        } else {
          console.log(JSON.stringify({
            status: 'success',
            type: 'audio',
            source: options.url,
            title: result.title,
            author: result.author,
            duration: result.duration,
            audioFile: result.audioFile
          }, null, 2));
          return;
        }
      }

      const audioPath = await downloadAudioWithYtDlp(options.url, options.outputDir);
      console.log(JSON.stringify({
        status: 'success',
        type: 'audio',
        source: options.url,
        audioFile: audioPath
      }, null, 2));
    }
  } catch (error) {
    console.error(`[fetch-media] 错误: ${error.message}`);
    console.log(JSON.stringify({
      status: 'error',
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

main();
