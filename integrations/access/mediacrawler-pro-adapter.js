import net from 'node:net';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROVIDERS = {
  xhs: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  dy: ['douyin.com', 'iesdouyin.com'],
  bili: ['bilibili.com', 'b23.tv'],
  ks: ['kuaishou.com', 'chenzhongtech.com']
};

export class MediaCrawlerProAdapter {
  constructor({ cookieBridgeUrl, downloadServerUrl, fetchImpl = fetch } = {}) {
    this.id = 'mediacrawlerpro-specialized-content';
    this.versionRef = 'local-cookiebridge-v1';
    this.capabilities = ['basic_content', 'images', 'media'];
    this.accessMode = 'authorized';
    this.priorityClass = 'specialized';
    this.runtimeRequirements = ['content', 'media_transcription', 'visual_analysis'];
    this.fetchImpl = fetchImpl;
    this.cookieBridgeUrl = normalizeLocalUrl(cookieBridgeUrl);
    this.downloadServerUrl = normalizeLocalUrl(downloadServerUrl);
    this.healthStatus = this.cookieBridgeUrl && this.downloadServerUrl ? 'healthy' : 'unavailable';
  }

  matches(source) {
    try { return Boolean(this.providerFor(source)); } catch { return false; }
  }

  providerFor(source) {
    const host = new URL(source).hostname.toLowerCase();
    return Object.entries(PROVIDERS).find(([, domains]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`)))?.[0] || null;
  }

  async acquire({ source, connectionUse, workspace, runtimeRequirement }) {
    const provider = this.providerFor(source);
    if (!provider) throw new Error('MediaCrawlerPro 不支持此来源。');
    if (connectionUse?.credentialKind !== 'cookie_bridge' || !connectionUse.cookieBridgeClientId) {
      const error = new Error('该平台需要通过 CookieBridge 建立受控连接。');
      error.code = 'connection_required';
      throw error;
    }
    let cookies = '';
    try {
      const resolvedSource = await this.resolveSource(source, provider);
      cookies = await this.readCookies(provider, connectionUse.cookieBridgeClientId);
      const response = await this.fetchImpl(`${this.downloadServerUrl}/api/v1/content_detail`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: provider, content_url: resolvedSource, cookies })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.isok === false || payload.biz_code) throw new Error('MediaCrawlerPro 内容读取未成功。');
      const normalized = normalizeContent(payload?.data?.content, { runtimeRequirement });
      if (['remote_media', 'remote_audio'].includes(normalized.runtime?.kind) && workspace) {
        normalized.runtime = await this.downloadAuthorizedMedia({
          source:resolvedSource,
          mediaUrl:normalized.runtime.url,
          cookies,
          workspace,
          kind:normalized.runtime.kind === 'remote_audio' ? 'audio' : 'video'
        });
      }
      return normalized;
    } catch (error) {
      if (error?.code === 'connection_required') throw error;
      throw new Error('MediaCrawlerPro 深度读取当前不可用。');
    } finally {
      cookies = '';
    }
  }

  async collectMetrics({ source, connectionUse, historyLimit = 20 }) {
    const provider = this.providerFor(source);
    if (!['xhs', 'dy'].includes(provider)) {
      const error = new Error('当前只支持读取小红书和抖音作品指标。');
      error.code = 'capability_not_available';
      throw error;
    }
    assertCookieBridgeConnection(connectionUse);
    const limit = Math.max(5, Math.min(Number(historyLimit) || 20, 20));
    let cookies = '';
    try {
      const resolvedSource = await this.resolveSource(source, provider);
      cookies = await this.readCookies(provider, connectionUse.cookieBridgeClientId);
      const detailPayload = await this.postDownloadServer('/api/v1/content_detail', {
        platform:provider,
        content_url:resolvedSource,
        cookies
      });
      const detail = detailPayload?.data?.content || {};
      const currentWork = sanitizeMetricWork(normalizeMetricWork(detail, source));
      const detailAuthor = normalizeMetricAuthor(detail.author, provider);
      const base = {
        schemaVersion:'agent.army/boom-metrics-bundle/v1',
        platform:publicPlatform(provider),
        sourceUrl:source,
        observedAt:new Date().toISOString(),
        currentWork,
        historyWorks:[],
        historyOrder:'creator_feed_desc',
        sampleCount:0,
        acquisition:{
          adapterId:this.id,
          versionRef:this.versionRef,
          source:'mediacrawlerpro'
        }
      };
      if (!detailAuthor.id || !detailAuthor.profileUrl) {
        return {
          ...base,
          status:'metrics_unavailable',
          unavailableReasons:['creator_identity_unavailable'],
          creator:{ ...detailAuthor, followerCount:null }
        };
      }

      const creatorPayload = await this.postDownloadServer('/api/v1/creator_query', {
        platform:provider,
        creator_url:detailAuthor.profileUrl,
        cookies
      });
      const creatorInfo = creatorPayload?.data || {};
      const creator = {
        id:String(creatorInfo.user_id || detailAuthor.id).trim(),
        name:String(creatorInfo.nickname || detailAuthor.name || '').trim() || null,
        followerCount:normalizeExactCount(creatorInfo.follower_count),
        profileUrl:detailAuthor.profileUrl
      };

      const historyWorks = [];
      const seenIds = new Set();
      const targetId = String(currentWork.id || '').trim();
      let cursor = '';
      let hasMore = true;
      let pageCount = 0;
      while (hasMore && historyWorks.length < limit && pageCount < 5) {
        const listPayload = await this.postDownloadServer('/api/v1/creator_contents', {
          platform:provider,
          creator_id:creator.id,
          cursor,
          cookies
        });
        const page = listPayload?.data || {};
        const contents = Array.isArray(page.contents) ? page.contents : [];
        for (const content of contents) {
          const work = normalizeMetricWork(content);
          if (!work.id || work.id === targetId || seenIds.has(work.id)) continue;
          seenIds.add(work.id);
          historyWorks.push(work);
          if (historyWorks.length >= limit) break;
        }
        pageCount += 1;
        hasMore = page.has_more === true && Boolean(String(page.next_cursor || '').trim());
        cursor = hasMore ? String(page.next_cursor) : '';
      }

      const enrichedHistoryWorks = (await this.enrichHistoryMetrics(provider, historyWorks, cookies))
        .map(sanitizeMetricWork);
      const sampleCount = enrichedHistoryWorks.filter((work) => hasCoreMetric(provider, work)).length;
      const unavailableReasons = [];
      if (!creator.followerCount || creator.followerCount <= 0) unavailableReasons.push('follower_count_unavailable');
      if (!hasCoreMetric(provider, currentWork)) unavailableReasons.push('current_work_metric_unavailable');
      return {
        ...base,
        status:unavailableReasons.length ? 'metrics_unavailable' : sampleCount < 5 ? 'insufficient_history' : 'collected',
        ...(unavailableReasons.length ? { unavailableReasons } : {}),
        creator,
        historyWorks:enrichedHistoryWorks,
        sampleCount
      };
    } finally {
      cookies = '';
    }
  }

  async resolveSource(source, provider) {
    if (provider !== 'xhs' || !isXhsShortUrl(source)) return source;
    try {
      const response = await this.fetchImpl(source, {
        method:'GET',
        redirect:'follow',
        headers:{
          Accept:'text/html,application/xhtml+xml',
          'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'
        }
      });
      const resolved = new URL(response.url);
      if (!response.ok || !isXhsContentHost(resolved.hostname)) throw new Error('unexpected redirect target');
      const discoveryMatch = resolved.pathname.match(/^\/discovery\/item\/([^/]+)\/?$/);
      if (discoveryMatch) resolved.pathname = `/explore/${discoveryMatch[1]}`;
      if (!/^\/explore\/[^/]+\/?$/.test(resolved.pathname)) throw new Error('unsupported xhs content path');
      return resolved.toString();
    } catch {
      const error = new Error('小红书分享短链解析失败。');
      error.code = 'adapter_unavailable';
      throw error;
    }
  }

  async enrichHistoryMetrics(provider, historyWorks, cookies) {
    if (provider !== 'xhs') return historyWorks;
    const enriched = [...historyWorks];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < enriched.length) {
        const index = nextIndex++;
        const work = enriched[index];
        if (hasCoreMetric(provider, work) || !isPublicHttpUrl(work.sourceUrl)) continue;
        try {
          const payload = await this.postDownloadServer('/api/v1/content_detail', {
            platform:provider,
            content_url:work.sourceUrl,
            cookies
          });
          const detail = normalizeMetricWork(payload?.data?.content || {}, work.sourceUrl);
          if (detail.id && detail.id === work.id) enriched[index] = detail;
        } catch {
          // A missing/deleted history item must not invalidate the current work.
        }
      }
    };
    await Promise.all(Array.from({ length:Math.min(4, enriched.length) }, worker));
    return enriched;
  }

  async postDownloadServer(pathname, body) {
    const response = await this.fetchImpl(`${this.downloadServerUrl}${pathname}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.isok === false || payload.biz_code) {
      const error = new Error('MediaCrawlerPro 指标读取未成功。');
      error.code = 'adapter_unavailable';
      throw error;
    }
    return payload;
  }

  async readCookies(provider, clientId) {
    const target = new URL(`/api/cookies/${provider}`, this.cookieBridgeUrl);
    target.searchParams.set('client_id', clientId);
    const response = await this.fetchImpl(target, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    const cookies = payload?.data?.cookies;
    if (!response.ok || payload.isok === false || typeof cookies !== 'string' || !cookies) {
      const error = new Error('CookieBridge 没有可用登录状态。');
      error.code = 'connection_required';
      throw error;
    }
    return cookies;
  }

  async downloadAuthorizedMedia({ source, mediaUrl, cookies, workspace, kind = 'video' }) {
    const response = await this.fetchImpl(mediaUrl, {
      headers: {
        Accept: '*/*',
        Cookie: cookies,
        Referer: new URL(source).origin,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'
      }
    });
    if (!response.ok || !response.body) {
      const error = new Error('已授权媒体下载被平台拒绝。');
      error.code = 'authorization_required';
      throw error;
    }
    await fs.mkdir(workspace, { recursive: true });
    const outputPath = path.join(workspace, kind === 'audio' ? 'authorized-audio.m4a' : 'authorized-source.mp4');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath, { flags: 'w' }));
    return { kind, path: outputPath };
  }
}

