const completedTaskStatuses: any = new Set(['succeeded', 'cancelled', 'rejected']);
const attentionTaskStatuses: any = new Set([
    'failed',
    'needs_input',
    'pending_approval',
    'waiting_approval',
    'waiting_test',
    'paused',
    'blocked',
    'error',
]);
export function taskStatusGroup(status: any): any {
    if (completedTaskStatuses.has(status))
        return 'completed';
    if (attentionTaskStatuses.has(status))
        return 'attention';
    return 'active';
}
export function filterTaskRecords(tasks: any, { selectedTaskId = '', statusFilter = 'attention' }: any = {}): any {
    return tasks.filter((task: any): any => selectedTaskId
        ? task.taskId === selectedTaskId
        : statusFilter === 'all' || taskStatusGroup(task.status) === statusFilter);
}
export function selectTaskRecordFilter(selectedTaskId: any, nextFilter: any): any {
    return {
        selectedTaskId: '',
        currentTaskFilter: nextFilter,
        exitedTaskDetail: Boolean(selectedTaskId),
    };
}
