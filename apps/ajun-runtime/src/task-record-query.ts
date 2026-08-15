import { isOwnerActionableTask } from './task-overview-focus.ts';
const VIEW_STATUSES: any = Object.freeze({
    needs_action: new Set(['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error']),
    completed: new Set(['succeeded', 'cancelled', 'rejected', 'stopped']),
});
export const TASK_RECORD_VIEWS: any = Object.freeze(['needs_action', 'active', 'completed', 'all']);
export function taskRecordView(status: any): any {
    const normalized: any = String(status || '').trim();
    if (VIEW_STATUSES.needs_action.has(normalized))
        return 'needs_action';
    if (VIEW_STATUSES.completed.has(normalized))
        return 'completed';
    return 'active';
}
export function isRoutineHealthTask(task: any): any {
    if (task?.taskType !== 'operations.health-review' || task?.source?.channel !== 'paperclip')
        return false;
    const title: any = String(task.input?.title || '').trim();
    const description: any = String(task.input?.description || '').trim();
    return title === 'A君定时本机巡检' || description.startsWith('agent-army:operations-health-v1');
}
export function isHiddenRoutineTask(task: any, includeRoutine: any = false): any {
    return !includeRoutine && isRoutineHealthTask(task);
}
export function isInternalDiagnosticTask(task: any, tasks: any = []): any {
    if (isReadOnlyDiagnosisTask(task))
        return true;
    if (task?.taskType !== 'governance.assurance-review')
        return false;
    const parentTaskId: any = String(task?.parentTaskId || '').trim();
    return Boolean(parentTaskId) && tasks.some((candidate: any): any => candidate?.taskId === parentTaskId && isReadOnlyDiagnosisTask(candidate));
}
export function taskRecordViewForTask(task: any, tasks: any = []): any {
    if (VIEW_STATUSES.completed.has(task?.status))
        return 'completed';
    if (['pending_approval', 'waiting_approval', 'paused', 'blocked', 'error'].includes(task?.status))
        return 'needs_action';
    if (['failed', 'needs_input', 'waiting_test'].includes(task?.status)
        && isOwnerActionableTask(task, tasks))
        return 'needs_action';
    if (['queued', 'running', 'pausing', 'waiting_worker', 'recovery_pending', 'technical_repair'].includes(task?.status))
        return 'active';
    return 'archived';
}
export function normalizeTaskRecordQuery(input: any = {}): any {
    const requestedView: any = String(input.view || 'needs_action').trim();
    const view: any = TASK_RECORD_VIEWS.includes(requestedView) ? requestedView : 'needs_action';
    const limit: any = Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 24, 50));
    const since: any = validIso(input.since);
    const until: any = validIso(input.until);
    return {
        view,
        q: clean(input.q, 160).toLocaleLowerCase('zh-CN'),
        agentId: clean(input.agentId, 80),
        taskType: clean(input.taskType, 160),
        since,
        until,
        includeRoutine: input.includeRoutine === true || input.includeRoutine === 'true' || input.includeRoutine === '1',
        limit,
        cursor: decodeTaskRecordCursor(input.cursor),
    };
}
export function queryTaskRecordsInMemory(tasks: any, input: any = {}): any {
    const query: any = normalizeTaskRecordQuery(input);
    const ordered: any = [...(Array.isArray(tasks) ? tasks : [])].sort(compareTaskRecords);
    const baseMatches: any = ordered.filter((task: any): any => matchesBaseQuery(task, query));
    const hiddenRoutine: any = baseMatches.filter((task: any): any => isHiddenRoutineTask(task, query.includeRoutine));
    const visible: any = baseMatches.filter((task: any): any => !isHiddenRoutineTask(task, query.includeRoutine) && !isInternalDiagnosticTask(task, ordered));
    const counts: any = Object.fromEntries(TASK_RECORD_VIEWS.map((view: any): any => [
        view,
        visible.filter((task: any): any => view === 'all' || taskRecordViewForTask(task, ordered) === view).length,
    ]));
    const selected: any = visible.filter((task: any): any => query.view === 'all' || taskRecordViewForTask(task, ordered) === query.view);
    const afterCursor: any = query.cursor
        ? selected.filter((task: any): any => isAfterCursor(task, query.cursor))
        : selected;
    const page: any = afterCursor.slice(0, query.limit + 1);
    const hasMore: any = page.length > query.limit;
    const items: any = (hasMore ? page.slice(0, query.limit) : page).map((task: any): any => ({
        ...task,
        recordView: taskRecordViewForTask(task, ordered),
    }));
    return {
        items,
        total: counts[query.view],
        counts,
        nextCursor: hasMore ? encodeTaskRecordCursor(items.at(-1)) : null,
        revision: recordRevision(selected, counts),
        routineSummary: routineSummary(hiddenRoutine),
        query: { ...query, cursor: query.cursor ? input.cursor : null },
    };
}
function isReadOnlyDiagnosisTask(task: any): any {
    return task?.taskType === 'operations.failure-recovery'
        && task?.source?.channel === 'internal-recovery'
        && task?.recovery?.mode === 'read_only_diagnosis'
        && task?.input?.context?.diagnosisOnly === true;
}
export function encodeTaskRecordCursor(task: any): any {
    if (!task)
        return null;
    return Buffer.from(JSON.stringify([
        String(task.updatedAt || task.createdAt || ''),
        String(task.taskId || ''),
    ])).toString('base64url');
}
export function decodeTaskRecordCursor(value: any): any {
    const encoded: any = String(value || '').trim();
    if (!encoded)
        return null;
    try {
        const [updatedAt, taskId] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!validIso(updatedAt) || !String(taskId || '').trim())
            return null;
        return { updatedAt, taskId: String(taskId) };
    }
    catch {
        return null;
    }
}
export function taskRecordStatusSets(): any {
    return {
        needsAction: [...VIEW_STATUSES.needs_action],
        completed: [...VIEW_STATUSES.completed],
    };
}
function matchesBaseQuery(task: any, query: any): any {
    const updatedAt: any = String(task.updatedAt || task.createdAt || '');
    if (query.since && updatedAt < query.since)
        return false;
    if (query.until && updatedAt > query.until)
        return false;
    if (query.agentId && String(task.assigneeAgentId || '') !== query.agentId)
        return false;
    if (query.taskType && String(task.taskType || '') !== query.taskType)
        return false;
    if (!query.q)
        return true;
    const haystack: any = [
        task.taskId,
        task.input?.title,
        task.input?.description,
        task.assigneeAgentId,
        task.taskType,
        task.status,
    ].map((value: any): any => String(value || '').toLocaleLowerCase('zh-CN')).join('\n');
    return query.q.split(/\s+/).every((term: any): any => haystack.includes(term));
}
function isAfterCursor(task: any, cursor: any): any {
    const updatedAt: any = String(task.updatedAt || task.createdAt || '');
    return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && String(task.taskId || '') < cursor.taskId);
}
function compareTaskRecords(left: any, right: any): any {
    const byTime: any = String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''));
    return byTime || String(right.taskId || '').localeCompare(String(left.taskId || ''));
}
function recordRevision(tasks: any, counts: any): any {
    const first: any = tasks[0];
    return [first?.updatedAt || first?.createdAt || '', first?.taskId || '', counts.all || 0].join(':');
}
function routineSummary(tasks: any): any {
    const today: any = new Date().toISOString().slice(0, 10);
    return {
        hidden: tasks.length,
        today: tasks.filter((task: any): any => String(task.updatedAt || task.createdAt || '').startsWith(today)).length,
        attention: tasks.filter((task: any): any => taskRecordView(task.status) === 'needs_action').length,
        latestUpdatedAt: tasks[0]?.updatedAt || tasks[0]?.createdAt || null,
    };
}
function validIso(value: any): any {
    const text: any = String(value || '').trim();
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}
function clean(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
