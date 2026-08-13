export class TaskRunEventRetention {
  constructor({
    eventStore,
    retentionDays = null,
    retentionDaysByClass = { transient:7, detail:30, audit:365 },
    mode = 'dry-run',
    clock = () => new Date().toISOString(),
  }) {
    if (!eventStore?.cleanupExpiredDetails) throw new Error('运行事件清理器需要 Event Store。');
    if (!['dry-run', 'apply'].includes(mode)) throw new Error('运行事件清理模式无效。');
    this.eventStore = eventStore;
    this.retentionDays = retentionDays;
    this.retentionDaysByClass = retentionDaysByClass;
    this.mode = mode;
    this.clock = clock;
    this.lastResult = null;
  }

  runOnce() {
    const options = {
      now:this.clock(),
      ...(this.retentionDays == null
        ? { retentionDaysByClass:this.retentionDaysByClass }
        : { retentionDays:this.retentionDays }),
    };
    this.lastResult = this.mode === 'apply'
      ? this.eventStore.cleanupExpiredDetails(options)
      : this.eventStore.previewExpiredEvents(options);
    return this.lastResult;
  }
}
