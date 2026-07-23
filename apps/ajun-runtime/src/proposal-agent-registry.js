export class ProposalAgentRegistry {
  constructor({ baseRegistry, store } = {}) {
    this.baseRegistry = baseRegistry;
    this.store = store;
  }

  async list() {
    const [registered, proposals] = await Promise.all([this.baseRegistry.list(), this.store.listProposals()]);
    const liveProposals = proposals
      .filter(canWork)
      .map((proposal) => ({
        ...proposal.candidateManifest,
        status: 'active',
        runtime: { kind: 'proposal-public-report', proposalId: proposal.proposalId },
        source: 'approved-proposal'
      }));
    const byId = new Map(registered.map((agent) => [agent.agentId, agent]));
    for (const agent of liveProposals) byId.set(agent.agentId, agent);
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }

  async get(agentId) { return (await this.list()).find((agent) => agent.agentId === agentId) || null; }

  async candidates(taskType) { return (await this.list()).filter((agent) => agent.acceptedTaskTypes.includes(taskType)); }
}

function canWork(proposal) {
  return proposal?.status === 'active'
    && proposal.requestedCapabilities?.includes('content.public.fetch')
    && proposal.candidateManifest?.acceptedTaskTypes?.length === 1
    && proposal.candidateManifest.acceptedTaskTypes[0] === 'report.public-material';
}
