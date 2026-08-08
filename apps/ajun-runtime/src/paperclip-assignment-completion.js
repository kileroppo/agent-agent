const COMPLETABLE_TASK_STATUSES = new Set(['succeeded', 'failed', 'waiting_test']);

export function isPaperclipCompletableTaskStatus(status) {
  return COMPLETABLE_TASK_STATUSES.has(String(status || ''));
}

export function paperclipIssueStatusForTask(taskStatus) {
  return taskStatus === 'succeeded' ? 'done' : 'blocked';
}

export function paperclipCompletionSync({ status, taskStatus, issueId, runId, now }) {
  return {
    status,
    paperclipIssueId:String(issueId || ''),
    paperclipRunId:String(runId || ''),
    taskStatus:String(taskStatus || ''),
    expectedIssueStatus:paperclipIssueStatusForTask(taskStatus),
    ...(status === 'confirmed' ? { confirmedAt:String(now || '') } : { requestedAt:String(now || '') }),
  };
}

export function paperclipCompletionConfirmed(task, assignment) {
  const sync = task?.governance?.completionSync;
  return sync?.status === 'confirmed'
    && sync.paperclipIssueId === assignment?.issueId
    && sync.paperclipRunId === assignment?.runId
    && sync.taskStatus === task.status
    && sync.expectedIssueStatus === paperclipIssueStatusForTask(task.status);
}

export function pendingPaperclipCompletion(task) {
  const sync = task?.governance?.completionSync;
  if (
    sync?.status !== 'pending'
    || !isPaperclipCompletableTaskStatus(task?.status)
    || sync.taskStatus !== task.status
    || sync.expectedIssueStatus !== paperclipIssueStatusForTask(task.status)
    || !sync.paperclipIssueId
    || !sync.paperclipRunId
  ) return null;
  return {
    issueId:sync.paperclipIssueId,
    runId:sync.paperclipRunId,
    expectedIssueStatus:sync.expectedIssueStatus,
  };
}
