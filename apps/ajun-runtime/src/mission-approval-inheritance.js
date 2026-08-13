import { ValidationError } from './task-validation-error.js';

export class MissionApprovalInheritance {
  constructor({ store, registry, taskDefinitions, executeTask } = {}) {
    this.store = store;
    this.registry = registry;
    this.taskDefinitions = taskDefinitions;
    this.executeTask = executeTask;
  }

  async resumeChild(taskId) {
    const tasks = await this.store.list();
    const child = tasks.find((task) => task.taskId === taskId);
    if (!child) throw new ValidationError('找不到多人协作中的子工作。');
    if (child.status !== 'waiting_approval') return child;
    const context = child.input?.context || {};
    const parent = tasks.find((task) => task.taskId === child.parentTaskId);
    const approvals = await this.store.listApprovals();
    const parentApproval = approvals.find((approval) =>
      approval.approvalId === context.parentApprovalId
      && parent?.approvalRefs?.includes(approval.approvalId)
      && approval.taskId === parent?.taskId
      && approval.status === 'approved'
      && approval.action === 'manual-risk-review'
      && approval.governanceMode === 'paperclip'
      && approval.requestedScope?.taskType === parent?.taskType
    );
    const agent = (await this.registry.list()).find((item) => item.agentId === child.assigneeAgentId) || null;
    const acceptedByAssignedAgent = agent?.status === 'active'
      && Array.isArray(agent.acceptedTaskTypes)
      && agent.acceptedTaskTypes.includes(child.taskType);
    const safelyInheritable = this.taskDefinitions?.allowsApprovalInheritance?.(child.taskType) === true;
    const trustedParent = parent?.taskType === 'army.cross-agent-mission'
      && ['running', 'succeeded'].includes(parent.status)
      && context.missionSafeOnly === true
      && context.missionTaskId === parent.taskId
      && context.parentPaperclipIssueId === parent.governance?.paperclipIssueId;
    if (!parentApproval || !acceptedByAssignedAgent || !safelyInheritable || !trustedParent) {
      throw new ValidationError('这项子工作没有可继承的组织级批准，未继续执行。');
    }
    const decidedAt = new Date().toISOString();
    for (const approvalId of child.approvalRefs || []) {
      const approval = approvals.find((item) => item.approvalId === approvalId);
      if (approval?.status === 'pending') {
        await this.store.updateApproval(approvalId, {
          status:'superseded',
          decisionBy:'A君',
          decisionReason:'父级多人任务已完成组织级确认；这项安全子工作不重复要求确认。',
          decidedAt,
        });
      }
    }
    const queued = await this.store.updateTask(child.taskId, {
      status:'queued', currentStage:'parent_scope_approved', error:undefined,
    });
    return this.executeTask(queued, agent);
  }
}
