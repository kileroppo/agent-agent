export class ProposalAcceptanceRunner {
  constructor({ publicReport, githubScout = null, intelResearcher = null } = {}) { this.publicReport = publicReport; this.githubScout = githubScout; this.intelResearcher = intelResearcher; }

  async run({ proposal, testInstance, sourceUrl = '', sourceUrls = [], query = null, topic = null }) {
    const agentId = proposal?.candidateManifest?.agentId;
    const task = {
      taskId: `proposal-test:${testInstance.testInstanceId}`,
      assigneeAgentId: agentId,
      input: { sourceUrl, sourceUrls, query, topic }
    };
    if (agentId === 'github-scout' && exactCapabilities(proposal, ['github.public.search', 'github.public.read'])) {
      if (!query) throw new Error('小G的受限测试需要一个公开 GitHub 检索关键词。');
      return this.githubScout?.execute(task) || Promise.reject(new Error('小G受限测试执行器不可用。'));
    }
    if (agentId === 'intel-researcher' && exactCapabilities(proposal, ['content.public.fetch', 'github.public.search', 'github.public.read'])) {
      if (!topic) throw new Error('小R的受限测试需要一个研究主题。');
      return this.intelResearcher?.execute(task) || Promise.reject(new Error('小R受限测试执行器不可用。'));
    }
    if (proposal.requestedCapabilities?.includes('content.public.fetch') && proposal.candidateManifest?.acceptedTaskTypes?.join(',') === 'report.public-material') return this.publicReport.execute(task);
    throw new Error('当前草案没有可自动验证的受限试用范围。');
  }
}

function exactCapabilities(proposal, expected) {
  const capabilities = proposal?.requestedCapabilities || [];
  return capabilities.length === expected.length && expected.every((item) => capabilities.includes(item));
}
