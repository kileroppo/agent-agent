declare module 'ajun-runtime/task-run-event-store' {
  export class TaskRunEventStore {
    constructor(databasePath: string);
    appendTaskRunEvent(event: Readonly<Record<string, unknown>>): unknown;
    queryTaskRunEvents(input?: Readonly<Record<string, unknown>>): { items: any[]; nextCursor?: any };
    close(): void;
  }
}
