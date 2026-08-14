import fs from 'node:fs/promises';
import path from 'node:path';
export function createHermesModelProfileResolver({ registry, proposalStore, root, readFile = fs.readFile }: any = {}): any {
    const profilesRoot: any = path.resolve(root, 'integrations/hermes/profiles');
    return async function resolveHermesModelProfile(agentId: any): Promise<any> {
        const agent: any = await registry.get(agentId);
        let runtimeProfileRef: any = agent?.status === 'active' ? agent.runtimeProfileRef : null;
        if (!runtimeProfileRef) {
            const proposals: any = await proposalStore.listProposals();
            const testingProposal: any = proposals.find((proposal: any): any => proposal.status === 'testing'
                && proposal.acceptance?.status === 'passed'
                && proposal.candidateManifest?.agentId === agentId);
            if (!testingProposal)
                return null;
            const instances: any = await proposalStore.listTestInstances();
            const passedInstance: any = instances.find((instance: any): any => instance.proposalId === testingProposal.proposalId
                && instance.status === 'passed');
            if (!passedInstance)
                return null;
            runtimeProfileRef = testingProposal.candidateManifest?.runtimeProfileRef;
        }
        if (!runtimeProfileRef)
            return null;
        const mappingPath: any = path.resolve(root, runtimeProfileRef);
        if (!mappingPath.startsWith(`${profilesRoot}${path.sep}`))
            return null;
        try {
            const mapping: any = JSON.parse(await readFile(mappingPath, 'utf8'));
            return mapping.profileId === agentId ? mapping.profileId : null;
        }
        catch {
            return null;
        }
    };
}
