const completedTaskStatuses = new Set(['succeeded', 'cancelled', 'rejected']);
const attentionTaskStatuses = new Set([
  'failed',
  'needs_input',
  'pending_approval',
  'waiting_approval',
  'waiting_test',
  'paused',
  'blocked',
  'error',
]);

export function taskStatusGroup(status) {
  if (completedTaskStatuses.has(status)) return 'completed';
  if (attentionTaskStatuses.has(status)) return 'attention';
  return 'active';
}

export function filterTaskRecords(tasks, { selectedTaskId = '', statusFilter = 'attention' } = {}) {
  return tasks.filter((task) => selectedTaskId
    ? task.taskId === selectedTaskId
    : statusFilter === 'all' || taskStatusGroup(task.status) === statusFilter);
}

export function selectTaskRecordFilter(selectedTaskId, nextFilter) {
  return {
    selectedTaskId:'',
    currentTaskFilter:nextFilter,
    exitedTaskDetail:Boolean(selectedTaskId),
  };
}
