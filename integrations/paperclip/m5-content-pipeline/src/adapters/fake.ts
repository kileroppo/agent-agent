import { randomUUID } from 'node:crypto';
import { pipelineHeaderMatchesDeclaration, routineMatchesDeclaration, stageMatchesDeclaration, } from '../reconcile.ts';
export class FakePaperclipAdapter {
    readonly state: Record<string, any[]>;
    readonly calls: any[];

    constructor(seed: any = {}) {
        this.state = {
            goals: [...(seed.goals ?? [])],
            projects: [...(seed.projects ?? [])],
            routines: [...(seed.routines ?? [])],
            triggers: [...(seed.triggers ?? [])],
            pipelines: [...(seed.pipelines ?? [])],
            budgets: [...(seed.budgets ?? [])],
            cases: [...(seed.cases ?? [])],
            agents: [...(seed.agents ?? [])],
        };
        this.calls = [];
    }
    async ensureSystemAgent(payload: any) {
        const marker = payload.metadata?.agentArmySystemRole;
        const current = this.state.agents.find((item: any) => item.status !== 'terminated' && item.metadata?.agentArmySystemRole === marker);
        if (!current) {
            const resource = {
                id: randomUUID(),
                status: 'idle',
                ...structuredClone(payload),
            };
            this.state.agents.push(resource);
            this.calls.push({ action: 'create-system-agent', payload: structuredClone(payload) });
            return { resource, created: true, updated: false };
        }
        const desired = { ...structuredClone(payload), status: 'idle' };
        const comparable = { ...current };
        delete comparable.id;
        if (JSON.stringify(comparable) === JSON.stringify(desired)) {
            return { resource: current, created: false, updated: false };
        }
        Object.assign(current, desired);
        this.calls.push({ action: 'reconcile-system-agent', agentId: current.id, payload: structuredClone(payload) });
        return { resource: current, created: false, updated: true };
    }
    async findByMarker(type: any, marker: any) {
        const collection = this.state[`${type}s`];
        return collection?.find((item: any) => item.description?.includes(marker) || item.marker === marker || item.key === marker) ?? null;
    }
    async create(type: any, payload: any) {
        const result = { id: randomUUID(), ...structuredClone(payload) };
        if (type === 'pipeline' && Array.isArray(result.stages)) {
            result.stages = result.stages.map((stage: any) => ({ id: randomUUID(), ...stage }));
        }
        this.state[`${type}s`].push(result);
        this.calls.push({ action: 'create', type, payload: structuredClone(payload) });
        return result;
    }
    async reconcileRoutine(routine: any, payload: any) {
        const current = this.state.routines.find((item: any) => item.id === routine.id);
        if (!current)
            throw new Error(`Fake routine 不存在: ${routine.id}`);
        if (routineMatchesDeclaration(current, payload)) {
            return { resource: current, updated: false };
        }
        Object.assign(current, structuredClone(payload));
        this.calls.push({
            action: 'reconcile-routine',
            routineId: current.id,
            payload: structuredClone(payload),
        });
        return { resource: current, updated: true };
    }
    async reconcilePipeline(pipeline: any, payload: any) {
        const current = this.state.pipelines.find((item: any) => item.id === pipeline.id);
        if (!current)
            throw new Error(`Fake pipeline 不存在: ${pipeline.id}`);
        if (current.projectId !== payload.projectId) {
            throw new Error(`M5 Pipeline projectId 漂移，拒绝自动迁移: ${current.projectId ?? 'null'}`);
        }
        const desiredKeys = new Set(payload.stages.map((stage: any) => stage.key));
        const unexpected = (current.stages ?? []).filter((stage: any) => !desiredKeys.has(stage.key));
        if (unexpected.length > 0) {
            throw new Error(`M5 Pipeline 存在未声明阶段，拒绝自动删除: ${unexpected.map((stage: any) => stage.key).join(', ')}`);
        }
        current.stages ??= [];
        let updated = false;
        if (!pipelineHeaderMatchesDeclaration(current, payload)) {
            Object.assign(current, {
                name: payload.name,
                description: payload.description,
                enforceTransitions: payload.enforceTransitions,
            });
            updated = true;
        }
        const byKey = new Map((current.stages ?? []).map((stage: any) => [stage.key, stage]));
        for (const declared of payload.stages) {
            const existing = byKey.get(declared.key);
            if (!existing) {
                const created = { id: randomUUID(), ...structuredClone(declared) };
                current.stages.push(created);
                byKey.set(created.key, created);
                updated = true;
            }
            else if (!stageMatchesDeclaration(existing, declared)) {
                Object.assign(existing, structuredClone(declared), { id: (existing as any).id });
                updated = true;
            }
        }
        if (updated) {
            this.calls.push({
                action: 'reconcile-pipeline',
                pipelineId: current.id,
                payload: structuredClone(payload),
            });
        }
        return { resource: current, updated };
    }
    async setPipelineTransitions(pipelineId: any, transitions: any) {
        const pipeline = this.state.pipelines.find((item: any) => item.id === pipelineId);
        if (!pipeline)
            throw new Error(`Fake pipeline 不存在: ${pipelineId}`);
        pipeline.transitions = structuredClone(transitions);
        this.calls.push({ action: 'set-transitions', pipelineId, transitions: structuredClone(transitions) });
    }
    async createRoutineTrigger(routineId: any, payload: any) {
        const result = { id: randomUUID(), routineId, ...structuredClone(payload) };
        this.state.triggers.push(result);
        this.calls.push({ action: 'create-trigger', routineId, payload: structuredClone(payload) });
        return result;
    }
    async ensureRoutineTrigger(routine: any, payload: any) {
        const existing = this.state.triggers.find((item: any) => item.routineId === routine.id && item.kind === payload.kind && item.label === payload.label);
        if (existing)
            return { resource: existing, created: false };
        return { resource: await this.createRoutineTrigger(routine.id, payload), created: true };
    }
    async ingestCase(pipelineId: any, payload: any) {
        const duplicate = this.state.cases.find((item: any) => item.pipelineId === pipelineId && item.caseKey === payload.caseKey);
        if (duplicate)
            return duplicate;
        const result = { id: randomUUID(), pipelineId, version: 1, ...structuredClone(payload) };
        this.state.cases.push(result);
        this.calls.push({ action: 'ingest-case', pipelineId, payload: structuredClone(payload) });
        return result;
    }
    async ingestCases(pipelineId: any, payloads: any) {
        return Promise.all(payloads.map((payload: any) => this.ingestCase(pipelineId, payload)));
    }
    async replaceCaseBlockers(caseId: any, blockedByCaseIds: any) {
        const item = this.state.cases.find((entry: any) => entry.id === caseId);
        if (!item)
            throw new Error(`Fake case 不存在: ${caseId}`);
        const uniqueIds = [...new Set(blockedByCaseIds)];
        if (uniqueIds.length !== blockedByCaseIds.length
            || uniqueIds.includes(caseId)
            || uniqueIds.some((id: any) => !this.state.cases.some((entry: any) => entry.id === id))) {
            throw new Error(`Fake blocker 集合无效: ${caseId}`);
        }
        item.blockedByCaseIds = [...uniqueIds];
        this.calls.push({
            action: 'replace-case-blockers',
            caseId,
            blockedByCaseIds: [...uniqueIds],
        });
        return { blockedByCaseIds: [...uniqueIds] };
    }
    async getCase(caseId: any) {
        return this.state.cases.find((item: any) => item.id === caseId) ?? null;
    }
    async patchCaseFields(caseId: any, expectedVersion: any, fields: any) {
        const item = this.state.cases.find((entry: any) => entry.id === caseId);
        if (!item)
            throw new Error(`Fake case 不存在: ${caseId}`);
        if (item.version !== expectedVersion)
            throw new Error(`Fake case 版本冲突: ${caseId}`);
        item.fields = structuredClone(fields);
        item.version += 1;
        this.calls.push({
            action: 'patch-case-fields',
            caseId,
            expectedVersion,
            fields: structuredClone(fields),
        });
        return item;
    }
    async getProjectDailyTrigger(projectId: any) {
        const routines = this.state.routines.filter((item: any) => item.projectId === projectId
            && String(item.description || '').includes('[agent-army:m5:routine:m5-daily-campaign]'));
        if (routines.length !== 1) {
            throw new Error(`Fake Project 每日 Routine 必须唯一，当前为 ${routines.length}`);
        }
        const triggers = this.state.triggers.filter((item: any) => item.routineId === routines[0].id && item.kind === 'schedule');
        if (triggers.length !== 1) {
            throw new Error(`Fake Project 每日 Trigger 必须唯一，当前为 ${triggers.length}`);
        }
        return triggers[0];
    }
    async listPipelineCases(pipelineId: any) {
        return this.state.cases.filter((item: any) => item.pipelineId === pipelineId);
    }
    async reviewCase(caseId: any, payload: any) {
        const item = this.state.cases.find((entry: any) => entry.id === caseId);
        if (!item)
            throw new Error(`Fake case 不存在: ${caseId}`);
        this.calls.push({ action: 'review-case', caseId, payload: structuredClone(payload) });
        return { ...item, version: item.version + 1, review: structuredClone(payload) };
    }
    async transitionCase(caseId: any, payload: any) {
        const item = this.state.cases.find((entry: any) => entry.id === caseId);
        if (!item)
            throw new Error(`Fake case 不存在: ${caseId}`);
        if (item.version !== payload.expectedVersion)
            throw new Error(`Fake case 版本冲突: ${caseId}`);
        item.stageKey = payload.toStageKey;
        item.version += 1;
        this.calls.push({ action: 'transition-case', caseId, payload: structuredClone(payload) });
        return item;
    }
    async upsertBudget(payload: any) {
        const existing = this.state.budgets.find((item: any) => item.scopeType === payload.scopeType && item.scopeId === payload.scopeId);
        if (existing) {
            Object.assign(existing, structuredClone(payload));
            this.calls.push({ action: 'upsert-budget', payload: structuredClone(payload) });
            return existing;
        }
        return this.create('budget', payload);
    }
}
