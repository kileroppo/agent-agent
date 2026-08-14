import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { htmlToText } from './public-web-fetch.ts';
import { resolvePublicUrl } from './public-pdf-reader.ts';
const MAX_DOM_BYTES: any = 2 * 1024 * 1024;
const DEFAULT_CHROME: any = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export class PublicDynamicWebReader {
    chromePath: any;
    lookup: any;
    run: any;
    constructor({ chromePath = DEFAULT_CHROME, lookupImpl = dns.lookup, runImpl = runControlledChrome, }: any = {}) {
        this.chromePath = chromePath;
        this.lookup = lookupImpl;
        this.run = runImpl;
    }
    async read({ sourceUrl }: any = {}): Promise<any> {
        const source: any = await resolvePublicUrl(sourceUrl, this.lookup);
        const parsed: any = new URL(source.url);
        const proxy: any = await createPinnedOriginProxy({
            hostname: parsed.hostname,
            port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
            resolvedAddress: source.resolvedAddress,
        });
        const profileDirectory: any = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-dynamic-reader-'));
        try {
            const html: any = await this.run(this.chromePath, [
                '--headless=new',
                '--disable-background-networking',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-features=MediaRouter,OptimizationHints,Translate',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-first-run',
                '--no-default-browser-check',
                `--user-data-dir=${profileDirectory}`,
                `--proxy-server=http://127.0.0.1:${proxy.port}`,
                '--proxy-bypass-list=<-loopback>',
                'about:blank',
            ], {
                timeoutMs: 20000,
                maxBuffer: MAX_DOM_BYTES,
                sourceUrl: source.url,
            });
            const text: any = htmlToText(html).slice(0, 60000);
            if (!text)
                throw dynamicError('动态公开页面没有可用正文。', 'empty_content');
            const title: any = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
                ?.replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 500) || null;
            return Object.freeze({
                schemaVersion: 'agent.army/public-dynamic-web-content/v1',
                sourceRef: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
                title,
                text,
                contentHash: crypto.createHash('sha256').update(html).digest('hex'),
                fetchedAt: new Date().toISOString(),
                validation: Object.freeze({
                    exists: true,
                    readable: true,
                    publicReadOnly: true,
                    javascriptRendered: true,
                    isolatedProfile: true,
                    originPinned: true,
                    crossOriginRequestsBlocked: proxy.blockedCount(),
                    accessScope: 'public_read',
                }),
            });
        }
        finally {
            await proxy.close();
            await fs.rm(profileDirectory, { recursive: true, force: true });
        }
    }
}
export class PublicDynamicWebReaderError extends Error {
    code: any;
    constructor(message: any, code: any) {
        super(message);
        this.code = code;
    }
}
async function createPinnedOriginProxy({ hostname, port, resolvedAddress }: any): Promise<any> {
    const allowedHost: any = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    let blocked: any = 0;
    const server: any = http.createServer((request: any, response: any): any => {
        if (!['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())) {
            blocked += 1;
            response.writeHead(405).end();
            return;
        }
        let target: any;
        try {
            target = new URL(String(request.url || ''));
        }
        catch {
            blocked += 1;
            response.writeHead(400).end();
            return;
        }
        if (!allowedTarget(target.hostname, target.port || (target.protocol === 'https:' ? 443 : 80))) {
            blocked += 1;
            response.writeHead(403).end();
            return;
        }
        const upstream: any = http.request({
            host: resolvedAddress,
            port,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            headers: { ...request.headers, host: target.host },
        }, (upstreamResponse: any): any => {
            response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        });
        upstream.on('error', (): any => response.writeHead(502).end());
        request.pipe(upstream);
    });
    server.on('connect', (request: any, clientSocket: any, head: any): any => {
        const [requestedHost, rawPort] = String(request.url || '').split(':');
        const requestedPort: any = Number(rawPort || 443);
        if (!allowedTarget(requestedHost, requestedPort)) {
            blocked += 1;
            clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const upstream: any = net.connect({ host: resolvedAddress, port }, (): any => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length)
                upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', (): any => clientSocket.destroy());
        clientSocket.on('error', (): any => upstream.destroy());
    });
    function allowedTarget(candidateHost: any, candidatePort: any): any {
        return String(candidateHost || '').toLowerCase().replace(/^\[|\]$/g, '') === allowedHost
            && Number(candidatePort) === port;
    }
    await new Promise((resolve: any, reject: any): any => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address: any = server.address();
    return Object.freeze({
        port: address.port,
        blockedCount: (): any => blocked,
        close: (): any => new Promise((resolve: any): any => server.close(resolve)),
    });
}
function dynamicError(message: any, code: any): any {
    return new PublicDynamicWebReaderError(message, code);
}
export async function runControlledChrome(command: any, args: any, { timeoutMs, maxBuffer, sourceUrl }: any = {}): Promise<any> {
    const initialUrl: any = args.at(-1);
    const child: any = spawn(command, [
        ...args.slice(0, -1),
        '--remote-debugging-port=0',
        initialUrl,
    ], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr: any = '';
    const websocketUrl: any = await new Promise((resolve: any, reject: any): any => {
        const timer: any = setTimeout((): any => reject(dynamicError('动态浏览器启动超时。', 'browser_timeout')), 8000);
        const onError: any = (error: any): any => {
            clearTimeout(timer);
            reject(error);
        };
        child.once('error', onError);
        child.stderr.on('data', (chunk: any): any => {
            stderr = `${stderr}${chunk}`.slice(-64 * 1024);
            const match: any = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (!match)
                return;
            clearTimeout(timer);
            child.off('error', onError);
            resolve(match[1]);
        });
        child.once('exit', (code: any): any => {
            clearTimeout(timer);
            reject(dynamicError(`动态浏览器启动失败（${code ?? 'unknown'}）。`, 'browser_unavailable'));
        });
    });
    let protocol: any;
    try {
        const targetWebsocketUrl: any = await pageTargetWebsocketUrl(websocketUrl);
        protocol = await CdpConnection.connect(targetWebsocketUrl, timeoutMs);
        const origin: any = new URL(sourceUrl);
        protocol.onEvent('Fetch.requestPaused', (params: any): any => {
            const method: any = String(params?.request?.method || '').toUpperCase();
            const requestUrl: any = String(params?.request?.url || '');
            let allowed: any = ['GET', 'HEAD'].includes(method);
            if (allowed && /^(?:data|blob):/i.test(requestUrl)) {
                allowed = true;
            }
            else if (allowed) {
                try {
                    allowed = new URL(requestUrl).origin === origin.origin;
                }
                catch {
                    allowed = false;
                }
            }
            void protocol.command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed
                ? { requestId: params.requestId }
                : { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch((): any => { });
        });
        await protocol.command('Page.enable');
        await protocol.command('Runtime.enable');
        await protocol.command('Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
        const loaded: any = protocol.waitForEvent('Page.loadEventFired', null, Math.max(2000, timeoutMs - 4000));
        await protocol.command('Page.navigate', { url: sourceUrl });
        await loaded.catch((): any => null);
        await new Promise((resolve: any): any => setTimeout(resolve, 500));
        const evaluated: any = await protocol.command('Runtime.evaluate', {
            expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
            returnByValue: true,
        });
        const html: any = String(evaluated?.result?.value || '');
        if (Buffer.byteLength(html) > maxBuffer) {
            throw dynamicError('动态页面 DOM 超过 2MB 上限。', 'content_too_large');
        }
        return html;
    }
    finally {
        protocol?.close();
        child.kill('SIGTERM');
        await new Promise((resolve: any): any => {
            if (child.exitCode != null)
                return resolve();
            const timer: any = setTimeout((): any => {
                child.kill('SIGKILL');
                resolve();
            }, 2000);
            child.once('exit', (): any => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
async function pageTargetWebsocketUrl(browserWebsocketUrl: any): Promise<any> {
    const browserUrl: any = new URL(browserWebsocketUrl);
    const response: any = await fetch(`http://${browserUrl.host}/json/new?about%3Ablank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
        throw dynamicError('动态浏览器页面目标不可用。', 'browser_unavailable');
    const page: any = await response.json();
    if (!page)
        throw dynamicError('动态浏览器没有可控页面目标。', 'browser_unavailable');
    return page.webSocketDebuggerUrl;
}
class CdpConnection {
    listeners: any;
    nextId: any;
    pending: any;
    socket: any;
    timeoutMs: any;
    constructor(socket: any, timeoutMs: any) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', (event: any): any => this.#message(event.data));
        socket.addEventListener('close', (): any => this.#closed());
    }
    static async connect(url: any, timeoutMs: any): Promise<any> {
        const socket: any = new WebSocket(url);
        await new Promise((resolve: any, reject: any): any => {
            const timer: any = setTimeout((): any => reject(dynamicError('动态浏览器调试连接超时。', 'browser_timeout')), 5000);
            socket.addEventListener('open', (): any => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            socket.addEventListener('error', (): any => {
                clearTimeout(timer);
                reject(dynamicError('动态浏览器调试连接失败。', 'browser_unavailable'));
            }, { once: true });
        });
        return new CdpConnection(socket, timeoutMs);
    }
    command(method: any, params: any = {}, sessionId: any = null): any {
        const id: any = this.nextId++;
        return new Promise((resolve: any, reject: any): any => {
            const timer: any = setTimeout((): any => {
                this.pending.delete(id);
                reject(dynamicError(`动态浏览器命令 ${method} 超时。`, 'browser_timeout'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
            }));
        });
    }
    onEvent(method: any, handler: any): any {
        const handlers: any = this.listeners.get(method) || [];
        handlers.push(handler);
        this.listeners.set(method, handlers);
    }
    waitForEvent(method: any, sessionId: any, timeoutMs: any): any {
        return new Promise((resolve: any, reject: any): any => {
            const timer: any = setTimeout((): any => reject(dynamicError(`等待 ${method} 超时。`, 'browser_timeout')), timeoutMs);
            const handler: any = (params: any, eventSessionId: any): any => {
                if (sessionId && eventSessionId !== sessionId)
                    return;
                clearTimeout(timer);
                const handlers: any = this.listeners.get(method) || [];
                this.listeners.set(method, handlers.filter((candidate: any): any => candidate !== handler));
                resolve(params);
            };
            this.onEvent(method, handler);
        });
    }
    close(): any {
        this.socket.close();
    }
    #message(raw: any): any {
        let message: any;
        try {
            message = JSON.parse(String(raw || ''));
        }
        catch {
            return;
        }
        if (message.id) {
            const pending: any = this.pending.get(message.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
                pending.reject(dynamicError(message.error.message || '动态浏览器命令失败。', 'browser_protocol_error'));
            else
                pending.resolve(message.result || {});
            return;
        }
        for (const handler of this.listeners.get(message.method) || []) {
            handler(message.params || {}, message.sessionId || null);
        }
    }
    #closed(): any {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(dynamicError('动态浏览器连接已关闭。', 'browser_unavailable'));
        }
        this.pending.clear();
    }
}
