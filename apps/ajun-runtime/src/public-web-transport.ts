import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
const MAX_BYTES: any = 1000000;
const MAX_TRANSPORT_BYTES: any = 8 * 1024 * 1024;
const PUBLIC_READER_USER_AGENT: any = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 AgentArmyPublicReader/1.0';
// macOS 的系统网络设置会被 curl 正确使用；Node 自带联网在本机服务进程里
// 可能忽略这些设置。这里只是一个无跳转、限时、限大小的公开网页读取通道。
export class PublicWebTransport {
    command: any;
    lookup: any;
    pinsResolvedAddress: any;
    run: any;
    constructor({ command = '/usr/bin/curl', run = runBoundedCommand, lookupImpl = dns.lookup }: any = {}) {
        this.command = command;
        this.run = run;
        this.lookup = lookupImpl;
        this.pinsResolvedAddress = true;
    }
    async fetch(url: any, { headers = {}, signal, timeoutMs = 20000, resolvedAddress = null, maxBytes = MAX_BYTES, }: any = {}): Promise<any> {
        if (signal?.aborted)
            throw new Error('公开网页读取已取消。');
        const responseByteLimit: any = Math.max(1, Math.min(Number.isSafeInteger(maxBytes) ? maxBytes : MAX_BYTES, MAX_TRANSPORT_BYTES));
        const accept: any = String(headers.accept || headers.Accept || 'text/html, text/plain;q=0.9');
        const userAgent: any = String(headers['user-agent'] || headers['User-Agent'] || PUBLIC_READER_USER_AGENT).replace(/[\r\n]/g, '').slice(0, 240) || PUBLIC_READER_USER_AGENT;
        const pinnedAddress: any = await publicResolvedAddress(url, resolvedAddress, this.lookup);
        const resolveArgs: any = curlResolveArgs(url, pinnedAddress);
        let raw: any;
        try {
            raw = await this.run(this.command, [
                '--silent', '--show-error', '--request', 'GET', '--max-time', String(Math.max(1, Math.ceil(Number(timeoutMs) / 1000) || 20)), '--max-filesize', String(responseByteLimit),
                '--proto', '=http,https', '--max-redirs', '0', '--user-agent', userAgent, '--header', `accept: ${accept}`, '--include',
                ...resolveArgs,
                String(url),
            ], { maxBuffer: responseByteLimit + 64 * 1024 });
        }
        catch {
            throw new Error('公开网页暂时无法读取。');
        }
        return parseCurlResponse(raw, responseByteLimit);
    }
}
async function publicResolvedAddress(value: any, suppliedAddress: any, lookup: any): Promise<any> {
    let url: any;
    try {
        url = new URL(String(value));
    }
    catch {
        throw new Error('公开网页 URL 无效。');
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || !url.hostname
        || url.username
        || url.password
        || privateHost(url.hostname))
        throw new Error('公开网页传输拒绝本机、内网、含凭据或非 HTTP(S) URL。');
    const supplied: any = String(suppliedAddress || '').trim();
    if (supplied) {
        if (!net.isIP(supplied) || privateHost(supplied))
            throw new Error('公开网页固定解析地址无效。');
        return supplied;
    }
    if (net.isIP(url.hostname))
        return url.hostname.replace(/^\[|\]$/g, '');
    const addresses: any = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }: any): any => privateHost(address))) {
        throw new Error('公开网页域名解析到本机或内网地址。');
    }
    return addresses[0].address;
}
function curlResolveArgs(value: any, resolvedAddress: any): any {
    const address: any = String(resolvedAddress || '').trim();
    if (!address)
        return [];
    if (!net.isIP(address))
        throw new Error('公开网页固定解析地址无效。');
    const url: any = new URL(String(value));
    const port: any = url.port || (url.protocol === 'https:' ? '443' : '80');
    const curlAddress: any = net.isIP(address) === 6 ? `[${address}]` : address;
    const hostname: any = url.hostname.replace(/^\[|\]$/g, '');
    return ['--resolve', `${hostname}:${port}:${curlAddress}`];
}
function privateHost(host: any): any {
    const value: any = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (value === 'localhost'
        || value.endsWith('.localhost')
        || value.endsWith('.local')
        || value.endsWith('.internal')
        || value.endsWith('.home.arpa'))
        return true;
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
        const mapped: any = mappedIpv4(value);
        return Boolean(mapped && privateHost(mapped))
            || value === '::'
            || value === '::1'
            || value.startsWith('fc')
            || value.startsWith('fd')
            || /^fe[89ab]/.test(value);
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
export function runBoundedCommand(command: any, args: any, { maxBuffer = MAX_BYTES + 64 * 1024 }: any = {}): any {
    return new Promise((resolve: any, reject: any): any => {
        const child: any = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: any[] = [];
        const stderr: any[] = [];
        let stdoutBytes: any = 0;
        let settled: any = false;
        const fail: any = (error: any): any => {
            if (settled)
                return;
            settled = true;
            child.kill('SIGKILL');
            reject(error);
        };
        child.once('error', fail);
        child.stdout.on('data', (chunk: any): any => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBuffer) {
                fail(new Error('公开网页响应超过传输上限。'));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: any): any => {
            const current: any = stderr.reduce((sum: any, item: any): any => sum + item.length, 0);
            if (current < 64 * 1024)
                stderr.push(chunk.subarray(0, 64 * 1024 - current));
        });
        child.once('close', (code: any, signal: any): any => {
            if (settled)
                return;
            settled = true;
            if (code !== 0) {
                reject(new Error(Buffer.concat(stderr).toString('utf8').trim()
                    || `公开网页传输失败（${code ?? signal ?? 'unknown'}）。`));
                return;
            }
            resolve(Buffer.concat(stdout, stdoutBytes));
        });
    });
}
function parseCurlResponse(raw: any, maxBodyBytes: any = MAX_BYTES): any {
    const bytes: any = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
    const split: any = headerEnd(bytes);
    if (split < 0)
        throw new Error('公开网页响应格式无效。');
    const headerText: any = bytes.subarray(0, split).toString('latin1');
    const status: any = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/im)?.[1] || 0);
    if (!status)
        throw new Error('公开网页响应缺少状态。');
    const headers: any = new Headers();
    for (const line of headerText.split(/\r?\n/).slice(1)) {
        const index: any = line.indexOf(':');
        if (index > 0)
            headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    const body: any = bytes.subarray(split + headerSeparatorLength(bytes, split));
    if (body.length > maxBodyBytes)
        throw new Error('公开网页响应超过传输上限。');
    return new Response(body, { status, headers });
}
function headerEnd(bytes: any): any {
    for (let index: any = 0; index < bytes.length - 1; index += 1) {
        if (bytes[index] === 10 && bytes[index + 1] === 10)
            return index;
        if (index < bytes.length - 3 && bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10)
            return index;
    }
    return -1;
}
function headerSeparatorLength(bytes: any, index: any): any { return bytes[index] === 13 ? 4 : 2; }
