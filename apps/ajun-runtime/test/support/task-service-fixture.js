import { TaskService } from '../../src/task-service.js';

export function setupTaskService({
  agents = [],
  governance = null,
  onTaskFailed = null,
  agentChannelStates = null,
  contentGrowthWaitMs = undefined,
  employeeAssignmentWaitMs = undefined,
  m5ProviderVision = null,
  m5WorkProductValidator = async () => true,
  skillExecutionRegistry = undefined,
  executors = {},
  roleToolAdapters = {},
  officePresentationWorkspaceRoot = null,
  localAiCapabilityStatus = null,
  taskRunEvents = null,
} = {}) {
  const records = { tasks:[], approvals:[] };
  const store = createTaskStore(records);
  const testGovernance = governance ? { async assertCaseIssueLink() {}, ...governance } : governance;
  const registry = {
    async list() { return agents; },
    async get(agentId) { return agents.find((agent) => agent.agentId === agentId) || null; },
    async candidates(type) { return agents.filter((agent) => agent.acceptedTaskTypes.includes(type)); },
  };
  const service = new TaskService({
    registry,
    store,
    governance:testGovernance,
    executors,
    roleToolAdapters,
    officePresentationWorkspaceRoot,
    onTaskFailed,
    agentChannelStates,
    contentGrowthWaitMs,
    employeeAssignmentWaitMs,
    m5ProviderVision,
    m5WorkProductValidator,
    localAiCapabilityStatus,
    taskRunEvents,
    ...(skillExecutionRegistry ? { skillExecutionRegistry } : {}),
  });
  return { records, registry, service, store };
}

export const coordinator = {
  agentId:'ajun',
  name:'A君',
  status:'active',
  acceptedTaskTypes:['army.intake', 'army.route-task', 'army.cross-agent-mission'],
};

export function verifiedArtifact(task, type, data = {}, extra = {}) {
  return {
    taskId:task.taskId,
    type,
    location:extra.location || `runtime://${task.taskId}/${type}`,
    validation:{ exists:true, readable:true, nonEmpty:true, ...(extra.validation || {}) },
    data,
  };
}

export function verifiedHealthReport(task) {
  return verifiedArtifact(task, 'health_report', {
    overall:'healthy',
    components:[{ id:'ajun-runtime', name:'A君运行台', status:'healthy' }],
  });
}

export function verifiedIntakeRecord(task, data = {}) {
  return verifiedArtifact(task, 'task_intake_record', data);
}

function createTaskStore(records) {
  return {
    async createTask(task) { return (await this.createTaskOnce(task)).task; },
    async createTaskOnce(task) {
      const existing = task.idempotencyKey
        ? records.tasks.find((item) => item.idempotencyKey === task.idempotencyKey)
        : null;
      if (existing) {
        if (existing.idempotencyFingerprint && task.idempotencyFingerprint
          && existing.idempotencyFingerprint !== task.idempotencyFingerprint) {
          const error = new Error('同一幂等键不能绑定不同的任务内容。');
          error.code = 'task_idempotency_conflict';
          throw error;
        }
        return { task:existing, created:false };
      }
      const record = { taskId:`task-${records.tasks.length + 1}`, approvalRefs:[], ...task };
      records.tasks.push(record);
      return { task:record, created:true };
    },
    async createApproval(approval) {
      const record = { approvalId:`approval-${records.approvals.length + 1}`, status:'pending', ...approval };
      records.approvals.push(record);
      const task = records.tasks.find((item) => item.taskId === approval.taskId);
      task.approvalRefs.push(record.approvalId);
      if (approval.holdTask !== false) {
        task.status = 'waiting_approval';
        task.currentStage = 'approval_required';
      }
      return record;
    },
    async updateApproval(approvalId, patch) {
      const approval = records.approvals.find((item) => item.approvalId === approvalId);
      Object.assign(approval, patch);
      return approval;
    },
    async updateTask(taskId, patch) {
      const task = records.tasks.find((item) => item.taskId === taskId);
      Object.assign(task, patch);
      return task;
    },
    async resolveApprovalAndUpdateTask(approvalId, approvalPatch, taskId, taskPatch) {
      const approval = records.approvals.find((item) => item.approvalId === approvalId);
      const task = records.tasks.find((item) => item.taskId === taskId);
      Object.assign(approval, approvalPatch);
      Object.assign(task, typeof taskPatch === 'function' ? taskPatch(task, approval) : taskPatch);
      return { approval, task };
    },
    async claimTaskExecution(taskId, patch) {
      const task = records.tasks.find((item) => item.taskId === taskId);
      if (task.status !== 'queued') return { task, claimed:false };
      Object.assign(task, patch, { status:'running' });
      return { task, claimed:true };
    },
    async list() { return records.tasks; },
    async listApprovals() { return records.approvals; },
  };
}
