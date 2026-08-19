import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE_DIR: any = 'custom-ai-capabilities';

const BLOCKED_HOSTS: any = new Set(['169.254.169.254', '100.100.100.200', 'metadata.google.internal']);

function validateEndpointUrl(endpointUrl: any): void {
    let parsed: any;
    try { parsed = new URL(endpointUrl); } catch { throw validationError('endpointUrl 不是有效的 URL。'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw validationError('endpointUrl 只允许 http 或 https 协议。');
    const hostname: any = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1')
        throw validationError('endpointUrl 不允许指向回环地址。');
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))
        throw validationError('endpointUrl 不允许指向回环地址。');
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname))
        throw validationError('endpointUrl 不允许指向链路本地地址。');
    if (BLOCKED_HOSTS.has(hostname))
        throw validationError('endpointUrl 不允许指向云元数据服务。');
}

export class CustomAiCapabilityStore {
    dir: any;
    constructor({ dataDir }: any) {
        this.dir = path.join(dataDir, STORE_DIR);
    }
    async list(): Promise<any> {
        await fs.mkdir(this.dir, { recursive: true });
        const files: any = await fs.readdir(this.dir);
        const entries: any[] = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const content: any = await fs.readFile(path.join(this.dir, file), 'utf8');
                entries.push(JSON.parse(content));
            } catch { /* skip corrupt files */ }
        }
        return entries.sort((a: any, b: any): any => (a.registeredAt || '').localeCompare(b.registeredAt || ''));
    }
    async register(input: any): Promise<any> {
        const capabilityType: any = String(input?.capabilityType || '').trim();
        if (!capabilityType) throw validationError('capabilityType 不能为空。');
        const label: any = String(input?.label || '').trim();
        if (!label) throw validationError('label 不能为空。');
        const endpointUrl: any = String(input?.endpointUrl || '').trim();
        if (!endpointUrl) throw validationError('endpointUrl 不能为空。');
        validateEndpointUrl(endpointUrl);
        const entry: any = {
            id: crypto.randomUUID(),
            capabilityType,
            label,
            endpointUrl,
            healthCheckPath: String(input?.healthCheckPath || '/health').trim() || '/health',
            healthCheckMethod: String(input?.healthCheckMethod || 'GET').trim().toUpperCase() || 'GET',
            registeredAt: new Date().toISOString(),
            lastHealthCheck: null,
            lastHealthStatus: 'unknown',
        };
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(path.join(this.dir, `${entry.id}.json`), JSON.stringify(entry, null, 2) + '\n');
        return entry;
    }
    async remove(id: any): Promise<any> {
        const safeId: any = String(id || '').trim();
        if (!safeId) return { removed: false };
        const filePath: any = path.join(this.dir, `${safeId}.json`);
        try { await fs.unlink(filePath); return { removed: true }; } catch { return { removed: false }; }
    }
    async checkHealth(id: any): Promise<any> {
        const safeId: any = String(id || '').trim();
        const filePath: any = path.join(this.dir, `${safeId}.json`);
        let entry: any;
        try { entry = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { throw validationError('找不到指定的自定义能力。'); }
        validateEndpointUrl(entry.endpointUrl);
        const url: any = entry.endpointUrl.replace(/\/+$/, '') + entry.healthCheckPath;
        let status: any = 'unhealthy';
        try {
            const response: any = await fetch(url, { method: entry.healthCheckMethod, signal: AbortSignal.timeout(3000) });
            if (response.ok) status = 'healthy';
        } catch { /* unhealthy */ }
        entry.lastHealthCheck = new Date().toISOString();
        entry.lastHealthStatus = status;
        await fs.writeFile(filePath, JSON.stringify(entry, null, 2) + '\n');
        return entry;
    }
}

function validationError(message: any): any {
    return Object.assign(new Error(message), { httpStatus: 422, code: 'custom_ai_validation' });
}
