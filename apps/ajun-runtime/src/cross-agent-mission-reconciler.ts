import {
  isExactLegacyMaturityContentBlock,
  isExactQueuedMaturityContentRetry,
  isExactQueuedMaturityMissionRetry,
} from './maturity-legacy-content-retry.ts';

export class CrossAgentMissionReconciler {
  store: any; missions: any; intervalMs: number;
  timer: ReturnType<typeof setInterval> | null; running: Promise<any> | null;
  constructor({ store, missions, intervalMs = 3_000 }: any = {}) { this.store = store; this.missions = missions; this.intervalMs = intervalMs; this.timer = null; this.running = null; }

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
    for (const mission of tasks.filter((task: any) => needsDispatch(task, tasks))) await this.missions.dispatch(mission);
  }
}

function needsDispatch(task: any, tasks: any[]) {
  const summary = task.artifactRefs?.find((item: any) => item.type === 'cross_agent_mission_summary');
  if (task.taskType !== 'army.cross-agent-mission'
    || !task.artifactRefs?.some((item: any) => item.type === 'cross_agent_mission_plan')
    || summary?.data?.completed === true) return false;
  if (isExactQueuedMaturityMissionRetry(task)) return true;
  if (task.status === 'running') return true;
  if (task.status !== 'waiting_test' || !task.input?.context?.productMaturityBatchId) return false;
  const children = tasks.filter((item: any) => item.parentTaskId === task.taskId);
  return children.some(isExactLegacyMaturityContentBlock)
    || children.some(isExactQueuedMaturityContentRetry)
    || (children.length === 3 && children.every((item: any) => item.status === 'succeeded'));
}
