const MAX_AUTOMATIC_RETRIES = 1;

export class FailureRecoveryCoordinator {
  constructor({ tasks, store, diagnoser = null, projectRoot = null, maxAutomaticRetries = MAX_AUTOMATIC_RETRIES } = {}) {
    this.tasks = tasks;
    this.store = store;
    this.diagnoser = diagnoser;
    this.projectRoot = projectRoot;
    this.maxAutomaticRetries = maxAutomaticRetries;
  }

  async handle(failedTask) {
    if (!shouldHandleFailure(failedTask)) return { status: 'ignored' };
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
    if (decision?.action === 'retry_once' && attempt < this.maxAutomaticRetries && failedTask.input?.sourceUrl) {
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
      await this.markCoordination(failedTask, { status: 'retrying', operatorTaskId: operatorTask.taskId, retryTaskId: retryTask.taskId, attempt: attempt + 1 });
      return { status: 'retrying', operatorTask, retryTask };
    }
    const diagnosis = this.diagnoser && this.projectRoot ? await this.diagnoser.diagnose({ input:{ title:failedTask.input?.title, context }, taskId:failedTask.taskId }, this.projectRoot) : null;
    const technicalTask = await this.tasks.create({
      title: `修复任务故障：${failedTask.input?.title || '未命名任务'}`,
      description: '自动恢复无法安全完成，已升级给技术专家。',
      taskType: 'operations.technical-repair',
      agentId: 'technical-expert',
      requester: failedTask.requester,
      source: { channel: 'internal-recovery', parentChannel: failedTask.source?.channel || null, chatRef: failedTask.source?.chatRef || null },
      parentTaskId: failedTask.taskId,
      idempotencyKey: `technical-repair:${rootTaskId}`,
      context: { ...context, ...(diagnosis ? { diagnosis } : {}), ...(diagnosis?.repairScope ? { repairScope:diagnosis.repairScope } : {}) }
    });
    await this.markCoordination(failedTask, { status: 'escalated', operatorTaskId: operatorTask.taskId, technicalTaskId: technicalTask.taskId, attempt });
    return { status: 'escalated', operatorTask, technicalTask };
  }

  async markCoordination(task, coordination) {
    if (!this.store?.updateTask) return;
    await this.store.updateTask(task.taskId, { recovery: { ...(task.recovery || {}), coordination } });
  }
}

function shouldHandleFailure(task) {
  return task?.status === 'failed'
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task.taskType);
}

function safeContext(task, attempt, maxAutomaticRetries) {
  const error = task.error || {};
  return {
    failedTaskId: task.taskId,
    sourceUrl: task.input?.sourceUrl || null,
    attempt,
    maxAutomaticRetries,
    failure: {
      code: String(error.code || 'unknown_failure'),
      category: String(error.category || 'manual'),
      stage: String(error.stage || task.currentStage || 'unknown'),
      retryable: error.retryable === true
    }
  };
}
