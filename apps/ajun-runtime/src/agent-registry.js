import fs from 'node:fs/promises';
import path from 'node:path';

export class AgentRegistry {
  constructor({ agentsDir }) { this.agentsDir = agentsDir; }

  async list() {
    const entries = await fs.readdir(this.agentsDir, { withFileTypes: true });
    const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try { return JSON.parse(await fs.readFile(path.join(this.agentsDir, entry.name, 'manifest.json'), 'utf8')); } catch { return null; }
    }));
    return manifests.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }

  async get(agentId) { return (await this.list()).find((agent) => agent.agentId === agentId) || null; }

  async candidates(taskType) { return (await this.list()).filter((agent) => agent.acceptedTaskTypes.includes(taskType)); }
}
