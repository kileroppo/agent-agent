import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export const M5_EXISTING_V2_RECONCILE_CONFIRMATION = 'APPLY_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE';
export const M5_EXISTING_V2_RECOVERY_CONFIRMATION = 'RECOVER_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE';
export class M5V2RecoveryRequiredError extends Error {
    readonly code = 'M5_V2_RECOVERY_REQUIRED';
    readonly recovery_required = true;
    readonly recovery: any;

    constructor(message: any, recovery: any) {
        super(message);
        this.name = 'M5V2RecoveryRequiredError';
        this.recovery = recovery;
    }
}
export async function writeM5V2RollbackSnapshotFile(filePath: any, snapshot: any) {
    if (!isAbsolute(filePath))
        throw new Error('回滚快照路径必须是绝对路径');
    if (snapshot?.schemaVersion !== 'agent.army/m5-existing-v2-rollback/v2'
        || !/^[a-f0-9]{64}$/.test(String(snapshot?.sha256 || ''))) {
        throw new Error('回滚快照结构或哈希无效');
    }
    await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return filePath;
}
export function createM5V2ProgressJournalAppender(filePath: any, { append = false }: any = {}) {
    if (!isAbsolute(filePath))
        throw new Error('进度 journal 路径必须是绝对路径');
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    const appendEvent = async (event: any) => {
        if (!handle)
            handle = await open(filePath, append ? 'a' : 'wx', 0o600);
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.sync();
        return filePath;
    };
    appendEvent.close = async () => {
        if (!handle)
            return;
        await handle.close();
        handle = null;
    };
    appendEvent.path = filePath;
    return appendEvent;
}
export function logicalTransitions(pipeline: any) {
    const stageKeyById = new Map((pipeline?.stages ?? []).map((stage: any) => [stage.id, stage.key]));
    return (pipeline?.transitions ?? []).map((item: any) => ({
        fromStageKey: item.fromStageKey ?? stageKeyById.get(item.fromStageId) ?? null,
        toStageKey: item.toStageKey ?? stageKeyById.get(item.toStageId) ?? null,
        label: item.label ?? null,
    }));
}
export function transitionSetsEqual(left: any, right: any) {
    return canonicalTransitions(left) === canonicalTransitions(right);
}
function canonicalTransitions(transitions: any) {
    const values = transitions.map((item: any) => `${item.fromStageKey ?? ''}\u0000${item.toStageKey ?? ''}\u0000${item.label ?? ''}`);
    if (new Set(values).size !== values.length)
        return '__duplicate__';
    return JSON.stringify(values.sort());
}
function normalizeTransitions(transitions: any) {
    return structuredClone(transitions ?? []).map((item: any) => ({
        fromStageKey: item.fromStageKey ?? null,
        toStageKey: item.toStageKey ?? null,
        label: item.label ?? null,
    }));
}
export function transitionsHash(transitions: any) {
    return createHash('sha256')
        .update(canonicalTransitions(normalizeTransitions(transitions)))
        .digest('hex');
}
export function normalizeRoutinePayload(payload: any) {
    if (!payload)
        return null;
    return {
        projectId: payload.projectId ?? null,
        folderId: payload.folderId ?? null,
        goalId: payload.goalId ?? null,
        parentIssueId: payload.parentIssueId ?? null,
        title: payload.title,
        description: payload.description ?? null,
        assigneeAgentId: payload.assigneeAgentId ?? null,
        priority: payload.priority ?? 'medium',
        status: payload.status ?? 'active',
        concurrencyPolicy: payload.concurrencyPolicy ?? 'coalesce_if_active',
        catchUpPolicy: payload.catchUpPolicy ?? 'skip_missed',
        variables: (payload.variables ?? []).map((variable: any) => ({
            name: variable.name,
            label: variable.label ?? null,
            type: variable.type ?? 'text',
            defaultValue: variable.defaultValue ?? null,
            required: Boolean(variable.required),
            options: [...(variable.options ?? [])],
        })),
        env: null,
    };
}
export function payloadHash(payload: any) {
    return createHash('sha256').update(stableJson(payload)).digest('hex');
}
export function assertRollbackSnapshot(snapshot: any, companyId: any) {
    if (snapshot?.schemaVersion !== 'agent.army/m5-existing-v2-rollback/v2'
        || snapshot?.companyId !== companyId) {
        throw new Error('M5 v2 回滚快照版本或 company 不匹配');
    }
    const { sha256, ...body } = snapshot;
    if (payloadHash(body) !== sha256)
        throw new Error('M5 v2 回滚快照哈希不匹配');
    const hashesMatch = (payloadHash(snapshot.assetsRoutine.oldPayload)
        === snapshot.assetsRoutine.oldPayloadSha256
        && payloadHash(snapshot.assetsRoutine.targetPayload)
            === snapshot.assetsRoutine.targetPayloadSha256
        && payloadHash(snapshot.visualRoutine.targetPayload)
            === snapshot.visualRoutine.targetPayloadSha256
        && transitionsHash(snapshot.pipelineTransitions.oldTransitions)
            === snapshot.pipelineTransitions.oldTransitionsSha256
        && transitionsHash(snapshot.pipelineTransitions.targetTransitions)
            === snapshot.pipelineTransitions.targetTransitionsSha256);
    if (!hashesMatch)
        throw new Error('M5 v2 回滚快照子资源哈希不匹配');
}
export function progressOperation(now: any, step: any, operation: any) {
    return {
        schemaVersion: 'agent.army/m5-existing-v2-progress/v1',
        type: 'operation_succeeded',
        at: now().toISOString(),
        step,
        operation: structuredClone(operation),
    };
}
export function safeErrorMessage(error: any) {
    return String(error?.message || error || 'unknown')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}
export function buildRollbackSnapshot({ now, adapter, pipelineId, pipelineKey, projectId, assets, assetsDesired, visual, visualDesired, liveTransitions, desiredTransitions, }: any) {
    const oldAssetsPayload = normalizeRoutinePayload(assets);
    const targetAssetsPayload = normalizeRoutinePayload(assetsDesired?.payload);
    const targetVisualPayload = normalizeRoutinePayload(visualDesired?.payload);
    const oldTransitions = normalizeTransitions(liveTransitions);
    const targetTransitions = normalizeTransitions(desiredTransitions);
    const snapshot = {
        schemaVersion: 'agent.army/m5-existing-v2-rollback/v2',
        capturedAt: now().toISOString(),
        companyId: adapter.companyId,
        projectId,
        pipelineId,
        pipelineKey,
        assetsRoutine: {
            id: assets?.id ?? null,
            priorRevisionId: assets?.latestRevisionId ?? null,
            oldPayload: oldAssetsPayload,
            oldPayloadSha256: payloadHash(oldAssetsPayload),
            targetPayload: targetAssetsPayload,
            targetPayloadSha256: payloadHash(targetAssetsPayload),
            rollback: assets?.id && assets?.latestRevisionId
                ? {
                    method: 'PATCH',
                    path: `/api/routines/${assets.id}`,
                    bodyTemplate: {
                        ...structuredClone(oldAssetsPayload),
                        baseRevisionId: '{currentTargetRevisionId}',
                    },
                }
                : null,
        },
        visualRoutine: {
            priorState: visual ? 'present' : 'absent',
            priorId: visual?.id ?? null,
            priorRevisionId: visual?.latestRevisionId ?? null,
            marker: visualDesired?.marker ?? null,
            targetPayload: targetVisualPayload,
            targetPayloadSha256: payloadHash(targetVisualPayload),
            rollback: visual
                ? null
                : {
                    resolveByMarker: visualDesired?.marker ?? null,
                    method: 'PATCH',
                    pathTemplate: '/api/routines/{resolvedRoutineId}',
                    bodyTemplate: {
                        status: 'archived',
                        baseRevisionId: '{currentTargetRevisionId}',
                    },
                },
        },
        pipelineTransitions: {
            oldTransitions,
            oldTransitionsSha256: transitionsHash(oldTransitions),
            targetTransitions,
            targetTransitionsSha256: transitionsHash(targetTransitions),
            restore: {
                method: 'PUT',
                path: `/api/pipelines/${pipelineId}/transitions`,
                body: {
                    transitions: structuredClone(oldTransitions),
                    enforceTransitions: true,
                },
            },
        },
    };
    return {
        ...snapshot,
        sha256: createHash('sha256').update(stableJson(snapshot)).digest('hex'),
    };
}
function stableJson(value: any): string {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
