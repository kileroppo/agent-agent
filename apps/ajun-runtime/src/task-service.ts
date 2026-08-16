import { buildArchitectureGroundTruth } from './architecture-evidence.ts';
import { SkillExecutionRegistry } from './skill-execution-registry.ts';
import { TaskCapabilityCatalog } from './task-capability-catalog.ts';
import { TaskExecutionCoordinator } from './task-execution-coordinator.ts';
import { TaskFailureRecoveryCoordinator } from './task-failure-recovery-coordinator.ts';
import { TaskIntake } from './task-intake.ts';
import { TaskNotification } from './task-notification.ts';
import { TaskRecordService } from './task-record-service.ts';
import { TaskRecovery } from './task-recovery.ts';
import { OfficePresentationExecution } from './office-presentation-execution.ts';
import { taskServiceExecutionMethods } from './task-service-execution.ts';
export { ValidationError } from './task-validation-error.ts';
import { taskApprovalCoordinatorMethods } from './task-approval-coordinator.ts';
import { TaskOverview } from './task-overview.ts';
import { taskXiaodTranscriptRevisionMethods } from './task-xiaod-transcript-revision.ts';
import { TaskLifecycleEventRecorder } from './task-lifecycle-event-recorder.ts';
import { DeliveryQualityRuntime, prepareDeliveryQualityResult } from './workflow/delivery-quality-runtime.ts';
import { TaskLocalAiRunEventRecorder } from './task-local-ai-run-event-recorder.ts';
import { TaskIntakeContinuation } from './task-intake-continuation.ts';
import { TaskApprovalLifecycle } from './task-approval-lifecycle.ts';
import { MissionApprovalInheritance } from './mission-approval-inheritance.ts';
import { TaskFeedback } from './task-feedback.ts';
import { maturityQueuedChildRecoveryMethods } from './maturity-queued-child-recovery.ts';
import { approvedMissionResumeEligible } from './task-recovery-policy.ts';
import { ValidationError } from './task-validation-error.ts';
export class TaskService {
    agentChannelStates: any;
    approvalLifecycle: any;
    approvalResolutionRuns: any;
    approvedMissionResumeRuns: any;
    capabilityCatalog: any;
    contentGrowthRuns: any;
    contentGrowthWaitMs: any;
    deliveryQuality: any;
    employeeAssignmentRuns: any;
    employeeAssignmentWaitMs: any;
    executionCoordinator: any;
    executors: any;
    failureRecovery: any;
    fallbackExecutor: any;
    feishuChannelStatus: any;
    governance: any;
    intake: any;
    intakeContinuation: any;
    localAiCapabilityStatus: any;
    localAiRunEvents: any;
    m5ProviderVision: any;
    m5WorkProductObserver: any;
    m5WorkProductValidator: any;
    missionApprovalInheritance: any;
    missionChildPolicy: any;
    notification: any;
    officePresentationExecution: any;
    paperclipAssignmentCompletionRuns: any;
    registry: any;
    roleToolAdapters: any;
    skillExecutionRegistry: any;
    store: any;
    taskControlRuns: any;
    taskDefinitionRegistry: any;
    taskDetailBaseUrl: any;
    taskFeedback: any;
    taskLifecycleEvents: any;
    taskOverview: any;
    taskRecords: any;
    taskRecovery: any;
    usageLedger: any;
    workerStatus: any;
    xiaodDeliveryRequestRuns: any;
    xiaodDeliveryRuns: any;
    xiaodTranscriptRevisionRuns: any;
    maturityExecutionGuard: any;
    declare getPaperclipAssignment: (input?: any) => Promise<any>;
    declare requestTaskControl: (taskId: any, action: any) => Promise<any>;
    declare resolvePaperclipApproval: (approvalId: any, decision: any, options?: any) => Promise<any>;
    declare approveApproval: (approvalId: any, options?: any) => Promise<any>;
    declare rejectApproval: (approvalId: any, options?: any) => Promise<any>;
    constructor({ registry, store, governance = null, executors = {}, fallbackExecutor = null, onTaskFailed = null, feishuChannelStatus = null, agentChannelStates = null, workerStatus = null, contentGrowthWaitMs = 240000, employeeAssignmentWaitMs = 0, taskDetailBaseUrl = '', roleToolAdapters = {}, m5ProviderVision = null, m5WorkProductValidator = null, skillExecutionRegistry = new SkillExecutionRegistry(), capabilityCatalog = new TaskCapabilityCatalog({ executors }), localAiCapabilityStatus = null, officePresentationWorkspaceRoot = null, usageLedger = null, taskRunEvents = null, missionChildPolicy = null, }: any) {
        this.registry = registry;
        this.taskDefinitionRegistry = capabilityCatalog.registry;
        this.store = store;
        this.governance = governance;
        this.executors = executors;
        this.capabilityCatalog = capabilityCatalog;
        this.fallbackExecutor = fallbackExecutor;
        this.feishuChannelStatus = feishuChannelStatus;
        this.agentChannelStates = agentChannelStates;
        this.workerStatus = workerStatus;
        this.taskDetailBaseUrl = taskDetailBaseUrl;
        this.roleToolAdapters = roleToolAdapters;
        this.m5ProviderVision = typeof m5ProviderVision === 'function'
            ? m5ProviderVision
            : null;
        this.m5WorkProductValidator = typeof m5WorkProductValidator === 'function'
            ? m5WorkProductValidator
            : null;
        this.skillExecutionRegistry = skillExecutionRegistry;
        this.localAiCapabilityStatus = typeof localAiCapabilityStatus === 'function'
            ? localAiCapabilityStatus
            : null;
        this.usageLedger = usageLedger;
        this.missionChildPolicy = missionChildPolicy;
        this.taskLifecycleEvents = new TaskLifecycleEventRecorder({ eventStore: taskRunEvents });
        this.localAiRunEvents = new TaskLocalAiRunEventRecorder({
            eventStore: taskRunEvents,
            registry,
            resolveAssignment: (input: any): any => this.getPaperclipAssignment(input),
        });
        this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240000, 240000));
        this.employeeAssignmentWaitMs = Math.max(0, Math.min(Number(employeeAssignmentWaitMs) || 0, 240000));
        this.contentGrowthRuns = new Map();
        this.employeeAssignmentRuns = new Map();
        this.approvalResolutionRuns = new Map();
        this.approvedMissionResumeRuns = new Map();
        this.taskControlRuns = new Map();
        this.xiaodDeliveryRequestRuns = new Map();
        this.xiaodDeliveryRuns = new Map();
        this.xiaodTranscriptRevisionRuns = new Map();
        this.paperclipAssignmentCompletionRuns = new Map();
        this.m5WorkProductObserver = null;
        this.failureRecovery = new TaskFailureRecoveryCoordinator({ store, recover: onTaskFailed });
        this.taskRecovery = new TaskRecovery({
            store,
            recover: typeof onTaskFailed === 'function' ? (task: any, input: any): any => onTaskFailed(task, input) : null,
            createTask: (input: any): any => this.create(input),
            capabilityStatus: this.localAiCapabilityStatus,
            resumeApprovedMission: (task: any): any => this.resumeApprovedMission(task),
        });
        this.executionCoordinator = new TaskExecutionCoordinator({
            store,
            governance,
            capabilityCatalog,
            executorResolver: (agentId: any): any => capabilityCatalog.executor(agentId, this.executors),
            fallbackExecutor,
            fallbackExecutorResolver: (): any => this.fallbackExecutor,
            markFailureRecoveryPending: (task: any): any => this.failureRecovery.markPending(task),
            startFailureRecovery: (task: any): any => this.failureRecovery.start(task),
            prepareCompletion: prepareDeliveryQualityResult,
        });
        this.officePresentationExecution = new OfficePresentationExecution({
            workspaceRoot: officePresentationWorkspaceRoot,
            store,
            governance,
            capabilityCatalog,
            executorResolver: (agentId: any): any => capabilityCatalog.executor(agentId, this.executors),
            roleToolAdapters,
            prepareCompletion: prepareDeliveryQualityResult,
        });
        this.intake = new TaskIntake({
            registry,
            store,
            governance,
            execute: (task: any, agent: any): any => this.executeTask(task, agent),
        });
        this.notification = new TaskNotification({ store, registry, executors });
        this.taskRecords = new TaskRecordService({ store, taskDetailBaseUrl, taskRecovery: this.taskRecovery, capabilityCatalog });
        this.taskOverview = new TaskOverview({
            registry,
            store,
            governance,
            executors,
            capabilityCatalog,
            skillExecutionRegistry,
            localAiCapabilityStatus: this.localAiCapabilityStatus,
            usageLedger,
            taskDetailBaseUrl,
            getFeishuChannelStatus: (): any => this.feishuChannelStatus,
            getAgentChannelStates: (): any => this.agentChannelStates,
            getWorkerStatus: (): any => this.workerStatus,
        });
        this.deliveryQuality = new DeliveryQualityRuntime({
            store,
            createTask: (input: any): any => this.create(input),
            taskRunEvents,
            syncTask: async (task: any): Promise<any> => this.store.updateTask(task.taskId, { governance: await this.governance.update(task) }),
        });
        this.intakeContinuation = new TaskIntakeContinuation({
            store,
            createTask: (input: any): any => this.create(input),
        });
        this.approvalLifecycle = new TaskApprovalLifecycle({ store, governance });
        this.missionApprovalInheritance = new MissionApprovalInheritance({
            store,
            registry,
            taskDefinitions: capabilityCatalog.registry,
            executeTask: (task: any, agent: any): any => this.executeTask(task, agent),
        });
        this.taskFeedback = new TaskFeedback({ store });
    }
    setFeishuChannelStatus(status: any): any { this.feishuChannelStatus = status; }
    setAgentChannelStates(status: any): any { this.agentChannelStates = status; }
    setWorkerStatus(status: any): any { this.workerStatus = status; }
    setM5WorkProductObserver(observer: any): any { this.m5WorkProductObserver = observer; }
    recordPaperclipLocalAiRunEvent(input: any = {}): any { return this.localAiRunEvents.record(input); }
    async architectureGroundTruth(): Promise<any> {
        return buildArchitectureGroundTruth({
            agents: await this.registry.list({ includeInactive: true }),
            tasks: await this.store.list()
        });
    }
    async create(input: any): Promise<any> {
        const startedAt: any = new Date().toISOString();
        let task: any = await this.intake.create(input);
        task = await this.deliveryQuality.continue(task);
        this.taskLifecycleEvents.recordCreated(task, startedAt);
        return task;
    }
    async continueFromRecommendation(taskId: any): Promise<any> {
        return this.intakeContinuation.continue(taskId);
    }
    async revokePrivateReadGrant(approvalId: any, { revokedBy = 'A君', chatRef = '' }: any = {}): Promise<any> {
        return this.approvalLifecycle.revokePrivateReadGrant(approvalId, { revokedBy, chatRef });
    }
    async requestPause(taskId: any): Promise<any> { return this.requestTaskControl(taskId, 'pause-task'); }
    async requestResume(taskId: any): Promise<any> { return this.requestTaskControl(taskId, 'resume-task'); }
    async expirePendingApprovals({ now = Date.now() }: any = {}): Promise<any> {
        return this.approvalLifecycle.expirePending({ now });
    }
    async expireApproval(approvalId: any, { now = Date.now() }: any = {}): Promise<any> {
        return this.approvalLifecycle.expire(approvalId, { now });
    }
    async resumeApprovedMissionChild(taskId: any): Promise<any> {
        return this.missionApprovalInheritance.resumeChild(taskId);
    }
    async resumeApprovedMission(taskOrId: any): Promise<any> {
        const taskId: any = String(typeof taskOrId === 'string' ? taskOrId : taskOrId?.taskId || '').trim();
        if (!taskId)
            throw new ValidationError('找不到要继续的已批准任务。');
        const running: any = this.approvedMissionResumeRuns.get(taskId);
        if (running)
            return running;
        const operation: any = (async (): Promise<any> => {
            const task: any = await this.store.getTask(taskId);
            if (!task)
                throw new ValidationError('找不到要继续的已批准任务。');
            if (task.status !== 'queued' || task.currentStage !== 'approval_approved')
                return task;
            const approvals: any = await this.store.listApprovals();
            if (!approvedMissionResumeEligible(task, approvals))
                throw new ValidationError('这项任务没有有效的已批准范围，未继续执行。');
            const agent: any = typeof this.registry.get === 'function'
                ? await this.registry.get(task.assigneeAgentId)
                : (await this.registry.list({ includeManagers:true }))
                    .find((item: any): any => item.agentId === task.assigneeAgentId) || null;
            const executor: any = agent?.status === 'active'
                ? this.capabilityCatalog.executor(agent.agentId, this.executors)
                : null;
            if (!executor || typeof executor.execute !== 'function')
                throw new ValidationError('已批准任务缺少本机总任务规划器，未继续执行。');
            const planning: any = await this.store.updateTask(task.taskId, {
                status:'running',
                currentStage:'approval_resume_planning',
                error:undefined,
                execution:{
                    ...(task.execution || {}),
                    executor:agent.agentId,
                    mode:'approved_mission_local_plan',
                    startedAt:new Date().toISOString(),
                },
            });
            const result: any = await executor.execute(planning);
            if (result?.status !== 'running'
                || !result?.artifactRefs?.some((item: any): any => item.type === 'cross_agent_mission_plan')) {
                throw new ValidationError('本机总任务规划器没有生成可分派计划，未继续执行。');
            }
            const resumed: any = await this.store.updateTask(task.taskId, { ...result, error:undefined });
            this.taskLifecycleEvents?.recordPersisted(resumed, { previousTask:task });
            return resumed;
        })().finally((): any => this.approvedMissionResumeRuns.get(taskId) === operation
            && this.approvedMissionResumeRuns.delete(taskId));
        this.approvedMissionResumeRuns.set(taskId, operation);
        return operation;
    }
    async executeTask(task: any, agent: any): Promise<any> {
        if (this.officePresentationExecution.supports(task, agent)) {
            return this.officePresentationExecution.execute(task, agent);
        }
        return this.executionCoordinator.execute(task, agent);
    }
    async recordFeedback(taskId: any, { sentiment, note = '' }: any = {}): Promise<any> {
        return this.taskFeedback.record(taskId, { sentiment, note });
    }
    async overview({ includeTasks = true }: any = {}): Promise<any> {
        return this.taskOverview.read({ includeTasks });
    }
    async consoleOverview(): Promise<any> { return this.overview({ includeTasks: false }); }
    async listTaskRecords(query: any = {}, { audience = 'lan' }: any = {}): Promise<any> { return this.taskRecords.list(query, { audience }); }
    async taskRecordDetail(taskId: any, { audience = 'lan' }: any = {}): Promise<any> { return this.taskRecords.detail(taskId, { audience }); }
    async recoveryView(taskOrId: any, options: any = {}): Promise<any> { return this.taskRecovery.view(taskOrId, options); }
    async requestRecovery(taskId: any, input: any, actor: any = {}): Promise<any> { return this.taskRecovery.request(taskId, input, actor); }
    async usageOverview(options: any = {}): Promise<any> {
        return this.taskOverview.usage(options);
    }
    async notificationStatus(taskId: any, chatRef: any = ''): Promise<any> {
        return this.notification.status(taskId, chatRef);
    }
}
Object.assign(TaskService.prototype, taskServiceExecutionMethods);
Object.assign(TaskService.prototype, taskApprovalCoordinatorMethods);
Object.assign(TaskService.prototype, taskXiaodTranscriptRevisionMethods);
Object.assign(TaskService.prototype, maturityQueuedChildRecoveryMethods);
