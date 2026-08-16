import { validateArchitectureEvidenceRefs } from './architecture-evidence.ts';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import { M5StageRecoveryController } from './m5-stage-recovery-controller.ts';
import { CampaignDeliveryEvidence } from './campaign-delivery-evidence.ts';
import { taskPaperclipAssignmentMethods } from './task-paperclip-assignment.ts';
import { taskRoleExecutionMethods } from './task-role-execution.ts';
import { validateTaskCompletion } from './task-completion-contract.ts';
import { taskIdempotencyFingerprint } from './task-idempotency.ts';
import { PaperclipAssignmentCompletion, isPaperclipProjectionSyncTaskStatus, } from './paperclip-assignment-completion.ts';
import { ValidationError, isTerminalTask, paperclipUuid, contentGrowthArtifactVerified, normalizeArchitectureLayers, } from './task-service-execution-support.ts';
import { assertM5PlanRevisionConsumed } from './task-service-m5-execution-context-support.ts';
import { prepareDeliveryQualityResult } from './workflow/delivery-quality-runtime.ts';
import { deliveryQualityReviewInput } from './workflow/delivery-quality-review-input.ts';
import { isPaperclipCompletionTaskStatus } from './task-status-policy.ts';
const campaignDeliveryEvidenceModules: any = new WeakMap();
function campaignDeliveryEvidence(service: any): any {
    let module: any = campaignDeliveryEvidenceModules.get(service);
    if (!module) {
        module = new CampaignDeliveryEvidence({
            store: service.store,
            governance: service.governance,
            workProductValidator: service.m5WorkProductValidator,
            observeWorkProduct: (input: any): any => service.m5WorkProductObserver?.(input),
        });
        campaignDeliveryEvidenceModules.set(service, module);
    }
    return module;
}
function paperclipAssignmentCompletion(service: any, { usePublicConfirm = false }: any = {}): any {
    return new PaperclipAssignmentCompletion({
        store: service.store,
        governance: service.governance,
        ...(usePublicConfirm ? {
            confirmTask: (task: any, assignment: any): any => service.confirmPaperclipAssignmentCompletion(task, assignment),
        } : {}),
    });
}
export const taskServiceExecutionMethods: Record<string, any> = {
    ...taskPaperclipAssignmentMethods,
    async recordM5StageExecution(taskId: any, result: any = {}): Promise<any> {
        return campaignDeliveryEvidence(this).recordStageExecution(taskId, result);
    },
    async recordM5StageExecutionFailure(taskId: any, routeExecution: any, error: any): Promise<any> {
        return campaignDeliveryEvidence(this).recordStageFailure(taskId, routeExecution, error);
    },
    completePaperclipAssignment(input: any = {}): any {
        const key: any = `${String(input.issueId || '').trim()}:${String(input.runId || '').trim()}`;
        const fingerprint: any = taskIdempotencyFingerprint(Object.fromEntries(Object.entries(input).filter(([name]: any): any => name !== 'paperclipApiKey')));
        const running: any = this.paperclipAssignmentCompletionRuns.get(key);
        if (running) {
            if (running.fingerprint !== fingerprint)
                throw new ValidationError('同一 Paperclip Run 正在回报不同的完成结果；已拒绝覆盖。');
            return running.execution;
        }
        const execution: any = Promise.resolve().then((): any => this.completePaperclipAssignmentOnce(input)).finally((): any => {
            if (this.paperclipAssignmentCompletionRuns.get(key)?.execution === execution)
                this.paperclipAssignmentCompletionRuns.delete(key);
        });
        this.paperclipAssignmentCompletionRuns.set(key, { fingerprint, execution });
        return execution;
    },
    async completePaperclipAssignmentOnce(input: any = {}): Promise<any> {
        const { task, assignment } = await this.getPaperclipAssignment(input);
        if (isTerminalTask(task)) {
            const duplicateContract: any = getM5RoutineExecutionContract(assignment.routineKey);
            if (input.status === 'succeeded' && duplicateContract?.executionMode === 'hermes') {
                await this.syncM5StageWorkProducts({ task: { ...task, status: 'succeeded' }, assignment, apiKey: input.paperclipApiKey });
            }
            const synchronized: any = await this.ensurePaperclipAssignmentCompletion({ task, assignment, paperclipAgentId: input.paperclipAgentId, apiKey: input.paperclipApiKey });
            const existingReview: any = task.taskType === 'governance.assurance-review'
                ? (task.artifactRefs || []).find((item: any): any => item?.type === 'employee_role_report')?.data?.qualityReview
                : null;
            const qualitySourceTask: any = existingReview
                ? await this.deliveryQuality.resolveReview(synchronized, existingReview)
                : null;
            return { task: synchronized, assignment, duplicate: true, ...(qualitySourceTask ? { qualitySourceTask } : {}) };
        }
        const requestedStatus: any = String(input.status || 'succeeded').trim();
        if (!isPaperclipCompletionTaskStatus(requestedStatus)) {
            throw new ValidationError('员工回报状态无效。');
        }
        const completedAt: any = new Date().toISOString();
        const summary: any = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
        if (!summary)
            throw new ValidationError('员工必须提供可核对的结果摘要。');
        const qualityReview: any = deliveryQualityReviewInput(task, input, ValidationError);
        const m5Contract: any = getM5RoutineExecutionContract(assignment.routineKey);
        const m5PlanRevisionReceipt: any = m5Contract?.executionMode === 'hermes'
            ? assertM5PlanRevisionConsumed({
                expected: task.input?.context?.m5Recovery,
                actual: task.execution?.m5RouteExecution,
                runId: assignment.runId,
                allowUnchangedFailure: requestedStatus === 'failed',
                input,
            })
            : null;
        if (requestedStatus === 'succeeded'
            && m5Contract?.stageKey === 'visual_analysis') {
            const projectId: any = paperclipUuid(assignment.projectId);
            const verifiedVisual: any = projectId && (task.artifactRefs || []).some((artifact: any): any => artifact?.type === 'visual_analysis_package'
                && contentGrowthArtifactVerified(task, artifact, {
                    expectedProjectId: projectId,
                }));
            if (!verifiedVisual) {
                throw new ValidationError('M5 画面分析缺少与当前 Paperclip Project 一致的 confirmed 视觉回执，不能回报 succeeded。');
            }
        }
        if (requestedStatus === 'failed' && m5Contract?.executionMode === 'hermes') {
            return this.handleM5ReportedFailure({
                task,
                assignment,
                contract: m5Contract,
                summary,
                completedAt,
                m5PlanRevisionReceipt,
            });
        }
        let architectureEvidence: any = null;
        let architectureLayers: any = null;
        if (assignment.agentId === 'architect') {
            const groundTruth: any = await this.architectureGroundTruth();
            architectureLayers = normalizeArchitectureLayers(input);
            const factEvidence: any = validateArchitectureEvidenceRefs(architectureLayers.factClaims.flatMap((item: any): any => item.evidenceRefs.map((ref: any): any => ({ ref, claim: item.claim }))), groundTruth);
            const judgmentEvidence: any = validateArchitectureEvidenceRefs(architectureLayers.architectureJudgments.flatMap((item: any): any => item.basisRefs.map((ref: any): any => ({ ref, claim: item.judgment }))), groundTruth);
            const invalidRefs: any[] = [...new Set([...factEvidence.invalidRefs, ...judgmentEvidence.invalidRefs])];
            architectureEvidence = {
                valid: factEvidence.valid && invalidRefs.length === 0,
                refs: [...factEvidence.refs, ...judgmentEvidence.refs],
                invalidRefs,
                snapshotId: groundTruth.snapshotId
            };
            if (invalidRefs.length) {
                throw new ValidationError(`架构报告引用了快照中不存在的对象：${invalidRefs.join('、')}。当前事实和判断依据必须使用真实引用。`);
            }
            if (requestedStatus === 'succeeded' && !factEvidence.valid) {
                const reason: any = factEvidence.invalidRefs.length
                    ? `当前事实引用了快照中不存在的对象：${factEvidence.invalidRefs.join('、')}`
                    : '架构报告至少需要一条带真实引用的当前事实；推理和候选方案不能替代现状基线。';
                throw new ValidationError(`${reason} 未写入成功结论。`);
            }
        }
        const artifact: Record<string, any> = {
            artifactId: `employee-role-report:${assignment.issueId}:${assignment.runId}`,
            taskId: task.taskId,
            type: 'employee_role_report',
            title: '员工岗位回报',
            createdAt: completedAt,
            data: {
                schemaVersion: 'agent.army/employee-role-report/v1',
                agentId: assignment.agentId,
                reportedStatus: requestedStatus,
                attempt: Number.isInteger(task.recovery?.attempt)
                    ? task.recovery.attempt
                    : Number.isInteger(task.attempt) ? task.attempt : 1,
                summary,
                evidence: String(input.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
                remainingRisks: String(input.remainingRisks || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
                ...(qualityReview ? { qualityReview } : {}),
                ...(architectureEvidence ? {
                    evidenceRefs: architectureEvidence.refs,
                    evidenceValidation: {
                        valid: architectureEvidence.valid,
                        invalidRefs: architectureEvidence.invalidRefs,
                        snapshotId: architectureEvidence.snapshotId
                    },
                    factClaims: architectureLayers.factClaims,
                    architectureJudgments: architectureLayers.architectureJudgments,
                    candidateProposals: architectureLayers.candidateProposals,
                    currentStateUnknowns: architectureLayers.currentStateUnknowns,
                    // 兼容旧读取方；新写入统一使用 currentStateUnknowns。
                    unverifiedClaims: architectureLayers.currentStateUnknowns
                } : {}),
                paperclipIssueId: assignment.issueId,
                paperclipRunId: assignment.runId,
                ...(m5PlanRevisionReceipt ? {
                    m5PlanRevisionReceipt,
                } : {}),
            },
            validation: { exists: true, readable: true, nonEmpty: true, checkedAt: completedAt }
        };
        const completionArtifacts: any[] = [...(task.artifactRefs || []), artifact];
        if (requestedStatus === 'succeeded') {
            const completion: any = validateTaskCompletion(task, completionArtifacts);
            if (!completion.valid)
                throw new ValidationError(`${completion.reason} Paperclip/Hermes 的文字回报不能替代专用业务产物。`);
            if (m5Contract?.executionMode === 'hermes') {
                await this.syncM5StageWorkProducts({
                    task: { ...task, status: 'succeeded', artifactRefs: completionArtifacts },
                    assignment,
                    apiKey: input.paperclipApiKey,
                });
            }
        }
        const completedResult: any = prepareDeliveryQualityResult(task, {
            status: requestedStatus,
            currentStage: requestedStatus === 'succeeded' ? 'paperclip_hermes_completed' : requestedStatus === 'waiting_test' ? 'paperclip_hermes_waiting_test' : 'paperclip_hermes_failed',
            artifactRefs: completionArtifacts,
            execution: {
                ...(task.execution || {}),
                owner: 'paperclip-hermes',
                finishedAt: completedAt,
                outcome: requestedStatus,
                ...(m5PlanRevisionReceipt ? {
                    m5PlanRevisionReceipt,
                } : {}),
            },
            governance: {
                ...(task.governance || {}),
                completionSync: paperclipAssignmentCompletion(this).sync({
                    status: 'pending',
                    taskStatus: requestedStatus,
                    issueId: assignment.issueId,
                    runId: assignment.runId,
                    now: completedAt,
                }),
            },
            ...(requestedStatus === 'failed' ? {
                error: reportedFailureError(task.error, summary, completedAt)
            } : { error: undefined })
        });
        let updated: any = await this.store.updateTask(task.taskId, completedResult);
        this.taskLifecycleEvents?.recordPersisted(updated, { previousTask: task });
        updated = await this.ensurePaperclipAssignmentCompletion({ task: updated, assignment, paperclipAgentId: input.paperclipAgentId, apiKey: input.paperclipApiKey });
        if (updated.status === 'running' && updated.currentStage === 'delivery_quality_review_pending') {
            const beforeQuality: any = structuredClone(updated);
            updated = await this.deliveryQuality.continue(updated);
            this.taskLifecycleEvents?.recordPersisted(updated, { previousTask: beforeQuality });
        }
        const qualitySourceTask: any = qualityReview
            ? await this.deliveryQuality.resolveReview(updated, qualityReview)
            : null;
        return { task: updated, assignment, duplicate: false, ...(qualitySourceTask ? { qualitySourceTask } : {}) };
    },
    async ensurePaperclipAssignmentCompletion({ task, assignment, paperclipAgentId, apiKey }: any = {}): Promise<any> {
        if (!isPaperclipProjectionSyncTaskStatus(task?.status))
            return task;
        if (task.status === 'succeeded')
            await this.syncM5StageWorkProducts({ task, assignment, apiKey });
        return paperclipAssignmentCompletion(this, { usePublicConfirm: true }).ensure(task, assignment, {
            paperclipAgentId,
            apiKey,
        });
    },
    async confirmPaperclipAssignmentCompletion(task: any, assignment: any): Promise<any> {
        return paperclipAssignmentCompletion(this).confirm(task, assignment);
    },
    async handleM5ReportedFailure({ task, assignment, contract, summary, completedAt, m5PlanRevisionReceipt = null, }: any = {}): Promise<any> {
        const controller: any = new M5StageRecoveryController({
            governance: this.governance,
            workProductValidator: this.m5WorkProductValidator,
        });
        const recovery: any = await controller.handleFailure({
            assignment,
            contract,
            task,
            summary,
            routeExecution: task.execution?.m5RouteExecution,
        });
        const failureArtifactId: any = `m5-stage-failure:${assignment.pipelineCaseId}:${assignment.runId}`;
        const failureArtifact: Record<string, any> = {
            artifactId: failureArtifactId,
            taskId: task.taskId,
            type: 'employee_role_report',
            title: '员工岗位失败回报',
            createdAt: completedAt,
            data: {
                schemaVersion: 'agent.army/employee-role-report/v1',
                agentId: assignment.agentId,
                reportedStatus: 'failed',
                attempt: Number.isInteger(task.recovery?.attempt)
                    ? task.recovery.attempt
                    : Number.isInteger(task.attempt) ? task.attempt : 1,
                summary,
                paperclipIssueId: assignment.issueId,
                paperclipRunId: assignment.runId,
                m5Recovery: {
                    action: recovery.action,
                    stageAttempt: recovery.stageAttempt,
                    replanCount: recovery.replanCount,
                    recoveryAction: recovery.recoveryAction || null,
                },
                ...(m5PlanRevisionReceipt ? {
                    m5PlanRevisionReceipt,
                } : {}),
            },
            validation: { exists: true, readable: true, nonEmpty: true, checkedAt: completedAt },
        };
        const retainedArtifacts: any = (task.artifactRefs || []).filter((artifact: any): any => artifact.artifactId !== failureArtifactId
            && !contract.expectedWorkProduct.artifactKinds.includes(artifact.type));
        const verifiedReplay: any = recovery.action === 'verified_work_product';
        const blocked: any = recovery.action === 'blocked';
        const status: any = verifiedReplay ? 'succeeded' : blocked ? 'failed' : 'running';
        const currentStage: any = verifiedReplay
            ? 'm5_stage_work_product_replayed'
            : blocked
                ? 'm5_stage_recovery_blocked'
                : recovery.action === 'replan'
                    ? 'm5_content_replan_scheduled'
                    : 'm5_stage_retry_scheduled';
        const updated: any = await this.store.updateTask(task.taskId, {
            status,
            currentStage,
            artifactRefs: [...retainedArtifacts, failureArtifact],
            execution: {
                ...(task.execution || {}),
                owner: 'paperclip-hermes',
                finishedAt: verifiedReplay || blocked ? completedAt : null,
                outcome: verifiedReplay
                    ? 'verified_work_product_replayed'
                    : blocked
                        ? 'm5_stage_recovery_blocked'
                        : recovery.action === 'replan'
                            ? 'm5_content_replan_scheduled'
                            : 'm5_stage_retry_scheduled',
                paperclipEmployee: null,
                m5Recovery: {
                    action: recovery.action,
                    stageAttempt: recovery.stageAttempt,
                    replanCount: recovery.replanCount,
                    runId: assignment.runId,
                    replayed: recovery.replayed === true,
                    recoveryAction: recovery.recoveryAction || null,
                },
                ...(m5PlanRevisionReceipt ? {
                    m5PlanRevisionReceipt,
                } : {}),
            },
            governance: {
                ...(task.governance || {}),
                status: 'synced',
                syncedAt: completedAt,
            },
            error: verifiedReplay ? undefined : {
                code: blocked ? 'm5_stage_recovery_limit_reached' : `m5_${recovery.action}_scheduled`,
                message: summary,
                userMessage: blocked
                    ? recovery.recoveryAction?.instruction || 'M5 阶段恢复上限已达到，等待负责人恢复当前 Case。'
                    : recovery.action === 'replan'
                        ? `M5 ${contract.stageKey} 阶段重试已用尽，已安排受控内容重规划。`
                        : `M5 ${contract.stageKey} 阶段已安排安全重试。`,
                category: blocked ? 'manual' : 'retryable',
                stage: contract.stageKey,
                retryable: !blocked,
                occurredAt: completedAt,
            },
        });
        return {
            task: updated,
            assignment,
            recovery,
            duplicate: recovery.replayed === true,
        };
    },
    async syncM5StageWorkProducts({ task, assignment, apiKey }: any = {}): Promise<any> {
        return campaignDeliveryEvidence(this).syncStageWorkProducts({ task, assignment, apiKey });
    },
    ...taskRoleExecutionMethods,
};
function reportedFailureError(existing: any, summary: any, completedAt: any): any {
    const code: any = String(existing?.code || '').trim().slice(0, 120);
    const message: any = String(existing?.message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const userMessage: any = reportedFailureSummary(existing?.userMessage);
    if (code && code !== 'paperclip_hermes_reported_failure' && (message || userMessage)) {
        return {
            code,
            message: message || userMessage,
            userMessage: userMessage || message,
            category: String(existing?.category || 'manual').trim().slice(0, 80) || 'manual',
            stage: String(existing?.stage || 'paperclip_hermes').trim().slice(0, 120) || 'paperclip_hermes',
            retryable: existing?.retryable === true,
            occurredAt: String(existing?.occurredAt || completedAt),
        };
    }
    const safeSummary: any = reportedFailureSummary(summary);
    return {
        code: 'paperclip_hermes_reported_failure',
        message: safeSummary || null,
        userMessage: safeSummary || null,
        category: 'manual',
        stage: 'paperclip_hermes',
        retryable: false,
        occurredAt: completedAt,
    };
}
function reportedFailureSummary(value: any): any {
    const text: any = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    return text === '员工已如实回报任务失败，请查看结果摘要和剩余风险。' ? '' : text;
}
