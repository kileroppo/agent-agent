import crypto from 'node:crypto';
const MAX_TASK_EVIDENCE: any = 24;
export function buildArchitectureGroundTruth({ agents = [], tasks = [], generatedAt = new Date().toISOString() }: any = {}): any {
    const agentEvidence: any = agents
        .filter((agent: any): any => agent?.agentId)
        .map((agent: any): any => ({
        ref: `agent:${agent.agentId}`,
        agentId: String(agent.agentId),
        name: String(agent.name || agent.agentId),
        status: String(agent.status || 'unknown'),
        acceptedTaskTypes: strings(agent.acceptedTaskTypes),
        toolAllowlist: strings(agent.toolAllowlist),
        repositoryRefs: [
            `agents/${agent.agentId}/manifest.json`,
            String(agent.promptRef || ''),
            String(agent.runtimeProfileRef || '')
        ].filter(Boolean)
    }))
        .sort((left: any, right: any): any => left.agentId.localeCompare(right.agentId));
    const allowedAgentIds: any = new Set(agentEvidence.map((item: any): any => item.agentId));
    const taskEvidence: any = [...tasks]
        .filter((task: any): any => task?.taskId)
        .sort((left: any, right: any): any => taskTime(right) - taskTime(left))
        .slice(0, MAX_TASK_EVIDENCE)
        .map((task: any): any => ({
        ref: `task:${task.taskId}`,
        taskId: String(task.taskId),
        taskType: String(task.taskType || 'unknown'),
        assigneeAgentId: allowedAgentIds.has(task.assigneeAgentId) ? task.assigneeAgentId : null,
        status: String(task.status || 'unknown'),
        title: safeTitle(task.input?.title),
        updatedAt: String(task.updatedAt || task.createdAt || ''),
        artifactTypes: strings((task.artifactRefs || []).map((item: any): any => item?.type))
    }));
    const byStatus: Record<string, any> = {};
    const byTaskType: Record<string, any> = {};
    for (const task of tasks) {
        const status: any = String(task?.status || 'unknown');
        const taskType: any = String(task?.taskType || 'unknown');
        byStatus[status] = (byStatus[status] || 0) + 1;
        byTaskType[taskType] = (byTaskType[taskType] || 0) + 1;
    }
    const taskTypes: any = [...new Set([
            ...agentEvidence.flatMap((agent: any): any => agent.acceptedTaskTypes),
            ...Object.keys(byTaskType)
        ])].sort().map((taskType: any): any => ({
        ref: `task-type:${taskType}`,
        taskType,
        agentIds: agentEvidence.filter((agent: any): any => agent.acceptedTaskTypes.includes(taskType)).map((agent: any): any => agent.agentId),
        taskCount: byTaskType[taskType] || 0
    }));
    const payload: Record<string, any> = {
        schemaVersion: 'agent.army/architecture-ground-truth/v1',
        generatedAt,
        agents: agentEvidence,
        taskTypes,
        taskSummary: { total: tasks.length, byStatus, byTaskType },
        taskEvidence,
        limitation: '这是 A君按当前注册表和脱敏任务账本生成的事实快照；未列出的文件、能力、任务类型和外部状态一律视为待验证。'
    };
    return {
        ...payload,
        snapshotId: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    };
}
export function validateArchitectureEvidenceRefs(refs: any, groundTruth: any): any {
    const allowed: any = new Set([
        ...(groundTruth?.agents || []).map((item: any): any => item.ref),
        ...(groundTruth?.taskTypes || []).map((item: any): any => item.ref),
        ...(groundTruth?.taskEvidence || []).map((item: any): any => item.ref),
        ...(groundTruth?.agents || []).flatMap((item: any): any => item.repositoryRefs || []).map((item: any): any => `repo:${item}`)
    ]);
    const normalized: any = Array.isArray(refs) ? refs.slice(0, 30).map((item: any): any => ({
        ref: String(item?.ref || '').trim().slice(0, 500),
        claim: String(item?.claim || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
    })).filter((item: any): any => item.ref && item.claim) : [];
    const invalidRefs: any = normalized.filter((item: any): any => !allowed.has(item.ref)).map((item: any): any => item.ref);
    return {
        valid: normalized.length > 0 && invalidRefs.length === 0,
        refs: normalized,
        invalidRefs,
        snapshotId: groundTruth?.snapshotId || null
    };
}
function strings(values: any): any {
    return [...new Set((Array.isArray(values) ? values : []).map((item: any): any => String(item || '').trim()).filter(Boolean))];
}
function safeTitle(value: any): any {
    return String(value || '')
        .replace(/https?:\/\/\S+/gi, '[公开链接]')
        .replace(/\b(?:token|cookie|secret|password|authorization)=[^\s&]+/gi, '$1=[已脱敏]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}
function taskTime(task: any): any {
    const value: any = Date.parse(task?.updatedAt || task?.createdAt || '');
    return Number.isFinite(value) ? value : 0;
}
