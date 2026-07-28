const FAILURE_STATUSES = new Set(['blocked', 'failed']);

export class PaperclipHermesTaskReconciler {
  constructor({ store, governance, now = () => Date.now(), intervalMs = 10_000 } = {}) {
    this.store = store;
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
    await Promise.all(tasks.filter(isDelegatedHermesTask).map((task) => this.reconcileTask(task)));
  }

  async reconcileTask(task) {
    let issue;
    try {
      issue = await this.governance.getPaperclipIssue(task.governance.paperclipIssueId);
    } catch {
      // Paperclip 短时不可用不应改写业务真相，也不刷新任务时间戳。
      return;
    }

    if (issue?.status === 'cancelled') {
      await this.settle(task, {
        status:'cancelled',
        currentStage:'paperclip_hermes_cancelled',
        outcome:'cancelled_in_paperclip',
        error:null
      });
      return;
    }

    if (FAILURE_STATUSES.has(issue?.status)) {
      const hasArtifact = hasReadableArtifact(task);
      await this.settle(task, hasArtifact ? {
        status:'waiting_test',
        currentStage:'paperclip_hermes_waiting_test',
        outcome:'artifact_requires_review',
        error:task.error || taskFailure(
          'paperclip_hermes_requires_review',
          'Paperclip 已结束本次运行，但本机保留了可读产物；需要人工核对后再决定是否采用。',
          this.now()
        )
      } : {
        status:'failed',
        currentStage:'paperclip_hermes_failed',
        outcome:'paperclip_hermes_failed',
        error:task.error || taskFailure(
          'paperclip_hermes_failed',
          'Paperclip 已结束本次运行，且没有可验证产物；任务已如实记为失败。',
          this.now()
        )
      });
      return;
    }

    if (issue?.status === 'done') {
      const hasArtifact = hasReadableArtifact(task);
      await this.settle(task, hasArtifact ? {
        status:'succeeded',
        currentStage:'paperclip_hermes_completed',
        outcome:'verified_artifact_ready',
        error:null
      } : {
        status:'waiting_test',
        currentStage:'paperclip_hermes_evidence_missing',
        outcome:'paperclip_done_without_local_evidence',
        error:taskFailure(
          'paperclip_hermes_evidence_missing',
          'Paperclip 已标记完成，但 A君没有找到可验证的本地产物；已转为待测试，不冒充完整成功。',
          this.now()
        )
      });
    }
  }

  async settle(task, { status, currentStage, outcome, error }) {
    const finishedAt = new Date(this.now()).toISOString();
    await this.store.updateTask(task.taskId, {
      status,
      currentStage,
      execution:{ ...(task.execution || {}), finishedAt, outcome },
      error
    });
  }
}

function isDelegatedHermesTask(task) {
  return task?.status === 'running'
    && task.taskType !== 'operations.technical-repair'
    && task.execution?.owner === 'paperclip-hermes'
    && Boolean(task.governance?.paperclipIssueId);
}

function hasReadableArtifact(task) {
  return (task.artifactRefs || []).some((artifact) =>
    artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true
  );
}

function taskFailure(code, userMessage, now) {
  return {
    code,
    message:userMessage,
    userMessage,
    category:'manual',
    stage:'paperclip_hermes',
    retryable:false,
    occurredAt:new Date(now).toISOString()
  };
}
