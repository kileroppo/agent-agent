import { presentTask } from './task-presentation.ts';
export const TASK_CONTEXT_CAPSULE_SCHEMA_VERSION: any = 'agent.army/task-context-capsule/v1';
export function buildTaskContextCapsule(task: any = {}, { approvals = [] }: any = {}): any {
    const presentation: any = presentTask(task, { approvals });
    const artifacts: any = (Array.isArray(task.artifactRefs) ? task.artifactRefs : [])
        .filter(isAdoptedArtifact)
        .slice(0, 10);
    return Object.freeze({
        schemaVersion: TASK_CONTEXT_CAPSULE_SCHEMA_VERSION,
        taskId: text(task.taskId, 128),
        taskType: text(task.taskType, 120),
        status: text(task.status, 60),
        goal: text(task.input?.description || task.input?.title || task.title, 300),
        result: taskResult(task, presentation.summary),
        adoptedArtifactRefs: artifacts.map(artifactReference),
        keyDecisions: taskDecisions(task).slice(0, 5),
        unfinishedItems: unfinishedItems(task).slice(0, 5),
        nextAction: text(presentation.nextAction, 300),
        evidenceRefs: artifacts.map(evidenceReference).filter(Boolean).slice(0, 10),
        updatedAt: iso(task.updatedAt || task.createdAt),
    });
}
function isAdoptedArtifact(artifact: any): any {
    return artifact?.validation?.exists === true
        && artifact?.validation?.nonEmpty === true
        && artifact?.validation?.readable !== false;
}
function artifactReference(artifact: any): any {
    return Object.freeze({
        artifactId: text(artifact.artifactId, 160) || null,
        type: text(artifact.type, 120) || null,
        title: text(artifact.title, 200) || null,
        checksum: text(artifact.checksum, 160) || null,
        location: safeReference(artifact.location),
    });
}
function evidenceReference(artifact: any): any {
    return text(artifact.artifactId || artifact.checksum || artifact.location, 240) || null;
}
function taskResult(task: any, fallback: any): any {
    const artifacts: any = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const summary: any = artifacts
        .filter(isAdoptedArtifact)
        .map((artifact: any): any => artifact?.data?.summary || artifact?.data?.resultSummary)
        .find(Boolean);
    return text(summary || task.result?.summary || fallback, 500);
}
function taskDecisions(task: any): any {
    const context: any = task.input?.context || {};
    return strings(context.keyDecisions || context.decisions, 5, 300);
}
function unfinishedItems(task: any): any {
    const context: any = task.input?.context || {};
    const explicit: any = strings(context.unfinishedItems || context.openItems, 5, 300);
    if (explicit.length)
        return explicit;
    const error: any = text(task.error?.userMessage || task.error?.message, 300);
    return error ? [error] : [];
}
function strings(value: any, maxItems: any, maxLength: any): any {
    return [...new Set((Array.isArray(value) ? value : [])
            .map((item: any): any => text(item, maxLength))
            .filter(Boolean))].slice(0, maxItems);
}
function safeReference(value: any): any {
    const candidate: any = text(value, 500);
    if (!candidate || /(?:token|cookie|secret|password|authorization)=/i.test(candidate))
        return null;
    return candidate;
}
function text(value: any, limit: any): any {
    return String(value || '')
        .replace(/\b(authorization|cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
        .replace(/([?&](?:token|key|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[已脱敏]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}
function iso(value: any): any {
    const time: any = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
