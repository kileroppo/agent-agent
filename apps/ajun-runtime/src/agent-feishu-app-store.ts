import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export class FileAgentFeishuAppStore {
    directory: any;
    constructor({ directory = process.env.AGENT_ARMY_PRIVATE_DIR || path.join(os.homedir(), '.agent-army') }: any = {}) { this.directory = directory; }
    async listApps(): Promise<any> {
        const data: any = await this.read('feishu-agent-apps.json', { apps: [] });
        return (Array.isArray(data.apps) ? data.apps : []).map(normalizeApp).filter(Boolean);
    }
    async upsertApp(app: any): Promise<any> {
        const next: any = normalizeApp(app);
        if (!next)
            throw new AgentFeishuAppStoreError('飞书智能体应用资料不完整，未保存。');
        const data: any = await this.read('feishu-agent-apps.json', { apps: [] });
        const apps: any = (Array.isArray(data.apps) ? data.apps : []).map(normalizeApp).filter(Boolean);
        const index: any = apps.findIndex((item: any): any => item.agentId === next.agentId);
        if (index >= 0)
            apps[index] = next;
        else
            apps.push(next);
        await this.write('feishu-agent-apps.json', { schemaVersion: 'agent.army/feishu-agent-apps/v1', apps });
        return next;
    }
    async saveSecret(agentId: any, appSecret: any): Promise<any> {
        const id: any = safeAgentId(agentId);
        const secret: any = String(appSecret || '').trim();
        if (!id || !secret)
            throw new AgentFeishuAppStoreError('飞书智能体应用密钥不完整，未保存。');
        const data: any = await this.read('feishu-agent-secrets.json', { secrets: {} });
        data.secrets = { ...(data.secrets || {}), [id]: secret };
        await this.write('feishu-agent-secrets.json', data);
    }
    async getSecret(agentId: any): Promise<any> {
        const data: any = await this.read('feishu-agent-secrets.json', { secrets: {} });
        return String(data.secrets?.[safeAgentId(agentId)] || '').trim() || null;
    }
    async read(name: any, fallback: any): Promise<any> {
        try {
            return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
        }
        catch (error: any) {
            if (error.code === 'ENOENT')
                return fallback;
            throw error;
        }
    }
    async write(name: any, data: any): Promise<any> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file: any = path.join(this.directory, name);
        await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        await fs.chmod(file, 0o600);
    }
}
export class AgentFeishuAppStoreError extends Error {
}
function normalizeApp(value: any): any {
    const agentId: any = safeAgentId(value?.agentId);
    const appId: any = String(value?.appId || '').trim();
    const allowedUserIds: any = list(value?.allowedUserIds);
    const allowedGroupIds: any = list(value?.allowedGroupIds);
    return agentId && appId && allowedUserIds.length ? { agentId, appId, allowedUserIds, allowedGroupIds } : null;
}
function list(value: any): any { return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((item: any): any => String(item || '').trim()).filter(Boolean))]; }
function safeAgentId(value: any): any { const id: any = String(value || '').trim(); return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : null; }
