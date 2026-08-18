import net from 'node:net';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ConnectionUse } from './connection-broker.ts';
import type {
  AdapterAcquireInput,
  AdapterAcquireResult,
  AdapterMetricsInput,
  ContentAcquisitionAdapter,
} from './content-acquisition-contracts.ts';

const PROVIDERS = {
  xhs: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  dy: ['douyin.com', 'iesdouyin.com'],
  bili: ['bilibili.com', 'b23.tv'],
  ks: ['kuaishou.com', 'chenzhongtech.com']
} as const;
type Provider = keyof typeof PROVIDERS;
type JsonObject = Record<string, any>;
type FetchImplementation = typeof fetch;
type MetricWork = Readonly<{
  id: string | null;
  title: string;
  sourceUrl: string | null;
  publishedAt?: string;
  publishTimeSource?: 'platform_field' | 'douyin_aweme_id';
  likes: number | null;
  favorites: number | null;
  plays: number | null;
  comments: number | null;
  shares: number | null;
}>;
type NormalizedContent = AdapterAcquireResult & {
  runtime: { kind?: string; url?: string; path?: string };
};

export class MediaCrawlerProAdapter implements ContentAcquisitionAdapter {
  readonly id = 'mediacrawlerpro-specialized-content';
  readonly versionRef = 'local-cookiebridge-v1';
  readonly capabilities = ['basic_content', 'images', 'media'] as const;
  readonly accessMode = 'authorized' as const;
  readonly priorityClass = 'specialized' as const;
  readonly runtimeRequirements = ['content', 'media_transcription', 'visual_analysis'] as const;
  readonly healthStatus: 'healthy' | 'unavailable';
  private readonly fetchImpl: FetchImplementation;
  private readonly cookieBridgeUrl: string;
  private readonly downloadServerUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly metricsTimeoutMs: number;
  private readonly mediaTimeoutMs: number;
  private readonly healthProbeTimeoutMs: number;

