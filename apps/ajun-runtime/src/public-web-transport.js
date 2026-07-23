import { execFile } from 'node:child_process';

const MAX_BYTES = 1_000_000;
const PUBLIC_READER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 AgentArmyPublicReader/1.0';

// macOS 的系统网络设置会被 curl 正确使用；Node 自带联网在本机服务进程里
// 可能忽略这些设置。这里只是一个无跳转、限时、限大小的公开网页读取通道。
export class PublicWebTransport {
  constructor({ command = '/usr/bin/curl', run = runCommand } = {}) {
    this.command = command;
    this.run = run;
  }

  async fetch(url, { headers = {}, signal, timeoutMs = 20_000 } = {}) {
    if (signal?.aborted) throw new Error('公开网页读取已取消。');
    const accept = String(headers.accept || headers.Accept || 'text/html, text/plain;q=0.9');
    const userAgent = String(headers['user-agent'] || headers['User-Agent'] || PUBLIC_READER_USER_AGENT).replace(/[\r\n]/g, '').slice(0, 240) || PUBLIC_READER_USER_AGENT;
    let raw;
    try {
      raw = await this.run(this.command, [
        '--silent', '--show-error', '--request', 'GET', '--max-time', String(Math.max(1, Math.ceil(Number(timeoutMs) / 1000) || 20)), '--max-filesize', String(MAX_BYTES),
        '--proto', '=http,https', '--max-redirs', '0', '--user-agent', userAgent, '--header', `accept: ${accept}`, '--include', String(url)
      ]);
    } catch {
      throw new Error('公开网页暂时无法读取。');
    }
    return parseCurlResponse(raw);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: 'buffer', maxBuffer: MAX_BYTES + 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function parseCurlResponse(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  const split = headerEnd(bytes);
  if (split < 0) throw new Error('公开网页响应格式无效。');
  const headerText = bytes.subarray(0, split).toString('latin1');
  const status = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/im)?.[1] || 0);
  if (!status) throw new Error('公开网页响应缺少状态。');
  const headers = new Headers();
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return new Response(bytes.subarray(split + headerSeparatorLength(bytes, split)), { status, headers });
}

function headerEnd(bytes) {
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return index;
    if (index < bytes.length - 3 && bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  return -1;
}

function headerSeparatorLength(bytes, index) { return bytes[index] === 13 ? 4 : 2; }
