import {
  createDeliveryReceipt,
  normalizeDeliveryReceipt,
} from '../delivery-receipt-state.ts';

export type DeliveryProbe = {
  queryDeliveryStatus: (input: {
    deliveryId?: string;
    idempotencyKey?: string;
    channel?: string;
  }) => Promise<{ status: 'delivered' | 'not_delivered' | 'unknown'; messageId?: string; observedAt?: string } | null>;
};

export type DeliverySender = {
  sendDelivery: (task: any) => Promise<{ success: boolean; messageId?: string; error?: string }>;
};

export type DeliveryUnknownReconcilerOptions = {
  store?: any;
  deliveryProbe?: DeliveryProbe;
  deliverySender?: DeliverySender;
  maxReconcileWindowMs?: number;
  now?: () => number;
};

const DEFAULT_RECONCILE_WINDOW_MS = 24 * 3600 * 1000; // 24 hours

export class DeliveryUnknownReconciler {
  private store: any;
  private deliveryProbe?: DeliveryProbe;
  private deliverySender?: DeliverySender;
  private maxReconcileWindowMs: number;
  private now: () => number;

  constructor(options: DeliveryUnknownReconcilerOptions = {}) {
    this.store = options.store;
    this.deliveryProbe = options.deliveryProbe;
    this.deliverySender = options.deliverySender;
    this.maxReconcileWindowMs = options.maxReconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async reconcile({ now = this.now() }: { now?: number } = {}): Promise<{
    status: string;
    resolvedCount: number;
    retriedCount: number;
    failedCount: number;
    checkedCount: number;
  }> {
    if (!this.store || typeof this.store.list !== 'function') {
      return { status: 'reconciled', resolvedCount: 0, retriedCount: 0, failedCount: 0, checkedCount: 0 };
    }

    const allTasks = await this.store.list();
    const unknownTasks = allTasks.filter((task: any) => {
      const receipt = normalizeDeliveryReceipt(task.deliveryReceipt || task.delivery);
      return receipt?.status === 'delivery_unknown';
    });

    let resolvedCount = 0;
    let retriedCount = 0;
    let failedCount = 0;

    for (const task of unknownTasks) {
      const receipt = normalizeDeliveryReceipt(task.deliveryReceipt || task.delivery);
      if (!receipt) continue;

      const unknownAt = receipt.unknownAt ? new Date(receipt.unknownAt).getTime() : 0;
      const elapsed = unknownAt !== 0 ? now - unknownAt : 0;
      const isExpired = elapsed > this.maxReconcileWindowMs;

      let probeResult = null;
      if (this.deliveryProbe) {
        try {
          probeResult = await this.deliveryProbe.queryDeliveryStatus({
            deliveryId: receipt.deliveryId,
            idempotencyKey: receipt.idempotencyKey,
            channel: receipt.channel,
          });
        } catch {
          // Probe error treated as null
        }
      }

      if (probeResult?.status === 'delivered') {
        // 反查确认已送达
        const updatedReceipt = createDeliveryReceipt({
          ...receipt,
          status: 'delivered',
          deliveredAt: new Date(now).toISOString(),
          evidence: {
            type: 'readback_probe',
            observedAt: probeResult.observedAt || new Date(now).toISOString(),
            reference: probeResult.messageId || 'confirmed_via_probe',
          },
        });
        await this.updateTaskReceipt(task, updatedReceipt);
        resolvedCount += 1;
      } else if (!isExpired && this.deliverySender) {
        // 未过期，执行单次受控补偿重发
        try {
          const sendRes = await this.deliverySender.sendDelivery(task);
          if (sendRes.success) {
            const updatedReceipt = createDeliveryReceipt({
              ...receipt,
              status: 'delivered',
              deliveredAt: new Date(now).toISOString(),
              evidence: {
                type: 'retry_sender',
                observedAt: new Date(now).toISOString(),
                reference: sendRes.messageId || 'confirmed_via_retry',
              },
            });
            await this.updateTaskReceipt(task, updatedReceipt);
            retriedCount += 1;
            resolvedCount += 1;
          } else {
            const updatedReceipt = createDeliveryReceipt({
              ...receipt,
              status: 'failed',
              failedAt: new Date(now).toISOString(),
              errorCode: 'delivery_retry_rejected',
            });
            await this.updateTaskReceipt(task, updatedReceipt);
            failedCount += 1;
          }
        } catch {
          // 重发失败
          const updatedReceipt = createDeliveryReceipt({
            ...receipt,
            status: 'failed',
            failedAt: new Date(now).toISOString(),
            errorCode: 'delivery_retry_exception',
          });
          await this.updateTaskReceipt(task, updatedReceipt);
          failedCount += 1;
        }
      } else if (isExpired) {
        // 超过有效核对窗口，收敛为明确的失败
        const updatedReceipt = createDeliveryReceipt({
          ...receipt,
          status: 'failed',
          failedAt: new Date(now).toISOString(),
          errorCode: 'delivery_verification_timeout',
        });
        await this.updateTaskReceipt(task, updatedReceipt);
        failedCount += 1;
      }
    }

    return {
      status: 'reconciled',
      resolvedCount,
      retriedCount,
      failedCount,
      checkedCount: unknownTasks.length,
    };
  }

  private async updateTaskReceipt(task: any, newReceipt: any) {
    const updatedTask = {
      ...task,
      deliveryReceipt: newReceipt,
      delivery: newReceipt,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (typeof this.store.save === 'function') {
      await this.store.save(updatedTask);
    }
  }
}
