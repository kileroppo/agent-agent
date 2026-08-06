const SEARCH_PROVIDERS = [
  { id:'duckduckgo', endpoint:'https://html.duckduckgo.com/html/', query:(query) => `?q=${encodeURIComponent(query)}`, extract:extractDuckDuckGoResults },
  { id:'bing', endpoint:'https://www.bing.com/search', query:(query) => `?q=${encodeURIComponent(query)}`, extract:extractBingResults }
];

export class PublicWebSearch {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }

  async search({ query, limit = 3 } = {}) {
    const normalized = String(query || '').replace(/\s+/g, ' ').trim();
    if (normalized.length < 2) throw new PublicWebSearchError('query_required', '请说明想查什么公开资料。');
    const count = Math.min(Math.max(Number(limit) || 3, 1), 5);
    let reachableProvider = false;
    for (const provider of SEARCH_PROVIDERS) {
      try {
        const response = await this.fetch(`${provider.endpoint}${provider.query(normalized)}`, { headers:{ accept:'text/html' }, signal:AbortSignal.timeout(8000), timeoutMs:8000 });
        if (!response.ok) continue;
        reachableProvider = true;
        const results = provider.extract(await response.text(), count);
        if (results.length) return { query:normalized, searchedAt:new Date().toISOString(), provider:provider.id, results };
      } catch {
        // A public search provider is only a discovery aid. Try the next
        // public provider instead of claiming that no public pages exist.
      }
    }
    if (reachableProvider) throw new PublicWebSearchError('no_results', '本次公开搜索没有得到可读取结果。');
    throw new PublicWebSearchError('search_unavailable', '公开搜索暂时不可用。');
  }
}

export class PublicWebSearchError extends Error { constructor(code, message) { super(message); this.code = code; } }

function extractDuckDuckGoResults(html, limit) {
  return extractAnchors(String(html || '').matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi), limit, 'https://html.duckduckgo.com/html/');
}

function extractBingResults(html, limit) {
  const anchors = [];
  for (const block of String(html || '').matchAll(/<li\b(?=[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'])[^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = block[1].match(/<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (anchor) anchors.push(anchor);
  }
  return extractAnchors(anchors, limit, 'https://www.bing.com/search');
}

function extractAnchors(matches, limit, baseUrl) {
  const results = [];
  const seen = new Set();
  for (const match of matches) {
    const url = resultUrl(decode(match[1]), baseUrl);
    if (!url || seen.has(url)) continue;
    const title = decode(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
    if (!title) continue;
    seen.add(url); results.push({ url, title:title.slice(0, 300) });
    if (results.length >= limit) break;
  }
  return results;
}

function resultUrl(href, baseUrl) {
  try {
    const parsed = new URL(href, baseUrl);
    const redirected = parsed.searchParams.get('uddg');
    const candidate = redirected ? decodeURIComponent(redirected) : parsed.toString();
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function decode(value) { return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'); }
