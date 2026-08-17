import { recoveryRelatedTasks, taskById, view } from './task-recovery-policy.ts';

export async function loadTaskRecoveryView({ store, taskOrId, options = {}, errorFactory }: any): Promise<any> {
    const task: any = typeof taskOrId === 'string' ? await taskById(store, taskOrId) : taskOrId;
    if (!task)
        throw errorFactory('找不到要处理的任务。', 'task_recovery_not_found', 404);
    const [relatedTasks, approvals] = await Promise.all([
        options.relatedTasks || recoveryRelatedTasks(store, task),
        options.approvals || (typeof store.listApprovals === 'function' ? store.listApprovals() : []),
    ]);
    return view(task, { ...options, relatedTasks, approvals });
}
