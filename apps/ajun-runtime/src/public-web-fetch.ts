import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
const MAX_BYTES: any = 1000000;
export class PublicWebFetch {
    fetch: any;
    lookup: any;
    constructor({ fetchImpl = fetch, lookupImpl = dns.lookup }: any = {}) { this.fetch = fetchImpl; this.lookup = lookupImpl; }
    async acquire({ sourceUrl }: any): Promise<any> {
        const source: any = await publicUrl(sourceUrl, this.lookup);
        const response: any = await this.fetch(source.url, {
            redirect: 'error',
            headers: { accept: 'text/html, text/plain;q=0.9' },
            signal: AbortSignal.timeout(8000),
            resolvedAddress: source.resolvedAddress,
        });
        if (!response.ok)
            throw new PublicWebFetchError('source_unavailable', `公开页面返回 ${response.status}。`);
        const contentType: any = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('text/html') && !contentType.startsWith('text/plain'))
            throw new PublicWebFetchError('unsupported_content_type', '当前公开网页能力只读取 HTML 或纯文本。');
        const raw: any = await limitedText(response);
        const title: any = contentType.includes('html') ? decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')).trim() : null;
        const text: any = contentType.includes('html')
            ? htmlToText(raw, { fragment: new URL(source.url).hash.slice(1) })
            : raw.trim();
        if (!text)
            throw new PublicWebFetchError('empty_content', '公开页面没有可用正文。');
        return {
            schemaVersion: 'agent.army/public-web-content/v1', sourceRef: safeSourceRef(source.url),
            title: title?.slice(0, 500) || null, text: text.slice(0, 30000), truncated: raw.length >= MAX_BYTES || text.length > 30000,
            contentHash: crypto.createHash('sha256').update(raw).digest('hex'),
            fetchedAt: new Date().toISOString(), validation: { exists: true, readable: true, accessScope: 'public_read' }
        };
    }
}
export class PublicWebFetchError extends Error {
    code: any;
    constructor(code: any, message: any) { super(message); this.code = code; }
}
async function publicUrl(value: any, lookup: any): Promise<any> {
    let parsed: any;
    try {
        parsed = new URL(String(value));
    }
    catch {
        throw new PublicWebFetchError('invalid_source_url', '需要一个公开 HTTP(S) 链接。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || privateHost(parsed.hostname))
        throw new PublicWebFetchError('source_not_public', '只能读取公开 HTTP(S) 页面，不能访问本机、内网或私有地址。');
    if (parsed.username || parsed.password)
        throw new PublicWebFetchError('source_not_public', '公开链接不能包含账号信息。');
    let resolvedAddress: any = parsed.hostname;
    if (!net.isIP(parsed.hostname)) {
        let addresses: any;
        try {
            addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
        }
        catch {
            throw new PublicWebFetchError('source_unavailable', '公开页面域名无法解析。');
        }
        if (!addresses.length || addresses.some(({ address }: any): any => privateHost(address)))
            throw new PublicWebFetchError('source_not_public', '只能读取公开 HTTP(S) 页面，不能访问本机、内网或私有地址。');
        resolvedAddress = addresses[0].address;
    }
    return { url: parsed.toString(), resolvedAddress };
}
function privateHost(host: any): any {
    const value: any = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (value === 'localhost' || value.endsWith('.localhost'))
        return true;
    if (net.isIP(value) === 4)
        return value.startsWith('127.') || value.startsWith('10.') || value.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value) || value.startsWith('169.254.') || value.startsWith('0.') || /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(value) || value === '255.255.255.255';
    if (net.isIP(value) === 6) {
        const mapped: any = mappedIpv4(value);
        return Boolean(mapped && privateHost(mapped))
            || value === '::'
            || value === '::1'
            || value.startsWith('fc')
            || value.startsWith('fd')
            || value.startsWith('fe8')
            || value.startsWith('fe9')
            || value.startsWith('fea')
            || value.startsWith('feb');
    }
    return false;
}
function mappedIpv4(value: any): any {
    if (!value.startsWith('::ffff:'))
        return null;
    const suffix: any = value.slice('::ffff:'.length);
    if (net.isIP(suffix) === 4)
        return suffix;
    const parts: any = suffix.split(':');
    if (parts.length !== 2 || parts.some((part: any): any => !/^[0-9a-f]{1,4}$/i.test(part)))
        return null;
    const high: any = Number.parseInt(parts[0], 16);
    const low: any = Number.parseInt(parts[1], 16);
    return [
        (high >>> 8) & 255,
        high & 255,
        (low >>> 8) & 255,
        low & 255,
    ].join('.');
}
async function limitedText(response: any): Promise<any> {
    const reader: any = response.body?.getReader();
    if (!reader)
        return '';
    const chunks: any[] = [];
    let length: any = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        length += value.byteLength;
        if (length > MAX_BYTES) {
            chunks.push(value.slice(0, Math.max(0, MAX_BYTES - (length - value.byteLength))));
            break;
        }
        chunks.push(value);
    }
    return new TextDecoder().decode(concat(chunks));
}
function concat(chunks: any): any {
    const size: any = chunks.reduce((sum: any, item: any): any => sum + item.byteLength, 0);
    const out: any = new Uint8Array(size);
    let offset: any = 0;
    for (const item of chunks) {
        out.set(item, offset);
        offset += item.byteLength;
    }
    return out;
}
export function htmlToText(html: any, { fragment = '' }: any = {}): any {
    const sanitized: any = String(html || '')
        .replace(/<(head|script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const body: any = primaryContent(sanitized, fragment)
        .replace(/<(header|nav|aside|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(br|\/p|\/div|\/section|\/article|\/main|\/li|\/h[1-6]|\/blockquote)[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<[^>]+>/g, ' ');
    return decode(body)
        .split(/\n+/)
        .map((line: any): any => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}
function primaryContent(html: any, fragment: any): any {
    const fragmentIndex: any = elementWithIdIndex(html, fragment);
    if (fragmentIndex >= 0) {
        const sectionIndex: any = html.toLowerCase().lastIndexOf('<section', fragmentIndex);
        return html.slice(sectionIndex >= 0 ? sectionIndex : fragmentIndex);
    }
    const main: any = /<(?:main|article)\b[^>]*>|<[^>]+\brole\s*=\s*(?:"main"|'main'|main)(?=[\s>])[^>]*>/i.exec(html);
    return main ? html.slice(main.index) : html;
}
function elementWithIdIndex(html: any, fragment: any): any {
    const id: any = String(fragment || '').trim();
    if (!id || id.length > 300)
        return -1;
    const escaped: any = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match: any = new RegExp(`<[^>]+\\bid\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped})(?=[\\s>])[^>]*>`, 'i').exec(html);
    return match?.index ?? -1;
}
function decode(value: any): any { return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function safeSourceRef(value: any): any { const parsed: any = new URL(value); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
