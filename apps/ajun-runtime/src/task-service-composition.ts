import { SkillExecutionRegistry } from './skill-execution-registry.ts';
import { TaskCapabilityCatalog } from './task-capability-catalog.ts';
import { TaskExecutionCoordinator } from './task-execution-coordinator.ts';
import { TaskFailureRecoveryCoordinator } from './task-failure-recovery-coordinator.ts';
import { TaskIntake } from './task-intake.ts';
import { TaskNotification } from './task-notification.ts';
import { TaskRecordService } from './task-record-service.ts';
import { TaskRecovery } from './task-recovery.ts';
import { OfficePresentationExecution } from './office-presentation-execution.ts';
import { TaskOverview } from './task-overview.ts';
import { TaskLifecycleEventRecorder } from './task-lifecycle-event-recorder.ts';
import { DeliveryQualityRuntime, prepareDeliveryQualityResult } from './workflow/delivery-quality-runtime.ts';
import { TaskLocalAiRunEventRecorder } from './task-local-ai-run-event-recorder.ts';
import { TaskIntakeContinuation } from './task-intake-continuation.ts';
import { TaskApprovalLifecycle } from './task-approval-lifecycle.ts';
import { MissionApprovalInheritance } from './mission-approval-inheritance.ts';
import { TaskFeedback } from './task-feedback.ts';
import { WorkflowAcceptanceService } from './workflow-acceptance-service.ts';

/**
 * Builds TaskService's collaborators in one place. TaskService remains the public
 * facade while lifecycle wiring and cross-collaborator callbacks live here.
 */
