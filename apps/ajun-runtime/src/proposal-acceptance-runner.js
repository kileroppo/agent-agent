export class ProposalAcceptanceRunner {
  constructor({ publicReport } = {}) { this.publicReport = publicReport; }

  async run({ proposal, testInstance, sourceUrl }) {
    if (!proposal.requestedCapabilities?.includes('content.public.fetch') || proposal.candidateManifest?.acceptedTaskTypes?.join(',') !== 'report.public-material') {
      throw new Error('当前草案没有可自动验证的公开网页试用范围。');
    }
    return this.publicReport.execute({
      taskId: `proposal-test:${testInstance.testInstanceId}`,
      assigneeAgentId: proposal.candidateManifest.agentId,
      input: { sourceUrl }
    });
  }
}
