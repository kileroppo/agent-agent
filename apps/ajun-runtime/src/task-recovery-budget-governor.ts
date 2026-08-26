export type FaultCategory =
  | 'transient_retryable'
  | 'missing_credential'
  | 'service_offline'
  | 'fatal_non_retryable';

export type ClassifiedFault = {
  category: FaultCategory;
  reason: string;
  recommendedAction: string;
};

export function classifyFault(error: any): ClassifiedFault {
  if (!error) {
    return {
      category: 'fatal_non_retryable',
      reason: '未知的空异常。',
      recommendedAction: '人工复核。',
    };
  }

  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || error?.status || '').toUpperCase();

  // 1. 凭据缺失/失效
  if (
    code === '401' ||
    code === '403' ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('cookie') ||
    message.includes('token') ||
    message.includes('auth')
  ) {
    return {
      category: 'missing_credential',
      reason: '账号登录态或 API Token 失效/未授权。',
      recommendedAction: '请在运行台或飞书更新平台 Cookie/Token，更新后将自动继续。',
    };
  }

  // 2. 下游服务离线
  if (
    code === 'ECONNREFUSED' ||
    message.includes('econnrefused') ||
    message.includes('service offline') ||
    message.includes('health check failed')
  ) {
    return {
      category: 'service_offline',
      reason: '关键下游能力服务离线或端口不可达。',
      recommendedAction: '已挂起等待服务自愈网格探活恢复。',
    };
  }

  // 3. 瞬时网络抖动 / 限流
  if (
    code === '429' ||
    code === '502' ||
    code === '503' ||
    code === '504' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('too many requests')
  ) {
    return {
      category: 'transient_retryable',
      reason: '瞬时网络超时或 Provider 请求限流。',
      recommendedAction: '将在退避窗口后进行受控自动重试。',
    };
  }

  // 4. 致命参数 / 格式校验错误
  return {
    category: 'fatal_non_retryable',
    reason: `不可自动恢复的业务/逻辑错误: ${error?.message || '未知错误'}`,
    recommendedAction: '请检查输入参数或提示词后重新发起。',
  };
}

export type BudgetGovernorOptions = {
  maxRetriesPerHour?: number; // 单任务每小时最多自动重试次数 (默认 3 次)
  windowMs?: number; // 统计窗口 (默认 1 小时)
  now?: () => number;
};

export class TaskRecoveryBudgetGovernor {
  private retryHistory = new Map<string, number[]>(); // taskId -> timestamps
  private maxRetriesPerHour: number;
  private windowMs: number;
  private now: () => number;

  constructor(options: BudgetGovernorOptions = {}) {
    this.maxRetriesPerHour = options.maxRetriesPerHour ?? 3;
    this.windowMs = options.windowMs ?? 3600_000;
    this.now = options.now ?? (() => Date.now());
  }

  evaluateRecovery(
    taskId: string,
    error: any,
    now = this.now()
  ): {
    allowed: boolean;
    category: FaultCategory;
    reason: string;
    remainingBudget: number;
    recommendedAction: string;
  } {
    const fault = classifyFault(error);

    if (fault.category !== 'transient_retryable') {
      return {
        allowed: false,
        category: fault.category,
        reason: fault.reason,
        remainingBudget: 0,
        recommendedAction: fault.recommendedAction,
      };
    }

    const timestamps = (this.retryHistory.get(taskId) || []).filter(
      (ts) => ts > now - this.windowMs
    );
    const remainingBudget = Math.max(0, this.maxRetriesPerHour - timestamps.length);

    if (remainingBudget <= 0) {
      return {
        allowed: false,
        category: 'transient_retryable',
        reason: `任务已达 1 小时内最大重试上限 (${this.maxRetriesPerHour} 次)，自动重试已熔断停止。`,
        remainingBudget: 0,
        recommendedAction: '已转入人工复核，避免无限重试消耗资源。',
      };
    }

    return {
      allowed: true,
      category: 'transient_retryable',
      reason: fault.reason,
      remainingBudget,
      recommendedAction: fault.recommendedAction,
    };
  }

  recordRetry(taskId: string, now = this.now()): void {
    const timestamps = (this.retryHistory.get(taskId) || []).filter(
      (ts) => ts > now - this.windowMs
    );
    timestamps.push(now);
    this.retryHistory.set(taskId, timestamps);
  }

  reset(taskId?: string): void {
    if (taskId) {
      this.retryHistory.delete(taskId);
    } else {
      this.retryHistory.clear();
    }
  }
}
