type RuntimeTask = Record<string, any>;

type TaskRunEventStore = {
  appendTaskRunEvent(event: RuntimeTask): unknown;
};

export class TaskLifecycleEventRecorder {
  constructor(input?: { eventStore?: TaskRunEventStore | null });
  recordCreated(task: RuntimeTask, startedAt?: string | null): void;
  recordPersisted(task: RuntimeTask, input?: {
    previousTask?: RuntimeTask | null;
    startedAt?: string | null;
    force?: boolean;
  }): void;
}
