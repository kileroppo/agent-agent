export class PaperclipHeartbeatHandler {
  constructor({ operator, governance, now = () => new Date() } = {}) {
    this.operator = operator;
    this.governance = governance;
    this.now = now;
    this.inFlightIssues = new Map();
  }

  async handle(payload) {
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId) throw new PaperclipHeartbeatError('Paperclip heartbeat 缺少运行或岗位标识。');
    if (!issueId) return { accepted: true, skipped: true, reason: '当前 heartbeat 没有分配任务。' };

    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);

    const execution = this.executeIssue({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try { return await execution; } finally { this.inFlightIssues.delete(issueId); }
  }

  async executeIssue({ issueId, runId, agentId }) {
    const current = await this.governance.getPaperclipIssue(issueId);
    if (current.status === 'done') return { accepted: true, skipped: true, issueId, reason: '任务已完成，不重复执行。' };

    const task = {
      taskId: issueId,
      input: { title: 'Paperclip 指派的本机健康检查' },
      execution: { executor: 'paperclip-http-adapter', paperclipRunId: runId, paperclipAgentId: agentId, startedAt: this.now().toISOString() }
    };

    try {
      const result = await this.operator.execute(task);
      await this.governance.completePaperclipIssue(issueId, { runId, agentId, result });
      return { accepted: true, issueId, stage: result.currentStage, status: result.status };
    } catch (error) {
      await this.governance.failPaperclipIssue(issueId, { runId, agentId, error }).catch(() => undefined);
      throw error;
    }
  }
}

export class PaperclipHeartbeatError extends Error {}
