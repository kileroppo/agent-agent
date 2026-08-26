export type ApprovalRecord = {
  approvalId: string;
  taskId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired_cancelled' | string;
  validUntil?: string | null;
  action: string;
  reason?: string;
  requestedScope?: string;
  createdAt?: string;
};

export type UrgentReminder = {
  approvalId: string;
  taskId: string;
  action: string;
  remainingMinutes: number;
  validUntil: string;
};

export type EscalationEvaluationResult = {
  urgentReminders: UrgentReminder[];
  expiredApprovals: ApprovalRecord[];
};

const DEFAULT_URGENCY_THRESHOLD_MS = 3600_000; // 1 小时临期预警

export function evaluateApprovalEscalations(
  approvals: ApprovalRecord[],
  {
    urgencyThresholdMs = DEFAULT_URGENCY_THRESHOLD_MS,
    now = Date.now(),
  }: { urgencyThresholdMs?: number; now?: number } = {}
): EscalationEvaluationResult {
  const urgentReminders: UrgentReminder[] = [];
  const expiredApprovals: ApprovalRecord[] = [];

  for (const approval of approvals) {
    if (approval.status !== 'pending' || !approval.validUntil) continue;

    const validUntilMs = new Date(approval.validUntil).getTime();
    const diffMs = validUntilMs - now;

    if (diffMs <= 0) {
      expiredApprovals.push(approval);
    } else if (diffMs <= urgencyThresholdMs) {
      urgentReminders.push({
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        action: approval.action,
        remainingMinutes: Math.max(1, Math.round(diffMs / 60000)),
        validUntil: approval.validUntil,
      });
    }
  }

  return { urgentReminders, expiredApprovals };
}

export class ApprovalEscalationGovernor {
  private store: any;
  private onUrgentReminder?: (reminder: UrgentReminder) => Promise<void> | void;
  private urgencyThresholdMs: number;
  private now: () => number;

  constructor({
    store,
    onUrgentReminder,
    urgencyThresholdMs = DEFAULT_URGENCY_THRESHOLD_MS,
    now = () => Date.now(),
  }: {
    store: any;
    onUrgentReminder?: (reminder: UrgentReminder) => Promise<void> | void;
    urgencyThresholdMs?: number;
    now?: () => number;
  }) {
    this.store = store;
    this.onUrgentReminder = onUrgentReminder;
    this.urgencyThresholdMs = urgencyThresholdMs;
    this.now = now;
  }

  async reconcile({ now = this.now() }: { now?: number } = {}): Promise<{
    status: string;
    urgentCount: number;
    expiredCount: number;
  }> {
    if (!this.store || typeof this.store.listApprovals !== 'function') {
      return { status: 'noop', urgentCount: 0, expiredCount: 0 };
    }

    const approvals = await this.store.listApprovals();
    const { urgentReminders, expiredApprovals } = evaluateApprovalEscalations(approvals, {
      urgencyThresholdMs: this.urgencyThresholdMs,
      now,
    });

    // 1. 处理超期审批单 -> 自动取消并熔断关联任务
    for (const expired of expiredApprovals) {
      const nowIso = new Date(now).toISOString();
      if (typeof this.store.updateApproval === 'function') {
        await this.store.updateApproval(expired.approvalId, {
          status: 'expired_cancelled',
          decidedAt: nowIso,
          decisionReason: '审批单已超出有效时间窗口，系统已安全熔断并释放任务。',
        });
      }

      if (expired.taskId && typeof this.store.updateTask === 'function') {
        const task = await this.store.getTask(expired.taskId);
        if (task && task.status === 'waiting_approval') {
          await this.store.updateTask(expired.taskId, {
            status: 'failed',
            currentStage: 'approval_expired',
            error: {
              code: 'approval_expired_cancelled',
              message: '高危动作审批超时未确认，任务已安全熔断取消。',
            },
          });
        }
      }
    }

    // 2. 处理临期催办
    for (const urgent of urgentReminders) {
      try {
        await this.onUrgentReminder?.(urgent);
      } catch {}
    }

    return {
      status: 'reconciled',
      urgentCount: urgentReminders.length,
      expiredCount: expiredApprovals.length,
    };
  }
}
