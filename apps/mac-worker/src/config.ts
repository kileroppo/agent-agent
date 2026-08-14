import os from 'node:os';
import path from 'node:path';
export function loadConfig(env: any = process.env) {
    const cloudUrl = secureCloudUrl(env.AGENT_ARMY_CLOUD_URL);
    const workerToken = String(env.AGENT_ARMY_WORKER_TOKEN || '').trim();
    if (workerToken.length < 32)
        throw new Error('AGENT_ARMY_WORKER_TOKEN 至少需要 32 个字符。');
    const xiaodUrl = loopbackUrl(env.XIAOD_RUNTIME_URL || 'http://127.0.0.1:4318');
    const workerId = clean(env.AGENT_ARMY_WORKER_ID || os.hostname(), 120);
    if (!workerId)
        throw new Error('AGENT_ARMY_WORKER_ID 不能为空。');
    return {
        cloudUrl,
        workerToken,
        workerId,
        xiaodUrl,
        stateFile: path.resolve(env.AGENT_ARMY_MAC_WORKER_STATE || path.join(process.cwd(), 'data/state.json')),
        pollMs: positiveNumber(env.AGENT_ARMY_WORKER_POLL_MS, 5000, 1000, 60000),
        requestTimeoutMs: positiveNumber(env.AGENT_ARMY_WORKER_REQUEST_TIMEOUT_MS, 10000, 1000, 60000)
    };
}
function secureCloudUrl(value: any) {
    const parsed = new URL(String(value || ''));
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
        throw new Error('云端办公室必须使用 HTTPS；只有本机验收允许 HTTP loopback。');
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
}
function loopbackUrl(value: any) {
    const parsed = new URL(String(value || ''));
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
        throw new Error('小D运行时必须是这台 Mac 的 HTTP loopback 地址。');
    }
    return parsed.toString().replace(/\/$/, '');
}
function positiveNumber(value: any, fallback: any, minimum: any, maximum: any) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
}
function clean(value: any, limit: any) {
    return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, limit);
}
