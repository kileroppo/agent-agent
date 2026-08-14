import {
  isPaperclipCompletionTaskStatus,
  paperclipIssueStatusForTaskStatus,
} from './task-status-policy.ts';

export class PaperclipAssignmentCompletion {
  constructor({
    store,
    governance,
    now = () => new Date().toISOString(),
    confirmTask = null,
  } = {}) {
    this.store = store;
    this.governance = governance;
    this.now = now;
    this.confirmTask = typeof confirmTask === 'function' ? confirmTask : null;
  }

  sync({ status, taskStatus, issueId, runId, now = this.now() }) {
    return paperclipCompletionSync({
      status,
      taskStatus,
      issueId,
      runId,
      now,
    });
  }

  confirmed(task, assignment) {
    return paperclipCompletionConfirmed(task, assignment);
  }

  pending(task) {
    return pendingPaperclipCompletion(task);
  }

  async ensure(task, assignment, { paperclipAgentId, apiKey } = {}) {
    if (!isPaperclipCompletableTaskStatus(task?.status)) return task;
    if (this.confirmed(task, assignment)) return task;
    const expected = paperclipIssueStatusForTask(task.status);
    if (await this.#hasExpectedIssueStatus(assignment.issueId, expected)) {
      return this.#confirmThroughSeam(task, assignment);
    }
    await this.governance.completePaperclipIssue(assignment.issueId, {
      runId:assignment.runId,
      agentId:paperclipAgentId,
      apiKey,
      result:task,
    });
    return this.#confirmThroughSeam(task, assignment);
  }

  async reconcilePending(task) {
    const pending = this.pending(task);
    if (!pending) return task;
    if (!(await this.#hasExpectedIssueStatus(pending.issueId, pending.expectedIssueStatus))) {
      return task;
    }
    return this.#confirmThroughSeam(task, pending);
  }

  async confirm(task, assignment) {
    const confirmedAt = this.now();
    return this.store.updateTask(task.taskId, {
      governance:{
        ...(task.governance || {}),
        status:'synced',
        syncedAt:confirmedAt,
        completionSync:this.sync({
          status:'confirmed',
          taskStatus:task.status,
          issueId:assignment.issueId,
          runId:assignment.runId,
          now:confirmedAt,
        }),
      },
    });
  }

  async #hasExpectedIssueStatus(issueId, expectedStatus) {
    if (typeof this.governance?.getPaperclipIssue !== 'function') return false;
    try {
      const issue = await this.governance.getPaperclipIssue(issueId);
      return String(issue?.status || '').trim() === expectedStatus;
    } catch {
      return false;
    }
  }

  #confirmThroughSeam(task, assignment) {
    return this.confirmTask
      ? this.confirmTask(task, assignment)
      : this.confirm(task, assignment);
  }
}

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
