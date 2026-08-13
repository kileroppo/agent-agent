import { presentTaskTimelinePage } from './task-timeline-presentation.js';

const ALLOWED_FILTERS = new Set(['failure', 'fallback', 'cost', 'quality']);

export class TaskTimelineService {
  constructor({ eventStore }) {
    if (!eventStore || typeof eventStore.queryTaskRunEvents !== 'function') {
      throw new TypeError('TaskTimelineService 需要 queryTaskRunEvents 事件存储。');
    }
    this.eventStore = eventStore;
  }

  async read(taskId, input = {}) {
    const query = normalizeTaskTimelineQuery(taskId, input);
    const page = await this.eventStore.queryTaskRunEvents({
      taskId:query.taskId,
      cursor:query.cursor,
      limit:query.limit,
      filters:query.filters,
    });
    return presentTaskTimelinePage(page, query);
  }
}

export function normalizeTaskTimelineQuery(taskId, input = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedTaskId)) {
    throw timelineQueryError('invalid_task_id', '任务编号格式不正确。');
  }
  const rawLimit = Number(input.limit ?? 30);
  const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;
  const cursor = String(input.cursor || '').trim();
  if (cursor && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512)) {
    throw timelineQueryError('invalid_cursor', '时间线游标无效。');
  }
  const filters = normalizeFilters(input.filters ?? input.filter);
  return {
    taskId:normalizedTaskId,
    audience:input.audience === 'local-owner' ? 'local-owner' : 'lan',
    cursor:cursor || null,
    limit,
    filters,
  };
}

function normalizeFilters(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const filters = [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
  const invalid = filters.find((item) => !ALLOWED_FILTERS.has(item));
  if (invalid) throw timelineQueryError('invalid_filter', `不支持的时间线筛选：${invalid}`);
  return filters;
}

function timelineQueryError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

export const taskTimelineQueryContract = Object.freeze({
  allowedFilters:ALLOWED_FILTERS,
  defaultLimit:30,
  maxLimit:100,
});
