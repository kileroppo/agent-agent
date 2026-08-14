import { ValidationError } from './task-validation-error.ts';
const XIAOD_TERMINAL_OR_REVIEW_STATUSES: any = new Set(['completed', 'failed', 'cancelled', 'awaiting_review', 'awaiting_delivery']);
export class XiaodTaskControl {
    service: any;
    constructor(service: any) {
        this.service = service;
    }
    request(taskId: any, action: any): any {
        const key: any = `${String(taskId || '').trim()}:${String(action || '').trim()}`;
        const running: any = this.service.taskControlRuns.get(key);
        if (running)
            return running;
        const execution: any = Promise.resolve().then((): any => this.#requestOnce(taskId, action)).finally((): any => {
            if (this.service.taskControlRuns.get(key) === execution)
                this.service.taskControlRuns.delete(key);
        });
        this.service.taskControlRuns.set(key, execution);
        return execution;
    }
    async resolve(task: any, approval: any, { decision, approvalPatch, alreadyCommitted = false, }: any = {}): Promise<any> {
        if (decision !== 'approve') {
            const taskPatch: any = (current: any): any => ({
                execution: {
                    ...(current.execution || {}),
                    control: {
                        ...(current.execution?.control || {}),
                        action: approval.action,
                        status: 'rejected',
                        approvalId: approval.approvalId,
                        decidedAt: new Date().toISOString(),
                    },
                },
            });
            return alreadyCommitted
                ? this.service.store.updateTask(task.taskId, taskPatch(task))
                : (await this.service.store.resolveApprovalAndUpdateTask(approval.approvalId, approvalPatch, task.taskId, taskPatch)).task;
        }
        const executor: any = this.service.executors.xiaod;
        const method: any = approval.action === 'pause-task' ? 'pause' : 'resume';
        if (typeof executor?.[method] !== 'function') {
            throw new ValidationError('小D当前不支持这项控制，未改变任务状态。');
        }
        if (!alreadyCommitted) {
            approval = await this.service.store.updateApproval(approval.approvalId, {
                localEffect: {
                    ...(approval.localEffect || {}),
                    action: approval.action,
                    state: 'resolving',
                    requestedAt: approval.localEffect?.requestedAt || new Date().toISOString(),
                },
            });
        }
        const { job, outcome } = await ensureControlEffect(this.service, task, approval, executor, method);
        const decidedAt: any = new Date().toISOString();
        const status: any = approval.action === 'pause-task'
            ? (job.status === 'paused' ? 'paused' : 'pausing')
            : 'running';
        const taskPatch: any = (current: any): any => ({
            status,
            currentStage: approval.action === 'pause-task' ? `xiaod_${job.status || 'pausing'}` : 'xiaod_resumed',
            error: undefined,
            execution: {
                ...(current.execution || {}),
                xiaodStatus: job.status,
                xiaodProgress: job.progress,
                control: {
                    action: approval.action,
                    status: outcome === 'obsolete' ? 'superseded' : 'accepted',
                    approvalId: approval.approvalId,
                    decidedAt,
                },
                polling: {
                    state: status === 'paused' ? 'settled' : 'pending',
                    consecutiveFailures: 0,
                    nextPollAt: status === 'paused' ? null : decidedAt,
                },
            },
        });
        let updated: any;
        if (alreadyCommitted)
            updated = await this.service.store.updateTask(task.taskId, taskPatch(task));
        else {
            updated = (await this.service.store.resolveApprovalAndUpdateTask(approval.approvalId, {
                ...approvalPatch,
                localEffect: {
                    ...(approval.localEffect || {}),
                    state: 'confirmed',
                    confirmedAt: decidedAt,
                    xiaodStatus: job.status,
                    outcome,
                },
            }, task.taskId, taskPatch)).task;
        }
        if (updated.governance?.paperclipIssueId) {
            updated = await this.service.store.updateTask(updated.taskId, {
                governance: await this.service.governance.update(updated),
            });
        }
        if (approval.action === 'resume-task' && outcome !== 'obsolete' && typeof executor.observe === 'function') {
            executor.observe(updated);
        }
        return updated;
    }
    async #requestOnce(taskId: any, action: any): Promise<any> {
        const task: any = (await this.service.store.list()).find((item: any): any => item.taskId === taskId);
        if (!task)
            throw new ValidationError('找不到要控制的任务。');
        const isPause: any = action === 'pause-task';
        if (!['pause-task', 'resume-task'].includes(action))
            throw new ValidationError('不支持这项任务控制。');
        if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) {
            throw new ValidationError('目前只能控制正在由小D处理的任务。');
        }
        if (isPause ? !['queued', 'running', 'pausing'].includes(task.status) : task.status !== 'paused') {
            throw new ValidationError(isPause ? '这条任务当前不能暂停。' : '只有已经暂停的任务可以继续。');
        }
        const existing: any = (await this.service.store.listApprovals()).find((item: any): any => item.taskId === task.taskId && item.action === action && item.status === 'pending');
        if (existing)
            return { task, approval: existing, duplicate: true };
        const approval: any = await this.service.store.createApproval({
            taskId: task.taskId,
            holdTask: false,
            governanceMode: 'paperclip',
            decisionChannel: 'feishu_card',
            action,
            riskLevel: 'high',
            reason: isPause ? '暂停会改变一项正在执行的工作。' : '继续会恢复一项已暂停的工作。',
            requestedBy: 'A君',
            approverScope: 'A君',
            requestedScope: {
                taskType: task.taskType,
                title: task.input?.title || '',
                assigneeAgentId: task.assigneeAgentId || null,
            },
            validUntil: new Date(Date.now() + 86400000).toISOString(),
        });
        if (!this.service.governance?.project)
            throw new ValidationError('Paperclip 暂不可用，不能绕过组织级确认。');
        const projection: any = await this.service.governance.project(task, approval);
        const updated: any = await this.service.store.updateTask(task.taskId, {
            governance: projection,
            execution: {
                ...(task.execution || {}),
                control: {
                    action,
                    status: 'waiting_approval',
                    approvalId: approval.approvalId,
                    requestedAt: new Date().toISOString(),
                },
            },
        });
        return { task: updated, approval, duplicate: false };
    }
}
async function ensureControlEffect(service: any, task: any, approval: any, executor: any, method: any): Promise<any> {
    if (typeof executor.getJob === 'function') {
        const observed: any = await executor.getJob(task.execution?.xiaodJobId);
        const recovered: any = xiaodControlOutcome(approval.action, observed);
        if (recovered)
            return { job: observed, outcome: recovered };
    }
    try {
        const job: any = await executor[method](task);
        const outcome: any = xiaodControlOutcome(approval.action, job);
        if (!outcome)
            throw new ValidationError('小D未确认任务控制结果。');
        return { job, outcome };
    }
    catch (error: any) {
        if (typeof executor.getJob !== 'function')
            throw error;
        const recovered: any = await executor.getJob(task.execution?.xiaodJobId);
        const outcome: any = xiaodControlOutcome(approval.action, recovered);
        if (!outcome)
            throw error;
        return { job: recovered, outcome };
    }
}
function xiaodControlOutcome(action: any, job: any): any {
    const status: any = String(job?.status || '');
    if (!status)
        return null;
    if (XIAOD_TERMINAL_OR_REVIEW_STATUSES.has(status))
        return 'obsolete';
    return action === 'pause-task'
        ? (['pausing', 'paused'].includes(status) ? 'applied' : null)
        : (status === 'paused' ? null : 'applied');
}
