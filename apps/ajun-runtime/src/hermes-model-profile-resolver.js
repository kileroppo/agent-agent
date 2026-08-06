import fs from 'node:fs/promises';
import path from 'node:path';

export function createHermesModelProfileResolver({
  registry,
  proposalStore,
  root,
  readFile = fs.readFile
} = {}) {
  const profilesRoot = path.resolve(root, 'integrations/hermes/profiles');

  return async function resolveHermesModelProfile(agentId) {
    const agent = await registry.get(agentId);
    let runtimeProfileRef = agent?.status === 'active' ? agent.runtimeProfileRef : null;

    if (!runtimeProfileRef) {
      const proposals = await proposalStore.listProposals();
      const testingProposal = proposals.find((proposal) =>
        proposal.status === 'testing'
        && proposal.acceptance?.status === 'passed'
        && proposal.candidateManifest?.agentId === agentId
      );
      if (!testingProposal) return null;

      const instances = await proposalStore.listTestInstances();
      const passedInstance = instances.find((instance) =>
        instance.proposalId === testingProposal.proposalId
        && instance.status === 'passed'
      );
      if (!passedInstance) return null;
      runtimeProfileRef = testingProposal.candidateManifest?.runtimeProfileRef;
    }

    if (!runtimeProfileRef) return null;
    const mappingPath = path.resolve(root, runtimeProfileRef);
    if (!mappingPath.startsWith(`${profilesRoot}${path.sep}`)) return null;
    try {
      const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
      return mapping.profileId === agentId ? mapping.profileId : null;
    } catch {
      return null;
    }
  };
}
