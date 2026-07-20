import net from 'node:net';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROVIDERS = {
  xhs: ['xiaohongshu.com', 'xhslink.com'],
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
    this.runtimeRequirements = ['content', 'media_transcription'];
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

  async acquire({ source, connectionUse, workspace }) {
    const provider = this.providerFor(source);
    if (!provider) throw new Error('MediaCrawlerPro 不支持此来源。');
    if (connectionUse?.credentialKind !== 'cookie_bridge' || !connectionUse.cookieBridgeClientId) {
      const error = new Error('该平台需要通过 CookieBridge 建立受控连接。');
      error.code = 'connection_required';
      throw error;
    }
    let cookies = '';
    try {
      cookies = await this.readCookies(provider, connectionUse.cookieBridgeClientId);
      const response = await this.fetchImpl(`${this.downloadServerUrl}/api/v1/content_detail`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: provider, content_url: source, cookies })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.isok === false || payload.biz_code) throw new Error('MediaCrawlerPro 内容读取未成功。');
      const normalized = normalizeContent(payload?.data?.content);
      if (normalized.runtime?.kind === 'remote_media' && workspace) {
        normalized.runtime = await this.downloadAuthorizedMedia({ source, mediaUrl: normalized.runtime.url, cookies, workspace });
      }
      return normalized;
    } catch (error) {
      if (error?.code === 'connection_required') throw error;
      throw new Error('MediaCrawlerPro 深度读取当前不可用。');
    } finally {
      cookies = '';
    }
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

  async downloadAuthorizedMedia({ source, mediaUrl, cookies, workspace }) {
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
    const outputPath = path.join(workspace, 'authorized-source.mp4');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath, { flags: 'w' }));
    return { kind: 'video', path: outputPath };
  }
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

function normalizeContent(content = {}) {
  const images = Array.isArray(content.image_urls) ? content.image_urls.filter(Boolean) : [];
  const video = isPublicHttpUrl(content.video_download_url) ? content.video_download_url : null;
  const basic = {
    title: String(content.title || '').slice(0, 500),
    description: String(content.desc || '').slice(0, 16000),
    sourceUrl: content.url || null,
    author: content.author || null,
    interaction: content.interaction || null,
    contentType: content.content_type || null
  };
  const contentItems = { basic_content: basic };
  if (images.length) contentItems.images = images.map((url) => ({ url }));
  if (video) contentItems.media = [{ url: video }];
  const providedCapabilities = ['basic_content'];
  if (images.length) providedCapabilities.push('images');
  if (video) providedCapabilities.push('media');
  return {
    providedCapabilities,
    contentItems,
    runtime: video ? { kind: 'remote_media', url: video } : {},
    capabilityNotes: '已通过已授权的 MediaCrawlerPro 深度通道读取内容结构与平台字段。'
  };
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
