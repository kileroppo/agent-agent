import { isPaperclipCompletionTaskStatus, isTaskExecutionClosedStatus, paperclipIssueStatusForTaskStatus, } from './task-status-policy.ts';
export class PaperclipAssignmentCompletion {
    confirmTask: any;
    governance: any;
    now: any;
    store: any;
    constructor({ store, governance, now = (): any => new Date().toISOString(), confirmTask = null, }: any = {}) {
        this.store = store;
        this.governance = governance;
        this.now = now;
        this.confirmTask = typeof confirmTask === 'function' ? confirmTask : null;
    }
    sync({ status, taskStatus, issueId, runId, now = this.now() }: any): any {
        return paperclipCompletionSync({
            status,
            taskStatus,
            issueId,
            runId,
            now,
        });
    }
    confirmed(task: any, assignment: any): any {
        return paperclipCompletionConfirmed(task, assignment);
    }
    pending(task: any): any {
        return pendingPaperclipCompletion(task);
    }
    async ensure(task: any, assignment: any, { paperclipAgentId, apiKey }: any = {}): Promise<any> {
        if (!isPaperclipProjectionSyncTaskStatus(task?.status))
            return task;
        if (this.confirmed(task, assignment))
            return task;
        const expected: any = paperclipIssueStatusForTask(task.status);
        if (await this.#hasExpectedIssueStatus(assignment.issueId, expected)) {
            return this.#confirmThroughSeam(task, assignment);
        }
        await this.governance.completePaperclipIssue(assignment.issueId, {
            runId: assignment.runId,
            agentId: paperclipAgentId,
            apiKey,
            result: task,
        });
        return this.#confirmThroughSeam(task, assignment);
    }
    async reconcilePending(task: any): Promise<any> {
        const pending: any = this.pending(task);
        if (!pending)
            return task;
        if (!(await this.#hasExpectedIssueStatus(pending.issueId, pending.expectedIssueStatus))) {
            return task;
        }
        return this.#confirmThroughSeam(task, pending);
    }
    async confirm(task: any, assignment: any): Promise<any> {
        const confirmedAt: any = this.now();
        return this.store.updateTask(task.taskId, {
            governance: {
                ...(task.governance || {}),
                status: 'synced',
                syncedAt: confirmedAt,
                completionSync: this.sync({
                    status: 'confirmed',
                    taskStatus: task.status,
                    issueId: assignment.issueId,
                    runId: assignment.runId,
                    now: confirmedAt,
                }),
            },
        });
    }
    async #hasExpectedIssueStatus(issueId: any, expectedStatus: any): Promise<any> {
        if (typeof this.governance?.getPaperclipIssue !== 'function')
            return false;
        try {
            const issue: any = await this.governance.getPaperclipIssue(issueId);
            return String(issue?.status || '').trim() === expectedStatus;
        }
        catch {
            return false;
        }
    }
    #confirmThroughSeam(task: any, assignment: any): any {
        return this.confirmTask
            ? this.confirmTask(task, assignment)
            : this.confirm(task, assignment);
    }
}
export function isPaperclipCompletableTaskStatus(status: any): any {
    return isPaperclipCompletionTaskStatus(status);
}
export function isPaperclipProjectionSyncTaskStatus(status: any): any {
    return isTaskExecutionClosedStatus(status);
}
export function paperclipIssueStatusForTask(taskStatus: any): any {
    return paperclipIssueStatusForTaskStatus(taskStatus);
}
export function paperclipCompletionSync({ status, taskStatus, issueId, runId, now }: any): any {
    return {
        status,
        paperclipIssueId: String(issueId || ''),
        paperclipRunId: String(runId || ''),
        taskStatus: String(taskStatus || ''),
        expectedIssueStatus: paperclipIssueStatusForTask(taskStatus),
        ...(status === 'confirmed' ? { confirmedAt: String(now || '') } : { requestedAt: String(now || '') }),
    };
}
export function paperclipCompletionConfirmed(task: any, assignment: any): any {
    const sync: any = task?.governance?.completionSync;
    return sync?.status === 'confirmed'
        && sync.paperclipIssueId === assignment?.issueId
        && sync.paperclipRunId === assignment?.runId
        && sync.taskStatus === task.status
        && sync.expectedIssueStatus === paperclipIssueStatusForTask(task.status);
}
export function pendingPaperclipCompletion(task: any): any {
    const sync: any = task?.governance?.completionSync;
    if (sync?.status !== 'pending'
        || !isPaperclipProjectionSyncTaskStatus(task?.status)
        || sync.taskStatus !== task.status
        || sync.expectedIssueStatus !== paperclipIssueStatusForTask(task.status)
        || !sync.paperclipIssueId
        || !sync.paperclipRunId)
        return null;
    return {
        issueId: sync.paperclipIssueId,
        runId: sync.paperclipRunId,
        expectedIssueStatus: sync.expectedIssueStatus,
    };
}
