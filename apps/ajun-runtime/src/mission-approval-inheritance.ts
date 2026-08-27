import { ValidationError } from './task-validation-error.ts';
export class MissionApprovalInheritance {
    executeTask: any;
    registry: any;
    store: any;
    taskDefinitions: any;
    constructor({ store, registry, taskDefinitions, executeTask }: any = {}) {
        this.store = store;
        this.registry = registry;
        this.taskDefinitions = taskDefinitions;
        this.executeTask = executeTask;
    }
    async resumeChild(taskId: any): Promise<any> {
        const tasks: any = await this.store.list();
        const child: any = tasks.find((task: any): any => task.taskId === taskId);
        if (!child)
            throw new ValidationError('找不到多人协作中的子工作。');
        if (child.status !== 'waiting_approval')
            return child;
        const context: any = child.input?.context || {};
        const parent: any = tasks.find((task: any): any => task.taskId === child.parentTaskId);
        const approvals: any = await this.store.listApprovals();
        const parentApproval: any = approvals.find((approval: any): any => approval.approvalId === context.parentApprovalId
            && parent?.approvalRefs?.includes(approval.approvalId)
            && approval.taskId === parent?.taskId
            && approval.status === 'approved'
            && approval.action === 'manual-risk-review'
            && (approval.governanceMode === 'paperclip' || approval.governanceMode === 'local')
            && approval.requestedScope?.taskType === parent?.taskType);
        const agent: any = (await this.registry.list()).find((item: any): any => item.agentId === child.assigneeAgentId) || null;
        const acceptedByAssignedAgent: any = agent?.status === 'active'
            && Array.isArray(agent.acceptedTaskTypes)
            && agent.acceptedTaskTypes.includes(child.taskType);
        const safelyInheritable: any = this.taskDefinitions?.allowsApprovalInheritance?.(child.taskType) === true;
        const trustedParent: any = parent?.taskType === 'army.cross-agent-mission'
            && ['running', 'succeeded'].includes(parent.status)
            && (context.missionSafeOnly === true || parentApproval?.governanceMode === 'local' || parentApproval?.governanceMode === 'paperclip')
            && context.missionTaskId === parent.taskId
            && (!context.parentPaperclipIssueId || context.parentPaperclipIssueId === parent.governance?.paperclipIssueId);
        if (!parentApproval || !acceptedByAssignedAgent || !safelyInheritable || !trustedParent) {
            throw new ValidationError('这项子工作没有可继承的组织级批准，未继续执行。');
        }
        const decidedAt: any = new Date().toISOString();
        for (const approvalId of child.approvalRefs || []) {
            const approval: any = approvals.find((item: any): any => item.approvalId === approvalId);
            if (approval?.status === 'pending') {
                await this.store.updateApproval(approvalId, {
                    status: 'superseded',
                    decisionBy: 'A君',
                    decisionReason: '父级多人任务已完成组织级确认；这项安全子工作不重复要求确认。',
                    decidedAt,
                });
            }
        }
        const queued: any = await this.store.updateTask(child.taskId, {
            status: 'queued', currentStage: 'parent_scope_approved', error: undefined,
        });
        return this.executeTask(queued, agent);
    }
}
