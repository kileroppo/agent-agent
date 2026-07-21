const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_UNAVAILABLE_POLLS = 5;

export class XiaodReconciler {
  constructor({ store, xiaod, governance = null, now = () => Date.now(), intervalMs = 3_000 } = {}) {
    this.store = store;
    this.xiaod = xiaod;
    this.governance = governance;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    const tasks = await this.store.list();
    const now = this.now();
    await Promise.all(tasks
      .filter((task) => isRunningXiaodTask(task) && isPollDue(task, now))
      .map((task) => this.reconcileTask(task)));
  }

  async reconcileTask(task) {
    try {
      const job = await this.xiaod.getJob(task.execution.xiaodJobId);
      const status = job.status === 'completed' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running';
      const execution = {
        ...task.execution,
        xiaodStatus: job.status,
        xiaodProgress: job.progress,
        updatedAt: new Date(this.now()).toISOString(),
        polling: { state: status === 'running' ? 'watching' : 'settled', consecutiveFailures: 0, nextPollAt: status === 'running' ? new Date(this.now() + this.intervalMs).toISOString() : null }
      };
      const patch = { status, currentStage: `xiaod_${job.status}`, execution };
      if (status === 'succeeded') patch.artifactRefs = [artifactFor(task, job, this.xiaod.baseUrl)];
      if (status === 'failed') patch.error = failureFor(job);
      await this.persist(task.taskId, patch);
    } catch (error) {
      await this.deferUnavailableTask(task, error);
    }
  }

  async deferUnavailableTask(task, error) {
    const priorFailures = Number(task.execution?.polling?.consecutiveFailures || 0);
    const consecutiveFailures = priorFailures + 1;
    const message = String(error?.message || '小D状态不可用。');
    if (consecutiveFailures >= MAX_UNAVAILABLE_POLLS) {
      await this.persist(task.taskId, {
        status: 'failed', currentStage: 'xiaod_status_unavailable',
        execution: { ...task.execution, updatedAt: new Date(this.now()).toISOString(), polling: { state: 'exhausted', consecutiveFailures, nextPollAt: null } },
        error: { code: 'xiaod_status_unavailable', message, userMessage: '多次无法确认小D任务状态，已停止自动查询；请稍后检查小D服务后重试。', category: 'retryable', stage: 'delegated_to_xiaod', occurredAt: new Date(this.now()).toISOString() }
      });
      return;
    }
    const delay = Math.min(BASE_BACKOFF_MS * (2 ** (consecutiveFailures - 1)), MAX_BACKOFF_MS);
    await this.persist(task.taskId, {
      status: 'running', currentStage: 'xiaod_status_retrying',
      execution: { ...task.execution, updatedAt: new Date(this.now()).toISOString(), polling: { state: 'backoff', consecutiveFailures, nextPollAt: new Date(this.now() + delay).toISOString() } },
      error: { code: 'xiaod_status_unavailable', message, userMessage: `暂时无法连接小D，${Math.ceil(delay / 1000)} 秒后会自动重试。`, category: 'retryable', stage: 'delegated_to_xiaod', occurredAt: new Date(this.now()).toISOString() }
    });
  }

  async persist(taskId, patch) {
    let updated = await this.store.updateTask(taskId, patch);
    if (this.governance && updated.governance?.paperclipIssueId) {
      updated = await this.store.updateTask(taskId, { governance: await this.governance.update(updated) });
    }
    return updated;
  }
}

function isRunningXiaodTask(task) {
  return task.status === 'running' && task.execution?.executor === 'xiaod' && Boolean(task.execution.xiaodJobId);
}

function isPollDue(task, now) {
  const nextPollAt = task.execution?.polling?.nextPollAt;
  return !nextPollAt || Date.parse(nextPollAt) <= now;
}

function artifactFor(task, job, baseUrl) {
  return { artifactId: `xiaod-job:${job.id}`, taskId: task.taskId, type: 'xiaod_media_delivery', title: job.title, location: `${baseUrl}/api/jobs/${job.id}`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: Boolean(job.output?.markdownPath), qualityPassed: Boolean(job.quality?.passed) }, createdAt: new Date().toISOString() };
}

function failureFor(job) {
  const failure = job.failure || {};
  return { code: 'xiaod_job_failed', message: typeof job.error === 'string' ? job.error : '小D任务失败。', userMessage: failure.recovery || '小D未能完成素材处理，请根据任务提示补充素材或稍后重试。', category: failure.category || 'manual', retryable: failure.retryable === true, stage: job.status, occurredAt: new Date().toISOString() };
}
