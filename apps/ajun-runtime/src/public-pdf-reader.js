import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class PublicPdfReader {
  constructor({
    transport = null,
    lookupImpl = dns.lookup,
    pdftotextPath = '/opt/homebrew/bin/pdftotext',
    runImpl = runCommand,
  } = {}) {
    this.transport = transport?.pinsResolvedAddress === true && typeof transport?.fetch === 'function'
      ? transport
      : null;
    this.lookup = lookupImpl;
    this.pdftotextPath = pdftotextPath;
    this.run = runImpl;
  }

  async read({ sourceUrl } = {}) {
    const source = await resolvePublicUrl(sourceUrl, this.lookup);
    if (!this.transport) {
      throw pdfError('公开 PDF 缺少可核验 DNS 固定传输器。', 'transport_unavailable');
    }
    const response = await this.transport.fetch(source.url, {
      redirect:'error',
      headers:{ accept:'application/pdf' },
      signal:AbortSignal.timeout(15_000),
      resolvedAddress:source.resolvedAddress,
      maxBytes:MAX_PDF_BYTES,
    });
    if (!response.ok) {
      throw pdfError(`公开 PDF 返回 ${response.status}。`, 'source_unavailable');
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/pdf')) {
      throw pdfError('公开来源不是 PDF。', 'unsupported_content_type');
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      await response.body?.cancel?.();
      throw pdfError('公开 PDF 超过 8MB 上限。', 'content_too_large');
    }
    const bytes = await limitedBuffer(response, MAX_PDF_BYTES);
    if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw pdfError('公开 PDF 文件无效或超过 8MB 上限。', 'invalid_pdf');
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-public-pdf-'));
    try {
      const inputPath = path.join(temporaryDirectory, 'source.pdf');
      await fs.writeFile(inputPath, bytes, { mode:0o600, flag:'wx' });
      const output = await this.run(this.pdftotextPath, [
        '-enc', 'UTF-8',
        '-nopgbrk',
        inputPath,
        '-',
      ], { timeoutMs:20_000, maxBuffer:MAX_TEXT_BYTES });
      const text = String(output || '').replace(/\u0000/g, '').trim().slice(0, 60_000);
      if (!text) throw pdfError('公开 PDF 没有可提取正文。', 'empty_content');
      return Object.freeze({
        schemaVersion:'agent.army/public-pdf-content/v1',
        sourceRef:safeSourceRef(source.url),
        title:pdfTitle(source.url),
        text,
        contentHash:crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes:bytes.length,
        fetchedAt:new Date().toISOString(),
        validation:Object.freeze({
          exists:true,
          readable:true,
          publicReadOnly:true,
          accessScope:'public_read',
          redirectPolicy:'deny',
          dnsPinned:true,
        }),
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive:true, force:true });
    }
  }
}

export class PublicPdfReaderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function resolvePublicUrl(value, lookup = dns.lookup) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw pdfError('需要一个公开 HTTP(S) 链接。', 'invalid_source_url');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || isPrivateAddress(parsed.hostname)
  ) {
    throw pdfError('只能读取不含凭据的公开 HTTP(S) 来源。', 'source_not_public');
  }
  let resolvedAddress = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(resolvedAddress)) {
    let addresses;
    try {
      addresses = await lookup(parsed.hostname, { all:true, verbatim:true });
    } catch {
      throw pdfError('公开来源域名无法解析。', 'source_unavailable');
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw pdfError('公开来源域名解析到本机或内网地址。', 'source_not_public');
    }
    resolvedAddress = addresses[0].address;
  }
  return Object.freeze({ url:parsed.toString(), resolvedAddress });
}

export function isPrivateAddress(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (
    value === 'localhost'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')
    || value.endsWith('.home.arpa')
  ) return true;
  if (net.isIP(value) === 4) {
    return value.startsWith('127.')
      || value.startsWith('10.')
      || value.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
      || value.startsWith('169.254.')
      || value.startsWith('0.')
      || /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(value)
      || value === '255.255.255.255';
  }
  if (net.isIP(value) === 6) {
    const mapped = mappedIpv4(value);
    return Boolean(mapped && isPrivateAddress(mapped))
      || value === '::'
      || value === '::1'
      || value.startsWith('fc')
      || value.startsWith('fd')
      || /^fe[89ab]/.test(value);
  }
  return false;
}

function mappedIpv4(value) {
  if (!value.startsWith('::ffff:')) return null;
  const suffix = value.slice('::ffff:'.length);
  if (net.isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
}

function safeSourceRef(value) {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function pdfTitle(value) {
  const pathname = new URL(value).pathname;
  return decodeURIComponent(path.basename(pathname) || '公开 PDF').slice(0, 300);
}

function pdfError(message, code) {
  return new PublicPdfReaderError(message, code);
}

async function limitedBuffer(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw pdfError('公开 PDF 响应没有可读正文。', 'invalid_pdf');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw pdfError('公开 PDF 超过 8MB 上限。', 'content_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

function runCommand(command, args, { timeoutMs, maxBuffer } = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding:'utf8',
    timeout:timeoutMs,
    maxBuffer,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
