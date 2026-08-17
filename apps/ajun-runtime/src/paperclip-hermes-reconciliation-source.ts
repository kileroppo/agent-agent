import { pendingPaperclipCompletion } from './paperclip-assignment-completion.ts';
import { queryReconciliationTasks } from './reconciliation-task-query.ts';

export class PaperclipHermesReconciliationSource {
  store: any;
  initialized = false;
  trackedTaskIds = new Set<string>();

  constructor(store: any) {
    this.store = store;
  }

  async list(): Promise<any[]> {
    const active = await queryReconciliationTasks(this.store, {
      views:['active'],
      predicate:isDelegatedHermesTask,
    });
    const known = this.initialized
      ? await this.readTrackedTasks()
      : await queryReconciliationTasks(this.store, { views:['all'], predicate:isRelevant });
    this.initialized = true;
    const tasks = [...new Map([...active, ...known].map((task: any) => [task.taskId, task])).values()];
    for (const task of tasks) {
      if (isRelevant(task)) this.trackedTaskIds.add(task.taskId);
      else this.trackedTaskIds.delete(task.taskId);
    }
    return tasks.filter(isRelevant);
  }

  async readTrackedTasks(): Promise<any[]> {
    if (this.trackedTaskIds.size === 0) return [];
    if (typeof this.store?.getTask === 'function') {
      const tasks = await Promise.all([...this.trackedTaskIds].map((taskId) => this.store.getTask(taskId)));
      return tasks.filter(Boolean);
    }
    return queryReconciliationTasks(this.store, {
      views:['all'],
      predicate:(task: any) => this.trackedTaskIds.has(task.taskId),
    });
  }
}

function isRelevant(task: any) {
  return Boolean(pendingPaperclipCompletion(task)) || isDelegatedHermesTask(task);
}

function isDelegatedHermesTask(task: any) {
  return task?.status === 'running'
    && task.taskType !== 'operations.technical-repair'
    && task.execution?.owner === 'paperclip-hermes'
    && Boolean(task.governance?.paperclipIssueId);
}
