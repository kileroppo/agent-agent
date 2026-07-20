import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 1_000_000;

export class PublicWebFetch {
  constructor({ fetchImpl = fetch, lookupImpl = dns.lookup } = {}) { this.fetch = fetchImpl; this.lookup = lookupImpl; }

  async acquire({ sourceUrl }) {
    const source = await publicUrl(sourceUrl, this.lookup);
    const response = await this.fetch(source, { redirect: 'error', headers: { accept: 'text/html, text/plain;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new PublicWebFetchError('source_unavailable', `公开页面返回 ${response.status}。`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.startsWith('text/plain')) throw new PublicWebFetchError('unsupported_content_type', '当前公开网页能力只读取 HTML 或纯文本。');
    const raw = await limitedText(response);
    const title = contentType.includes('html') ? decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')).trim() : null;
    const text = contentType.includes('html') ? toText(raw) : raw.trim();
    if (!text) throw new PublicWebFetchError('empty_content', '公开页面没有可用正文。');
    return {
      schemaVersion: 'agent.army/public-web-content/v1', sourceRef: safeSourceRef(source),
      title: title?.slice(0, 500) || null, text: text.slice(0, 30000), truncated: raw.length >= MAX_BYTES,
      fetchedAt: new Date().toISOString(), validation: { exists: true, readable: true, accessScope: 'public_read' }
    };
  }
}

export class PublicWebFetchError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function publicUrl(value, lookup) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new PublicWebFetchError('invalid_source_url', '需要一个公开 HTTP(S) 链接。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || privateHost(parsed.hostname)) throw new PublicWebFetchError('source_not_public', '只能读取公开 HTTP(S) 页面，不能访问本机、内网或私有地址。');
  if (parsed.username || parsed.password) throw new PublicWebFetchError('source_not_public', '公开链接不能包含账号信息。');
  if (!net.isIP(parsed.hostname)) {
    let addresses;
    try { addresses = await lookup(parsed.hostname, { all: true, verbatim: true }); }
    catch { throw new PublicWebFetchError('source_unavailable', '公开页面域名无法解析。'); }
    if (!addresses.length || addresses.some(({ address }) => privateHost(address))) throw new PublicWebFetchError('source_not_public', '只能读取公开 HTTP(S) 页面，不能访问本机、内网或私有地址。');
  }
  return parsed.toString();
}
function privateHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (net.isIP(value) === 4) return value.startsWith('127.') || value.startsWith('10.') || value.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value) || value.startsWith('169.254.') || value.startsWith('0.') || /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(value) || value === '255.255.255.255';
  if (net.isIP(value) === 6) return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.') || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(value);
  return false;
}
async function limitedText(response) {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks = []; let length = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) { chunks.push(value.slice(0, Math.max(0, MAX_BYTES - (length - value.byteLength)))); break; } chunks.push(value); }
  return new TextDecoder().decode(concat(chunks));
}
function concat(chunks) { const size = chunks.reduce((sum, item) => sum + item.byteLength, 0); const out = new Uint8Array(size); let offset = 0; for (const item of chunks) { out.set(item, offset); offset += item.byteLength; } return out; }
function toText(html) { return decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim(); }
function decode(value) { return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function safeSourceRef(value) { const parsed = new URL(value); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
