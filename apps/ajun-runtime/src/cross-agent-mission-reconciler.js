export class CrossAgentMissionReconciler {
  constructor({ store, missions, intervalMs = 3_000 } = {}) { this.store = store; this.missions = missions; this.intervalMs = intervalMs; this.timer = null; this.running = null; }

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
    for (const mission of tasks.filter(needsDispatch)) await this.missions.dispatch(mission);
  }
}

function needsDispatch(task) {
  const summary = task.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary');
  return task.taskType === 'army.cross-agent-mission' && task.status === 'running' && task.artifactRefs?.some((item) => item.type === 'cross_agent_mission_plan') && summary?.data?.completed !== true;
}
