import {
  isPaperclipCompletionTaskStatus,
  paperclipIssueStatusForTaskStatus,
} from './task-status-policy.js';

export function isPaperclipCompletableTaskStatus(status) {
  return isPaperclipCompletionTaskStatus(status);
}

export function paperclipIssueStatusForTask(taskStatus) {
  return paperclipIssueStatusForTaskStatus(taskStatus);
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
