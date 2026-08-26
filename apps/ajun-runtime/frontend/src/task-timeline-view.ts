import { html, raw, escapeHtml } from './html.js';

const FILTER_LABELS: Record<string, string> = Object.freeze({
    failure: '故障',
    fallback: '切换',
    cost: '费用',
    quality: '质量',
});

export function renderTaskTimeline(payload: any, options: { showAllDetails?: boolean } = {}): string {
    const rawItems: any[] = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
        return '<details class="record-detail-section task-timeline" data-task-timeline open><summary>过程</summary><p class="task-timeline-empty">没有过程记录。</p></details>';
    }

    // 1. Identify key business milestones vs raw noisy trace events
    const { milestones, rawTrace } = partitionTimelineItems(rawItems);

    // Render milestone highlights list (only when multiple items exist)
    const showMilestoneSection = milestones.length > 0;
    const milestonesHtml = showMilestoneSection
        ? html`
            <div class="timeline-milestones-section">
                <div class="timeline-section-header">
                    <div class="timeline-header-title">
                        <svg class="timeline-header-icon" aria-hidden="true"><use href="#icon-spark"></use></svg>
                        <strong>实施关键进展 (${milestones.length})</strong>
                    </div>
                    <span class="timeline-header-tip">已自动提炼业务节点</span>
                </div>
                <ol class="timeline-milestones-list">
                    ${raw(milestones.map((item, idx) => renderMilestoneItem(item, idx === milestones.length - 1)).join(''))}
                </ol>
            </div>
        `
        : '';

    // Render detailed items list
    const itemsHtml = rawTrace.map((item) => renderTimelineItem(item)).join('');

    return html`
        <details class="record-detail-section task-timeline" data-task-timeline open>
            <summary><span>过程</span><small>${rawItems.length}</small></summary>
            ${raw(renderActiveFilters(payload?.filters))}
            ${raw(showMilestoneSection ? milestonesHtml : '')}
            <div class="timeline-full-trace-header">
                <span class="trace-label">详细过程记录：</span>
            </div>
            <ol class="task-timeline-list">
                ${raw(itemsHtml)}
            </ol>
            ${raw(payload?.nextCursor ? '<button class="text-action task-timeline-more" type="button" data-task-timeline-more>继续加载</button>' : '')}
        </details>
    `;
}

function partitionTimelineItems(items: any[]): { milestones: any[]; rawTrace: any[] } {
    const milestones: any[] = [];
    const rawTrace: any[] = [];
    let lastSummary = '';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isMilestone = isHighValueMilestone(item, i, items.length);

        if (isMilestone) {
            if (item.summary !== lastSummary) {
                milestones.push(item);
                lastSummary = item.summary;
            }
        }
        rawTrace.push(item);
    }

    if (milestones.length === 0 && items.length > 0) {
        milestones.push(items[0]);
    }

    return { milestones, rawTrace };
}

function isHighValueMilestone(item: any, index: number, total: number): boolean {
    if (index === 0 || index === total - 1) return true;
    if (item?.technical?.qualityResult || (item?.technical?.artifactRefs && item.technical.artifactRefs.length > 0)) {
        return true;
    }
    if (['danger', 'warning'].includes(item?.tone)) {
        return true;
    }
    const title = String(item?.title || '').toLowerCase();
    const summary = String(item?.summary || '').toLowerCase();
    const keywords = ['开始', '认领', '生成', '交付', '审核', '复核', '完成', '验收', '失败', '异常', '中断', '创建', '转录', '采纳'];
    return keywords.some(k => title.includes(k) || summary.includes(k));
}

function renderMilestoneItem(item: any, isLatest: boolean): string {
    const occurredAt = formatTime(item?.occurredAt);
    const tone = safeTone(item?.tone);
    const icon = ({ success: 'check', warning: 'alert', danger: 'alert', active: 'clock' } as Record<string, string>)[tone] || 'clock';

    return html`
        <li class="milestone-item is-${tone} ${isLatest ? 'is-latest' : ''}">
            <div class="milestone-badge-wrapper">
                <span class="milestone-dot">
                    <svg class="milestone-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
                </span>
            </div>
            <div class="milestone-body">
                <div class="milestone-header">
                    <strong class="milestone-title">${item?.title || '实施节点'}</strong>
                    ${raw(occurredAt ? html`<time class="milestone-time" datetime="${item.occurredAt}">${occurredAt}</time>` : '')}
                </div>
                ${raw(item?.summary ? html`<p class="milestone-summary">${item.summary}</p>` : '')}
            </div>
        </li>
    `;
}

function renderTimelineItem(item: any): string {
    const occurredAt = formatTime(item?.occurredAt);
    const technical = item?.technical && typeof item.technical === 'object'
        ? renderTechnical(item.technical)
        : '';
    const tone = safeTone(item?.tone);
    const icon = ({ success: 'check', warning: 'alert', danger: 'alert', active: 'clock' } as Record<string, string>)[tone] || 'clock';

    return html`
        <li class="task-timeline-item ${tone}">
            <svg class="task-timeline-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
            <div>
                <div class="task-timeline-title">
                    <strong>${item?.title || '状态更新'}</strong>
                    ${raw(occurredAt ? html`<time datetime="${item.occurredAt}">${occurredAt}</time>` : '')}
                </div>
                ${raw(item?.summary ? html`<p>${item.summary}</p>` : '')}
                ${raw(technical)}
            </div>
        </li>
    `;
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
    const rowsHtml: string = rows.map(([label, value]: any): any => html`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
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

function safeTone(value: any): string {
    return ['active', 'success', 'warning', 'danger'].includes(value) ? value : 'active';
}

function formatTime(value: any): string {
    const timestamp: any = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}


