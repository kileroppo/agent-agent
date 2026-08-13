export class TaskRunEventRetention {
  constructor({ eventStore, retentionDays = 90, clock = () => new Date().toISOString() }) {
    if (!eventStore?.cleanupExpiredDetails) throw new Error('运行事件清理器需要 Event Store。');
    this.eventStore = eventStore;
    this.retentionDays = retentionDays;
    this.clock = clock;
  }

  runOnce() {
    return this.eventStore.cleanupExpiredDetails({ now:this.clock(), retentionDays:this.retentionDays });
  }
}