  constructor({ cookieBridgeUrl, downloadServerUrl, fetchImpl = fetch, requestTimeoutMs = 8_000, metricsTimeoutMs = 45_000, mediaTimeoutMs = 60_000, healthProbeTimeoutMs = 1_000 }: Readonly<{
    cookieBridgeUrl?: string;
    downloadServerUrl?: string;
    fetchImpl?: FetchImplementation;
    requestTimeoutMs?: number;
    metricsTimeoutMs?: number;
    mediaTimeoutMs?: number;
    healthProbeTimeoutMs?: number;
  }> = {}) {
    this.fetchImpl = fetchImpl;
    this.cookieBridgeUrl = normalizeLocalUrl(cookieBridgeUrl);
    this.downloadServerUrl = normalizeLocalUrl(downloadServerUrl);
    this.healthStatus = this.cookieBridgeUrl && this.downloadServerUrl ? 'healthy' : 'unavailable';
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs, 50, 30_000, 8_000);
    this.metricsTimeoutMs = boundedTimeout(metricsTimeoutMs, this.requestTimeoutMs, 55_000, 45_000);
    this.mediaTimeoutMs = boundedTimeout(mediaTimeoutMs, this.requestTimeoutMs, 10 * 60_000, 60_000);
    this.healthProbeTimeoutMs = boundedTimeout(healthProbeTimeoutMs, 50, 5_000, 1_000);
  }

  async probeHealth() {
    const checkedAt = new Date().toISOString();
    if (!this.cookieBridgeUrl || !this.downloadServerUrl) {
      return { status:'unavailable' as const, checkedAt, detail:'本机采集服务地址未完整配置。', checks:{ cookieBridgeTransport:false, downloadServerTransport:false } };
    }
    const [cookieBridgeTransport, downloadServerTransport] = await Promise.all([
      probeLoopbackTransport(this.cookieBridgeUrl, this.healthProbeTimeoutMs),
      probeLoopbackTransport(this.downloadServerUrl, this.healthProbeTimeoutMs),
    ]);
    const ready = cookieBridgeTransport && downloadServerTransport;
    return {
      status:ready ? 'healthy' as const : 'unavailable' as const,
      checkedAt,
      detail:ready ? 'CookieBridge 与 DownloadServer 本机传输均可达；具体平台作品仍需实际读取验证。' : 'CookieBridge 或 DownloadServer 本机传输不可达。',
      checks:{ cookieBridgeTransport, downloadServerTransport },
    };
  }

  matches(source: string): boolean {
    try { return Boolean(this.providerFor(source)); } catch { return false; }
  }

  providerFor(source: string): Provider | null {
    const host = new URL(source).hostname.toLowerCase();
    const match = (Object.entries(PROVIDERS) as Array<[Provider, readonly string[]]>)
      .find(([, domains]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
    return match?.[0] || null;
  }

  async acquire({ source, connectionUse, workspace, runtimeRequirement }: AdapterAcquireInput): Promise<AdapterAcquireResult> {
    const provider = this.providerFor(source);
    if (!provider) throw new Error('MediaCrawlerPro 不支持此来源。');
    assertCookieBridgeConnection(connectionUse);
    let cookies = '';
    try {
      const resolvedSource = await this.resolveSource(source, provider);
      cookies = await this.readCookies(provider, connectionUse.cookieBridgeClientId);
      const response = await this.fetchImpl(`${this.downloadServerUrl}/api/v1/content_detail`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: provider, content_url: resolvedSource, cookies }),
        signal:AbortSignal.timeout(this.requestTimeoutMs),
      });
      const payload = await response.json().catch(() => ({})) as JsonObject;
      if (!response.ok || payload.isok === false || payload.biz_code) throw new Error('MediaCrawlerPro 内容读取未成功。');
      const normalized = normalizeContent(payload?.data?.content, { runtimeRequirement, provider });
      if (normalized.runtime.kind && ['remote_media', 'remote_audio'].includes(normalized.runtime.kind) && normalized.runtime.url && workspace) {
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
      if (errorCode(error) === 'connection_required') throw error;
      throw new Error('MediaCrawlerPro 深度读取当前不可用。');
    } finally {
      cookies = '';
    }
  }

  async collectMetrics({ source, connectionUse, historyLimit = 20 }: AdapterMetricsInput): Promise<unknown> {
    const provider = this.providerFor(source);
    if (provider !== 'xhs' && provider !== 'dy' && provider !== 'bili') {
      throw codedError('当前深度指标通道只支持小红书、抖音和 B站作品。', 'capability_not_available');
    }
    assertCookieBridgeConnection(connectionUse);
    const limit = Math.max(5, Math.min(Number(historyLimit) || 20, 20));
    const metricsSignal = AbortSignal.timeout(this.metricsTimeoutMs);
    let cookies = '';
    try {
      const resolvedSource = await this.resolveSource(source, provider, metricsSignal);
      cookies = await this.readCookies(provider, connectionUse.cookieBridgeClientId, metricsSignal);
      const detailPayload = await this.postDownloadServer('/api/v1/content_detail', {
        platform:provider,
        content_url:resolvedSource,
        cookies
      }, metricsSignal);
      const detail = detailPayload?.data?.content || {};
      const currentWork = sanitizeMetricWork(normalizeMetricWork(detail, source, provider));
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
      }, metricsSignal);
      const creatorInfo = creatorPayload?.data || {};
      const creator = {
        id:String(creatorInfo.user_id || detailAuthor.id).trim(),
        name:String(creatorInfo.nickname || detailAuthor.name || '').trim() || null,
        followerCount:normalizeExactCount(creatorInfo.follower_count),
        profileUrl:detailAuthor.profileUrl
      };

      const historyWorks: MetricWork[] = [];
      const seenIds = new Set<string>();
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
        }, metricsSignal);
        const page = listPayload?.data || {};
        const contents = Array.isArray(page.contents) ? page.contents : [];
        for (const content of contents) {
          const work = normalizeMetricWork(content, null, provider);
          if (!work.id || work.id === targetId || seenIds.has(work.id)) continue;
          seenIds.add(work.id);
          historyWorks.push(work);
          if (historyWorks.length >= limit) break;
        }
        pageCount += 1;
        hasMore = page.has_more === true && Boolean(String(page.next_cursor || '').trim());
        cursor = hasMore ? String(page.next_cursor) : '';
      }

      const enrichedHistoryWorks = (await this.enrichHistoryMetrics(provider, historyWorks, cookies, metricsSignal))
        .map(sanitizeMetricWork);
      const sampleCount = enrichedHistoryWorks.filter((work) => hasCoreMetric(provider, work)).length;
      const unavailableReasons: string[] = [];
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
    } catch (error) {
      if (isTimeoutError(error) || metricsSignal.aborted)
        throw codedError('MediaCrawlerPro 指标读取超过受控时限。', 'provider_timeout');
      throw error;
    } finally {
      cookies = '';
    }
  }

  async resolveSource(source: string, provider: Provider, parentSignal: AbortSignal | null = null): Promise<string> {
    if (provider !== 'xhs' || !isXhsShortUrl(source)) return source;
    try {
      const response = await this.fetchImpl(source, {
        method:'GET',
        redirect:'follow',
        headers:{
          Accept:'text/html,application/xhtml+xml',
          'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'
        },
        signal:requestSignal(this.requestTimeoutMs, parentSignal),
      });
      let resolved = new URL(response.url);
      if (resolved.pathname === '/login') {
        const redirectPath = resolved.searchParams.get('redirectPath');
        if (!redirectPath) throw new Error('missing xhs login redirect path');
        resolved = new URL(redirectPath);
      }
      if (!response.ok || !isXhsContentHost(resolved.hostname)) throw new Error('unexpected redirect target');
      const discoveryMatch = resolved.pathname.match(/^\/discovery\/item\/([^/]+)\/?$/);
      if (discoveryMatch) resolved.pathname = `/explore/${discoveryMatch[1]}`;
      if (!/^\/explore\/[^/]+\/?$/.test(resolved.pathname)) throw new Error('unsupported xhs content path');
      return resolved.toString();
    } catch {
      throw codedError('小红书分享短链解析失败。', 'adapter_unavailable');
    }
  }

  async enrichHistoryMetrics(provider: Provider, historyWorks: readonly MetricWork[], cookies: string, parentSignal: AbortSignal | null = null): Promise<MetricWork[]> {
    if (provider !== 'xhs' && provider !== 'bili') return [...historyWorks];
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
          }, parentSignal);
          const detail = normalizeMetricWork(payload?.data?.content || {}, work.sourceUrl, provider);
          if (detail.id && detail.id === work.id) enriched[index] = detail;
        } catch {
          // A missing/deleted history item must not invalidate the current work.
        }
      }
    };
    await Promise.all(Array.from({ length:Math.min(4, enriched.length) }, worker));
    return enriched;
  }

  async postDownloadServer(pathname: string, body: Readonly<Record<string, unknown>>, parentSignal: AbortSignal | null = null): Promise<JsonObject> {
    const response = await this.fetchImpl(`${this.downloadServerUrl}${pathname}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(body),
      signal:requestSignal(this.requestTimeoutMs, parentSignal),
    });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok || payload.isok === false || payload.biz_code) {
      throw codedError('MediaCrawlerPro 指标读取未成功。', 'adapter_unavailable');
    }
    return payload;
  }

  async readCookies(provider: Provider, clientId: string, parentSignal: AbortSignal | null = null): Promise<string> {
    const target = new URL(`/api/cookies/${provider}`, this.cookieBridgeUrl);
    target.searchParams.set('client_id', clientId);
    const response = await this.fetchImpl(target, { headers: { Accept: 'application/json' }, signal:requestSignal(this.requestTimeoutMs, parentSignal) });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    const cookies = payload?.data?.cookies;
    if (!response.ok || payload.isok === false || typeof cookies !== 'string' || !cookies) {
      throw codedError('CookieBridge 没有可用登录状态。', 'connection_required');
    }
    return cookies;
  }

  async downloadAuthorizedMedia({ source, mediaUrl, cookies, workspace, kind = 'video' }: Readonly<{
    source: string;
    mediaUrl: string;
    cookies: string;
    workspace: string;
    kind?: 'audio' | 'video';
  }>): Promise<{ kind: string; path: string }> {
    const response = await this.fetchImpl(mediaUrl, {
      headers: {
        Accept: '*/*',
        Cookie: cookies,
        Referer: new URL(source).origin,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36'
      },
      signal:AbortSignal.timeout(this.mediaTimeoutMs),
    });
    if (!response.ok || !response.body) {
      throw codedError('已授权媒体下载被平台拒绝。', 'authorization_required');
    }
    await fs.mkdir(workspace, { recursive: true });
    const outputPath = path.join(workspace, kind === 'audio' ? 'authorized-audio.m4a' : 'authorized-source.mp4');
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      createWriteStream(outputPath, { flags: 'w' }),
    );
    return { kind, path: outputPath };
  }
}

function boundedTimeout(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(minimum, Math.min(Math.trunc(normalized), maximum)) : fallback;
}

function requestSignal(timeoutMs: number, parentSignal: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function isTimeoutError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
  return name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out|超时/i.test(error instanceof Error ? error.message : String(error));
}

function probeLoopbackTransport(value: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL(value);
    const socket = net.createConnection({ host:target.hostname, port:Number(target.port || (target.protocol === 'https:' ? 443 : 80)) });
    const finish = (ready: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function assertCookieBridgeConnection(connectionUse: ConnectionUse | null): asserts connectionUse is ConnectionUse & { cookieBridgeClientId: string } {
  if (connectionUse?.credentialKind === 'cookie_bridge' && typeof connectionUse.cookieBridgeClientId === 'string' && connectionUse.cookieBridgeClientId) return;
  throw codedError('该平台需要通过 CookieBridge 建立受控连接。', 'connection_required');
}

function isXhsShortUrl(source: string): boolean {
  try {
    return ['xhslink.cn', 'xhslink.com'].includes(new URL(source).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isXhsContentHost(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase();
  return host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
}

function publicPlatform(provider: 'xhs' | 'dy' | 'bili'): string {
  return provider === 'xhs' ? 'xiaohongshu' : provider === 'bili' ? 'bilibili' : 'douyin';
}

function normalizeMetricAuthor(value: unknown, provider: 'xhs' | 'dy' | 'bili') {
  const author: JsonObject = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
  const id = String(provider === 'dy'
    ? author.sec_uid || author.user_id || ''
    : provider === 'bili'
      ? author.mid || author.user_id || author.id || ''
      : author.user_id || '').trim();
  const profileUrl = isPublicHttpUrl(author.profile_url)
    ? author.profile_url
    : id
      ? provider === 'dy'
        ? `https://www.douyin.com/user/${encodeURIComponent(id)}`
        : provider === 'bili'
          ? `https://space.bilibili.com/${encodeURIComponent(id)}`
          : `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(id)}`
      : null;
  return {
    id:id || null,
    name:String(author.nickname || author.name || '').trim() || null,
    profileUrl
  };
}

function normalizeMetricWork(contentValue: unknown = {}, sourceFallback: string | null = null, provider: Provider | null = null): MetricWork {
  const content: JsonObject = contentValue && typeof contentValue === 'object' ? contentValue as JsonObject : {};
  const interaction = content.interaction && typeof content.interaction === 'object' ? content.interaction : {};
  const platformPublishedAt = normalizePublishedAt(publishTimeValue(content));
  const derivedPublishedAt = provider === 'dy' ? douyinPublishedAtFromAwemeId(content.id) : null;
  const publishedAt = platformPublishedAt || derivedPublishedAt;
  return {
    id:String(content.id || '').trim() || null,
    title:String(content.title || '').trim().slice(0, 500),
    sourceUrl:isPublicHttpUrl(content.url) ? content.url : sourceFallback,
    ...(publishedAt ? {
      publishedAt,
      publishTimeSource:platformPublishedAt ? 'platform_field' as const : 'douyin_aweme_id' as const
    } : {}),
    likes:normalizeExactCount(interaction.liked_count),
    favorites:normalizeExactCount(interaction.collected_count),
    plays:normalizeExactCount(interaction.play_count),
    comments:normalizeExactCount(interaction.comment_count),
    shares:normalizeExactCount(interaction.share_count)
  };
}

function publishTimeValue(content: JsonObject): unknown {
  const extra = content.extria_info && typeof content.extria_info === 'object'
    ? content.extria_info as JsonObject
    : {};
  return content.published_at
    ?? content.publishedAt
    ?? content.publish_time
    ?? content.publishTime
    ?? content.create_time
    ?? content.createTime
    ?? extra.published_at
    ?? extra.publish_time
    ?? extra.create_time;
}

function normalizePublishedAt(value: unknown): string | null {
  if (value == null || value === '') return null;
  let timestamp = NaN;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } else if (typeof value === 'string') {
    timestamp = Date.parse(value.trim());
  }
  const earliest = Date.UTC(2000, 0, 1);
  const latest = Date.now() + 24 * 60 * 60 * 1000;
  return Number.isFinite(timestamp) && timestamp >= earliest && timestamp <= latest
    ? new Date(timestamp).toISOString()
    : null;
}

