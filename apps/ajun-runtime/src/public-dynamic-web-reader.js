import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { htmlToText } from './public-web-fetch.js';
import { resolvePublicUrl } from './public-pdf-reader.js';

const MAX_DOM_BYTES = 2 * 1024 * 1024;
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export class PublicDynamicWebReader {
  constructor({
    chromePath = DEFAULT_CHROME,
    lookupImpl = dns.lookup,
    runImpl = runControlledChrome,
  } = {}) {
    this.chromePath = chromePath;
    this.lookup = lookupImpl;
    this.run = runImpl;
  }

  async read({ sourceUrl } = {}) {
    const source = await resolvePublicUrl(sourceUrl, this.lookup);
    const parsed = new URL(source.url);
    const proxy = await createPinnedOriginProxy({
      hostname:parsed.hostname,
      port:Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      resolvedAddress:source.resolvedAddress,
    });
    const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-dynamic-reader-'));
    try {
      const html = await this.run(this.chromePath, [
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
        timeoutMs:20_000,
        maxBuffer:MAX_DOM_BYTES,
        sourceUrl:source.url,
      });
      const text = htmlToText(html).slice(0, 60_000);
      if (!text) throw dynamicError('动态公开页面没有可用正文。', 'empty_content');
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500) || null;
      return Object.freeze({
        schemaVersion:'agent.army/public-dynamic-web-content/v1',
        sourceRef:`${parsed.protocol}//${parsed.host}${parsed.pathname}`,
        title,
        text,
        contentHash:crypto.createHash('sha256').update(html).digest('hex'),
        fetchedAt:new Date().toISOString(),
        validation:Object.freeze({
          exists:true,
          readable:true,
          publicReadOnly:true,
          javascriptRendered:true,
          isolatedProfile:true,
          originPinned:true,
          crossOriginRequestsBlocked:proxy.blockedCount(),
          accessScope:'public_read',
        }),
      });
    } finally {
      await proxy.close();
      await fs.rm(profileDirectory, { recursive:true, force:true });
    }
  }
}

