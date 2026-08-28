import { buildArchitectureGroundTruth } from './architecture-evidence.ts';
import { taskServiceExecutionMethods } from './task-service-execution.ts';
export { ValidationError } from './task-validation-error.ts';
import { taskApprovalCoordinatorMethods } from './task-approval-coordinator.ts';
import { taskXiaodTranscriptRevisionMethods } from './task-xiaod-transcript-revision.ts';
import { maturityQueuedChildRecoveryMethods } from './maturity-queued-child-recovery.ts';
import { approvedMissionResumeEligible } from './task-recovery-policy.ts';
import { ValidationError } from './task-validation-error.ts';
import { composeTaskService } from './task-service-composition.ts';
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
    workflowAcceptance: any;
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
    constructor(input: any) {
        Object.assign(this, composeTaskService(this, input));
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
    async recordWorkflowAcceptance(workflowId: any, input: any = {}): Promise<any> {
        return this.workflowAcceptance.record(workflowId, input);
    }
    async overview({ includeTasks = true }: any = {}): Promise<any> {
        return this.taskOverview.read({ includeTasks });
    }
    async consoleOverview(): Promise<any> { return this.taskOverview.readConsole(); }
    async healthOverview(options: any = {}): Promise<any> { return this.taskOverview.health(options); }
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
    async provideTaskInput(taskId: any, inputPayload: any = {}): Promise<any> {
        let task: any = await this.store.getTask(taskId);
        if (!task)
            throw new ValidationError('找不到要补充信息的任务。');
        const text: string = String(inputPayload?.input || inputPayload?.sourceUrl || inputPayload?.content || '').trim();
        if (!text)
            throw new ValidationError('请输入有效的补充内容或素材链接。');
        const isUrl: boolean = /^https?:\/\//i.test(text);
        const updatedInput: any = {
            ...(task.input || {}),
            ...(isUrl ? { sourceUrl: text } : {}),
            focus: task.input?.focus ? `${task.input.focus} (补充: ${text})` : text,
            description: task.input?.description ? `${task.input.description}\n补充信息: ${text}` : text,
        };
        task = await this.store.updateTask(taskId, {
            status: 'queued',
            currentStage: 'queued',
            error: null,
            input: updatedInput,
            routing: { ...(task.routing || {}), reason: '本机主人已在控制台补充信息并接续任务。' },
        });
        const agent: any = typeof this.registry.get === 'function'
            ? await this.registry.get(task.assigneeAgentId)
            : (await this.registry.list({ includeManagers: true })).find((item: any): any => item.agentId === task.assigneeAgentId);
        if (agent) {
            this.executeTask(task, agent).catch((err: any): void => console.error('Execute task after provideInput error:', err));
        }
        return task;
    }
}
Object.assign(TaskService.prototype, taskServiceExecutionMethods);
Object.assign(TaskService.prototype, taskApprovalCoordinatorMethods);
Object.assign(TaskService.prototype, taskXiaodTranscriptRevisionMethods);
Object.assign(TaskService.prototype, maturityQueuedChildRecoveryMethods);