function assertCookieBridgeConnection(connectionUse) {
  if (connectionUse?.credentialKind === 'cookie_bridge' && connectionUse.cookieBridgeClientId) return;
  const error = new Error('该平台需要通过 CookieBridge 建立受控连接。');
  error.code = 'connection_required';
  throw error;
}

function isXhsShortUrl(source) {
  try {
    return ['xhslink.cn', 'xhslink.com'].includes(new URL(source).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isXhsContentHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
}

function publicPlatform(provider) {
  return provider === 'xhs' ? 'xiaohongshu' : 'douyin';
}

function normalizeMetricAuthor(value, provider) {
  const author = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = String(provider === 'dy' ? author.sec_uid || author.user_id || '' : author.user_id || '').trim();
  const profileUrl = isPublicHttpUrl(author.profile_url)
    ? author.profile_url
    : id
      ? provider === 'dy'
        ? `https://www.douyin.com/user/${encodeURIComponent(id)}`
        : `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(id)}`
      : null;
  return {
    id:id || null,
    name:String(author.nickname || author.name || '').trim() || null,
    profileUrl
  };
}

function normalizeMetricWork(content = {}, sourceFallback = null) {
  const interaction = content.interaction && typeof content.interaction === 'object' ? content.interaction : {};
  return {
    id:String(content.id || '').trim() || null,
    title:String(content.title || '').trim().slice(0, 500),
    sourceUrl:isPublicHttpUrl(content.url) ? content.url : sourceFallback,
    likes:normalizeExactCount(interaction.liked_count),
    favorites:normalizeExactCount(interaction.collected_count),
    plays:normalizeExactCount(interaction.play_count),
    comments:normalizeExactCount(interaction.comment_count),
    shares:normalizeExactCount(interaction.share_count)
  };
}

function sanitizeMetricWork(work) {
  if (!work?.sourceUrl) return work;
  try {
    const source = new URL(work.sourceUrl);
    source.search = '';
    source.hash = '';
    return { ...work, sourceUrl:source.toString() };
  } catch {
    return { ...work, sourceUrl:null };
  }
}

function normalizeExactCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll(',', '');
  if (!/^\d+$/.test(normalized)) return null;
  const count = Number(normalized);
  return Number.isSafeInteger(count) ? count : null;
}

function hasCoreMetric(provider, work) {
  if (!Number.isInteger(work?.likes)) return false;
  return provider !== 'xhs' || Number.isInteger(work?.favorites);
}

function normalizeLocalUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopback(parsed.hostname)) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch { return ''; }
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function normalizeContent(content = {}, { runtimeRequirement } = {}) {
  const images = Array.isArray(content.image_urls) ? content.image_urls.filter(Boolean) : [];
  const video = isPublicHttpUrl(content.video_download_url) ? content.video_download_url : null;
  const audio = isPublicHttpUrl(content.extria_info?.audio_url) ? content.extria_info.audio_url : null;
  const durationSeconds = Number(content.extria_info?.duration);
  const basic = {
    title: String(content.title || '').slice(0, 500),
    description: String(content.desc || '').slice(0, 16000),
    sourceUrl: content.url || null,
    author: normalizeAuthor(content.author),
    interaction: content.interaction || null,
    contentType: content.content_type || null,
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : {})
  };
  const contentItems = { basic_content: basic };
  if (images.length) contentItems.images = images.map((url) => ({ url }));
  if (video || audio) {
    contentItems.media = [
      ...(video ? [{ url:video, role:'video' }] : []),
      ...(audio ? [{ url:audio, role:'audio' }] : [])
    ];
  }
  const providedCapabilities = ['basic_content'];
  if (images.length) providedCapabilities.push('images');
  if (video || audio) providedCapabilities.push('media');
  return {
    providedCapabilities,
    contentItems,
    runtime: runtimeRequirement === 'visual_analysis'
      ? video ? { kind:'remote_media', url:video } : {}
      : audio ? { kind:'remote_audio', url:audio } : video ? { kind:'remote_media', url:video } : {},
    capabilityNotes: '已通过已授权的 MediaCrawlerPro 深度通道读取内容结构与平台字段。'
  };
}

function normalizeAuthor(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value.name || value.nickname || value.display_name || value.unique_id || value.id;
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate).trim() || null
    : null;
}

function isPublicHttpUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (!net.isIP(host)) return true;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    if (host.includes(':')) return true;
    const [a, b] = host.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
  } catch { return false; }
}
