type ReconciliationTaskQuery = {
  taskType?: string;
  taskTypes?: string[];
  views?: Array<'active' | 'needs_action' | 'completed' | 'all'>;
  predicate?: (task: any) => boolean;
};

const PAGE_SIZE = 50;

export async function queryReconciliationTasks(store: any, {
  taskType,
  taskTypes = taskType ? [taskType] : [],
  views = ['all'],
  predicate = () => true,
}: ReconciliationTaskQuery = {}): Promise<any[]> {
  if (typeof store?.queryTasks !== 'function') {
    const tasks = typeof store?.list === 'function' ? await store.list() : [];
    return tasks.filter((task: any) => matchesTaskType(task, taskTypes) && predicate(task));
  }

  const queries = taskTypes.length > 0
    ? taskTypes.flatMap((selectedTaskType) => views.map((view) => ({ taskType:selectedTaskType, view })))
    : views.map((view) => ({ view }));
  const selected = new Map<string, any>();
  for (const query of queries) {
    let cursor: string | null = null;
    do {
      const page: any = await store.queryTasks({ ...query, includeRoutine:true, limit:PAGE_SIZE, cursor });
      for (const task of page?.items || []) {
        if (predicate(task)) selected.set(task.taskId, task);
      }
      cursor = page?.nextCursor || null;
    } while (cursor);
  }
  return [...selected.values()];
}

function matchesTaskType(task: any, taskTypes: string[]) {
  return taskTypes.length === 0 || taskTypes.includes(String(task?.taskType || ''));
}
