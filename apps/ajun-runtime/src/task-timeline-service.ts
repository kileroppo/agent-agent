import { presentTaskTimelinePage } from './task-timeline-presentation.ts';
const ALLOWED_FILTERS: any = new Set(['failure', 'fallback', 'cost', 'quality']);
export class TaskTimelineService {
    eventStore: any;
    constructor({ eventStore }: any) {
        if (!eventStore || typeof eventStore.queryTaskRunEvents !== 'function') {
            throw new TypeError('TaskTimelineService 需要 queryTaskRunEvents 事件存储。');
        }
        this.eventStore = eventStore;
    }
    async read(taskId: any, input: any = {}): Promise<any> {
        const query: any = normalizeTaskTimelineQuery(taskId, input);
        const page: any = await this.eventStore.queryTaskRunEvents({
            taskId: query.taskId,
            cursor: query.cursor,
            limit: query.limit,
            filters: query.filters,
        });
        return presentTaskTimelinePage(page, query);
    }
}
export function normalizeTaskTimelineQuery(taskId: any, input: any = {}): any {
    const normalizedTaskId: any = String(taskId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedTaskId)) {
        throw timelineQueryError('invalid_task_id', '任务编号格式不正确。');
    }
    const rawLimit: any = Number(input.limit ?? 30);
    const limit: any = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;
    const cursor: any = String(input.cursor || '').trim();
    if (cursor && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512)) {
        throw timelineQueryError('invalid_cursor', '时间线游标无效。');
    }
    const filters: any = normalizeFilters(input.filters ?? input.filter);
    return {
        taskId: normalizedTaskId,
        audience: input.audience === 'local-owner' ? 'local-owner' : 'lan',
        cursor: cursor || null,
        limit,
        filters,
    };
}
function normalizeFilters(value: any): any {
    const values: any = Array.isArray(value) ? value : String(value || '').split(',');
    const filters: any[] = [...new Set(values.map((item: any): any => String(item || '').trim()).filter(Boolean))];
    const invalid: any = filters.find((item: any): any => !ALLOWED_FILTERS.has(item));
    if (invalid)
        throw timelineQueryError('invalid_filter', `不支持的时间线筛选：${invalid}`);
    return filters;
}
function timelineQueryError(code: any, message: any): any {
    const error: any = new Error(message);
    error.code = code;
    error.statusCode = 400;
    return error;
}
export const taskTimelineQueryContract: any = Object.freeze({
    allowedFilters: ALLOWED_FILTERS,
    defaultLimit: 30,
    maxLimit: 100,
});
