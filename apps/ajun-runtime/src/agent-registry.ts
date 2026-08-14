import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentRegistrySnapshotCache } from './agent-registry-snapshot-cache.ts';
export class AgentRegistry {
    agentsDir: any;
    snapshotCache: AgentRegistrySnapshotCache | null;
    constructor({ agentsDir, snapshotCache = new AgentRegistrySnapshotCache() }: any) {
        this.agentsDir = agentsDir;
        this.snapshotCache = snapshotCache;
    }
    async list({ includeInactive = false, includeManagers = false }: any = {}): Promise<any> {
        const manifests: any = await this.readAll();
        return manifests
            .filter((manifest: any): any => includeManagers || manifest.kind !== 'manager')
            .filter((manifest: any): any => includeInactive || manifest.status === 'active')
            .sort((left: any, right: any): any => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    }
    async readAll(): Promise<any> {
        if (this.snapshotCache)
            return this.snapshotCache.read((): Promise<any[]> => this.loadAll());
        return this.loadAll();
    }
    async loadAll(): Promise<any[]> {
        const entries: any = await fs.readdir(this.agentsDir, { withFileTypes: true });
        const manifests: any = await Promise.all(entries.filter((entry: any): any => entry.isDirectory()).map(async (entry: any): Promise<any> => {
            try {
                const manifest: any = JSON.parse(await fs.readFile(path.join(this.agentsDir, entry.name, 'manifest.json'), 'utf8'));
                return { ...manifest, independentRuntime: await this.independentRuntime(manifest) };
            }
            catch {
                return null;
            }
        }));
        return manifests.filter(Boolean);
    }
    invalidate(): void {
        this.snapshotCache?.invalidate();
    }
    async get(agentId: any, options: any = {}): Promise<any> { return (await this.list({ includeInactive: true, includeManagers: true, ...options })).find((agent: any): any => agent.agentId === agentId) || null; }
    async candidates(taskType: any): Promise<any> {
        return (await this.list({ includeManagers: true }))
            .filter((agent: any): any => agent.acceptedTaskTypes.includes(taskType));
    }
    async runtimeProfile(manifest: any): Promise<any> {
        const profilePath: any = this.runtimeProfilePath(manifest);
        if (!profilePath)
            return null;
        try {
            return JSON.parse(await fs.readFile(profilePath, 'utf8'));
        }
        catch {
            return null;
        }
    }
    async independentRuntime(manifest: any): Promise<any> {
        const ref: any = String(manifest?.runtimeProfileRef || '').trim();
        if (!ref)
            return { state: 'not_declared' };
        const profilePath: any = this.runtimeProfilePath(manifest);
        if (!profilePath)
            return { state: 'invalid_reference' };
        try {
            const profile: any = JSON.parse(await fs.readFile(profilePath, 'utf8'));
            const local: any = profile.localProfile || {};
            const gateway: any = profile.gateway || {};
            if (!local.created)
                return { state: 'not_created' };
            if (manifest?.interaction?.directFeishu === 'disabled') {
                return local.credentialedTransportVerified === true ? { state: 'on_demand' } : { state: 'model_transport_pending' };
            }
            if (local.credentialedTransportVerified === true && (gateway.enabled !== false || local.gatewayStarted === true))
                return { state: 'ready' };
            if (local.modelConfigured !== true)
                return { state: 'model_pending' };
            if (local.credentialedTransportVerified !== true)
                return { state: 'model_transport_pending' };
            if (gateway.enabled !== true)
                return { state: 'channel_pending' };
            return { state: 'waiting_verification' };
        }
        catch {
            return { state: 'missing_profile' };
        }
    }
    runtimeProfilePath(manifest: any): any {
        const ref: any = String(manifest?.runtimeProfileRef || '').trim();
        if (!ref)
            return null;
        const repositoryRoot: any = path.dirname(this.agentsDir);
        const profilesRoot: any = path.resolve(repositoryRoot, 'integrations/hermes/profiles');
        const profilePath: any = path.resolve(repositoryRoot, ref);
        return profilePath.startsWith(`${profilesRoot}${path.sep}`) ? profilePath : null;
    }
}
