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
    for (const agent of liveProposals) {
      const existing = byId.get(agent.agentId);
      if (existing?.status === 'active') continue;
      byId.set(agent.agentId, {
        ...agent,
        ...(existing?.independentRuntime ? { independentRuntime:existing.independentRuntime } : {})
      });
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }

  async get(agentId) { return (await this.list()).find((agent) => agent.agentId === agentId) || null; }

  async candidates(taskType) { return (await this.list()).filter((agent) => agent.acceptedTaskTypes.includes(taskType)); }
}

function canWork(proposal) {
  if (proposal?.status !== 'active' || proposal.candidateManifest?.acceptedTaskTypes?.length !== 1) return false;
  const taskType = proposal.candidateManifest.acceptedTaskTypes[0];
  const capabilities = proposal.requestedCapabilities || [];
  if (taskType === 'report.public-material') return capabilities.includes('content.public.fetch');
  if (proposal.candidateManifest?.agentId === 'github-scout' && taskType === 'research.github-search') return sameItems(capabilities, ['github.public.search', 'github.public.read']);
  if (proposal.candidateManifest?.agentId === 'intel-researcher' && taskType === 'research.intel-report') return sameItems(capabilities, ['content.public.fetch', 'github.public.search', 'github.public.read']);
  return false;
}

function sameItems(items, expected) { return Array.isArray(items) && items.length === expected.length && expected.every((item) => items.includes(item)); }
