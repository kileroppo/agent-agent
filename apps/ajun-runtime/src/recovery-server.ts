import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const HOST: any = '127.0.0.1';
function createRecoveryServer({ releaseHash = process.env.AJUN_RECOVERY_RELEASE_HASH, payloadHash = process.env.AJUN_RECOVERY_PAYLOAD_HASH, reason = process.env.AJUN_RECOVERY_REASON || 'cutover_recovery', now = (): any => new Date(), pid = process.pid, bootId = crypto.randomUUID(), }: any = {}): any {
    assertHash(releaseHash, 'AJUN_RECOVERY_RELEASE_HASH');
    assertHash(payloadHash, 'AJUN_RECOVERY_PAYLOAD_HASH');
    const startedAt: any = now().toISOString();
    const status: any = Object.freeze({
        schemaVersion: 1,
        mode: 'local_recovery_only',
        ready: true,
        externalEffects: false,
        writableRoutes: false,
        releaseHash,
        payloadHash,
        reason: String(reason || 'cutover_recovery').slice(0, 80),
        pid,
        bootId,
        startedAt,
    });
    const server: any = http.createServer((request: any, response: any): any => {
        const url: any = new URL(request.url || '/', `http://${HOST}`);
        if (!['GET', 'HEAD'].includes(request.method || '')) {
            return rejectWrite(request, response);
        }
        if (url.pathname === '/api/health' || url.pathname === '/api/recovery/status') {
            return json(response, 200, status, request.method === 'HEAD');
        }
        if (url.pathname === '/') {
            const body: any = [
                '<!doctype html><html lang="zh-CN"><meta charset="utf-8">',
                '<meta name="viewport" content="width=device-width,initial-scale=1">',
                '<title>A君只读恢复模式</title>',
                '<main><h1>A君处于只读恢复模式</h1>',
                '<p>外部任务、飞书、Paperclip、媒体执行和发布均未启动。</p>',
                '<p>请完成受控恢复后再切回正式运行时。</p></main></html>',
            ].join('');
            response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
            });
            if (request.method === 'HEAD')
                return response.end();
            return response.end(body);
        }
        return json(response, 404, { error: 'not_found' }, request.method === 'HEAD');
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    return { server, status };
}
export async function startRecoveryServer({ host = process.env.AJUN_HOST || HOST, port = Number(process.env.PORT || 4321), ...options }: any = {}): Promise<any> {
    if (host !== HOST)
        throw new Error('recovery server只允许监听127.0.0.1');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error('recovery server端口不合法');
    }
    const { server, status } = createRecoveryServer(options);
    await new Promise((resolve: any, reject: any): any => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
    });
    const address: any = server.address();
    return { server, status, host: HOST, port: address.port };
}
function json(response: any, statusCode: any, value: any, headOnly: any = false): any {
    const body: any = `${JSON.stringify(value)}\n`;
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    if (headOnly)
        return response.end();
    return response.end(body);
}
function rejectWrite(request: any, response: any): any {
    const body: any = `${JSON.stringify({
        error: 'recovery_mode_read_only',
        message: 'A君正处于本机只读恢复模式，所有写操作均已关闭。',
    })}\n`;
    response.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
    });
    response.end(body, (): any => request.destroy());
}
function assertHash(value: any, name: any): any {
    if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
        throw new Error(`${name}必须是64位小写SHA-256`);
    }
}
async function main(): Promise<any> {
    const { server } = await startRecoveryServer();
    const stop: any = (): any => {
        server.close((error: any): any => {
            process.exitCode = error ? 1 : 0;
        });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
import fs from 'node:fs';

function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    try {
        const rawHref = pathToFileURL(process.argv[1]).href;
        if (import.meta.url === rawHref) return true;
        const realHref = pathToFileURL(fs.realpathSync(process.argv[1])).href;
        return import.meta.url === realHref;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    main().catch((error: any): any => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
