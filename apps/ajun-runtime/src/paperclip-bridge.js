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
      const managedAgent = task.assigneeAgentId ? await this.managedAgent(task.assigneeAgentId, company.id) : null;
      const issue = await this.request(`/api/companies/${company.id}/issues`, {
        method: 'POST', body: {
          title: task.input.title,
          description: describe(task),
          status: approval ? 'blocked' : managedAgent ? 'todo' : 'backlog',
          priority: priorityFor(task.priority),
          ...(task.taskType === 'operations.technical-repair' && managedAgent?.metadata?.paperclipProjectId ? { projectId:managedAgent.metadata.paperclipProjectId } : {}),
          ...(managedAgent ? { assigneeAgentId:managedAgent.id } : {})
        }
      });
      const result = { status: 'synced', paperclipIssueId: issue.id, paperclipIssueIdentifier: issue.identifier, ...(managedAgent ? { paperclipAssigneeAgentId:managedAgent.id, paperclipAssigneeName:managedAgent.name } : {}), syncedAt: new Date().toISOString() };
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

  async projectChild(task, parentIssueId) {
    try {
      const issue = await this.request(`/api/issues/${encodeURIComponent(parentIssueId)}/children`, {
        method:'POST', body:{ title:task.input.title, description:describe(task), status:'todo', priority:priorityFor(task.priority), blockParentUntilDone:true }
      });
      return { status:'synced', paperclipIssueId:issue.id, paperclipIssueIdentifier:issue.identifier, paperclipParentIssueId:parentIssueId, syncedAt:new Date().toISOString() };
    } catch (error) {
      return { status:'sync_pending', paperclipParentIssueId:parentIssueId, reason:safeError(error), syncedAt:new Date().toISOString() };
    }
  }

  async health() {
    try {
      const status = await this.request('/api/health');
      return { status: status.status === 'ok' ? 'ready' : 'degraded', version: status.version || null };
    } catch { return { status: 'offline', version: null }; }
  }

  async syncRoster(manifests) {
    try {
      const company = await this.companyForRuntime();
      const existing = await this.request(`/api/companies/${company.id}/agents`);
      const roster = (Array.isArray(manifests) ? manifests : []).filter((manifest) => manifest?.agentId && manifest?.name && manifest.status === 'active');
      const synced = [];
      for (const manifest of roster) {
        const current = existing.find((agent) => agent.metadata?.agentArmyId === manifest.agentId && agent.status !== 'terminated')
          || (manifest.agentId === 'operator' ? existing.find((agent) => agent.name === 'A君本机健康官' && agent.adapterType === 'http' && agent.status !== 'terminated') : null);
        if (current) {
          if (manifest.agentId === 'operator' && current.metadata?.agentArmyId !== 'operator') {
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, { method:'PATCH', body:{ metadata:{ ...(current.metadata || {}), agentArmyId:'operator', agentArmyRole:manifest.role, agentArmyManagedOnly:false } } });
          } else if (current.metadata?.agentArmyManagedOnly === true && rosterNeedsRefresh(current, manifest)) {
            const desired = paperclipRosterEntry(manifest);
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
              method:'PATCH', body:{
                name:desired.name, role:desired.role, title:desired.title, icon:desired.icon, capabilities:desired.capabilities,
                metadata:{ ...(current.metadata || {}), ...desired.metadata }
              }
            });
          }
          synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:current.id, name:current.name, created:false });
          continue;
        }
        const created = await this.request(`/api/companies/${company.id}/agents`, { method:'POST', body:paperclipRosterEntry(manifest) });
        const paused = await this.request(`/api/agents/${encodeURIComponent(created.id)}`, { method:'PATCH', body:{ status:'paused' } });
        existing.push(paused);
        synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:paused.id, name:paused.name, created:true });
      }
      return { status:'synced', companyId:company.id, agents:synced, syncedAt:new Date().toISOString() };
    } catch (error) {
      return { status:'sync_pending', reason:safeError(error), syncedAt:new Date().toISOString() };
    }
  }

  async projectProposal(proposal) {
    try {
      const company = await this.companyForRuntime();
      const issue = await this.request(`/api/companies/${company.id}/issues`, {
        method: 'POST', body: {
          title: `招聘审核：${proposal.candidateManifest.name}`,
          description: describeProposal(proposal), status: 'blocked', priority: 'medium'
        }
      });
      const approval = await this.request(`/api/companies/${company.id}/approvals`, {
        method: 'POST', body: {
          type: 'request_board_approval', issueIds: [issue.id],
          payload: { source: 'ajun-runtime', proposalId: proposal.proposalId, candidateAgentId: proposal.candidateManifest.agentId, requestedCapabilities: proposal.requestedCapabilities, desiredSkills: proposal.desiredSkills, budgetPolicy: proposal.budgetPolicy }
        }
      });
      return { status: 'synced', paperclipIssueId: issue.id, paperclipIssueIdentifier: issue.identifier, paperclipApprovalId: approval.id, syncedAt: new Date().toISOString() };
    } catch (error) { return { status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() }; }
  }

  async updateProposal(proposal) {
    const projection = proposal.governance;
    if (!projection?.paperclipIssueId) return projection || { status: 'not_projected' };
    try {
      const evidence = (proposal.audit || []).filter((item) => item.action === 'test_evidence_recorded').at(-1);
      await this.request(`/api/issues/${encodeURIComponent(projection.paperclipIssueId)}`, {
        method: 'PATCH', body: { status: proposal.status === 'active' ? 'done' : proposal.status === 'needs_revision' || proposal.status === 'rejected' ? 'blocked' : 'backlog', comment: `A君创建闭环状态：${proposal.status}。草案 ID：${proposal.proposalId}${evidence ? `\n${evidence.detail}` : ''}` }
      });
      return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
    } catch (error) { return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() }; }
  }

  async approveProposal(proposal, decisionNote = '负责人批准受限测试；不代表生产上线。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级批准。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'approved', syncedAt: new Date().toISOString() };
  }

  async rejectProposal(proposal, decisionNote = '负责人拒绝该草案；未启动测试或生产运行。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级拒绝。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'rejected', syncedAt: new Date().toISOString() };
  }

  async resolveApproval(approvalId, decision, decisionNote = '由飞书组织级审批卡确认。') {
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new Error('组织级审批决定无效。');
    const approval = await this.request(`/api/approvals/${encodeURIComponent(String(approvalId || ''))}/${normalized}`, { method: 'POST', body: { decisionNote } });
    const expected = normalized === 'approve' ? 'approved' : 'rejected';
    if (approval.status !== expected) throw new Error(`Paperclip 审批未进入预期状态：${approval.status || 'unknown'}。`);
    return approval;
  }

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

  async getIssueWorkProducts(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`);
  }

  async getPaperclipIssueRuns(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/runs`);
  }

  async getExecutionWorkspace(workspaceId) {
    return this.request(`/api/execution-workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async getPaperclipAgent(agentId) {
    const company = await this.companyForRuntime();
    const agents = await this.request(`/api/companies/${company.id}/agents`);
    return agents.find((agent) => agent.id === agentId) || null;
  }

  async createIssueWorkProduct(issueId, product) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, { method:'POST', body:product });
  }

  async completeTechnicalRepairIssue(issueId, title) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH', body:{ status:'done', comment:`A君已代为登记技术专家在受控工作区留下的修复证据：${String(title || '修复与验证证据')}。专家本身未被授予网络访问权限。` }
    });
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

  async managedAgent(agentArmyId, companyId = null) {
    const company = companyId ? { id:companyId } : await this.companyForRuntime();
    const agents = await this.request(`/api/companies/${company.id}/agents`);
    return agents.find((agent) => agent.metadata?.agentArmyId === agentArmyId && agent.status !== 'terminated') || null;
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
  const context = task.input?.context;
  if (context?.failure) {
    parts.push([
      '脱敏故障信息：',
      `代码：${String(context.failure.code || 'unknown')}`,
      `阶段：${String(context.failure.stage || 'unknown')}`,
      `类别：${String(context.failure.category || 'manual')}`,
      `是否允许安全重试：${context.failure.retryable === true ? '是' : '否'}`
    ].join('\n'));
  }
  if (task.taskType === 'operations.technical-repair') parts.push('工程要求：先复现和定位；只能修改当前项目；必须运行相关测试；没有证据不得宣称修好；禁止读取凭据、登录、外发、付费、扩权或发布。');
  return parts.join('\n\n');
}

function describeProposal(proposal) {
  return [
    '由飞书/A君创建入口生成的 Agent 草案。此条仅用于组织级审核；不包含原始聊天、凭据、Cookie 或业务素材。',
    `草案 ID：${proposal.proposalId}`,
    `候选岗位：${proposal.candidateManifest.name}（${proposal.candidateManifest.agentId}）`,
    `目标：${proposal.requestedOutcome}`,
    `能力：${proposal.requestedCapabilities.join('、') || '无外部能力'}`,
    `Skills：${proposal.desiredSkills.join('、') || '无'}`,
    `验收：${proposal.acceptanceTask.title}`
  ].join('\n\n');
}

function priorityFor(priority) { return ({ low: 'low', high: 'high', urgent: 'urgent' })[priority] || 'medium'; }
function issueStatusFor(status) { return ({ running: 'backlog', pausing:'backlog', paused:'blocked', succeeded: 'done', failed: 'blocked', cancelled:'blocked', waiting_approval: 'blocked', waiting_test:'blocked' })[status] || 'backlog'; }
function safeError(error) { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }

function paperclipRosterEntry(manifest) {
  return {
    name:manifest.name,
    role:paperclipRoleFor(manifest),
    title:manifest.role,
    icon:paperclipIconFor(manifest),
    capabilities:(manifest.responsibilities || []).join('；') || manifest.role,
    // These entries are organization records only.  A君 still owns the local
    // executor and reports the verified result back to Paperclip; starting an
    // extra Paperclip runtime here could duplicate a real task.
    adapterType:'http', adapterConfig:{}, budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{ agentArmyId:manifest.agentId, agentArmyRole:manifest.role, agentArmyManagedOnly:true }
  };
}

function paperclipRoleFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'researcher';
  return ({ creator:'pm', 'task-coordinator':'pm', reviewer:'security', architect:'cto', xiaod:'researcher', operator:'devops', 'technical-expert':'engineer' })[agentId] || 'general';
}

function paperclipIconFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'search';
  return ({ creator:'sparkles', 'task-coordinator':'target', reviewer:'shield', architect:'brain', xiaod:'file-code', operator:'cog', 'technical-expert':'wrench' })[agentId] || 'bot';
}

function rosterNeedsRefresh(current, manifest) {
  const desired = paperclipRosterEntry(manifest);
  return current.name !== desired.name
    || current.role !== desired.role
    || current.title !== desired.title
    || current.icon !== desired.icon
    || current.capabilities !== desired.capabilities
    || current.metadata?.agentArmyRole !== desired.metadata.agentArmyRole;
}
