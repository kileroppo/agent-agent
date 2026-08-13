import { buildArchitectureGroundTruth } from './architecture-evidence.js';
import { SkillExecutionRegistry } from './skill-execution-registry.js';
import { TaskCapabilityCatalog } from './task-capability-catalog.ts';
import { TaskExecutionCoordinator } from './task-execution-coordinator.ts';
import { TaskFailureRecoveryCoordinator } from './task-failure-recovery-coordinator.js';
import { TaskIntake } from './task-intake.js';
import { TaskNotification } from './task-notification.js';
import { TaskRecordService } from './task-record-service.js';
import { TaskRecovery } from './task-recovery.js';
import { OfficePresentationExecution } from './office-presentation-execution.js';
import { taskServiceExecutionMethods } from './task-service-execution.js';
export { ValidationError } from './task-validation-error.js';
import { taskApprovalCoordinatorMethods } from './task-approval-coordinator.js';
import { TaskOverview } from './task-overview.js';
import { taskXiaodTranscriptRevisionMethods } from './task-xiaod-transcript-revision.js';
import { TaskLifecycleEventRecorder } from './task-lifecycle-event-recorder.js';
import { DeliveryQualityRuntime, prepareDeliveryQualityResult } from './workflow/delivery-quality-runtime.ts';
import { TaskLocalAiRunEventRecorder } from './task-local-ai-run-event-recorder.js';
import { TaskIntakeContinuation } from './task-intake-continuation.js';
import { TaskApprovalLifecycle } from './task-approval-lifecycle.js';
import { MissionApprovalInheritance } from './mission-approval-inheritance.js';
import { TaskFeedback } from './task-feedback.js';
import { maturityQueuedChildRecoveryMethods } from './maturity-queued-child-recovery.ts';

export class TaskService {
  constructor({
    registry,
    store,
    governance = null,
    executors = {},
    fallbackExecutor = null,
    onTaskFailed = null,
    feishuChannelStatus = null,
    agentChannelStates = null,
    workerStatus = null,
    contentGrowthWaitMs = 240_000,
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
  }) {
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
    this.taskLifecycleEvents = new TaskLifecycleEventRecorder({ eventStore:taskRunEvents });
    this.localAiRunEvents = new TaskLocalAiRunEventRecorder({
      eventStore:taskRunEvents,
      registry,
      resolveAssignment:(input) => this.getPaperclipAssignment(input),
    });
    this.contentGrowthWaitMs = Math.max(1, Math.min(Number(contentGrowthWaitMs) || 240_000, 240_000));
    this.employeeAssignmentWaitMs = Math.max(0, Math.min(Number(employeeAssignmentWaitMs) || 0, 240_000));
    this.contentGrowthRuns = new Map();
    this.employeeAssignmentRuns = new Map();
    this.approvalResolutionRuns = new Map();
    this.taskControlRuns = new Map();
    this.xiaodDeliveryRequestRuns = new Map();
    this.xiaodDeliveryRuns = new Map();
    this.xiaodTranscriptRevisionRuns = new Map();
    this.paperclipAssignmentCompletionRuns = new Map();
    this.m5WorkProductObserver = null;
    this.failureRecovery = new TaskFailureRecoveryCoordinator({ store, recover:onTaskFailed });
    this.taskRecovery = new TaskRecovery({
      store,
      recover:typeof onTaskFailed === 'function' ? (task, input) => onTaskFailed(task, input) : null,
      createTask:(input) => this.create(input),
      capabilityStatus:this.localAiCapabilityStatus,
    });
    this.executionCoordinator = new TaskExecutionCoordinator({
      store,
      governance,
      capabilityCatalog,
      executorResolver:(agentId) => capabilityCatalog.executor(agentId, this.executors),
      fallbackExecutor,
      fallbackExecutorResolver:() => this.fallbackExecutor,
      markFailureRecoveryPending:(task) => this.failureRecovery.markPending(task),
      startFailureRecovery:(task) => this.failureRecovery.start(task),
      prepareCompletion:prepareDeliveryQualityResult,
    });
    this.officePresentationExecution = new OfficePresentationExecution({
      workspaceRoot:officePresentationWorkspaceRoot,
      store,
      governance,
      capabilityCatalog,
      executorResolver:(agentId) => capabilityCatalog.executor(agentId, this.executors),
      roleToolAdapters,
      prepareCompletion:prepareDeliveryQualityResult,
    });
    this.intake = new TaskIntake({
      registry,
      store,
      governance,
      execute:(task, agent) => this.executeTask(task, agent),
    });
    this.notification = new TaskNotification({ store, registry, executors });
    this.taskRecords = new TaskRecordService({ store, taskDetailBaseUrl, taskRecovery:this.taskRecovery });
    this.taskOverview = new TaskOverview({
      registry,
      store,
      governance,
      executors,
      capabilityCatalog,
      skillExecutionRegistry,
      localAiCapabilityStatus:this.localAiCapabilityStatus,
      usageLedger,
      taskDetailBaseUrl,
      getFeishuChannelStatus:() => this.feishuChannelStatus,
      getAgentChannelStates:() => this.agentChannelStates,
      getWorkerStatus:() => this.workerStatus,
    });
    this.deliveryQuality = new DeliveryQualityRuntime({
      store,
      createTask:(input) => this.create(input),
      taskRunEvents,
      syncTask:async (task) => this.store.updateTask(task.taskId, { governance:await this.governance.update(task) }),
    });
    this.intakeContinuation = new TaskIntakeContinuation({
      store,
      createTask:(input) => this.create(input),
    });
    this.approvalLifecycle = new TaskApprovalLifecycle({ store, governance });
    this.missionApprovalInheritance = new MissionApprovalInheritance({
      store,
      registry,
      taskDefinitions:capabilityCatalog.registry,
      executeTask:(task, agent) => this.executeTask(task, agent),
    });
    this.taskFeedback = new TaskFeedback({ store });
  }

  setFeishuChannelStatus(status) { this.feishuChannelStatus = status; }
  setAgentChannelStates(status) { this.agentChannelStates = status; }
  setWorkerStatus(status) { this.workerStatus = status; }
  setM5WorkProductObserver(observer) { this.m5WorkProductObserver = observer; }

  recordPaperclipLocalAiRunEvent(input = {}) { return this.localAiRunEvents.record(input); }

  async architectureGroundTruth() {
    return buildArchitectureGroundTruth({
      agents:await this.registry.list({ includeInactive:true }),
      tasks:await this.store.list()
    });
  }

  async create(input) {
    const startedAt = new Date().toISOString();
    let task = await this.intake.create(input);
    task = await this.deliveryQuality.continue(task);
    this.taskLifecycleEvents.recordCreated(task, startedAt);
    return task;
  }

  async continueFromRecommendation(taskId) {
    return this.intakeContinuation.continue(taskId);
  }

  async revokePrivateReadGrant(approvalId, { revokedBy = 'A君', chatRef = '' } = {}) {
    return this.approvalLifecycle.revokePrivateReadGrant(approvalId, { revokedBy, chatRef });
  }

  async requestPause(taskId) { return this.requestTaskControl(taskId, 'pause-task'); }
  async requestResume(taskId) { return this.requestTaskControl(taskId, 'resume-task'); }

  async expirePendingApprovals({ now = Date.now() } = {}) {
    return this.approvalLifecycle.expirePending({ now });
  }

  async expireApproval(approvalId, { now = Date.now() } = {}) {
    return this.approvalLifecycle.expire(approvalId, { now });
  }

  async resumeApprovedMissionChild(taskId) {
    return this.missionApprovalInheritance.resumeChild(taskId);
  }

  async executeTask(task, agent) {
    if (this.officePresentationExecution.supports(task, agent)) {
      return this.officePresentationExecution.execute(task, agent);
    }
    return this.executionCoordinator.execute(task, agent);
  }

  async recordFeedback(taskId, { sentiment, note = '' } = {}) {
    return this.taskFeedback.record(taskId, { sentiment, note });
  }

  async overview({ includeTasks = true } = {}) {
    return this.taskOverview.read({ includeTasks });
  }

  async consoleOverview() { return this.overview({ includeTasks:false }); }

  async listTaskRecords(query = {}, { audience = 'lan' } = {}) { return this.taskRecords.list(query, { audience }); }

  async taskRecordDetail(taskId, { audience = 'lan' } = {}) { return this.taskRecords.detail(taskId, { audience }); }

  async recoveryView(taskOrId, options = {}) { return this.taskRecovery.view(taskOrId, options); }

  async requestRecovery(taskId, input, actor = {}) { return this.taskRecovery.request(taskId, input, actor); }

  async usageOverview() {
    return this.taskOverview.usage();
  }

  async notificationStatus(taskId, chatRef = '') {
    return this.notification.status(taskId, chatRef);
  }
}


Object.assign(TaskService.prototype, taskServiceExecutionMethods);
Object.assign(TaskService.prototype, taskApprovalCoordinatorMethods);
Object.assign(TaskService.prototype, taskXiaodTranscriptRevisionMethods);
Object.assign(TaskService.prototype, maturityQueuedChildRecoveryMethods);
