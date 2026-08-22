import { html, raw, escapeHtml } from './html.js';
const FILTER_LABELS: any = Object.freeze({
    failure: '故障', fallback: '切换', cost: '费用', quality: '质量',
});
export function renderTaskTimeline(payload: any, _options: any = {}): any {
    const items: any = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) {
        return '<details class="record-detail-section task-timeline" data-task-timeline open><summary>运行过程</summary><p class="task-timeline-empty">暂时没有可展示的运行记录。</p></details>';
    }
    return html`<details class="record-detail-section task-timeline" data-task-timeline open>
    <summary><span>运行过程</span><small>${items.length} 条</small></summary>
    ${raw(renderActiveFilters(payload?.filters))}
    <ol class="task-timeline-list">${raw(items.map((item: any): any => renderTimelineItem(item)).join(''))}</ol>
    ${raw(payload?.nextCursor ? '<button class="text-action task-timeline-more" type="button" data-task-timeline-more>继续加载</button>' : '')}
  </details>`;
}
export function createTaskTimelineLoader({ api }: any = {}): any {
    if (typeof api !== 'function')
        throw new TypeError('任务时间线需要 api 读取函数。');
    let taskId: any = '';
    let filters: any = [];
    let page: any = { items: [], nextCursor: null, filters: [] };
    return {
        async load(nextTaskId: any, { nextFilters = [] }: any = {}): Promise<any> {
            taskId = String(nextTaskId || '');
            filters = normalizeFilters(nextFilters);
            page = await requestPage(api, taskId, filters, '');
            return renderTaskTimeline(page);
        },
        async loadMore(): Promise<any> {
            if (!page.nextCursor)
                return renderTaskTimeline(page);
            const next: any = await requestPage(api, taskId, filters, page.nextCursor);
            page = { ...next, items: [...page.items, ...next.items] };
            return renderTaskTimeline(page);
        },
        snapshot(): any { return structuredClone(page); },
    };
}
function renderTimelineItem(item: any): any {
    const occurredAt: any = formatTime(item?.occurredAt);
    const technical: any = item?.technical && typeof item.technical === 'object'
        ? renderTechnical(item.technical)
        : '';
    const tone: any = safeTone(item?.tone);
    const icon: any = ({ success: 'check', warning: 'alert', danger: 'alert', active: 'clock' } as Record<string, string>)[tone];
    return html`<li class="task-timeline-item ${tone}">
    <svg class="task-timeline-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
    <div><div class="task-timeline-title"><strong>${item?.title || '运行状态更新'}</strong>${raw(occurredAt ? html`<time datetime="${item.occurredAt}">${occurredAt}</time>` : '')}</div>
    <p>${item?.summary || '任务运行状态已经更新。'}</p>${raw(technical)}</div>
  </li>`;
}
function renderTechnical(technical: any): any {
    const rows: any = [
        ['能力', technical.capabilityId],
        ['路线', technical.routeId],
        ['Provider', technical.provider],
        ['模型', technical.model],
        ['尝试', technical.attempt],
        ['耗时', Number.isFinite(technical.durationMs) ? `${technical.durationMs} ms` : ''],
        ['错误代码', technical.errorCode],
        ['Policy', technical.policyDecisionId],
        ['检查点', technical.checkpointRef],
        ['执行回执', technical.receiptId],
        ['费用', technical.cost ? `${technical.cost.amount} ${technical.cost.currency}` : ''],
        ['排障摘要', technical.safeSummary],
    ].filter(([, value]: any): any => value !== '' && value !== null && value !== undefined);
    if (!rows.length && !(technical.artifactRefs || []).length && !technical.qualityResult)
        return '';
    const artifacts: any = (technical.artifactRefs || []).map((item: any): any => html`<li>${item.title || item.type || item.artifactId}</li>`).join('');
    const quality: any = technical.qualityResult
        ? html`<div><dt>质量门</dt><dd>${technical.qualityResult.status || technical.qualityResult.gateId || '已记录'}${raw(technical.qualityResult.failedCriteria?.length ? html` · ${technical.qualityResult.failedCriteria.join('；')}` : '')}</dd></div>`
        : '';
    const rowsHtml: any = rows.map(([label, value]: any): any => html`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    return html`<details class="record-technical task-timeline-technical"><summary>技术详情</summary><dl>${raw(rowsHtml)}${raw(quality)}</dl>${raw(artifacts ? `<strong>产物引用</strong><ul>${artifacts}</ul>` : '')}</details>`;
}
function renderActiveFilters(filters: any): any {
    const labels: any = normalizeFilters(filters).map((filter: any): any => FILTER_LABELS[filter]).filter(Boolean);
    return labels.length ? html`<span class="task-timeline-filter">仅看：${labels.join('、')}</span>` : '';
}
async function requestPage(api: any, taskId: any, filters: any, cursor: any): Promise<any> {
    const params: any = new URLSearchParams({ limit: '30' });
    if (cursor)
        params.set('cursor', cursor);
    for (const filter of filters)
        params.append('filter', filter);
    return api(`/api/tasks/${encodeURIComponent(taskId)}/timeline?${params}`);
}
function normalizeFilters(filters: any): any {
    return [...new Set((Array.isArray(filters) ? filters : []).filter((item: any): any => FILTER_LABELS[item]))];
}
function safeTone(value: any): any {
    return ['active', 'success', 'warning', 'danger'].includes(value) ? value : 'active';
}
function formatTime(value: any): any {
    const timestamp: any = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

