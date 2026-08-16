import { isHeldReadOnlyDiagnosis } from './delivery-quality-runtime.ts';
type ReconcileTask = Record<string, any>;
type ReconcileStore = { list(): Promise<ReconcileTask[]> };
type QualityRuntime = {
  continue(task: ReconcileTask): Promise<ReconcileTask>;
  failReview?(task: ReconcileTask, reviewTask: ReconcileTask): Promise<ReconcileTask>;
};

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
    const taskById = new Map(tasks.map((task) => [String(task?.taskId || ''), task]));
    const pending = tasks.filter((task) => isPendingQualityReview(task)
      || Boolean(failedQualityReview(task, taskById)));
    const resumedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (const task of pending) {
      try {
        const failedReview = failedQualityReview(task, taskById);
        if (failedReview && this.deliveryQuality.failReview) {
          await this.deliveryQuality.failReview(task, failedReview);
        } else {
          await this.deliveryQuality.continue(task);
        }
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

function failedQualityReview(task: ReconcileTask, taskById: Map<string, ReconcileTask>) {
  if (task?.status !== 'running' || task?.currentStage !== 'delivery_quality_review_pending') return null;
  const reviewTaskId = String(task?.deliveryQualityRuntime?.reviewTaskId || '').trim();
  const reviewTask = reviewTaskId ? taskById.get(reviewTaskId) : null;
  return reviewTask && ['failed', 'cancelled', 'rejected', 'waiting_test'].includes(String(reviewTask.status || ''))
    ? reviewTask
    : null;
}

type ReconcileResult = Readonly<{
  status: 'reconciled' | 'sync_pending';
  resumedTaskIds: readonly string[];
  failedTaskIds: readonly string[];
}>;

function isPendingQualityReview(task: ReconcileTask) {
  return isHeldReadOnlyDiagnosis(task) || (task?.status === 'running'
    && task?.currentStage === 'delivery_quality_review_pending'
    && Boolean(task?.deliveryQuality?.reviewTaskRequest)
    && (!task?.deliveryQualityRuntime?.reviewTaskId
      || ['pending', 'sync_pending'].includes(task?.deliveryQualityRuntime?.reviewSync?.status)));
}
