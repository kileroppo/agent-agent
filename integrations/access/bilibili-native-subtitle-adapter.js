import fs from 'node:fs/promises';
import path from 'node:path';

const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com']);
const TRUSTED_SUBTITLE_HOST_SUFFIXES = ['.hdslb.com', '.bilibili.com'];
const REQUEST_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://www.bilibili.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'
};

export class BilibiliNativeSubtitleAdapter {
  constructor({ cookieBridgeUrl, fetchImpl = fetch } = {}) {
    this.id = 'bilibili-native-subtitles';
    this.versionRef = 'bilibili-player-v2';
    this.capabilities = ['basic_content', 'subtitles'];
    this.accessMode = 'either';
    this.priorityClass = 'specialized';
    this.healthStatus = 'healthy';
    this.runtimeRequirements = ['media_transcription'];
    this.cookieBridgeUrl = normalizeLocalUrl(cookieBridgeUrl);
    this.fetchImpl = fetchImpl;
  }

  matches(source) {
    try {
      const parsed = new URL(source);
      const host = parsed.hostname.toLowerCase();
      return [...BILIBILI_HOSTS].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
        && Boolean(extractBvid(parsed));
    } catch {
      return false;
    }
  }

  providerFor() {
    return 'bili';
  }

  async acquire({ source, requestedCapabilities, connectionUse, workspace, onProgress }) {
    const parsed = new URL(source);
    const bvid = extractBvid(parsed);
    if (!bvid) {
      const error = new Error('B站链接中没有可识别的 BV 号。');
      error.code = 'capability_not_available';
      throw error;
    }

    const cookie = await this.readCookieHeader(connectionUse);
    const headers = cookie ? { ...REQUEST_HEADERS, Cookie: cookie } : REQUEST_HEADERS;
    const video = await this.fetchApiJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      headers
    );
    const page = selectPage(video, parsed.searchParams.get('p'));
    const basicContent = {
      title: String(video.title || '').slice(0, 500),
      description: String(video.desc || '').slice(0, 16000),
      sourceUrl: `https://www.bilibili.com/video/${bvid}`,
      author: video.owner?.name || null,
      durationSeconds: positiveNumber(page?.duration) || positiveNumber(video.duration) || null
    };

    if (!requestedCapabilities.includes('subtitles')) {
      return metadataOnly(basicContent, Boolean(cookie));
    }

