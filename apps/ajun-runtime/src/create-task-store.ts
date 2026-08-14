import path from 'node:path';
import { SQLiteTaskStore } from './sqlite-task-store.ts';
import { TaskStore } from './task-store.ts';
export function createTaskStore({ dataDir, mode = process.env.AGENT_ARMY_TASK_STORE || 'json', }: any = {}): any {
    if (!dataDir)
        throw new Error('dataDir 必填。');
    const normalized: any = String(mode || '').trim().toLowerCase();
    if (normalized === 'json')
        return new TaskStore(path.join(dataDir, 'runtime.json'));
    if (normalized === 'sqlite')
        return new SQLiteTaskStore(path.join(dataDir, 'runtime.sqlite'));
    throw new Error(`未知任务存储模式“${normalized}”，只支持 json 或 sqlite。`);
}
