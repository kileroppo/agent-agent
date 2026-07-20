export class LocalCreator {
  constructor({ proposals, now = () => new Date() } = {}) { this.proposals = proposals; this.now = now; }

  async execute(task) {
    const proposal = await this.proposals.create({
      requestedOutcome: task.input.title,
      candidateName: task.input.description || undefined,
      sourceEventRef: task.source?.eventRef || null
    }, { source: task.source?.channel || 'ajun-runtime' });
    const submitted = proposal.status === 'draft' ? await this.proposals.submit(proposal.proposalId) : proposal;
    const completedAt = this.now().toISOString();
    return {
      status: 'succeeded', currentStage: 'agent_proposal_submitted',
      execution: { executor: 'creator', mode: 'proposal_only', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: submitted.status },
      artifactRefs: [{ artifactId: `agent-proposal:${submitted.proposalId}`, taskId: task.taskId, type: 'agent_proposal', title: `岗位草案：${submitted.candidateManifest.name}`, location: `runtime://agent-proposals/${submitted.proposalId}`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: { proposalId: submitted.proposalId, status: submitted.status, nextAction: '等待负责人审核；未通过受限测试前不会创建或路由正式 Agent。' } }]
    };
  }
}
