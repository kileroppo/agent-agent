export type EventPriority = 'critical' | 'normal' | 'verbose';

export type StreamEvent = {
  id?: string;
  type: string;
  priority?: EventPriority;
  taskId?: string;
  timestamp: string;
  payload?: any;
};

export type EventGovernorOptions = {
  capacity?: number; // 环形缓冲区容量 (默认 500)
  onDrop?: (droppedEvent: StreamEvent) => void;
};

const CRITICAL_EVENT_TYPES = new Set([
  'task_started',
  'task_succeeded',
  'task_failed',
  'approval_required',
  'approval_decided',
  'governance_blocked',
  'delivery_confirmed',
]);

export function inferEventPriority(event: StreamEvent): EventPriority {
  if (event.priority) return event.priority;
  if (CRITICAL_EVENT_TYPES.has(event.type)) return 'critical';
  if (event.type.includes('tick') || event.type.includes('chunk') || event.type.includes('trace')) return 'verbose';
  return 'normal';
}

export class EventStreamGovernor {
  private buffer: StreamEvent[] = [];
  private capacity: number;
  private droppedCount = 0;
  private onDrop?: (droppedEvent: StreamEvent) => void;

  constructor(options: EventGovernorOptions = {}) {
    this.capacity = options.capacity ?? 500;
    this.onDrop = options.onDrop;
  }

  push(rawEvent: StreamEvent): boolean {
    if (!rawEvent) return false;

    const event: StreamEvent = {
      ...rawEvent,
      priority: inferEventPriority(rawEvent),
    };

    if (this.buffer.length < this.capacity) {
      this.buffer.push(event);
      return true;
    }

    // 缓冲区已满：背压淘汰策略 (优先淘汰最旧的 verbose，其次 normal)
    const verboseIdx = this.buffer.findIndex((e) => e.priority === 'verbose');
    if (verboseIdx >= 0) {
      const dropped = this.buffer.splice(verboseIdx, 1)[0];
      this.droppedCount += 1;
      this.onDrop?.(dropped);
      this.buffer.push(event);
      return true;
    }

    const normalIdx = this.buffer.findIndex((e) => e.priority === 'normal');
    if (normalIdx >= 0 && event.priority === 'critical') {
      const dropped = this.buffer.splice(normalIdx, 1)[0];
      this.droppedCount += 1;
      this.onDrop?.(dropped);
      this.buffer.push(event);
      return true;
    }

    if (event.priority !== 'critical') {
      // 队列中全为关键事件且新事件非关键，安全丢弃
      this.droppedCount += 1;
      this.onDrop?.(event);
      return false;
    }

    // 新事件是 critical，淘汰最旧的非头部事件
    const dropped = this.buffer.shift()!;
    this.droppedCount += 1;
    this.onDrop?.(dropped);
    this.buffer.push(event);
    return true;
  }

  drain(batchSize = 100): StreamEvent[] {
    return this.buffer.splice(0, batchSize);
  }

  size(): number {
    return this.buffer.length;
  }

  getMetrics(): {
    bufferSize: number;
    capacity: number;
    droppedCount: number;
    criticalCount: number;
  } {
    const criticalCount = this.buffer.filter((e) => e.priority === 'critical').length;
    return {
      bufferSize: this.buffer.length,
      capacity: this.capacity,
      droppedCount: this.droppedCount,
      criticalCount,
    };
  }

  clear(): void {
    this.buffer = [];
    this.droppedCount = 0;
  }
}
