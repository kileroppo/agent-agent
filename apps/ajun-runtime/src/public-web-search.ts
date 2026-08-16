const SEARCH_PROVIDERS: any[] = [
    { id: 'duckduckgo', endpoint: 'https://html.duckduckgo.com/html/', query: (query: any): any => `?q=${encodeURIComponent(query)}`, extract: extractDuckDuckGoResults },
    { id: 'bing', endpoint: 'https://www.bing.com/search', query: (query: any): any => `?q=${encodeURIComponent(query)}`, extract: extractBingResults }
];
export class PublicWebSearch {
    fetch: any;
    constructor({ fetchImpl = fetch }: any = {}) { this.fetch = fetchImpl; }
    async search({ query, limit = 3 }: any = {}): Promise<any> {
        const normalized: any = String(query || '').replace(/\s+/g, ' ').trim();
        if (normalized.length < 2)
            throw new PublicWebSearchError('query_required', '请说明想查什么公开资料。');
        const count: any = Math.min(Math.max(Number(limit) || 3, 1), 5);
        let reachableProvider: any = false;
        for (const provider of SEARCH_PROVIDERS) {
            try {
                const response: any = await this.fetch(`${provider.endpoint}${provider.query(normalized)}`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(8000), timeoutMs: 8000 });
                if (!response.ok)
                    continue;
                reachableProvider = true;
                const results: any = provider.extract(await response.text(), count);
                if (results.length)
                    return { query: normalized, searchedAt: new Date().toISOString(), provider: provider.id, results };
            }
            catch {
                // A public search provider is only a discovery aid. Try the next
                // public provider instead of claiming that no public pages exist.
            }
        }
        if (reachableProvider)
            throw new PublicWebSearchError('no_results', '本次公开搜索没有得到可读取结果。');
        throw new PublicWebSearchError('search_unavailable', '公开搜索暂时不可用。');
    }
}
export class PublicWebSearchError extends Error {
    code: any;
    constructor(code: any, message: any) { super(message); this.code = code; }
}
function extractDuckDuckGoResults(html: any, limit: any): any {
    return extractAnchors(String(html || '').matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi), limit, 'https://html.duckduckgo.com/html/');
}
function extractBingResults(html: any, limit: any): any {
    const anchors: any[] = [];
    for (const block of String(html || '').matchAll(/<li\b(?=[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'])[^>]*>([\s\S]*?)<\/li>/gi)) {
        const anchor: any = block[1].match(/<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        if (anchor)
            anchors.push(anchor);
    }
    return extractAnchors(anchors, limit, 'https://www.bing.com/search');
}
function extractAnchors(matches: any, limit: any, baseUrl: any): any {
    const results: any[] = [];
    const seen: any = new Set();
    for (const match of matches) {
        const url: any = resultUrl(decode(match[1]), baseUrl);
        if (!url || seen.has(url))
            continue;
        const title: any = decode(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
        if (!title)
            continue;
        seen.add(url);
        results.push({ url, title: title.slice(0, 300) });
        if (results.length >= limit)
            break;
    }
    return results;
}
function resultUrl(href: any, baseUrl: any): any {
    try {
        const parsed: any = new URL(href, baseUrl);
        const redirected: any = parsed.searchParams.get('uddg');
        const bingTarget: any = bingRedirectTarget(parsed);
        const candidate: any = redirected ? decodeURIComponent(redirected) : bingTarget || parsed.toString();
        const url: any = new URL(candidate);
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
    }
    catch {
        return null;
    }
}
function bingRedirectTarget(parsed: any): any {
    if (!/(?:^|\.)bing\.com$/i.test(String(parsed?.hostname || '')) || !/^\/ck\/a/i.test(String(parsed?.pathname || '')))
        return null;
    const encoded: any = String(parsed.searchParams.get('u') || '');
    if (!encoded.startsWith('a1') || encoded.length < 4)
        return null;
    try {
        const decoded: any = Buffer.from(encoded.slice(2), 'base64url').toString('utf8').trim();
        const target: any = new URL(decoded);
        return ['http:', 'https:'].includes(target.protocol) ? target.toString() : null;
    }
    catch {
        return null;
    }
}
function decode(value: any): any { return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'); }
