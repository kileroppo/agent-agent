import path from 'node:path';
import { createTaskStore } from '../create-task-store.js';
import { TaskRunEventRetention } from '../task-run-event-retention.js';
import { TaskRunEventStore } from '../task-run-event-store.js';
import { TaskTimelineService } from '../task-timeline-service.js';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createRuntimeStateComposition({
  configuration,
  logger = console,
  timers = systemTimers,
} = {}) {
  const { dataDir } = configuration.paths;
  const store = createTaskStore({
    dataDir,
    mode:configuration.persistence.taskStoreMode,
  });
  const taskRunEvents = new TaskRunEventStore(path.join(dataDir, 'task-run-events.sqlite'));
  const taskRunEventRetention = new TaskRunEventRetention({
    eventStore:taskRunEvents,
    mode:configuration.persistence.eventRetentionMode,
  });
  runRetention(taskRunEventRetention, logger, true);
  const retentionTimer = timers.setInterval(
    () => runRetention(taskRunEventRetention, logger, false),
    RETENTION_INTERVAL_MS,
  );
  retentionTimer?.unref?.();
  const taskTimeline = new TaskTimelineService({ eventStore:taskRunEvents });
  let closed = false;

  return Object.freeze({
    store,
    taskRunEvents,
    taskRunEventRetention,
    taskTimeline,
    close() {
      if (closed) return;
      closed = true;
      timers.clearInterval(retentionTimer);
      taskRunEvents.close();
    },
  });
}

function runRetention(retention, logger, initial) {
  try {
    retention.runOnce();
  } catch {
    logger.warn(initial
      ? '任务运行明细启动清理未完成，服务会先继续运行并在下个周期重试。'
      : '任务运行明细保留策略本轮未完成，将在下个周期继续。');
  }
}

const systemTimers = Object.freeze({
  setInterval:(callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval:(timer) => clearInterval(timer),
});
