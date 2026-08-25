import { duplicateRecovery, existingResult, failureClassification, ineligibleResult, legacyBlockedReadOnlyDiagnosis, recoveryEvents, recoveryRelatedTasks, requestAttempt, safeText, taskById, view } from './task-recovery-policy.ts';
import { retryVisualAnalysis, visionCapabilityReadiness } from './task-visual-recovery.ts';
import { cleanActionKey, cleanActor, cleanRequestId, recoveryError } from './task-recovery-input.ts';
import { closeSupersededReadOnlyDiagnosis, hasVerifiedReadOnlyDiagnosis, readOnlyDiagnosisContext } from './read-only-diagnosis-contract.ts';
import { resumeApprovedMissionRecovery, useConfirmedTranscriptOnlyRecovery } from './task-recovery-mission.ts';
import { loadTaskRecoveryView } from './task-recovery-view.ts';
export { TaskRecoveryError } from './task-recovery-input.ts';
export { failureClassification, view } from './task-recovery-policy.ts';
export class TaskRecovery {
    capabilityStatus: any;
    clock: any;
    createTask: any;
    recover: any;
    resumeApprovedMission: any;
    requests: any;
    store: any;
    constructor({ store, recover = null, createTask = null, capabilityStatus = null, resumeApprovedMission = null, clock = (): any => new Date() }: any = {}) {
        this.store = store;
        this.recover = recover;
        this.resumeApprovedMission = resumeApprovedMission;
        this.createTask = createTask;
        this.capabilityStatus = capabilityStatus;
        this.clock = clock;
        this.requests = new Map();
    }
    async view(taskOrId: any, options: any = {}): Promise<any> {
        return loadTaskRecoveryView({ store: this.store, taskOrId, options, errorFactory: recoveryError });
    }
    request(taskId: any, input: any = {}, actor: any = {}): any {
        const actionKey: any = cleanActionKey(input.actionKey);
        const requestId: any = cleanRequestId(input.requestId || input.idempotencyKey);
        const key: any = actionKey === 'retry_visual_analysis_after_recovery'
            ? `${String(taskId || '').trim()}:${actionKey}`
            : `${String(taskId || '').trim()}:${actionKey}:${requestId}`;
        const running: any = this.requests.get(key);
        if (running)
            return running;
        const execution: any = this.#requestOnce(taskId, { ...input, actionKey, requestId }, actor)
            .finally((): any => this.requests.get(key) === execution && this.requests.delete(key));
        this.requests.set(key, execution);
        return execution;
    }
    async #requestOnce(taskId: any, input: any, actor: any): Promise<any> {
        let task: any = await taskById(this.store, taskId);
        if (!task)
            throw recoveryError('找不到要处理的任务。', 'task_recovery_not_found', 404);
        const attempt: any = requestAttempt(task);
        const relatedTasks: any = await recoveryRelatedTasks(this.store, task);
        const legacyDiagnosisTask: any = legacyBlockedReadOnlyDiagnosis(task, relatedTasks);
        const duplicate: any = duplicateRecovery(task, input, attempt);
        if (duplicate && !legacyDiagnosisTask)
            return existingResult(task, duplicate);
        const expectedUpdatedAt: any = String(input.expectedUpdatedAt || '').trim();
        if (!expectedUpdatedAt || expectedUpdatedAt !== String(task.updatedAt || '')) {
            throw recoveryError('任务状态已经变化，请刷新详情后再决定。', 'task_recovery_stale', 409);
        }
        const approvals: any = typeof this.store.listApprovals === 'function' ? await this.store.listApprovals() : [];
        const recoveryView: any = view(task, { audience: 'local-owner', relatedTasks, approvals });
        if (!recoveryView.actions.some((item: any): any => item.actionKey === input.actionKey)) {
            return ineligibleResult(task, input.actionKey, recoveryView);
        }
        if (input.actionKey === 'retry_visual_analysis_after_recovery') {
            if (actor?.kind !== 'local-owner') {
                throw recoveryError('只有本机主人可以显式触发视觉恢复后重跑。', 'task_recovery_local_owner_required', 403);
            }
            const capability: any = await visionCapabilityReadiness(this.capabilityStatus, {
                failureCode: task.error?.code,
                failureAt: task.error?.occurredAt,
            });
            if (!capability.ready) {
                return {
                    status: 'waiting_capability',
                    taskId: task.taskId,
                    actionKey: input.actionKey,
                    capability,
                    message: capability.requiresBillingRecovery
                        ? '识图余额或额度尚未出现晚于本次失败的新端到端验证；未创建重跑任务，也未消耗重跑次数。'
                        : 'vision.analyze 尚未同时达到已配置、健康和端到端验证；未创建重跑任务，也未消耗重跑次数。',
                    recovery: recoveryView,
                };
            }
        }
        const requestedAt: any = this.clock().toISOString();
        const requestedBy: any = cleanActor(actor);
        task = await this.#record(task.taskId, {
            status: 'pending',
            actionKey: input.actionKey,
            requestId: input.requestId,
            attempt,
            requestedAt,
            requestedBy,
            reason: '本机主人从任务详情请求受控处理。',
        }, {
            event: 'requested',
            actionKey: input.actionKey,
            requestId: input.requestId,
            attempt,
            actor: requestedBy,
            occurredAt: requestedAt,
        });
        try {
            if (input.actionKey === 'accept_reviewed_artifact') {
                return await this.#acceptReviewedArtifact(task, { requestId: input.requestId, requestedBy });
            }
            const outcome: any = input.actionKey === 'resume_approved_mission'
                ? await resumeApprovedMissionRecovery({
                    task, requestId: input.requestId, requestedBy,
                    resumeApprovedMission: this.resumeApprovedMission,
                    record: (...args: any): any => (this.#record as any)(...args),
                    clock: this.clock, errorFactory: recoveryError,
                })
                : input.actionKey === 'use_confirmed_transcript_only'
                ? await useConfirmedTranscriptOnlyRecovery({
                    task, tasks: relatedTasks, requestId: input.requestId, requestedBy,
                    createTask: this.createTask,
                    record: (...args: any): any => (this.#record as any)(...args),
                    clock: this.clock, errorFactory: recoveryError,
                })
                : input.actionKey === 'request_read_only_diagnosis'
                    ? await this.#requestReadOnlyDiagnosis(task, { requestId: input.requestId, requestedBy, legacyDiagnosisTask })
                    : input.actionKey === 'retry_visual_analysis_after_recovery'
                        ? await retryVisualAnalysis({
                            task,
                            requestId: input.requestId,
                            requestedBy,
                            createTask: this.createTask,
                            record: (...args: any): any => (this.#record as any)(...args),
                            clock: this.clock,
                            errorFactory: recoveryError,
                        })
                        : await this.#runCoordinator(task, { actionKey: input.actionKey, requestId: input.requestId, requestedBy });
            const current: any = await taskById(this.store, task.taskId);
            return {
                status: 'accepted',
                taskId: task.taskId,
                actionKey: input.actionKey,
                operatorTaskId: outcome?.operatorTask?.taskId || outcome?.operatorTaskId || null,
                retryTaskId: outcome?.retryTask?.taskId || outcome?.retryTaskId || null,
                technicalTaskId: outcome?.technicalTask?.taskId || outcome?.technicalTaskId || null,
                recovery: view(current || task, { audience: 'local-owner', relatedTasks: await recoveryRelatedTasks(this.store, current || task) }),
            };
        }
        catch (error: any) {
            const failedAt: any = this.clock().toISOString();
            await this.#record(task.taskId, {
                status: 'failed',
                actionKey: input.actionKey,
                requestId: input.requestId,
                attempt,
                requestedAt,
                requestedBy,
                reason: safeText(error?.message || '恢复请求未能完成。', 300),
            }, {
                event: 'failed',
                actionKey: input.actionKey,
                requestId: input.requestId,
                attempt,
                actor: requestedBy,
                occurredAt: failedAt,
                reason: safeText(error?.message || '恢复请求未能完成。', 300),
            });
            throw error;
        }
    }
    async #runCoordinator(task: any, input: any): Promise<any> {
        if (typeof this.recover !== 'function') {
            throw recoveryError('受控恢复暂不可用，未改变任务。', 'task_recovery_unavailable', 503);
        }
        return this.recover(task, input);
    }
    async #requestReadOnlyDiagnosis(task: any, { requestId, requestedBy, legacyDiagnosisTask = null }: any): Promise<any> {
        if (typeof this.createTask !== 'function') {
            throw recoveryError('只读诊断入口暂不可用，未创建子任务。', 'task_recovery_unavailable', 503);
        }
        const paperclipIssueId: any = String(task.governance?.paperclipIssueId || '').trim();
        if (task.execution?.owner !== 'paperclip-hermes' || !paperclipIssueId) {
            throw recoveryError('原 Paperclip 任务关联不完整，未创建无审计关联的诊断。', 'paperclip_parent_issue_required', 503);
        }
        const diagnosisTask: any = await this.createTask({
            title: `只读诊断：${task.input?.title || '未命名任务'}`,
            description: '只读分类原任务失败和缺失证据，输出恢复建议。禁止重跑原任务、修改代码、扩大权限或调用外部发布动作。',
            taskType: 'operations.failure-recovery',
            agentId: 'operator',
            requester: { kind: 'local-owner', ref: requestedBy.ref },
            source: { channel: 'internal-recovery', parentChannel: task.source?.channel || null, chatRef: task.source?.chatRef || null },
            parentTaskId: task.taskId,
            idempotencyKey: `recovery-read-only-diagnosis-v2:${task.taskId}`,
            context: readOnlyDiagnosisContext(task, failureClassification(task)),
            recovery: {
                rootTaskId: task.recovery?.rootTaskId || task.taskId,
                attempt: Number(task.recovery?.attempt || 0),
                triggeredByTaskId: task.taskId,
                mode: 'read_only_diagnosis',
                requestId,
            },
        });
        const diagnosisVerified: any = hasVerifiedReadOnlyDiagnosis(diagnosisTask);
        if (legacyDiagnosisTask)
            await closeSupersededReadOnlyDiagnosis({
                store: this.store,
                task: legacyDiagnosisTask,
                replacementTaskId: diagnosisTask.taskId,
                decidedAt: this.clock().toISOString(),
            });
        await this.#record(task.taskId, {
            status: diagnosisVerified ? 'verified' : diagnosisTask.status === 'running' ? 'running' : 'pending',
            actionKey: 'request_read_only_diagnosis',
            requestId,
            requestedBy,
            operatorTaskId: diagnosisTask.taskId,
            attempt: Number(task.recovery?.attempt || 0) + 1,
            reason: diagnosisVerified ? '只读诊断已完成并形成可验证结果。' : '已创建原 Paperclip Issue 的只读诊断子任务。',
        }, {
            event: 'diagnosed',
            actionKey: 'request_read_only_diagnosis',
            requestId,
            attempt: Number(task.recovery?.attempt || 0) + 1,
            actor: requestedBy,
            taskId: diagnosisTask.taskId,
            occurredAt: this.clock().toISOString(),
        });
        return { operatorTask: diagnosisTask };
    }
    async #record(taskId: any, coordination: any, event: any): Promise<any> {
        const current: any = await taskById(this.store, taskId);
        if (!current)
            throw recoveryError('找不到要更新的恢复任务。', 'task_recovery_not_found', 404);
        const events: any = recoveryEvents(current);
        if (!events.some((item: any): any => item.requestId === event.requestId && item.event === event.event))
            events.push(event);
        return this.store.updateTask(taskId, {
            recovery: { ...(current.recovery || {}), coordination, events: events.slice(-50) },
        });
    }
    async #acceptReviewedArtifact(task: any, { requestId, requestedBy }: any): Promise<any> {
        const completedAt: any = this.clock().toISOString();
        const updatedTask: any = await this.store.updateTask(task.taskId, {
            status: 'succeeded',
            currentStage: 'paperclip_hermes_completed',
            outcome: 'verified_artifact_accepted',
            error: null,
            recovery: {
                ...(task.recovery || {}),
                coordination: {
                    status: 'succeeded',
                    actionKey: 'accept_reviewed_artifact',
                    requestId,
                    completedAt,
                    reason: '本机主人已确认采纳本次产物并完成业务闭环。',
                },
            },
        });
        return {
            status: 'accepted',
            taskId: task.taskId,
            actionKey: 'accept_reviewed_artifact',
            message: '已确认采纳本次产物，任务已标记为已完成。',
            task: updatedTask,
            recovery: view(updatedTask, { audience: 'local-owner', relatedTasks: await recoveryRelatedTasks(this.store, updatedTask) }),
        };
    }
}
