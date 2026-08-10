import { classifyTechnicalFailure } from './technical-failure-classifier.ts';

const MAX_AUTOMATIC_RETRIES = 1;

export class FailureRecoveryCoordinator {
  constructor({ tasks, store, diagnoser = null, projectRoot = null, maxAutomaticRetries = MAX_AUTOMATIC_RETRIES } = {}) {
    this.tasks = tasks;
    this.store = store;
    this.diagnoser = diagnoser;
    this.projectRoot = projectRoot;
    this.maxAutomaticRetries = maxAutomaticRetries;
  }

  async handle(failedTask, options = {}) {
    if (!shouldHandleFailure(failedTask)) return { status: 'ignored' };
    const actionKey = String(options.actionKey || 'automatic').trim();
    if (actionKey === 'request_read_only_diagnosis') return { status:'ignored' };
    if (actionKey === 'request_safe_recovery' && !locallyOwned(failedTask)) {
      return { status:failedTask.execution?.owner === 'paperclip-hermes' ? 'requires_external' : 'not_eligible' };
    }
    const rootTaskId = failedTask.recovery?.rootTaskId || failedTask.taskId;
    const attempt = Number(failedTask.recovery?.attempt || 0);
    const context = safeContext(failedTask, attempt, this.maxAutomaticRetries);
    const operatorTask = await this.tasks.create({
      title: `处理任务故障：${failedTask.input?.title || '未命名任务'}`,
      description: '由系统自动交给运维官判断是否可以安全恢复。',
      taskType: 'operations.failure-recovery',
      agentId: 'operator',
      requester: failedTask.requester,
      source: { channel: 'internal-recovery', parentChannel: failedTask.source?.channel || null, chatRef: failedTask.source?.chatRef || null },
      parentTaskId: failedTask.taskId,
      idempotencyKey: `recovery-review:${failedTask.taskId}`,
      context
    });
    const decision = operatorTask.artifactRefs?.find((item) => item.type === 'recovery_decision')?.data;
    const directRetryAllowed = decision?.action === 'retry_once'
      && decision?.executionAuthorized === true
      && failedTask.execution?.owner !== 'paperclip-hermes'
      && attempt < this.maxAutomaticRetries
      && failedTask.input?.sourceUrl;
    if (directRetryAllowed) {
      const retryTask = await this.tasks.create({
        title: failedTask.input.title,
        description: failedTask.input.description,
        sourceUrl: failedTask.input.sourceUrl,
        sourceUrls: failedTask.input.sourceUrls,
        taskType: failedTask.taskType,
        agentId: failedTask.assigneeAgentId,
        requester: failedTask.requester,
        source: failedTask.source,
        parentTaskId: failedTask.taskId,
        idempotencyKey: `recovery-retry:${rootTaskId}:${attempt + 1}`,
        recovery: { rootTaskId, attempt: attempt + 1, triggeredByTaskId: operatorTask.taskId, mode: 'automatic_retry' }
      });
      await this.markCoordination(failedTask, { status: 'retrying', actionKey, operatorTaskId: operatorTask.taskId, retryTaskId: retryTask.taskId, attempt: attempt + 1 }, options);
      return { status: 'retrying', operatorTask, retryTask };
    }
    const diagnosis = this.diagnoser && this.projectRoot ? await this.diagnoser.diagnose({ input:{ title:failedTask.input?.title, context }, taskId:failedTask.taskId }, this.projectRoot) : null;
    const route = diagnosis?.repairScope ? 'isolated_code_repair' : context.failureClassification?.route || 'diagnose_before_action';
    const technicalTask = await this.tasks.create({
      title: `${diagnosis?.repairScope ? '修复' : '诊断'}任务故障：${failedTask.input?.title || '未命名任务'}`,
      description:diagnosis?.repairScope
        ? '只读诊断已形成受控修复范围，交给技术专家在隔离副本实施和验证。'
        : '自动恢复无法安全完成，交给技术专家形成根因分类、缺失证据和明确下一步；没有修复范围时不得猜测改代码。',
      taskType: 'operations.technical-repair',
      agentId: 'technical-expert',
      requester: failedTask.requester,
      source: { channel: 'internal-recovery', parentChannel: failedTask.source?.channel || null, chatRef: failedTask.source?.chatRef || null },
      parentTaskId: failedTask.taskId,
      idempotencyKey: `technical-repair:${rootTaskId}`,
      context: {
        ...context,
        ...(failedTask.governance?.paperclipIssueId ? { parentPaperclipIssueId:failedTask.governance.paperclipIssueId } : {}),
        technicalRoute:route,
        ...(diagnosis ? { diagnosis } : {}),
        ...(diagnosis?.repairScope ? { repairScope:diagnosis.repairScope } : {}),
      }
    });
    await this.markCoordination(failedTask, { status: 'escalated', actionKey, operatorTaskId: operatorTask.taskId, technicalTaskId: technicalTask.taskId, attempt }, options);
    return { status: 'escalated', operatorTask, technicalTask };
  }

  async markCoordination(task, coordination, options = {}) {
    if (!this.store?.updateTask) return;
    const current = await currentTask(this.store, task.taskId) || task;
    const events = Array.isArray(current.recovery?.events) ? [...current.recovery.events] : [];
    if (options.requestId && !events.some((event) => event.event === coordination.status && event.requestId === options.requestId)) {
      events.push({
        event:coordination.status,
        actionKey:options.actionKey || coordination.actionKey,
        requestId:options.requestId,
        attempt:coordination.attempt,
        actor:options.requestedBy || { kind:'local-owner', ref:'A君' },
        occurredAt:new Date().toISOString(),
      });
    }
    await this.store.updateTask(task.taskId, {
      recovery:{ ...(current.recovery || {}), coordination, ...(events.length ? { events:events.slice(-50) } : {}) },
    });
  }
}

async function currentTask(store, taskId) {
  if (typeof store?.getTask === 'function') return store.getTask(taskId);
  if (typeof store?.list === 'function') return (await store.list()).find((task) => task.taskId === taskId) || null;
  return null;
}

function shouldHandleFailure(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task.taskType);
}

function locallyOwned(task) {
  const owner = String(task?.execution?.owner || '').trim();
  return !owner || owner.startsWith('ajun-') || owner === 'local-evidence-fallback';
}

function safeContext(task, attempt, maxAutomaticRetries) {
  const error = task.error || {};
  const failureClassification = classifyTechnicalFailure({
    error,
    taskType:task.taskType,
    sourceUrl:task.input?.sourceUrl
  });
  return {
    failedTaskId: task.taskId,
    sourceUrl: task.input?.sourceUrl || null,
    attempt,
    maxAutomaticRetries,
    failureClassification,
    failure: {
      code: String(error.code || 'unknown_failure'),
      category: String(error.category || 'manual'),
      stage: String(error.stage || task.currentStage || 'unknown'),
      retryable: error.retryable === true,
      message:failureClassification.evidence.message
    }
  };
}
