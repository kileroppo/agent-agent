import { pipelineHeaderMatchesDeclaration, routineMatchesDeclaration, stageMatchesDeclaration, } from '../reconcile.ts';
import { M5_SCHEMA_IDS } from '@agent-army/m5-contracts';
import { PaperclipHttpTransport } from '@agent-army/paperclip-client';
export class HttpPaperclipAdapter {
    readonly transport: PaperclipHttpTransport;
    readonly apiBase: string;
    readonly companyId: string;
    readonly apiKey: string;
    readonly fetchImpl: (...args: any[]) => Promise<any>;

    constructor({ apiBase, companyId, apiKey, allowRemote = false, fetchImpl = fetch }: any) {
        if (!companyId)
            throw new Error('companyId 必填');
        this.transport = new PaperclipHttpTransport({ baseUrl: apiBase, apiKey, allowRemote, fetchImpl, timeoutMs: 0 });
        this.apiBase = this.transport.baseUrl;
        this.companyId = companyId;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
    }
    async request(method: any, path: any, body: any = undefined) {
        return this.transport.request(method, path, { body });
    }
    async authenticateRun({ apiKey, runId }: any = {}) {
        if (!String(apiKey || '').trim() || !String(runId || '').trim()) {
            throw new Error('Paperclip Run 身份参数缺失');
        }
        const response = await this.fetchImpl(`${this.apiBase}/api/agents/me`, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${String(apiKey).trim()}`,
                'x-paperclip-run-id': String(runId).trim(),
            },
        });
        const text = await response.text();
        const parsed = text ? JSON.parse(text) : null;
        if (!response.ok || !parsed?.id || !parsed?.companyId) {
            throw new Error('Paperclip Run 身份核验失败');
        }
        return parsed;
    }
    async findByMarker(type: any, marker: any) {
        const paths = {
            goal: `/api/companies/${this.companyId}/goals`,
            project: `/api/companies/${this.companyId}/projects`,
            routine: `/api/companies/${this.companyId}/routines`,
            pipeline: `/api/companies/${this.companyId}/pipelines`,
        };
        const rows = await this.request('GET', (paths as Record<string, string>)[type]);
        return rows.find((item: any) => item.description?.includes(marker) || item.key === marker) ?? null;
    }
    async create(type: any, payload: any) {
        const paths = {
            goal: `/api/companies/${this.companyId}/goals`,
            project: `/api/companies/${this.companyId}/projects`,
            routine: `/api/companies/${this.companyId}/routines`,
            pipeline: `/api/companies/${this.companyId}/pipelines`,
            budget: `/api/companies/${this.companyId}/budgets/policies`,
        };
        return this.request('POST', (paths as Record<string, string>)[type], payload);
    }
    async ensureSystemAgent(payload: any) {
        const agents = await this.request('GET', `/api/companies/${this.companyId}/agents`);
        const marker = payload.metadata?.agentArmySystemRole;
        const matches = agents.filter((item: any) => item.status !== 'terminated' && item.metadata?.agentArmySystemRole === marker);
        if (matches.length > 1) {
            throw new Error(`Paperclip 系统控制器 ${marker} 必须唯一，当前为 ${matches.length} 个`);
        }
        if (matches.length === 0) {
            const created = await this.request('POST', `/api/companies/${this.companyId}/agents`, payload);
            const resource = await this.request('PATCH', `/api/agents/${created.id}`, { status: 'idle' });
            return { resource, created: true, updated: false };
        }
        const current = matches[0];
        const coreMatchesDesired = [
            'role',
            'title',
            'icon',
            'capabilities',
            'adapterType',
            'budgetMonthlyCents',
        ].every((key: any) => structurallyEqual(current[key] ?? null, payload[key] ?? null))
            && structurallyEqual(current.adapterConfig || {}, payload.adapterConfig || {})
            && current.metadata?.executionOwner === payload.metadata?.executionOwner
            && current.status === 'idle';
        const permissionsMatch = structurallyEqual(current.permissions || {}, payload.permissions || {});
        if (coreMatchesDesired && permissionsMatch) {
            return { resource: current, created: false, updated: false };
        }
        let resource = current;
        if (!permissionsMatch) {
            resource = await this.request('PATCH', `/api/agents/${current.id}/permissions`, {
                canCreateAgents: Boolean(payload.permissions?.canCreateAgents),
                canCreateSkills: Boolean(payload.permissions?.canCreateSkills),
                canAssignTasks: Boolean(payload.permissions?.canAssignTasks),
            });
        }
        if (!coreMatchesDesired) {
            // Paperclip 2026.722 does not persist an independent shortname: urlKey is
            // derived from name, and renaming can collide with another active agent.
            // The managed role marker is the stable identity, so preserve its name/urlKey.
            const { permissions: _permissions, name: _name, urlKey: _urlKey, shortname: _shortname, ...agentPayload } = payload;
            resource = await this.request('PATCH', `/api/agents/${current.id}`, {
                ...agentPayload,
                metadata: { ...(current.metadata || {}), ...payload.metadata },
                status: 'idle',
            });
        }
        return { resource, created: false, updated: true };
    }
    async reconcileRoutine(routine: any, payload: any) {
        const detail = await this.request('GET', `/api/routines/${routine.id}`);
        if (routineMatchesDeclaration(detail, payload)) {
            return { resource: detail, updated: false };
        }
        const updated = await this.request('PATCH', `/api/routines/${routine.id}`, {
            ...payload,
            ...(detail.latestRevisionId ? { baseRevisionId: detail.latestRevisionId } : {}),
        });
        return { resource: updated, updated: true };
    }
    async reconcilePipeline(pipeline: any, payload: any) {
        let detail = await this.request('GET', `/api/pipelines/${pipeline.id}`);
        if (detail.projectId !== payload.projectId) {
            throw new Error(`M5 Pipeline projectId 漂移，拒绝自动迁移: ${detail.projectId ?? 'null'}`);
        }
        const desiredKeys = new Set(payload.stages.map((stage: any) => stage.key));
        const unexpected = (detail.stages ?? []).filter((stage: any) => !desiredKeys.has(stage.key));
        if (unexpected.length > 0) {
            throw new Error(`M5 Pipeline 存在未声明阶段，拒绝自动删除: ${unexpected.map((stage: any) => stage.key).join(', ')}`);
        }
        let updated = false;
        if (!pipelineHeaderMatchesDeclaration(detail, payload)) {
            await this.request('PATCH', `/api/pipelines/${pipeline.id}`, {
                name: payload.name,
                description: payload.description,
                enforceTransitions: payload.enforceTransitions,
            });
            updated = true;
        }
        const byKey = new Map((detail.stages ?? []).map((stage: any) => [stage.key, stage]));
        for (const declared of payload.stages) {
            const existing = byKey.get(declared.key);
            if (!existing) {
                await this.request('POST', `/api/pipelines/${pipeline.id}/stages`, declared);
                updated = true;
            }
            else if (!stageMatchesDeclaration(existing, declared)) {
                await this.request('PATCH', `/api/pipelines/${pipeline.id}/stages/${(existing as any).id}`, declared);
                updated = true;
            }
        }
        if (updated)
            detail = await this.request('GET', `/api/pipelines/${pipeline.id}`);
        return { resource: detail, updated };
    }
    async setPipelineTransitions(pipelineId: any, transitions: any) {
        return this.request('PUT', `/api/pipelines/${pipelineId}/transitions`, {
            transitions,
            enforceTransitions: true,
        });
    }
    async createRoutineTrigger(routineId: any, payload: any) {
        const result = await this.request('POST', `/api/routines/${routineId}/triggers`, payload);
        return result.trigger ?? result;
    }
    async ensureRoutineTrigger(routine: any, payload: any) {
        const detail = await this.request('GET', `/api/routines/${routine.id}`);
        const existing = detail.triggers?.find((item: any) => item.kind === payload.kind && item.label === payload.label);
        if (existing)
            return { resource: existing, created: false };
        return { resource: await this.createRoutineTrigger(routine.id, payload), created: true };
    }
    async ingestCase(pipelineId: any, payload: any) {
        const result = await this.request('POST', `/api/pipelines/${pipelineId}/cases`, payload);
        return result.case ?? result;
    }
    async ingestCases(pipelineId: any, payloads: any) {
        if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 200) {
            throw new Error('Paperclip 批量 Case 必须包含1到200项');
        }
        const results = await this.request('POST', `/api/pipelines/${pipelineId}/cases/batch`, { items: payloads });
        if (!Array.isArray(results) || results.length !== payloads.length) {
            throw new Error('Paperclip 批量 Case 响应数量不匹配');
        }
        const failed = results.find((item: any) => item?.ok !== true || !item.case?.id);
        if (failed) {
            const code = String(failed?.error?.details?.code || 'unknown').slice(0, 120);
            throw new Error(`Paperclip 批量 Case 创建失败: ${code}`);
        }
        return results.map((item: any) => item.case);
    }
    async replaceCaseBlockers(caseId: any, blockedByCaseIds: any) {
        return this.request('PUT', `/api/cases/${caseId}/blockers`, { blockedByCaseIds });
    }
    async getCase(caseId: any) {
        const result = await this.request('GET', `/api/cases/${encodeURIComponent(caseId)}`);
        return result?.case ?? result;
    }
    async patchCaseFields(caseId: any, expectedVersion: any, fields: any) {
        const result = await this.request('PATCH', `/api/cases/${encodeURIComponent(caseId)}`, {
            expectedVersion,
            fields,
        });
        return result?.case ?? result;
    }
    async getProjectDailyTrigger(projectId: any) {
        const routines = await this.request('GET', `/api/companies/${encodeURIComponent(this.companyId)}/routines`);
        const matches = routines.filter((item: any) => item.projectId === projectId
            && String(item.description || '').includes('[agent-army:m5:routine:m5-daily-campaign]'));
        if (matches.length !== 1) {
            throw new Error(`Project 每日 Routine 必须唯一，当前为 ${matches.length}`);
        }
        const detail = await this.request('GET', `/api/routines/${encodeURIComponent(matches[0].id)}`);
        const triggers = (detail.triggers || []).filter((item: any) => item.kind === 'schedule');
        if (triggers.length !== 1) {
            throw new Error(`Project 每日 Trigger 必须唯一，当前为 ${triggers.length}`);
        }
        return triggers[0];
    }
    async listPipelineCases(pipelineId: any) {
        const result = await this.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}/cases`);
        const rows = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
        return rows.map((item: any) => item?.case ?? item);
    }
    async getCaseOutputs(caseId: any) {
        return this.request('GET', `/api/cases/${encodeURIComponent(caseId)}/outputs`);
    }
    async listCaseIssueLinks(caseId: any) {
        return this.request('GET', `/api/cases/${encodeURIComponent(caseId)}/issue-links`);
    }
    async countActiveParallelIssues(pipelineId: any) {
        const cases = (await this.listPipelineCases(pipelineId))
            .filter((item: any) => (item?.fields?.workBranch?.schemaVersion === M5_SCHEMA_IDS.PARALLEL_WORK_BRANCH));
        const links = await Promise.all(cases.map((item: any) => this.listCaseIssueLinks(item.id)));
        const active = new Set();
        for (const rows of links) {
            for (const item of Array.isArray(rows) ? rows : rows?.items || []) {
                const issue = item?.issue;
                if (issue?.id
                    && ['backlog', 'todo', 'in_progress', 'blocked'].includes(issue.status))
                    active.add(issue.id);
            }
        }
        return active.size;
    }
    async runParallelRoutine({ branch, routineKey, idempotencyKey }: any) {
        const routine = await this.findByMarker('routine', `[agent-army:m5:routine:${routineKey}]`);
        if (!routine?.id)
            throw new Error(`M5 并行分支 Routine 不存在: ${routineKey}`);
        return this.request('POST', `/api/routines/${encodeURIComponent(routine.id)}/run`, {
            source: 'api',
            variables: {
                case_id: branch.id,
                case_version: Number(branch.version) || 1,
            },
            idempotencyKey,
        });
    }
    async linkCaseIssue(caseId: any, issueId: any, role: any = 'automation') {
        const existing = await this.listCaseIssueLinks(caseId);
        const rows = Array.isArray(existing) ? existing : existing?.items || [];
        const match = rows.find((item: any) => (item?.issue?.id || item?.issueId) === issueId);
        if (match)
            return match;
        return this.request('POST', `/api/cases/${encodeURIComponent(caseId)}/issue-links`, { issueId, role });
    }
    async completeParallelGateIssues(caseId: any, comment: any) {
        const rows = await this.listCaseIssueLinks(caseId);
        const links = Array.isArray(rows) ? rows : rows?.items || [];
        const targets = links
            .map((item: any) => item?.issue)
            .filter((issue: any) => issue?.id
            && !['done', 'cancelled'].includes(issue.status)
            && `${issue.title || ''}\n${issue.description || ''}`
                .includes('[agent-army:m5:routine:m5-parallel-join]'));
        await Promise.all(targets.map((issue: any) => this.request('PATCH', `/api/issues/${encodeURIComponent(issue.id)}`, { status: 'done', comment })));
        return targets.map((item: any) => item.id);
    }
    async reviewCase(caseId: any, payload: any) {
        return this.request('POST', `/api/cases/${caseId}/review`, payload);
    }
    async transitionCase(caseId: any, payload: any) {
        const result = await this.request('POST', `/api/cases/${caseId}/transition`, payload);
        return result.case ?? result;
    }
    async upsertBudget(payload: any) {
        const result = await this.create('budget', payload);
        return result.policy ?? result;
    }
}
function structurallyEqual(left: any, right: any): boolean {
    if (Object.is(left, right))
        return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((item: any, index: any) => structurallyEqual(item, right[index]));
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key: any, index: any) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
}
