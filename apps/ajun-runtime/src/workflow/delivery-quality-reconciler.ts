type ReconcileTask = Record<string, any>;
type ReconcileStore = { list(): Promise<ReconcileTask[]> };
type QualityRuntime = { continue(task: ReconcileTask): Promise<ReconcileTask> };

/** Boot-time recovery for the persistence gap between quality hold and review creation. */
export class DeliveryQualityReconciler {
  store: ReconcileStore;
  deliveryQuality: QualityRuntime;
  onResult: ((result: ReconcileResult) => void) | null;
  started = false;
  running: Promise<ReconcileResult> | null = null;

  constructor({ store, deliveryQuality, onResult = null }: {
    store: ReconcileStore;
    deliveryQuality: QualityRuntime;
    onResult?: ((result: ReconcileResult) => void) | null;
  }) {
    if (!store?.list || !deliveryQuality?.continue) {
      throw new TypeError('交付质量恢复器需要任务存储和 DeliveryQualityRuntime。');
    }
    this.store = store;
    this.deliveryQuality = deliveryQuality;
    this.onResult = onResult;
  }

  start() {
    if (this.started) return this.running;
    this.started = true;
    return this.reconcile();
  }

  reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    const tasks = await this.store.list();
    const pending = tasks.filter(isPendingQualityReview);
    const resumedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (const task of pending) {
      try {
        await this.deliveryQuality.continue(task);
        resumedTaskIds.push(task.taskId);
      } catch {
        failedTaskIds.push(task.taskId);
      }
    }
    return Object.freeze({
      status:failedTaskIds.length ? 'sync_pending' : 'reconciled',
      resumedTaskIds:Object.freeze(resumedTaskIds),
      failedTaskIds:Object.freeze(failedTaskIds),
    });
  }
}

type ReconcileResult = Readonly<{
  status: 'reconciled' | 'sync_pending';
  resumedTaskIds: readonly string[];
  failedTaskIds: readonly string[];
}>;

function isPendingQualityReview(task: ReconcileTask) {
  return task?.status === 'running'
    && task?.currentStage === 'delivery_quality_review_pending'
    && Boolean(task?.deliveryQuality?.reviewTaskRequest)
    && !task?.deliveryQualityRuntime?.reviewTaskId;
}
