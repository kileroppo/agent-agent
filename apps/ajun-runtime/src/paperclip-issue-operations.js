export const paperclipIssueMethods = {
  async update(task) {
    const projection = task.governance;
    if (!projection?.paperclipIssueId) return projection || { status: 'not_projected' };
    if (task.taskType === 'operations.technical-repair' && projection.paperclipAssigneeAgentId && task.status !== 'waiting_test') {
      return { ...projection, status:'delegated', syncedAt:new Date().toISOString() };
    }
    try {
      await this.request(`/api/issues/${projection.paperclipIssueId}`, {
        method: 'PATCH', body: { status: issueStatusFor(task.status), comment: `A君状态更新：${task.status}${task.currentStage ? ` / ${task.currentStage}` : ''}` }
      });
      return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
    } catch (error) {
      return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
    }
  },

  async completePaperclipIssue(issueId, {
    runId,
    agentId,
    apiKey,
    result,
    hideFromDashboard = false,
  }) {
    const report = result.artifactRefs?.find((item) => item.type === 'health_report')?.data;
    const employeeReport = result.artifactRefs?.find((item) => item.type === 'employee_role_report')?.data;
    const outcome = report?.overall || employeeReport?.summary || result.execution?.outcome || 'unknown';
    const succeeded = result.status === 'succeeded';
    await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH', runId, apiKey, body: {
        status: succeeded ? 'done' : 'blocked',
        ...(hideFromDashboard && succeeded ? { hiddenAt:new Date().toISOString() } : {}),
        comment: [
          result.execution?.owner === 'paperclip-hermes'
            ? '员工 Hermes Profile 执行回报。'
            : 'A君本机执行回报（Paperclip HTTP Adapter）。',
          `运行：${runId}`,
          `岗位：${agentId}`,
          `阶段：${result.currentStage || 'unknown'}`,
          `结果：${outcome}`,
          ...(hideFromDashboard && succeeded
            ? ['系统巡检已归档：保留运行与任务证据，不进入老板大盘。']
            : []),
        ].join('\n')
      }
    });
  },

  async getPaperclipIssue(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`);
  },

  async getPaperclipIssueRuns(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/runs`);
  },

  async getPaperclipIssueActiveRun(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/active-run`);
  },

  async getPaperclipHeartbeatRun(runId) {
    return this.request(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  },

  async getExecutionWorkspace(workspaceId) {
    return this.request(`/api/execution-workspaces/${encodeURIComponent(workspaceId)}`);
  },

  async getPaperclipAgent(agentId) {
    const company = await this.companyForRuntime();
    const agents = await this.request(`/api/companies/${company.id}/agents`);
    return agents.find((agent) => agent.id === agentId) || null;
  },

  async updateIssueExecutionPolicy(issueId, { runId, executionPolicy } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{ executionPolicy },
    });
  },

  async createIssueWorkProduct(issueId, product, { runId, apiKey } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
      method:'POST',
      runId,
      apiKey,
      body:product,
    });
  },

  async getIssueWorkProducts(issueId, { runId } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
      runId,
    });
  },

  async completeMetricMonitorIssue(issueId, {
    runId,
    executionPolicy,
    comment,
  } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        executionPolicy,
        comment,
      },
    });
  },

  async completeRetrospectiveIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  },

  async updateLearningIssue(issueId, {
    runId,
    status,
    comment,
  } = {}) {
    if (!['in_progress', 'in_review', 'done'].includes(status)) {
      throw new Error('M5 学习任务状态无效。');
    }
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{ status, comment },
    });
  },

  async completePublisherIssue(issueId, {
    runId,
    comment,
  } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  },

  async completeTechnicalRepairIssue(issueId, title) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH', body:{ status:'done', comment:`A君已代为登记技术专家在受控工作区留下的修复证据：${String(title || '修复与验证证据')}。专家本身未被授予网络访问权限。` }
    });
  },

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
  },

  async companyForRuntime() {
    return this.taskProjector.companyForRuntime();
  },

  async managedAgent(agentArmyId, companyId = null) {
    return this.taskProjector.managedAgent(agentArmyId, companyId);
  }
};

function issueStatusFor(status) { return ({ running: 'backlog', pausing:'backlog', paused:'blocked', succeeded: 'done', failed: 'blocked', cancelled:'blocked', waiting_approval: 'blocked', waiting_test:'blocked', needs_input:'blocked', expired:'blocked' })[status] || 'backlog'; }
function safeError(error) { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }
