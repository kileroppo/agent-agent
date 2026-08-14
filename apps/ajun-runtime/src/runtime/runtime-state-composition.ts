import path from 'node:path';
import { createTaskStore } from '../create-task-store.ts';
import { TaskRunEventRetention } from '../task-run-event-retention.ts';
import { TaskRunEventStore } from '../task-run-event-store.ts';
import { TaskTimelineService } from '../task-timeline-service.ts';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RuntimeStateTimers = Readonly<{
  setInterval(callback: () => void, intervalMs: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}>;

export type RuntimeStateCompositionInput = Readonly<{
  configuration: Readonly<{
    paths: Readonly<{ dataDir: string }>;
    persistence: Readonly<{
      taskStoreMode: string;
      eventRetentionMode: string;
    }>;
  }>;
  logger?: Pick<Console, 'warn'>;
  timers?: RuntimeStateTimers;
}>;

export function createRuntimeStateComposition({
  configuration,
  logger = console,
  timers = systemTimers,
}: RuntimeStateCompositionInput) {
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

function runRetention(
  retention: Readonly<{ runOnce(): unknown }>,
  logger: Pick<Console, 'warn'>,
  initial: boolean,
) {
  try {
    retention.runOnce();
  } catch {
    logger.warn(initial
      ? '任务运行明细启动清理未完成，服务会先继续运行并在下个周期重试。'
      : '任务运行明细保留策略本轮未完成，将在下个周期继续。');
  }
}

const systemTimers = Object.freeze({
  setInterval:(callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
  clearInterval:(timer: NodeJS.Timeout) => clearInterval(timer),
});
