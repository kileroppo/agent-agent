import {
  paperclipHermesAdapterConfig,
  usesPaperclipHermesExecution,
} from './governance-hermes-runtime.js';

export const paperclipOrganizationMethods = {
  async syncRoster(manifests) {
    try {
      const company = await this.companyForRuntime();
      const existing = await this.request(`/api/companies/${company.id}/agents`);
      const roster = (Array.isArray(manifests) ? manifests : []).filter((manifest) => manifest?.agentId && manifest?.name && manifest.status === 'active');
      const desiredAgentIds = new Set(roster.map((manifest) => manifest.agentId));
      const synced = [];
      for (const manifest of roster) {
        const current = existing.find((agent) => agent.metadata?.agentArmyId === manifest.agentId && agent.status !== 'terminated')
          || (manifest.agentId === 'operator' ? existing.find((agent) => agent.name === 'A君本机健康官' && agent.adapterType === 'http' && agent.status !== 'terminated') : null);
        if (current) {
          const desired = paperclipRosterEntry(manifest);
          if (manifest.agentId === 'operator' && current.metadata?.agentArmyId !== 'operator' && !usesPaperclipHermesExecution(manifest)) {
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
              method:'PATCH',
              body:{ metadata:{ ...(current.metadata || {}), agentArmyId:'operator', agentArmyRole:manifest.role, agentArmyManagedOnly:false } }
            });
          } else if (rosterNeedsRefresh(current, manifest)) {
            const hermesOwned = usesPaperclipHermesExecution(manifest);
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
              method:'PATCH', body:{
                name:desired.name, role:desired.role, title:desired.title, icon:desired.icon, capabilities:desired.capabilities,
                ...(hermesOwned ? {
                  adapterType:desired.adapterType,
                  adapterConfig:desired.adapterConfig
                } : {}),
                ...(['paused', 'error'].includes(current.status) && hermesOwned ? { status:'idle' } : {}),
                metadata:{ ...(current.metadata || {}), ...desired.metadata }
              }
            });
          }
          if (usesPaperclipHermesExecution(manifest)) {
            await this.syncAgentSkills(current.id, manifest.runtimeCapabilities?.skills);
          }
          synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:current.id, name:current.name, created:false });
          continue;
        }
        const created = await this.request(`/api/companies/${company.id}/agents`, { method:'POST', body:paperclipRosterEntry(manifest) });
        const configured = await this.request(`/api/agents/${encodeURIComponent(created.id)}`, {
          method:'PATCH',
          body:{ status:usesPaperclipHermesExecution(manifest) ? 'idle' : 'paused' }
        });
        existing.push(configured);
        if (usesPaperclipHermesExecution(manifest)) {
          await this.syncAgentSkills(configured.id, manifest.runtimeCapabilities?.skills);
        }
        synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:configured.id, name:configured.name, created:true });
      }
      const retired = [];
      for (const current of existing) {
        const agentArmyId = String(current?.metadata?.agentArmyId || '').trim();
        if (!agentArmyId
          || desiredAgentIds.has(agentArmyId)
          || current.status === 'terminated'
          || current.metadata?.agentArmyManagedOnly !== true) continue;
        await this.request(`/api/agents/${encodeURIComponent(current.id)}/terminate`, { method:'POST' });
        retired.push({ agentArmyId, paperclipAgentId:current.id, name:current.name });
      }
      return { status:'synced', companyId:company.id, agents:synced, retired, syncedAt:new Date().toISOString() };
    } catch (error) {
      return { status:'sync_pending', reason:safeError(error), syncedAt:new Date().toISOString() };
    }
  },

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
  },

  async syncAgentSkills(paperclipAgentId, skills = []) {
    const desiredSkills = [...new Set((Array.isArray(skills) ? skills : []).map((item) => String(item || '').trim()).filter(Boolean))];
    return this.request(`/api/agents/${encodeURIComponent(paperclipAgentId)}/skills/sync`, {
      method:'POST',
      body:{ desiredSkills }
    });
  },

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
  },

  async approveProposal(proposal, decisionNote = '负责人批准受限测试；不代表生产上线。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级批准。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'approved', syncedAt: new Date().toISOString() };
  },

  async rejectProposal(proposal, decisionNote = '负责人拒绝该草案；未启动测试或生产运行。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级拒绝。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'rejected', syncedAt: new Date().toISOString() };
  },

  async resolveApproval(approvalId, decision, decisionNote = '由飞书组织级审批卡确认。') {
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new Error('组织级审批决定无效。');
    const approval = await this.request(`/api/approvals/${encodeURIComponent(String(approvalId || ''))}/${normalized}`, { method: 'POST', body: { decisionNote } });
    const expected = normalized === 'approve' ? 'approved' : 'rejected';
    if (approval.status !== expected) throw new Error(`Paperclip 审批未进入预期状态：${approval.status || 'unknown'}。`);
    return approval;
  },

  async getApproval(approvalId) {
    const normalized = String(approvalId || '').trim();
    if (!normalized) throw new Error('Paperclip 审批 ID 不能为空。');
    return this.request(`/api/approvals/${encodeURIComponent(normalized)}`);
  }
};

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

function paperclipRosterEntry(manifest) {
  const hermesOwned = usesPaperclipHermesExecution(manifest);
  return {
    name:manifest.name,
    role:paperclipRoleFor(manifest),
    title:manifest.role,
    icon:paperclipIconFor(manifest),
    capabilities:(manifest.responsibilities || []).join('；') || manifest.role,
    adapterType:hermesOwned ? 'hermes_local' : 'http',
    adapterConfig:hermesOwned ? paperclipHermesAdapterConfig(manifest) : {},
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmyId:manifest.agentId,
      agentArmyRole:manifest.role,
      agentArmyManagedOnly:true,
      executionOwner:manifest.executionOwner || 'ajun-local',
      hermesProfileId:hermesOwned ? manifest.agentId : null
    }
  };
}

function paperclipRoleFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'researcher';
  return ({ creator:'pm', reviewer:'security', architect:'cto', xiaod:'researcher', operator:'devops', 'technical-expert':'engineer' })[agentId] || 'general';
}

function paperclipIconFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'search';
  return ({ creator:'sparkles', reviewer:'shield', architect:'brain', xiaod:'file-code', operator:'cog', 'technical-expert':'wrench' })[agentId] || 'bot';
}

function rosterNeedsRefresh(current, manifest) {
  const desired = paperclipRosterEntry(manifest);
  const hermesOwned = usesPaperclipHermesExecution(manifest);
  if (!hermesOwned && current.metadata?.agentArmyManagedOnly !== true) return false;
  return current.name !== desired.name
    || current.role !== desired.role
    || current.title !== desired.title
    || current.icon !== desired.icon
    || current.capabilities !== desired.capabilities
    || (hermesOwned && current.adapterType !== desired.adapterType)
    || (hermesOwned && stableJson(current.adapterConfig || {}) !== stableJson(desired.adapterConfig || {}))
    || current.metadata?.agentArmyRole !== desired.metadata.agentArmyRole
    || current.metadata?.executionOwner !== desired.metadata.executionOwner
    || current.metadata?.hermesProfileId !== desired.metadata.hermesProfileId
    || (['paused', 'error'].includes(current.status) && usesPaperclipHermesExecution(manifest));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function safeError(error) { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }
