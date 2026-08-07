import { presentTask } from './task-presentation.js';

export class TaskRecordService {
  constructor({ store, taskDetailBaseUrl = '' }) {
    this.store = store;
    this.taskDetailBaseUrl = taskDetailBaseUrl;
  }

  async list(query = {}) {
    const [page, approvals] = await Promise.all([
      this.store.queryTasks(query),
      this.store.listApprovals(),
    ]);
    return {
      ...page,
      items:page.items.map((task) => presentRecordSummary(task, approvals, this.taskDetailBaseUrl)),
    };
  }

  async detail(taskId) {
    const [task, approvals] = await Promise.all([
      this.store.getTask(taskId),
      this.store.listApprovals(),
    ]);
    return task ? presentRecord(task, approvals, this.taskDetailBaseUrl) : null;
  }
}

function presentRecordSummary(task, approvals, detailBaseUrl) {
  return {
    taskId:task.taskId,
    status:task.status,
    taskType:task.taskType,
    assigneeAgentId:task.assigneeAgentId,
    input:{ title:task.input?.title || '' },
    createdAt:task.createdAt,
    updatedAt:task.updatedAt,
    currentStage:task.currentStage || '',
    recordView:task.recordView,
    recordSummary:true,
    presentation:presentTask(task, { approvals, detailBaseUrl }),
  };
}

function presentRecord(task, approvals, detailBaseUrl) {
  const pendingApproval = approvals.find((approval) =>
    approval?.status === 'pending' && (task.approvalRefs || []).includes(approval.approvalId)
  );
  return {
    ...task,
    presentation:presentTask(task, { approvals, detailBaseUrl }),
    pendingApproval:pendingApproval ? {
      approvalId:pendingApproval.approvalId,
      reason:pendingApproval.reason || '',
      requestedScope:pendingApproval.requestedScope || null,
    } : null,
  };
}