function douyinPublishedAtFromAwemeId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  if (!/^\d{18,20}$/.test(id)) return null;
  try {
    const seconds = Number(BigInt(id) >> 32n);
    const publishedAt = normalizePublishedAt(seconds);
    return publishedAt && Date.parse(publishedAt) >= Date.UTC(2016, 8, 1) ? publishedAt : null;
  } catch {
    return null;
  }
}

function sanitizeMetricWork(work: MetricWork): MetricWork {
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

function normalizeExactCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll(',', '');
  if (!/^\d+$/.test(normalized)) return null;
  const count = Number(normalized);
  return Number.isSafeInteger(count) ? count : null;
}

function hasCoreMetric(provider: Provider, work: MetricWork): boolean {
  if (!Number.isInteger(work?.likes)) return false;
  return provider !== 'xhs' || Number.isInteger(work?.favorites);
}

function normalizeLocalUrl(value: unknown): string {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopback(parsed.hostname)) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch { return ''; }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function normalizeContent(contentValue: unknown = {}, { runtimeRequirement, provider = null }: Readonly<{ runtimeRequirement?: string | null; provider?: Provider | null }> = {}): NormalizedContent {
  const content: JsonObject = contentValue && typeof contentValue === 'object' ? contentValue as JsonObject : {};
  const images = Array.isArray(content.image_urls) ? content.image_urls.filter(Boolean) : [];
  const video = isPublicHttpUrl(content.video_download_url) ? content.video_download_url : null;
  const audio = isPublicHttpUrl(content.extria_info?.audio_url) ? content.extria_info.audio_url : null;
  const durationSeconds = Number(content.extria_info?.duration);
  const publishedAt = normalizePublishedAt(publishTimeValue(content))
    || (provider === 'dy' ? douyinPublishedAtFromAwemeId(content.id) : null);
  const basic = {
    title: String(content.title || '').slice(0, 500),
    description: String(content.desc || '').slice(0, 16000),
    sourceUrl: content.url || null,
    author: normalizeAuthor(content.author),
    interaction: content.interaction || null,
    contentType: content.content_type || null,
    ...(publishedAt ? { publishedAt } : {}),
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : {})
  };
  const contentItems: Record<string, unknown> = { basic_content: basic };
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

function normalizeAuthor(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const author = value as JsonObject;
  const candidate = author.name || author.nickname || author.display_name || author.unique_id || author.id;
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate).trim() || null
    : null;
}

function isPublicHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
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

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}