export class PublicDynamicWebReaderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function createPinnedOriginProxy({ hostname, port, resolvedAddress }) {
  const allowedHost = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  let blocked = 0;
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())) {
      blocked += 1;
      response.writeHead(405).end();
      return;
    }
    let target;
    try {
      target = new URL(String(request.url || ''));
    } catch {
      blocked += 1;
      response.writeHead(400).end();
      return;
    }
    if (!allowedTarget(target.hostname, target.port || (target.protocol === 'https:' ? 443 : 80))) {
      blocked += 1;
      response.writeHead(403).end();
      return;
    }
    const upstream = http.request({
      host:resolvedAddress,
      port,
      method:request.method,
      path:`${target.pathname}${target.search}`,
      headers:{ ...request.headers, host:target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  server.on('connect', (request, clientSocket, head) => {
    const [requestedHost, rawPort] = String(request.url || '').split(':');
    const requestedPort = Number(rawPort || 443);
    if (!allowedTarget(requestedHost, requestedPort)) {
      blocked += 1;
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host:resolvedAddress, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  function allowedTarget(candidateHost, candidatePort) {
    return String(candidateHost || '').toLowerCase().replace(/^\[|\]$/g, '') === allowedHost
      && Number(candidatePort) === port;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return Object.freeze({
    port:address.port,
    blockedCount:() => blocked,
    close:() => new Promise((resolve) => server.close(resolve)),
  });
}

function dynamicError(message, code) {
  return new PublicDynamicWebReaderError(message, code);
}

export async function runControlledChrome(command, args, { timeoutMs, maxBuffer, sourceUrl } = {}) {
  const initialUrl = args.at(-1);
  const child = spawn(command, [
    ...args.slice(0, -1),
    '--remote-debugging-port=0',
    initialUrl,
  ], {
    stdio:['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  const websocketUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(dynamicError('动态浏览器启动超时。', 'browser_timeout')), 8_000);
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', onError);
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      child.off('error', onError);
      resolve(match[1]);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(dynamicError(`动态浏览器启动失败（${code ?? 'unknown'}）。`, 'browser_unavailable'));
    });
  });
  let protocol;
  try {
    const targetWebsocketUrl = await pageTargetWebsocketUrl(websocketUrl);
    protocol = await CdpConnection.connect(targetWebsocketUrl, timeoutMs);
    const origin = new URL(sourceUrl);
    protocol.onEvent('Fetch.requestPaused', (params) => {
      const method = String(params?.request?.method || '').toUpperCase();
      const requestUrl = String(params?.request?.url || '');
      let allowed = ['GET', 'HEAD'].includes(method);
      if (allowed && /^(?:data|blob):/i.test(requestUrl)) {
        allowed = true;
      } else if (allowed) {
        try {
          allowed = new URL(requestUrl).origin === origin.origin;
        } catch {
          allowed = false;
        }
      }
      void protocol.command(
        allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed
          ? { requestId:params.requestId }
          : { requestId:params.requestId, errorReason:'BlockedByClient' },
      ).catch(() => {});
    });
    await protocol.command('Page.enable');
    await protocol.command('Runtime.enable');
    await protocol.command('Fetch.enable', {
      patterns:[{ urlPattern:'*', requestStage:'Request' }],
    });
    const loaded = protocol.waitForEvent('Page.loadEventFired', null, Math.max(2_000, timeoutMs - 4_000));
    await protocol.command('Page.navigate', { url:sourceUrl });
    await loaded.catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const evaluated = await protocol.command('Runtime.evaluate', {
      expression:'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue:true,
    });
    const html = String(evaluated?.result?.value || '');
    if (Buffer.byteLength(html) > maxBuffer) {
      throw dynamicError('动态页面 DOM 超过 2MB 上限。', 'content_too_large');
    }
    return html;
  } finally {
    protocol?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function pageTargetWebsocketUrl(browserWebsocketUrl) {
  const browserUrl = new URL(browserWebsocketUrl);
  const response = await fetch(`http://${browserUrl.host}/json/new?about%3Ablank`, {
    method:'PUT',
    signal:AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw dynamicError('动态浏览器页面目标不可用。', 'browser_unavailable');
  const page = await response.json();
  if (!page) throw dynamicError('动态浏览器没有可控页面目标。', 'browser_unavailable');
  return page.webSocketDebuggerUrl;
}

class CdpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.#message(event.data));
    socket.addEventListener('close', () => this.#closed());
  }

  static async connect(url, timeoutMs) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(dynamicError('动态浏览器调试连接超时。', 'browser_timeout')), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once:true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(dynamicError('动态浏览器调试连接失败。', 'browser_unavailable'));
      }, { once:true });
    });
    return new CdpConnection(socket, timeoutMs);
  }

  command(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
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

  onEvent(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  waitForEvent(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(dynamicError(`等待 ${method} 超时。`, 'browser_timeout')), timeoutMs);
      const handler = (params, eventSessionId) => {
        if (sessionId && eventSessionId !== sessionId) return;
        clearTimeout(timer);
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((candidate) => candidate !== handler));
        resolve(params);
      };
      this.onEvent(method, handler);
    });
  }

  close() {
    this.socket.close();
  }

  #message(raw) {
    let message;
    try {
      message = JSON.parse(String(raw || ''));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(dynamicError(message.error.message || '动态浏览器命令失败。', 'browser_protocol_error'));
      else pending.resolve(message.result || {});
      return;
    }
    for (const handler of this.listeners.get(message.method) || []) {
      handler(message.params || {}, message.sessionId || null);
    }
  }

  #closed() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(dynamicError('动态浏览器连接已关闭。', 'browser_unavailable'));
    }
    this.pending.clear();
  }
}
