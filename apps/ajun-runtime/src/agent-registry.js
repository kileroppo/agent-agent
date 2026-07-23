import fs from 'node:fs/promises';
import path from 'node:path';

export class AgentRegistry {
  constructor({ agentsDir }) { this.agentsDir = agentsDir; }

  async list() {
    const entries = await fs.readdir(this.agentsDir, { withFileTypes: true });
    const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(this.agentsDir, entry.name, 'manifest.json'), 'utf8'));
        return { ...manifest, independentRuntime: await this.independentRuntime(manifest) };
      } catch { return null; }
    }));
    return manifests.filter((manifest) => manifest && manifest.kind !== 'manager').sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }

  async get(agentId) { return (await this.list()).find((agent) => agent.agentId === agentId) || null; }

  async candidates(taskType) { return (await this.list()).filter((agent) => agent.acceptedTaskTypes.includes(taskType)); }

  async independentRuntime(manifest) {
    const ref = String(manifest?.runtimeProfileRef || '').trim();
    if (!ref) return { state: 'not_declared' };

    const repositoryRoot = path.dirname(this.agentsDir);
    const profilesRoot = path.resolve(repositoryRoot, 'integrations/hermes/profiles');
    const profilePath = path.resolve(repositoryRoot, ref);
    if (!profilePath.startsWith(`${profilesRoot}${path.sep}`)) return { state: 'invalid_reference' };

    try {
      const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
      const local = profile.localProfile || {};
      const gateway = profile.gateway || {};
      if (!local.created) return { state: 'not_created' };
      if (local.credentialedTransportVerified === true && (gateway.enabled !== false || local.gatewayStarted === true)) return { state: 'ready' };
      if (local.modelConfigured !== true) return { state: 'model_pending' };
      if (gateway.enabled !== true) return { state: 'channel_pending' };
      return { state: 'waiting_verification' };
    } catch {
      return { state: 'missing_profile' };
    }
  }
}
