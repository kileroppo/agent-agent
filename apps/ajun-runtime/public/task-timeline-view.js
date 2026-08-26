import { html, raw, escapeHtml } from './html.js';
const FILTER_LABELS = Object.freeze({
    failure: '故障',
    fallback: '切换',
    cost: '费用',
    quality: '质量',
});
export function renderTaskTimeline(payload, options = {}) {
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
        return '<details class="record-detail-section task-timeline" data-task-timeline open><summary>过程</summary><p class="task-timeline-empty">没有过程记录。</p></details>';
    }
    // 1. Identify key business milestones vs raw noisy trace events
    const { milestones, rawTrace } = partitionTimelineItems(rawItems);
    // If total items <= 3, render single unified flat timeline (No repetitive sections)
    if (rawItems.length <= 3) {
        const itemsHtml = rawItems.map((item) => renderTimelineItem(item)).join('');
        return html `
            <details class="record-detail-section task-timeline" data-task-timeline open>
                <summary><span>实施过程</span><small>${rawItems.length} 个节点</small></summary>
                ${raw(renderActiveFilters(payload?.filters))}
                <ol class="task-timeline-list">
                    ${raw(itemsHtml)}
                </ol>
                ${raw(payload?.nextCursor ? '<button class="text-action task-timeline-more" type="button" data-task-timeline-more>继续加载</button>' : '')}
            </details>
        `;
    }
    // When items > 3: Milestones on top, full trace collapsed in disclosure below
    const milestonesHtml = html `
        <div class="timeline-milestones-section">
            <div class="timeline-section-header">
                <div class="timeline-header-title">
                    <svg class="timeline-header-icon" aria-hidden="true"><use href="#icon-spark"></use></svg>
                    <strong>实施核心进展 (${milestones.length})</strong>
                </div>
                <span class="timeline-header-tip">已自动提炼关键节点</span>
            </div>
            <ol class="timeline-milestones-list">
                ${raw(milestones.map((item, idx) => renderMilestoneItem(item, idx === milestones.length - 1)).join(''))}
            </ol>
        </div>
    `;
    const itemsHtml = rawTrace.map((item) => renderTimelineItem(item)).join('');
    return html `
        <details class="record-detail-section task-timeline" data-task-timeline open>
            <summary><span>过程</span><small>${rawItems.length}</small></summary>
            ${raw(renderActiveFilters(payload?.filters))}
            ${raw(milestonesHtml)}
            <details class="timeline-trace-disclosure">
                <summary class="timeline-trace-summary">
                    <span class="trace-summary-left">
                        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
                        <span>完整排障日志与技术追踪</span>
                        <small class="trace-count">${rawItems.length} 条记录</small>
                    </span>
                </summary>
                <div class="timeline-trace-content">
                    <ol class="task-timeline-list">
                        ${raw(itemsHtml)}
                    </ol>
                    ${raw(payload?.nextCursor ? '<button class="text-action task-timeline-more" type="button" data-task-timeline-more>继续加载</button>' : '')}
                </div>
            </details>
        </details>
    `;
}
function partitionTimelineItems(items) {
    const milestones = [];
    const rawTrace = [];
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
function isHighValueMilestone(item, index, total) {
    if (index === 0 || index === total - 1)
        return true;
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
function renderMilestoneItem(item, isLatest) {
    const occurredAt = formatTime(item?.occurredAt);
    const tone = safeTone(item?.tone);
    const icon = { success: 'check', warning: 'alert', danger: 'alert', active: 'clock' }[tone] || 'clock';
    return html `
        <li class="milestone-item is-${tone} ${isLatest ? 'is-latest' : ''}">
            <div class="milestone-badge-wrapper">
                <span class="milestone-dot">
                    <svg class="milestone-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
                </span>
            </div>
            <div class="milestone-body">
                <div class="milestone-header">
                    <strong class="milestone-title">${item?.title || '实施节点'}</strong>
                    ${raw(occurredAt ? html `<time class="milestone-time" datetime="${item.occurredAt}">${occurredAt}</time>` : '')}
                </div>
                ${raw(item?.summary ? html `<p class="milestone-summary">${item.summary}</p>` : '')}
            </div>
        </li>
    `;
}
function renderTimelineItem(item) {
    const occurredAt = formatTime(item?.occurredAt);
    const technical = item?.technical && typeof item.technical === 'object'
        ? renderTechnical(item.technical)
        : '';
    const tone = safeTone(item?.tone);
    const icon = { success: 'check', warning: 'alert', danger: 'alert', active: 'clock' }[tone] || 'clock';
    return html `
        <li class="task-timeline-item ${tone}">
            <svg class="task-timeline-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>
            <div>
                <div class="task-timeline-title">
                    <strong>${item?.title || '状态更新'}</strong>
                    ${raw(occurredAt ? html `<time datetime="${item.occurredAt}">${occurredAt}</time>` : '')}
                </div>
                ${raw(item?.summary ? html `<p>${item.summary}</p>` : '')}
                ${raw(technical)}
            </div>
        </li>
    `;
}
export function createTaskTimelineLoader({ api } = {}) {
    if (typeof api !== 'function')
        throw new TypeError('任务时间线需要 api 读取函数。');
    let taskId = '';
    let filters = [];
    let page = { items: [], nextCursor: null, filters: [] };
    return {
        async load(nextTaskId, { nextFilters = [] } = {}) {
            taskId = String(nextTaskId || '');
            filters = normalizeFilters(nextFilters);
            page = await requestPage(api, taskId, filters, '');
            return renderTaskTimeline(page);
        },
        async loadMore() {
            if (!page.nextCursor)
                return renderTaskTimeline(page);
            const next = await requestPage(api, taskId, filters, page.nextCursor);
            page = { ...next, items: [...page.items, ...next.items] };
            return renderTaskTimeline(page);
        },
        snapshot() { return structuredClone(page); },
    };
}
function renderTechnical(technical) {
    const rows = [
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
    ].filter(([, value]) => value !== '' && value !== null && value !== undefined);
    if (!rows.length && !(technical.artifactRefs || []).length && !technical.qualityResult)
        return '';
    const artifacts = (technical.artifactRefs || []).map((item) => html `<li>${item.title || item.type || item.artifactId}</li>`).join('');
    const quality = technical.qualityResult
        ? html `<div><dt>质量门</dt><dd>${technical.qualityResult.status || technical.qualityResult.gateId || '已记录'}${raw(technical.qualityResult.failedCriteria?.length ? html ` · ${technical.qualityResult.failedCriteria.join('；')}` : '')}</dd></div>`
        : '';
    const rowsHtml = rows.map(([label, value]) => html `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    return html `<details class="record-technical task-timeline-technical"><summary>技术详情</summary><dl>${raw(rowsHtml)}${raw(quality)}</dl>${raw(artifacts ? `<strong>产物引用</strong><ul>${artifacts}</ul>` : '')}</details>`;
}
function renderActiveFilters(filters) {
    const labels = normalizeFilters(filters).map((filter) => FILTER_LABELS[filter]).filter(Boolean);
    return labels.length ? html `<span class="task-timeline-filter">仅看：${labels.join('、')}</span>` : '';
}
async function requestPage(api, taskId, filters, cursor) {
    const params = new URLSearchParams({ limit: '30' });
    if (cursor)
        params.set('cursor', cursor);
    for (const filter of filters)
        params.append('filter', filter);
    return api(`/api/tasks/${encodeURIComponent(taskId)}/timeline?${params}`);
}
function normalizeFilters(filters) {
    return [...new Set((Array.isArray(filters) ? filters : []).filter((item) => FILTER_LABELS[item]))];
}
function safeTone(value) {
    return ['active', 'success', 'warning', 'danger'].includes(value) ? value : 'active';
}
function formatTime(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
