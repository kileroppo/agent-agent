import { ValidationError } from './task-validation-error.js';

const XIAOD_TERMINAL_OR_REVIEW_STATUSES = new Set(['completed', 'failed', 'cancelled', 'awaiting_review', 'awaiting_delivery']);

export class XiaodTaskControl {
  constructor(service) {
    this.service = service;
  }

  request(taskId, action) {
    const key = `${String(taskId || '').trim()}:${String(action || '').trim()}`;
    const running = this.service.taskControlRuns.get(key);
    if (running) return running;
    const execution = Promise.resolve().then(() => this.#requestOnce(taskId, action)).finally(() => {
      if (this.service.taskControlRuns.get(key) === execution) this.service.taskControlRuns.delete(key);
    });
    this.service.taskControlRuns.set(key, execution);
    return execution;
  }

  async resolve(task, approval, {
    decision,
    approvalPatch,
    alreadyCommitted = false,
  } = {}) {
    if (decision !== 'approve') {
      const taskPatch = (current) => ({
        execution:{
          ...(current.execution || {}),
          control:{
            ...(current.execution?.control || {}),
            action:approval.action,
            status:'rejected',
            approvalId:approval.approvalId,
            decidedAt:new Date().toISOString(),
          },
        },
      });
      return alreadyCommitted
        ? this.service.store.updateTask(task.taskId, taskPatch(task))
        : (await this.service.store.resolveApprovalAndUpdateTask(
          approval.approvalId,
          approvalPatch,
          task.taskId,
          taskPatch,
        )).task;
    }

    const executor = this.service.executors.xiaod;
    const method = approval.action === 'pause-task' ? 'pause' : 'resume';
    if (typeof executor?.[method] !== 'function') {
      throw new ValidationError('小D当前不支持这项控制，未改变任务状态。');
    }
    if (!alreadyCommitted) {
      approval = await this.service.store.updateApproval(approval.approvalId, {
        localEffect:{
          ...(approval.localEffect || {}),
          action:approval.action,
          state:'resolving',
          requestedAt:approval.localEffect?.requestedAt || new Date().toISOString(),
        },
      });
    }
    const { job, outcome } = await ensureControlEffect(this.service, task, approval, executor, method);
    const decidedAt = new Date().toISOString();
    const status = approval.action === 'pause-task'
      ? (job.status === 'paused' ? 'paused' : 'pausing')
      : 'running';
    const taskPatch = (current) => ({
      status,
      currentStage:approval.action === 'pause-task' ? `xiaod_${job.status || 'pausing'}` : 'xiaod_resumed',
      error:undefined,
      execution:{
        ...(current.execution || {}),
        xiaodStatus:job.status,
        xiaodProgress:job.progress,
        control:{
          action:approval.action,
          status:outcome === 'obsolete' ? 'superseded' : 'accepted',
          approvalId:approval.approvalId,
          decidedAt,
        },
        polling:{
          state:status === 'paused' ? 'settled' : 'pending',
          consecutiveFailures:0,
          nextPollAt:status === 'paused' ? null : decidedAt,
        },
      },
    });
    let updated;
    if (alreadyCommitted) updated = await this.service.store.updateTask(task.taskId, taskPatch(task));
    else {
      updated = (await this.service.store.resolveApprovalAndUpdateTask(
        approval.approvalId,
        {
          ...approvalPatch,
          localEffect:{
            ...(approval.localEffect || {}),
            state:'confirmed',
            confirmedAt:decidedAt,
            xiaodStatus:job.status,
            outcome,
          },
        },
        task.taskId,
        taskPatch,
      )).task;
    }
    if (updated.governance?.paperclipIssueId) {
      updated = await this.service.store.updateTask(updated.taskId, {
        governance:await this.service.governance.update(updated),
      });
    }
    if (approval.action === 'resume-task' && outcome !== 'obsolete' && typeof executor.observe === 'function') {
      executor.observe(updated);
    }
    return updated;
  }

  async #requestOnce(taskId, action) {
    const task = (await this.service.store.list()).find((item) => item.taskId === taskId);
    if (!task) throw new ValidationError('找不到要控制的任务。');
    const isPause = action === 'pause-task';
    if (!['pause-task', 'resume-task'].includes(action)) throw new ValidationError('不支持这项任务控制。');
    if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId) {
      throw new ValidationError('目前只能控制正在由小D处理的任务。');
    }
    if (isPause ? !['queued', 'running', 'pausing'].includes(task.status) : task.status !== 'paused') {
      throw new ValidationError(isPause ? '这条任务当前不能暂停。' : '只有已经暂停的任务可以继续。');
    }
    const existing = (await this.service.store.listApprovals()).find((item) =>
      item.taskId === task.taskId && item.action === action && item.status === 'pending'
    );
    if (existing) return { task, approval:existing, duplicate:true };
    const approval = await this.service.store.createApproval({
      taskId:task.taskId,
      holdTask:false,
      governanceMode:'paperclip',
      decisionChannel:'feishu_card',
      action,
      riskLevel:'high',
      reason:isPause ? '暂停会改变一项正在执行的工作。' : '继续会恢复一项已暂停的工作。',
      requestedBy:'A君',
      approverScope:'A君',
      requestedScope:{
        taskType:task.taskType,
        title:task.input?.title || '',
        assigneeAgentId:task.assigneeAgentId || null,
      },
      validUntil:new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (!this.service.governance?.project) throw new ValidationError('Paperclip 暂不可用，不能绕过组织级确认。');
    const projection = await this.service.governance.project(task, approval);
    const updated = await this.service.store.updateTask(task.taskId, {
      governance:projection,
      execution:{
        ...(task.execution || {}),
        control:{
          action,
          status:'waiting_approval',
          approvalId:approval.approvalId,
          requestedAt:new Date().toISOString(),
        },
      },
    });
    return { task:updated, approval, duplicate:false };
  }
}

async function ensureControlEffect(service, task, approval, executor, method) {
  if (typeof executor.getJob === 'function') {
    const observed = await executor.getJob(task.execution?.xiaodJobId);
    const recovered = xiaodControlOutcome(approval.action, observed);
    if (recovered) return { job:observed, outcome:recovered };
  }
  try {
    const job = await executor[method](task);
    const outcome = xiaodControlOutcome(approval.action, job);
    if (!outcome) throw new ValidationError('小D未确认任务控制结果。');
    return { job, outcome };
  } catch (error) {
    if (typeof executor.getJob !== 'function') throw error;
    const recovered = await executor.getJob(task.execution?.xiaodJobId);
    const outcome = xiaodControlOutcome(approval.action, recovered);
    if (!outcome) throw error;
    return { job:recovered, outcome };
  }
}

function xiaodControlOutcome(action, job) {
  const status = String(job?.status || '');
  if (!status) return null;
  if (XIAOD_TERMINAL_OR_REVIEW_STATUSES.has(status)) return 'obsolete';
  return action === 'pause-task'
    ? (['pausing', 'paused'].includes(status) ? 'applied' : null)
    : (status === 'paused' ? null : 'applied');
}