export function composeTaskService(host: any, input: any): Record<string, any> {
    const {
        registry,
        store,
        governance = null,
        executors = {},
        fallbackExecutor = null,
        onTaskFailed = null,
        feishuChannelStatus = null,
        agentChannelStates = null,
        workerStatus = null,
        contentGrowthWaitMs = 240000,
        employeeAssignmentWaitMs = 0,
        taskDetailBaseUrl = '',
        roleToolAdapters = {},
        m5ProviderVision = null,
        m5WorkProductValidator = null,
        skillExecutionRegistry = new SkillExecutionRegistry(),
        capabilityCatalog = new TaskCapabilityCatalog({ executors }),
        localAiCapabilityStatus = null,
        officePresentationWorkspaceRoot = null,
        usageLedger = null,
        taskRunEvents = null,
        missionChildPolicy = null,
    } = input;
    const localAiStatus = typeof localAiCapabilityStatus === 'function' ? localAiCapabilityStatus : null;
    const taskLifecycleEvents = new TaskLifecycleEventRecorder({ eventStore: taskRunEvents });
    const failureRecovery = new TaskFailureRecoveryCoordinator({ store, recover: onTaskFailed });
    const taskRecovery = new TaskRecovery({
        store,
        recover: typeof onTaskFailed === 'function' ? (task: any, recoveryInput: any): any => onTaskFailed(task, recoveryInput) : null,
        createTask: (taskInput: any): any => host.create(taskInput),
        capabilityStatus: localAiStatus,
        resumeApprovedMission: (task: any): any => host.resumeApprovedMission(task),
    });
    const executionCoordinator = new TaskExecutionCoordinator({
        store,
        governance,
        capabilityCatalog,
        executorResolver: (agentId: any): any => capabilityCatalog.executor(agentId, executors),
        fallbackExecutor,
        fallbackExecutorResolver: (): any => host.fallbackExecutor,
        markFailureRecoveryPending: (task: any): any => failureRecovery.markPending(task),
        startFailureRecovery: (task: any): any => failureRecovery.start(task),
        prepareCompletion: prepareDeliveryQualityResult,
    });
    const officePresentationExecution = new OfficePresentationExecution({
        workspaceRoot: officePresentationWorkspaceRoot,
        store,
        governance,
        capabilityCatalog,
        executorResolver: (agentId: any): any => capabilityCatalog.executor(agentId, executors),
        roleToolAdapters,
        prepareCompletion: prepareDeliveryQualityResult,
    });
    const taskOverview = new TaskOverview({
        registry,
        store,
        governance,
        executors,
        capabilityCatalog,
        skillExecutionRegistry,
        localAiCapabilityStatus: localAiStatus,
        usageLedger,
        taskDetailBaseUrl,
        getFeishuChannelStatus: (): any => host.feishuChannelStatus,
        getAgentChannelStates: (): any => host.agentChannelStates,
        getWorkerStatus: (): any => host.workerStatus,
    });
    const deliveryQuality = new DeliveryQualityRuntime({
        store,
        createTask: (taskInput: any): any => host.create(taskInput),
        taskRunEvents,
        syncTask: async (task: any): Promise<any> => store.updateTask(task.taskId, { governance: await governance.update(task) }),
        markReviewPending: async (task: any): Promise<any> => {
            const issueId: any = String(task?.governance?.paperclipIssueId || '').trim();
            if (!issueId || typeof governance?.markPaperclipIssueReviewPending !== 'function')
                return null;
            return governance.markPaperclipIssueReviewPending(issueId, {
                result: task,
                reviewTaskId: task.deliveryQualityRuntime?.reviewTaskId,
            });
        },
    });
    return {
        registry,
        taskDefinitionRegistry: capabilityCatalog.registry,
        store,
        governance,
        executors,
        capabilityCatalog,
        fallbackExecutor,
        feishuChannelStatus,
        agentChannelStates,
        workerStatus,
        taskDetailBaseUrl,
        roleToolAdapters,
        m5ProviderVision: typeof m5ProviderVision === 'function' ? m5ProviderVision : null,
        m5WorkProductValidator: typeof m5WorkProductValidator === 'function' ? m5WorkProductValidator : null,
        skillExecutionRegistry,
        localAiCapabilityStatus: localAiStatus,
        usageLedger,
        missionChildPolicy,
        taskLifecycleEvents,
        localAiRunEvents: new TaskLocalAiRunEventRecorder({
            eventStore: taskRunEvents,
            registry,
            resolveAssignment: (assignmentInput: any): any => host.getPaperclipAssignment(assignmentInput),
        }),
        contentGrowthWaitMs: Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240000, 240000)),
        employeeAssignmentWaitMs: Math.max(0, Math.min(Number(employeeAssignmentWaitMs) || 0, 240000)),
        contentGrowthRuns: new Map(),
        employeeAssignmentRuns: new Map(),
        approvalResolutionRuns: new Map(),
        approvedMissionResumeRuns: new Map(),
        taskControlRuns: new Map(),
        xiaodDeliveryRequestRuns: new Map(),
        xiaodDeliveryRuns: new Map(),
        xiaodTranscriptRevisionRuns: new Map(),
        paperclipAssignmentCompletionRuns: new Map(),
        m5WorkProductObserver: null,
        failureRecovery,
        taskRecovery,
        executionCoordinator,
        officePresentationExecution,
        intake: new TaskIntake({
            registry,
            store,
            governance,
            execute: (task: any, agent: any): any => host.executeTask(task, agent),
        }),
        notification: new TaskNotification({ store, registry, executors }),
        taskRecords: new TaskRecordService({ store, taskDetailBaseUrl, taskRecovery, capabilityCatalog }),
        taskOverview,
        deliveryQuality,
        intakeContinuation: new TaskIntakeContinuation({ store, createTask: (taskInput: any): any => host.create(taskInput) }),
        approvalLifecycle: new TaskApprovalLifecycle({ store, governance }),
        missionApprovalInheritance: new MissionApprovalInheritance({
            store,
            registry,
            taskDefinitions: capabilityCatalog.registry,
            executeTask: (task: any, agent: any): any => host.executeTask(task, agent),
        }),
        taskFeedback: new TaskFeedback({ store }),
        workflowAcceptance: new WorkflowAcceptanceService({ store }),
    };
}
