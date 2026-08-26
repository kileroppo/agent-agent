export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreakerOptions = {
  failureThreshold?: number; // 连续失败多少次打开熔断器 (默认 3 次)
  cooldownMs?: number; // 熔断后冷却多久进入半开探测 (默认 60 秒)
  now?: () => number;
};

export class AdapterCircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastOpenedAt = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60000;
    this.now = options.now ?? (() => Date.now());
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const elapsed = this.now() - this.lastOpenedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
      }
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(error?: any): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastOpenedAt = this.now();
    }
  }

  async execute<T>(
    primaryFn: () => Promise<T>,
    fallbackFn?: (err?: any) => Promise<T>
  ): Promise<T> {
    const currentState = this.getState();

    // 1. OPEN 状态：直接快速降级执行 Plan B，绝不阻塞超时
    if (currentState === 'OPEN') {
      if (typeof fallbackFn === 'function') {
        const circuitError = new Error('熔断器已开启，直接路由至 Plan B 备用通道。');
        (circuitError as any).code = 'CIRCUIT_BREAKER_OPEN';
        return await fallbackFn(circuitError);
      }
      const err = new Error('服务适配器处于熔断保护中，请求已快速失败。');
      (err as any).code = 'CIRCUIT_BREAKER_OPEN';
      throw err;
    }

    // 2. CLOSED 或 HALF_OPEN 状态：尝试主调用
    try {
      const res = await primaryFn();
      this.recordSuccess();
      return res;
    } catch (err: any) {
      this.recordFailure(err);
      if (typeof fallbackFn === 'function') {
        return await fallbackFn(err);
      }
      throw err;
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastOpenedAt = 0;
  }
}