    await onProgress?.({ stage: 'acquiring', progress: 18, message: '正在优先读取 B站原生字幕' });
    const player = await this.fetchApiJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(page.cid)}`,
      headers
    );
    const subtitleCandidates = rankSubtitles(player?.subtitle?.subtitles);
    if (subtitleCandidates.length === 0) throw capabilityUnavailable('该视频没有可用的 B站原生字幕。');

    let subtitle = null;
    let cues = [];
    for (const candidate of subtitleCandidates.slice(0, 5)) {
      try {
        const subtitleUrl = trustedSubtitleUrl(candidate.subtitle_url || candidate.url);
        const subtitlePayload = await this.fetchJson(subtitleUrl, headers);
        const candidateCues = validCues(subtitlePayload?.body);
        assertUsefulCoverage(candidateCues, basicContent.durationSeconds);
        subtitle = candidate;
        cues = candidateCues;
        break;
      } catch (error) {
        if (error?.code !== 'capability_not_available') throw error;
      }
    }
    if (!subtitle) throw capabilityUnavailable('B站原生字幕均不满足完整转录要求。');

    await fs.mkdir(workspace, { recursive: true });
    const subtitlePath = path.join(workspace, `subtitle.${safeLanguage(subtitle.lan)}.vtt`);
    await fs.writeFile(subtitlePath, toWebVtt(cues), { mode: 0o600 });
    return {
      providedCapabilities: ['basic_content', 'subtitles'],
      contentItems: {
        basic_content: basicContent,
        subtitles: [{
          localRef: path.basename(subtitlePath),
          mimeType: 'text/vtt',
          language: subtitle.lan || null,
          languageLabel: subtitle.lan_doc || null
        }]
      },
      runtime: { kind: 'subtitle', path: subtitlePath },
      validation: {
        exists: true,
        readable: true,
        accessScope: cookie ? 'authorized_read' : 'public_read',
        subtitleCueCount: cues.length,
        subtitleCoverage: coverageRatio(cues, basicContent.durationSeconds)
      },
      capabilityNotes: '已通过 B站原生字幕接口获取完整度合格的字幕；未下载媒体，也未运行 ASR。'
    };
  }

  async readCookieHeader(connectionUse) {
    if (
      connectionUse?.credentialKind !== 'cookie_bridge'
      || !connectionUse.cookieBridgeClientId
      || !this.cookieBridgeUrl
    ) return '';
    try {
      const target = new URL('/api/cookies/bili', this.cookieBridgeUrl);
      target.searchParams.set('client_id', connectionUse.cookieBridgeClientId);
      const response = await this.fetchImpl(target, { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      const cookies = payload?.data?.cookies;
      return response.ok && payload.isok !== false && typeof cookies === 'string' ? cookies : '';
    } catch {
      return '';
    }
  }

  async fetchApiJson(url, headers) {
    const payload = await this.fetchJson(url, headers);
    if (payload?.code === 0) return payload.data || {};
    const error = new Error('B站字幕接口未返回可用内容。');
    error.code = payload?.code === -101 ? 'authorization_required' : 'adapter_unavailable';
    throw error;
  }

  async fetchJson(url, headers) {
    const response = await this.fetchImpl(url, { headers, redirect: 'follow' });
    if (!response.ok) {
      const error = new Error(`B站内容读取失败（HTTP ${response.status || 'unknown'}）。`);
      error.code = response.status === 412 || response.status === 429 ? 'source_rate_limited' : 'adapter_unavailable';
      throw error;
    }
    return response.json();
  }
}

function metadataOnly(basicContent, authorized) {
  return {
    providedCapabilities: ['basic_content'],
    contentItems: { basic_content: basicContent },
    runtime: {},
    validation: { exists: true, readable: true, accessScope: authorized ? 'authorized_read' : 'public_read' },
    capabilityNotes: '已读取 B站公开视频信息。'
  };
}

function extractBvid(parsed) {
  return parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] || null;
}

function selectPage(video, requestedPage) {
  const pages = Array.isArray(video.pages) ? video.pages : [];
  const index = Math.max(0, Number(requestedPage || 1) - 1);
  const page = pages[index] || pages[0] || { cid: video.cid, duration: video.duration };
  if (!page?.cid) throw capabilityUnavailable('B站视频缺少可读取的分集信息。');
  return page;
}

function rankSubtitles(value) {
  const subtitles = Array.isArray(value) ? value : [];
  const priorities = ['zh-CN', 'ai-zh', 'zh-Hans', 'zh-Hant', 'en'];
  return [...subtitles].sort((left, right) => {
    const leftRank = languageRank(left, priorities);
    const rightRank = languageRank(right, priorities);
    return leftRank - rightRank;
  });
}

function languageRank(subtitle, priorities) {
  const lan = String(subtitle?.lan || '');
  const direct = priorities.indexOf(lan);
  if (direct >= 0) return direct;
  return /中文|汉语|華語/.test(String(subtitle?.lan_doc || '')) ? priorities.length : priorities.length + 1;
}

function trustedSubtitleUrl(value) {
  const normalized = String(value || '').startsWith('//') ? `https:${value}` : String(value || '');
  const parsed = new URL(normalized);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !TRUSTED_SUBTITLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    const error = new Error('B站返回了不受信任的字幕地址。');
    error.code = 'adapter_unavailable';
    throw error;
  }
  return parsed.toString();
}

function toWebVtt(cues) {
  const body = cues
    .map((cue, index) => [
      String(index + 1),
      `${vttTime(cue.from)} --> ${vttTime(cue.to)}`,
      String(cue.content).replace(/\r/g, '').replace(/-->/g, '→').trim()
    ].join('\n'))
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function validCues(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((cue) => {
    const from = Number(cue?.from);
    const to = Number(cue?.to);
    return Number.isFinite(from) && Number.isFinite(to) && to > from && String(cue?.content || '').trim();
  });
}

function assertUsefulCoverage(cues, durationSeconds) {
  const duration = positiveNumber(durationSeconds);
  const textCharacters = cues.reduce((total, cue) => total + String(cue.content || '').replace(/\s/g, '').length, 0);
  const minimumCues = duration && duration <= 20 ? 1 : 3;
  const minimumCharacters = duration && duration <= 20 ? 8 : 20;
  const coverage = coverageRatio(cues, duration);
  if (cues.length < minimumCues || textCharacters < minimumCharacters || (duration && coverage < 0.75)) {
    throw capabilityUnavailable('B站原生字幕覆盖不足，不能作为完整转录使用。');
  }
}

function coverageRatio(cues, durationSeconds) {
  const duration = positiveNumber(durationSeconds);
  if (!duration || cues.length === 0) return null;
  const lastCueEnd = Math.max(...cues.map((cue) => Number(cue.to) || 0));
  return Math.min(1, Math.max(0, lastCueEnd / duration));
}

function vttTime(value) {
  const totalMilliseconds = Math.max(0, Math.round(Number(value) * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function safeLanguage(value) {
  return String(value || 'unknown').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'unknown';
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function capabilityUnavailable(message) {
  const error = new Error(message);
  error.code = 'capability_not_available';
  return error;
}

function normalizeLocalUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
