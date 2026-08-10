// @ts-expect-error legacy lifecycle implementation has no declaration yet
import { interruptedTaskExecutionPatch } from './task-lifecycle.js';

const LOCAL_START_STAGES = new Set([
  'starting',
  'office_presentation_local_starting',
]);

export class InterruptedLocalExecutionReconciler {
  store: any; bootedAt: string; onResult: ((result: any) => void) | null;
  running: Promise<any> | null; started: boolean;
  constructor({ store, bootedAt = new Date().toISOString(), onResult = null }: any = {}) {
    this.store = store;
    this.bootedAt = bootedAt;
    this.onResult = onResult;
    this.running = null;
    this.started = false;
  }

  start() {
    if (this.started) return this.running;
    this.started = true;
    return this.reconcile();
  }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    try {
      const tasks = await this.store.list();
      const interrupted = tasks.filter((task: any) => interruptedBeforeBoot(task, this.bootedAt));
      const recovered: string[] = [];
      for (const task of interrupted) {
        const result = typeof this.store.recoverInterruptedTaskExecution === 'function'
          ? await this.store.recoverInterruptedTaskExecution(task.taskId, {
              expectedStartedAt:task.execution.startedAt,
              expectedStage:task.currentStage,
              interruptedAt:this.bootedAt,
            })
          : { task:await this.store.updateTask(task.taskId, interruptedTaskExecutionPatch(task, this.bootedAt)), recovered:true };
        if (result.recovered) recovered.push(result.task.taskId);
      }
      return { status:'reconciled', recoveredTaskIds:recovered };
    } catch {
      return { status:'sync_pending', recoveredTaskIds:[], reason:'重启前中断的本地任务暂时无法整理。' };
    }
  }
}

function interruptedBeforeBoot(task: any, bootedAt: string) {
  if (task?.status !== 'running' || !LOCAL_START_STAGES.has(task.currentStage)) return false;
  const startedAt = Date.parse(task.execution?.startedAt || '');
  const bootTime = Date.parse(bootedAt || '');
  return Number.isFinite(startedAt) && Number.isFinite(bootTime) && startedAt < bootTime;
}
