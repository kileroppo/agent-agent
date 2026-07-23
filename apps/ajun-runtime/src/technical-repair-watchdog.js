const STALLED_STAGES = new Set([
  'isolated_workspace_ready',
  'repair_evidence_missing',
  'repair_promotion_rejected',
  'repair_promotion_conflict'
]);

export class TechnicalRepairWatchdog {
  constructor({ store, governance = null, now = () => Date.now(), intervalMs = 10_000, staleAfterMs = 90_000 } = {}) {
    this.store = store;
    this.governance = governance;
    this.now = now;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    const tasks = await this.store.list();
    await Promise.all(tasks.filter((task) => needsWaitingTest(task, this.now(), this.staleAfterMs)).map((task) => this.markWaitingTest(task)));
    await Promise.all(tasks.filter(needsPaperclipWaitingTestSync).map((task) => this.syncWaitingTest(task)));
  }

  async markWaitingTest(task) {
    const checkedAt = new Date(this.now()).toISOString();
    const reason = '本机技术修理已超过等待时间，仍没有完整的修改、测试和恢复证据。已标为待测试，不会继续占用处理中；其他工作可以继续推进。';
    let updated = await this.store.updateTask(task.taskId, {
      status:'waiting_test', currentStage:'repair_waiting_for_test',
      execution:{ ...(task.execution || {}), updatedAt:checkedAt, outcome:'waiting_for_test' },
      error:{ code:'technical_repair_waiting_test', message:reason, userMessage:reason, category:'manual', stage:'technical_repair', occurredAt:checkedAt }
    });
    await this.syncWaitingTest(updated);
  }

  async syncWaitingTest(task) {
    if (!this.governance || !task.governance?.paperclipIssueId) return task;
    try {
      const governance = await this.governance.update(task);
      return await this.store.updateTask(task.taskId, { governance, execution:{ ...(task.execution || {}), paperclipWaitingTestSyncedAt:new Date(this.now()).toISOString() } });
    } catch { return task; /* 本机状态已如实保留；Paperclip 下轮可继续同步。 */ }
  }
}

function needsWaitingTest(task, now, staleAfterMs) {
  if (task.taskType !== 'operations.technical-repair' || task.status !== 'running') return false;
  if (!STALLED_STAGES.has(task.currentStage)) return false;
  const updatedAt = Date.parse(task.updatedAt || task.createdAt || '');
  return Number.isFinite(updatedAt) && updatedAt <= now - staleAfterMs;
}

function needsPaperclipWaitingTestSync(task) {
  return task.taskType === 'operations.technical-repair' && task.status === 'waiting_test'
    && Boolean(task.governance?.paperclipIssueId) && !task.execution?.paperclipWaitingTestSyncedAt;
}
