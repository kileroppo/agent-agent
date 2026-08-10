import { isOwnerActionableTask } from './task-overview-focus.ts';

const VIEW_STATUSES = Object.freeze({
  needs_action:new Set(['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error']),
  completed:new Set(['succeeded', 'cancelled', 'rejected', 'stopped']),
});

export const TASK_RECORD_VIEWS = Object.freeze(['needs_action', 'active', 'completed', 'all']);

export function taskRecordView(status) {
  const normalized = String(status || '').trim();
  if (VIEW_STATUSES.needs_action.has(normalized)) return 'needs_action';
  if (VIEW_STATUSES.completed.has(normalized)) return 'completed';
  return 'active';
}

export function isRoutineHealthTask(task) {
  if (task?.taskType !== 'operations.health-review' || task?.source?.channel !== 'paperclip') return false;
  const title = String(task.input?.title || '').trim();
  const description = String(task.input?.description || '').trim();
  return title === 'A君定时本机巡检' || description.startsWith('agent-army:operations-health-v1');
}

export function isHiddenRoutineTask(task, includeRoutine = false) {
  return !includeRoutine && isRoutineHealthTask(task);
}

export function taskRecordViewForTask(task, tasks = []) {
  if (VIEW_STATUSES.completed.has(task?.status)) return 'completed';
  if (['pending_approval', 'waiting_approval', 'paused', 'blocked', 'error'].includes(task?.status)) return 'needs_action';
  if (['failed', 'needs_input', 'waiting_test'].includes(task?.status)
    && isOwnerActionableTask(task, tasks)) return 'needs_action';
  if (['queued', 'running', 'pausing', 'waiting_worker', 'recovery_pending', 'technical_repair'].includes(task?.status)) return 'active';
  return 'archived';
}

export function normalizeTaskRecordQuery(input = {}) {
  const requestedView = String(input.view || 'needs_action').trim();
  const view = TASK_RECORD_VIEWS.includes(requestedView) ? requestedView : 'needs_action';
  const limit = Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 24, 50));
  const since = validIso(input.since);
  const until = validIso(input.until);
  return {
    view,
    q:clean(input.q, 160).toLocaleLowerCase('zh-CN'),
    agentId:clean(input.agentId, 80),
    taskType:clean(input.taskType, 160),
    since,
    until,
    includeRoutine:input.includeRoutine === true || input.includeRoutine === 'true' || input.includeRoutine === '1',
    limit,
    cursor:decodeTaskRecordCursor(input.cursor),
  };
}

export function queryTaskRecordsInMemory(tasks, input = {}) {
  const query = normalizeTaskRecordQuery(input);
  const ordered = [...(Array.isArray(tasks) ? tasks : [])].sort(compareTaskRecords);
  const baseMatches = ordered.filter((task) => matchesBaseQuery(task, query));
  const hiddenRoutine = baseMatches.filter((task) => isHiddenRoutineTask(task, query.includeRoutine));
  const visible = baseMatches.filter((task) => !isHiddenRoutineTask(task, query.includeRoutine));
  const counts = Object.fromEntries(TASK_RECORD_VIEWS.map((view) => [
    view,
    visible.filter((task) => view === 'all' || taskRecordViewForTask(task, ordered) === view).length,
  ]));
  const selected = visible.filter((task) => query.view === 'all' || taskRecordViewForTask(task, ordered) === query.view);
  const afterCursor = query.cursor
    ? selected.filter((task) => isAfterCursor(task, query.cursor))
    : selected;
  const page = afterCursor.slice(0, query.limit + 1);
  const hasMore = page.length > query.limit;
  const items = (hasMore ? page.slice(0, query.limit) : page).map((task) => ({
    ...task,
    recordView:taskRecordViewForTask(task, ordered),
  }));
  return {
    items,
    total:counts[query.view],
    counts,
    nextCursor:hasMore ? encodeTaskRecordCursor(items.at(-1)) : null,
    revision:recordRevision(selected, counts),
    routineSummary:routineSummary(hiddenRoutine),
    query:{ ...query, cursor:query.cursor ? input.cursor : null },
  };
}

export function encodeTaskRecordCursor(task) {
  if (!task) return null;
  return Buffer.from(JSON.stringify([
    String(task.updatedAt || task.createdAt || ''),
    String(task.taskId || ''),
  ])).toString('base64url');
}

export function decodeTaskRecordCursor(value) {
  const encoded = String(value || '').trim();
  if (!encoded) return null;
  try {
    const [updatedAt, taskId] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!validIso(updatedAt) || !String(taskId || '').trim()) return null;
    return { updatedAt, taskId:String(taskId) };
  } catch {
    return null;
  }
}

export function taskRecordStatusSets() {
  return {
    needsAction:[...VIEW_STATUSES.needs_action],
    completed:[...VIEW_STATUSES.completed],
  };
}

function matchesBaseQuery(task, query) {
  const updatedAt = String(task.updatedAt || task.createdAt || '');
  if (query.since && updatedAt < query.since) return false;
  if (query.until && updatedAt > query.until) return false;
  if (query.agentId && String(task.assigneeAgentId || '') !== query.agentId) return false;
  if (query.taskType && String(task.taskType || '') !== query.taskType) return false;
  if (!query.q) return true;
  const haystack = [
    task.taskId,
    task.input?.title,
    task.input?.description,
    task.assigneeAgentId,
    task.taskType,
    task.status,
  ].map((value) => String(value || '').toLocaleLowerCase('zh-CN')).join('\n');
  return query.q.split(/\s+/).every((term) => haystack.includes(term));
}

function isAfterCursor(task, cursor) {
  const updatedAt = String(task.updatedAt || task.createdAt || '');
  return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && String(task.taskId || '') < cursor.taskId);
}

function compareTaskRecords(left, right) {
  const byTime = String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''));
  return byTime || String(right.taskId || '').localeCompare(String(left.taskId || ''));
}

function recordRevision(tasks, counts) {
  const first = tasks[0];
  return [first?.updatedAt || first?.createdAt || '', first?.taskId || '', counts.all || 0].join(':');
}

function routineSummary(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    hidden:tasks.length,
    today:tasks.filter((task) => String(task.updatedAt || task.createdAt || '').startsWith(today)).length,
    attention:tasks.filter((task) => taskRecordView(task.status) === 'needs_action').length,
    latestUpdatedAt:tasks[0]?.updatedAt || tasks[0]?.createdAt || null,
  };
}

function validIso(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
