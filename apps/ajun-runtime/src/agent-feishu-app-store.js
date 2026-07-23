import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class FileAgentFeishuAppStore {
  constructor({ directory = path.join(os.homedir(), '.agent-army') } = {}) { this.directory = directory; }

  async listApps() {
    const data = await this.read('feishu-agent-apps.json', { apps:[] });
    return (Array.isArray(data.apps) ? data.apps : []).map(normalizeApp).filter(Boolean);
  }

  async upsertApp(app) {
    const next = normalizeApp(app);
    if (!next) throw new AgentFeishuAppStoreError('飞书智能体应用资料不完整，未保存。');
    const data = await this.read('feishu-agent-apps.json', { apps:[] });
    const apps = (Array.isArray(data.apps) ? data.apps : []).map(normalizeApp).filter(Boolean);
    const index = apps.findIndex((item) => item.agentId === next.agentId);
    if (index >= 0) apps[index] = next; else apps.push(next);
    await this.write('feishu-agent-apps.json', { schemaVersion:'agent.army/feishu-agent-apps/v1', apps });
    return next;
  }

  async saveSecret(agentId, appSecret) {
    const id = safeAgentId(agentId); const secret = String(appSecret || '').trim();
    if (!id || !secret) throw new AgentFeishuAppStoreError('飞书智能体应用密钥不完整，未保存。');
    const data = await this.read('feishu-agent-secrets.json', { secrets:{} });
    data.secrets = { ...(data.secrets || {}), [id]:secret };
    await this.write('feishu-agent-secrets.json', data);
  }

  async getSecret(agentId) {
    const data = await this.read('feishu-agent-secrets.json', { secrets:{} });
    return String(data.secrets?.[safeAgentId(agentId)] || '').trim() || null;
  }

  async read(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async write(name, data) {
    await fs.mkdir(this.directory, { recursive:true, mode:0o700 });
    const file = path.join(this.directory, name);
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode:0o600 });
    await fs.chmod(file, 0o600);
  }
}

export class AgentFeishuAppStoreError extends Error {}

function normalizeApp(value) {
  const agentId = safeAgentId(value?.agentId);
  const appId = String(value?.appId || '').trim();
  const allowedUserIds = list(value?.allowedUserIds);
  const allowedGroupIds = list(value?.allowedGroupIds);
  return agentId && appId && allowedUserIds.length ? { agentId, appId, allowedUserIds, allowedGroupIds } : null;
}
function list(value) { return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((item) => String(item || '').trim()).filter(Boolean))]; }
function safeAgentId(value) { const id = String(value || '').trim(); return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : null; }
