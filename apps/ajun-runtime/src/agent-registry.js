import fs from 'node:fs/promises';
import path from 'node:path';

export class AgentRegistry {
  constructor({ agentsDir }) { this.agentsDir = agentsDir; }

  async list({ includeInactive = false, includeManagers = false } = {}) {
    const manifests = await this.readAll();
    return manifests
      .filter((manifest) => includeManagers || manifest.kind !== 'manager')
      .filter((manifest) => includeInactive || manifest.status === 'active')
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }

  async readAll() {
    const entries = await fs.readdir(this.agentsDir, { withFileTypes: true });
    const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(this.agentsDir, entry.name, 'manifest.json'), 'utf8'));
        return { ...manifest, independentRuntime: await this.independentRuntime(manifest) };
      } catch { return null; }
    }));
    return manifests.filter(Boolean);
  }

  async get(agentId, options = {}) { return (await this.list({ includeInactive:true, includeManagers:true, ...options })).find((agent) => agent.agentId === agentId) || null; }

  async candidates(taskType) {
    return (await this.list({ includeManagers:true }))
      .filter((agent) => agent.acceptedTaskTypes.includes(taskType));
  }

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
      if (manifest?.interaction?.directFeishu === 'disabled') {
        return local.credentialedTransportVerified === true ? { state:'on_demand' } : { state:'model_transport_pending' };
      }
      if (local.credentialedTransportVerified === true && (gateway.enabled !== false || local.gatewayStarted === true)) return { state: 'ready' };
      if (local.modelConfigured !== true) return { state: 'model_pending' };
      if (local.credentialedTransportVerified !== true) return { state: 'model_transport_pending' };
      if (gateway.enabled !== true) return { state: 'channel_pending' };
      return { state: 'waiting_verification' };
    } catch {
      return { state: 'missing_profile' };
    }
  }
}
