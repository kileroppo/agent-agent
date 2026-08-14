import { paperclipHermesAdapterConfig, usesPaperclipHermesExecution, } from './governance-hermes-runtime.ts';
export const paperclipOrganizationMethods: Record<string, any> = {
    async syncRoster(manifests: any): Promise<any> {
        try {
            const company: any = await this.companyForRuntime();
            const existing: any = await this.request(`/api/companies/${company.id}/agents`);
            const roster: any = (Array.isArray(manifests) ? manifests : [])
                .filter((manifest: any): any => manifest?.agentId && manifest?.name && manifest.status === 'active')
                .map((manifest: any): any => this.modelPolicy?.applyToManifest(manifest) || manifest);
            const desiredAgentIds: any = new Set(roster.map((manifest: any): any => manifest.agentId));
            const synced: any[] = [];
            for (const manifest of roster) {
                const current: any = existing.find((agent: any): any => agent.metadata?.agentArmyId === manifest.agentId && agent.status !== 'terminated')
                    || (manifest.agentId === 'operator' ? existing.find((agent: any): any => agent.name === 'A君本机健康官' && agent.adapterType === 'http' && agent.status !== 'terminated') : null);
                if (current) {
                    const desired: any = paperclipRosterEntry(manifest);
                    if (manifest.agentId === 'operator' && current.metadata?.agentArmyId !== 'operator' && !usesPaperclipHermesExecution(manifest)) {
                        await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
                            method: 'PATCH',
                            body: { metadata: { ...(current.metadata || {}), agentArmyId: 'operator', agentArmyRole: manifest.role, agentArmyManagedOnly: false } }
                        });
                    }
                    else if (rosterNeedsRefresh(current, manifest)) {
                        const hermesOwned: any = usesPaperclipHermesExecution(manifest);
                        await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
                            method: 'PATCH', body: {
                                name: desired.name, role: desired.role, title: desired.title, icon: desired.icon, capabilities: desired.capabilities,
                                ...(hermesOwned ? {
                                    adapterType: desired.adapterType,
                                    adapterConfig: desired.adapterConfig
                                } : {}),
                                ...(['paused', 'error'].includes(current.status) && hermesOwned ? { status: 'idle' } : {}),
                                metadata: { ...(current.metadata || {}), ...desired.metadata }
                            }
                        });
                    }
                    if (usesPaperclipHermesExecution(manifest)) {
                        await this.syncAgentSkills(current.id, manifest.runtimeCapabilities?.skills);
                    }
                    synced.push({ agentArmyId: manifest.agentId, paperclipAgentId: current.id, name: current.name, created: false });
                    continue;
                }
                const created: any = await this.request(`/api/companies/${company.id}/agents`, { method: 'POST', body: paperclipRosterEntry(manifest) });
                const configured: any = await this.request(`/api/agents/${encodeURIComponent(created.id)}`, {
                    method: 'PATCH',
                    body: { status: usesPaperclipHermesExecution(manifest) ? 'idle' : 'paused' }
                });
                existing.push(configured);
                if (usesPaperclipHermesExecution(manifest)) {
                    await this.syncAgentSkills(configured.id, manifest.runtimeCapabilities?.skills);
                }
                synced.push({ agentArmyId: manifest.agentId, paperclipAgentId: configured.id, name: configured.name, created: true });
            }
            const retired: any[] = [];
            for (const current of existing) {
                const agentArmyId: any = String(current?.metadata?.agentArmyId || '').trim();
                if (!agentArmyId
                    || desiredAgentIds.has(agentArmyId)
                    || current.status === 'terminated'
                    || current.metadata?.agentArmyManagedOnly !== true)
                    continue;
                await this.request(`/api/agents/${encodeURIComponent(current.id)}/terminate`, { method: 'POST' });
                retired.push({ agentArmyId, paperclipAgentId: current.id, name: current.name });
            }
            return { status: 'synced', companyId: company.id, agents: synced, retired, syncedAt: new Date().toISOString() };
        }
        catch (error: any) {
            return { status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
        }
    },
    async projectProposal(proposal: any): Promise<any> {
        try {
            const company: any = await this.companyForRuntime();
            const issue: any = await this.request(`/api/companies/${company.id}/issues`, {
                method: 'POST', body: {
                    title: `招聘审核：${proposal.candidateManifest.name}`,
                    description: describeProposal(proposal), status: 'blocked', priority: 'medium'
                }
            });
            const approval: any = await this.request(`/api/companies/${company.id}/approvals`, {
                method: 'POST', body: {
                    type: 'request_board_approval', issueIds: [issue.id],
                    payload: { source: 'ajun-runtime', proposalId: proposal.proposalId, candidateAgentId: proposal.candidateManifest.agentId, requestedCapabilities: proposal.requestedCapabilities, desiredSkills: proposal.desiredSkills, budgetPolicy: proposal.budgetPolicy }
                }
            });
            return { status: 'synced', paperclipIssueId: issue.id, paperclipIssueIdentifier: issue.identifier, paperclipApprovalId: approval.id, syncedAt: new Date().toISOString() };
        }
        catch (error: any) {
            return { status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
        }
    },
    async syncAgentSkills(paperclipAgentId: any, skills: any = []): Promise<any> {
        const desiredSkills: any[] = [...new Set((Array.isArray(skills) ? skills : []).map((item: any): any => String(item || '').trim()).filter(Boolean))];
        return this.request(`/api/agents/${encodeURIComponent(paperclipAgentId)}/skills/sync`, {
            method: 'POST',
            body: { desiredSkills }
        });
    },
    async updateProposal(proposal: any): Promise<any> {
        const projection: any = proposal.governance;
        if (!projection?.paperclipIssueId)
            return projection || { status: 'not_projected' };
        try {
            const evidence: any = (proposal.audit || []).filter((item: any): any => item.action === 'test_evidence_recorded').at(-1);
            await this.request(`/api/issues/${encodeURIComponent(projection.paperclipIssueId)}`, {
                method: 'PATCH', body: { status: proposal.status === 'active' ? 'done' : proposal.status === 'needs_revision' || proposal.status === 'rejected' ? 'blocked' : 'backlog', comment: `A君创建闭环状态：${proposal.status}。草案 ID：${proposal.proposalId}${evidence ? `\n${evidence.detail}` : ''}` }
            });
            return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
        }
        catch (error: any) {
            return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
        }
    },
    async approveProposal(proposal: any, decisionNote: any = '负责人批准受限测试；不代表生产上线。'): Promise<any> {
        const approvalId: any = proposal.governance?.paperclipApprovalId;
        if (!approvalId)
            throw new Error('Paperclip 审核投影不存在，不能绕过组织级批准。');
        await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: { decisionNote } });
        return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'approved', syncedAt: new Date().toISOString() };
    },
    async rejectProposal(proposal: any, decisionNote: any = '负责人拒绝该草案；未启动测试或生产运行。'): Promise<any> {
        const approvalId: any = proposal.governance?.paperclipApprovalId;
        if (!approvalId)
            throw new Error('Paperclip 审核投影不存在，不能绕过组织级拒绝。');
        await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: { decisionNote } });
        return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'rejected', syncedAt: new Date().toISOString() };
    },
    async resolveApproval(approvalId: any, decision: any, decisionNote: any = '由飞书组织级审批卡确认。'): Promise<any> {
        const normalized: any = String(decision || '').trim().toLowerCase();
        if (!['approve', 'reject'].includes(normalized))
            throw new Error('组织级审批决定无效。');
        const approval: any = await this.request(`/api/approvals/${encodeURIComponent(String(approvalId || ''))}/${normalized}`, { method: 'POST', body: { decisionNote } });
        const expected: any = normalized === 'approve' ? 'approved' : 'rejected';
        if (approval.status !== expected)
            throw new Error(`Paperclip 审批未进入预期状态：${approval.status || 'unknown'}。`);
        return approval;
    },
    async getApproval(approvalId: any): Promise<any> {
        const normalized: any = String(approvalId || '').trim();
        if (!normalized)
            throw new Error('Paperclip 审批 ID 不能为空。');
        return this.request(`/api/approvals/${encodeURIComponent(normalized)}`);
    }
};
function describeProposal(proposal: any): any {
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
function paperclipRosterEntry(manifest: any): any {
    const hermesOwned: any = usesPaperclipHermesExecution(manifest);
    return {
        name: manifest.name,
        role: paperclipRoleFor(manifest),
        title: manifest.role,
        icon: paperclipIconFor(manifest),
        capabilities: (manifest.responsibilities || []).join('；') || manifest.role,
        adapterType: hermesOwned ? 'hermes_local' : 'http',
        adapterConfig: hermesOwned ? paperclipHermesAdapterConfig(manifest) : {},
        budgetMonthlyCents: 0,
        permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
        metadata: {
            agentArmyId: manifest.agentId,
            agentArmyRole: manifest.role,
            agentArmyManagedOnly: true,
            executionOwner: manifest.executionOwner || 'ajun-local',
            hermesProfileId: hermesOwned ? manifest.agentId : null
        }
    };
}
function paperclipRoleFor(manifest: any): any {
    const agentId: any = manifest?.agentId;
    if (manifest?.acceptedTaskTypes?.includes('report.public-material'))
        return 'researcher';
    return (({ creator: 'pm', reviewer: 'security', architect: 'cto', xiaod: 'researcher', operator: 'devops', 'technical-expert': 'engineer' }) as any)[agentId] || 'general';
}
function paperclipIconFor(manifest: any): any {
    const agentId: any = manifest?.agentId;
    if (manifest?.acceptedTaskTypes?.includes('report.public-material'))
        return 'search';
    return (({ creator: 'sparkles', reviewer: 'shield', architect: 'brain', xiaod: 'file-code', operator: 'cog', 'technical-expert': 'wrench' }) as any)[agentId] || 'bot';
}
function rosterNeedsRefresh(current: any, manifest: any): any {
    const desired: any = paperclipRosterEntry(manifest);
    const hermesOwned: any = usesPaperclipHermesExecution(manifest);
    if (!hermesOwned && current.metadata?.agentArmyManagedOnly !== true)
        return false;
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
function stableJson(value: any): any {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (!value || typeof value !== 'object')
        return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key: any): any => (`${JSON.stringify(key)}:${stableJson((value as any)[key])}`)).join(',')}}`;
}
function safeError(error: any): any { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }
