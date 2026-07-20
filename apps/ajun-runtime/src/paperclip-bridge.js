const DEFAULT_URL = 'http://127.0.0.1:3100';
const COMPANY_NAME = 'Agent军团';

export class PaperclipBridge {
  constructor({ baseUrl = process.env.PAPERCLIP_URL || DEFAULT_URL, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.company = null;
  }

  async project(task, approval) {
    try {
      const company = await this.companyForRuntime();
      const issue = await this.request(`/api/companies/${company.id}/issues`, {
        method: 'POST', body: {
          title: task.input.title,
          description: describe(task),
          status: approval ? 'blocked' : 'backlog',
          priority: priorityFor(task.priority)
        }
      });
      const result = { status: 'synced', paperclipIssueId: issue.id, paperclipIssueIdentifier: issue.identifier, syncedAt: new Date().toISOString() };
      if (approval) {
        const governanceApproval = await this.request(`/api/companies/${company.id}/approvals`, {
          method: 'POST', body: {
            type: 'request_board_approval', issueIds: [issue.id],
            payload: { source: 'ajun-runtime', taskId: task.taskId, action: approval.action, riskLevel: approval.riskLevel, reason: approval.reason, requestedScope: approval.requestedScope }
          }
        });
        result.paperclipApprovalId = governanceApproval.id;
      }
      return result;
    } catch (error) {
      return { status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
    }
  }

  async health() {
    try {
      const status = await this.request('/api/health');
      return { status: status.status === 'ok' ? 'ready' : 'degraded', version: status.version || null };
    } catch { return { status: 'offline', version: null }; }
  }

  async update(task) {
    const projection = task.governance;
    if (!projection?.paperclipIssueId) return projection || { status: 'not_projected' };
    try {
      await this.request(`/api/issues/${projection.paperclipIssueId}`, {
        method: 'PATCH', body: { status: issueStatusFor(task.status), comment: `A君状态更新：${task.status}${task.currentStage ? ` / ${task.currentStage}` : ''}` }
      });
      return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
    } catch (error) {
      return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
    }
  }

  async completePaperclipIssue(issueId, { runId, agentId, result }) {
    const report = result.artifactRefs?.find((item) => item.type === 'health_report')?.data;
    const outcome = report?.overall || result.execution?.outcome || 'unknown';
    await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH', body: {
        status: result.status === 'succeeded' ? 'done' : 'blocked',
        comment: [
          'A君本机执行回报（Paperclip HTTP Adapter）。',
          `运行：${runId}`,
          `岗位：${agentId}`,
          `阶段：${result.currentStage || 'unknown'}`,
          `结果：${outcome}`
        ].join('\n')
      }
    });
  }

  async getPaperclipIssue(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`);
  }

  async failPaperclipIssue(issueId, { runId, agentId, error }) {
    await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH', body: {
        status: 'blocked',
        comment: [
          'A君本机执行失败（Paperclip HTTP Adapter）。',
          `运行：${runId}`,
          `岗位：${agentId}`,
          `原因：${safeError(error)}`
        ].join('\n')
      }
    });
  }

  async companyForRuntime() {
    if (this.company) return this.company;
    const companies = await this.request('/api/companies');
    const company = companies.find((item) => item.name === COMPANY_NAME);
    if (!company) throw new Error(`Paperclip 中未找到“${COMPANY_NAME}”组织。`);
    this.company = company;
    return company;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method || 'GET', headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(2500)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Paperclip 返回 ${response.status}`);
    return payload;
  }
}

function describe(task) {
  const parts = [
    '由 A君运行台创建的过渡任务投影。正式军团任务由 Paperclip 统一调度；A君只执行本机业务适配。',
    `A君任务 ID：${task.taskId}`,
    `任务类型：${task.taskType}`,
    `运行时状态：${task.status}`,
    `承接岗位：${task.assigneeAgentId || '待路由'}`
  ];
  if (task.input.description) parts.push(`说明：${task.input.description}`);
  return parts.join('\n\n');
}

function priorityFor(priority) { return ({ low: 'low', high: 'high', urgent: 'urgent' })[priority] || 'medium'; }
function issueStatusFor(status) { return ({ running: 'backlog', succeeded: 'done', failed: 'blocked', waiting_approval: 'blocked' })[status] || 'backlog'; }
function safeError(error) { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }
