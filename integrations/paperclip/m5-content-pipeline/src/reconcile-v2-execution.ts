import { inspectExistingM5V2Reconcile, unwrap } from './reconcile-v2-inspection.ts';
import { M5_EXISTING_V2_RECONCILE_CONFIRMATION, M5V2RecoveryRequiredError, logicalTransitions, progressOperation, safeErrorMessage, transitionSetsEqual, } from './reconcile-v2-journal.ts';
export async function applyExistingM5V2Reconcile({ adapter, definition, pipelineId, projectId, confirmation, writeRollbackSnapshot, appendRecoveryProgress, now = () => new Date(), }: any = {}) {
    if (confirmation !== M5_EXISTING_V2_RECONCILE_CONFIRMATION) {
        throw new Error('现有 M5 v2 对账缺少精确确认串');
    }
    if (typeof writeRollbackSnapshot !== 'function') {
        throw new Error('live 对账必须先提供回滚快照写入器');
    }
    if (typeof appendRecoveryProgress !== 'function') {
        throw new Error('live 对账必须提供 fsync 进度 journal');
    }
    const audit = await inspectExistingM5V2Reconcile({
        adapter,
        definition,
        pipelineId,
        projectId,
        now,
    });
    if (!audit.preconditionsPassed) {
        throw new Error(`现有 M5 v2 对账前置检查失败: ${audit.blockers.map((item: any) => item.code).join(', ')}`);
    }
    const hasWrites = audit.diff.createRoutine.length > 0
        || audit.diff.updateRoutine.length > 0
        || audit.diff.updateTransitions;
    if (!hasWrites) {
        return { ...audit, mode: 'apply', operations: [], alreadyReconciled: true };
    }
    const snapshotLocation = await writeRollbackSnapshot(audit.rollbackSnapshot);
    if (!snapshotLocation)
        throw new Error('回滚快照未确认落盘，拒绝 live 写入');
    const startedAt = now().toISOString();
    await appendRecoveryProgress({
        schemaVersion: 'agent.army/m5-existing-v2-progress/v1',
        type: 'apply_started',
        at: startedAt,
        snapshotSha256: audit.rollbackSnapshot.sha256,
        snapshotLocation,
    });
    const operations = [];
    let attemptedStep = null;
    try {
        for (const update of audit.diff.updateRoutine) {
            attemptedStep = 'assets_patch';
            const result = await adapter.reconcileRoutine({ id: update.id }, update.payload);
            if (!result.updated)
                throw new Error('m5-assets 在写入前发生变化，拒绝继续');
            const operation = {
                method: 'PATCH',
                resource: 'routine',
                key: update.key,
                id: update.id,
                revisionId: result.resource.latestRevisionId ?? null,
                targetPayloadSha256: audit.rollbackSnapshot.assetsRoutine.targetPayloadSha256,
            };
            operations.push(operation);
            await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
        }
        for (const create of audit.diff.createRoutine) {
            attemptedStep = 'visual_create';
            const resource = await adapter.create('routine', create.payload);
            const operation = {
                method: 'POST',
                resource: 'routine',
                key: create.key,
                id: resource.id,
                revisionId: resource.latestRevisionId ?? null,
                targetPayloadSha256: audit.rollbackSnapshot.visualRoutine.targetPayloadSha256,
            };
            operations.push(operation);
            await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
        }
        if (audit.diff.updateTransitions) {
            attemptedStep = 'transitions_put';
            const currentDocument = await adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}`);
            const current = unwrap(currentDocument, 'pipeline');
            if (!transitionSetsEqual(logicalTransitions(current), audit.rollbackSnapshot.pipelineTransitions.oldTransitions)) {
                throw new Error('Pipeline transitions 在写入前发生变化，拒绝覆盖');
            }
            await adapter.setPipelineTransitions(pipelineId, audit.desired.transitions);
            const operation = {
                method: 'PUT',
                resource: 'pipeline-transitions',
                id: pipelineId,
                count: audit.desired.transitions.length,
                targetTransitionsSha256: audit.rollbackSnapshot.pipelineTransitions.targetTransitionsSha256,
            };
            operations.push(operation);
            await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
        }
        attemptedStep = 'post_write_verification';
        const verification = await inspectExistingM5V2Reconcile({
            adapter,
            definition,
            pipelineId,
            projectId,
            now,
        });
        if (!verification.preconditionsPassed
            || verification.diff.createRoutine.length > 0
            || verification.diff.updateRoutine.length > 0
            || verification.diff.updateTransitions) {
            throw new Error('现有 M5 v2 对账写后回读失败');
        }
        await appendRecoveryProgress({
            schemaVersion: 'agent.army/m5-existing-v2-progress/v1',
            type: 'apply_completed',
            at: now().toISOString(),
            snapshotSha256: audit.rollbackSnapshot.sha256,
            completedOperations: structuredClone(operations),
        });
        return {
            mode: 'apply',
            operations,
            alreadyReconciled: false,
            rollbackSnapshot: audit.rollbackSnapshot,
            verification: {
                preconditionsPassed: true,
                routineCount: verification.checks.routineCount,
                stageCount: verification.checks.stageCount,
                transitionCount: verification.checks.transitionCount,
                cronEnabled: verification.states.cronEnabled,
                campaignGrantStatus: verification.states.campaignGrantStatus,
            },
        };
    }
    catch (error: any) {
        const recovery: Record<string, any> = {
            snapshotSha256: audit.rollbackSnapshot.sha256,
            snapshotLocation,
            attemptedStep,
            completedOperations: structuredClone(operations),
            cause: safeErrorMessage(error),
        };
        try {
            await appendRecoveryProgress({
                schemaVersion: 'agent.army/m5-existing-v2-progress/v1',
                type: 'recovery_required',
                at: now().toISOString(),
                ...recovery,
            });
        }
        catch (journalError: any) {
            recovery.journalError = safeErrorMessage(journalError);
        }
        throw new M5V2RecoveryRequiredError(`M5 v2 对账部分失败，需要按快照恢复: ${recovery.cause}`, recovery);
    }
}
