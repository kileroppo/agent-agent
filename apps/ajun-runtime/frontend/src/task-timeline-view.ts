const FILTER_LABELS: any = Object.freeze({
    failure: '故障', fallback: '切换', cost: '费用', quality: '质量',
});
export function renderTaskTimeline(payload: any, { escapeHtml = defaultEscapeHtml }: any = {}): any {
    const items: any = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) {
        return '<section class="record-detail-section task-timeline"><h3>运行过程</h3><p class="task-timeline-empty">暂时没有可展示的运行记录。</p></section>';
    }
    return `<section class="record-detail-section task-timeline" data-task-timeline>
    <div class="task-timeline-heading"><h3>运行过程</h3>${renderActiveFilters(payload?.filters, escapeHtml)}</div>
    <ol class="task-timeline-list">${items.map((item: any): any => renderTimelineItem(item, escapeHtml)).join('')}</ol>
    ${payload?.nextCursor ? '<button class="text-action task-timeline-more" type="button" data-task-timeline-more>继续加载</button>' : ''}
  </section>`;
}
export function createTaskTimelineLoader({ api, escapeHtml = defaultEscapeHtml }: any = {}): any {
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
            return renderTaskTimeline(page, { escapeHtml });
        },
        async loadMore(): Promise<any> {
            if (!page.nextCursor)
                return renderTaskTimeline(page, { escapeHtml });
            const next: any = await requestPage(api, taskId, filters, page.nextCursor);
            page = { ...next, items: [...page.items, ...next.items] };
            return renderTaskTimeline(page, { escapeHtml });
        },
        snapshot(): any { return structuredClone(page); },
    };
}
function renderTimelineItem(item: any, escapeHtml: any): any {
    const occurredAt: any = formatTime(item?.occurredAt);
    const technical: any = item?.technical && typeof item.technical === 'object'
        ? renderTechnical(item.technical, escapeHtml)
        : '';
    return `<li class="task-timeline-item ${escapeHtml(safeTone(item?.tone))}">
    <span class="task-timeline-dot" aria-hidden="true"></span>
    <div><div class="task-timeline-title"><strong>${escapeHtml(item?.title || '运行状态更新')}</strong>${occurredAt ? `<time datetime="${escapeHtml(item.occurredAt)}">${escapeHtml(occurredAt)}</time>` : ''}</div>
    <p>${escapeHtml(item?.summary || '任务运行状态已经更新。')}</p>${technical}</div>
  </li>`;
}
function renderTechnical(technical: any, escapeHtml: any): any {
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
    const artifacts: any = (technical.artifactRefs || []).map((item: any): any => `<li>${escapeHtml(item.title || item.type || item.artifactId)}</li>`).join('');
    const quality: any = technical.qualityResult
        ? `<div><dt>质量门</dt><dd>${escapeHtml(technical.qualityResult.status || technical.qualityResult.gateId || '已记录')}${technical.qualityResult.failedCriteria?.length ? ` · ${escapeHtml(technical.qualityResult.failedCriteria.join('；'))}` : ''}</dd></div>`
        : '';
    return `<details class="record-technical task-timeline-technical"><summary>技术详情</summary><dl>${rows.map(([label, value]: any): any => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}${quality}</dl>${artifacts ? `<strong>产物引用</strong><ul>${artifacts}</ul>` : ''}</details>`;
}
function renderActiveFilters(filters: any, escapeHtml: any): any {
    const labels: any = normalizeFilters(filters).map((filter: any): any => FILTER_LABELS[filter]).filter(Boolean);
    return labels.length ? `<span class="task-timeline-filter">仅看：${escapeHtml(labels.join('、'))}</span>` : '';
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
function defaultEscapeHtml(value: any): any {
    return String(value ?? '').replace(/[&<>"']/g, (character: any): any => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[character]);
}
