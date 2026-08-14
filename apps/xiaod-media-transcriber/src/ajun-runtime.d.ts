declare module 'ajun-runtime/task-run-event-store' {
  export class TaskRunEventStore {
    constructor(databasePath: string);
    appendTaskRunEvent(event: Readonly<Record<string, unknown>>): unknown;
    close(): void;
  }
}
