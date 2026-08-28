import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { isPrimaryArtifact } from './task-record-presentation.js';
export function renderListRows(options) {
    const { displayItems, selectedTaskId, compactAttentionReason, agentName, relativeTime, displayTaskTitle } = options;
    const itemIds = new Set(displayItems.map((t) => t.taskId));
    const childrenMap = new Map();
    const rootTasks = [];
    for (const item of displayItems) {
        if (item.parentTaskId && itemIds.has(item.parentTaskId)) {
            const arr = childrenMap.get(item.parentTaskId) || [];
            arr.push(item);
            childrenMap.set(item.parentTaskId, arr);
        }
        else {
            rootTasks.push(item);
        }
    }
    return rootTasks.map((task) => {
        const selected = selectedTaskId === task.taskId;
        const presentation = task.presentation || {};
        const isTaskAccepted = task.acceptanceTarget?.decision === 'accepted' || task.status === 'succeeded';
        const tone = isTaskAccepted ? 'completed' : (presentation.tone || 'active');
        const rowStatusLabel = isTaskAccepted ? (task.status === 'succeeded' ? '已完成' : '已采纳') : (presentation.statusLabel || '');
        const reason = compactAttentionReason(task);
        const createdFull = formatFullDateTime(task.createdAt);
        const updatedFull = formatFullDateTime(task.updatedAt);
        const timeHover = `创建于 ${createdFull || '未记录'}${task.updatedAt && task.updatedAt !== task.createdAt ? ` · 更新于 ${updatedFull}` : ''}`;
        const timeDisplay = relativeTime(task.createdAt || task.updatedAt);
        const children = childrenMap.get(task.taskId) || [];
        const retryBadgeHtml = children.length ? `<span class="task-badge-pill badge-rework" title="该任务共产生 ${children.length} 轮重试/协同环节">🔁 ${children.length}</span>` : '';
        return html `
            <button class="record-row${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-record-task-id="${task.taskId}">
                <span class="record-row-main">
                    <span class="record-row-title"><span class="record-row-title-text">${raw(displayTaskTitle(task))}</span>${raw(retryBadgeHtml)}</span>
                    ${raw(reason ? html `<span class="record-row-reason">${reason}</span>` : '')}
                    <span class="record-row-meta" title="${escapeHtml(timeHover)}"><span>${agentName(task.assigneeAgentId)}</span><span>·</span><span>${timeDisplay}</span></span>
                </span>
                <span class="record-row-status ${tone}">${rowStatusLabel}</span>
            </button>
        `;
    }).join('');
}
export function renderOverviewTab(options) {
    const { task, state, agentName, parsedTitle, reworkArtifactsHtml, isWaitingTest, acceptanceTarget, acceptanceState, outcomeHtml, artifacts, isTaskAccepted, renderTaskLineageCard, renderTaskProgressBar, renderAcceptanceDetail, renderArtifact, renderDeliverySink, renderOriginCard, escapeHtml, } = options;
    const waitingTestGuideHtml = isWaitingTest ? html `
        <div class="record-waiting-test-guide" role="status">
            <svg width="16" height="16" aria-hidden="true"><use href="#icon-shield"></use></svg>
            <div class="waiting-test-content">
                <strong>待人工核验确认</strong>
                <p>当前任务已执行完毕。请在下方交付产物中查验体验；核验满意后，点击下方「有用/采纳」完成任务验收闭环。</p>
            </div>
        </div>
    ` : '';
    const primaryArtifacts = artifacts.filter(isPrimaryArtifact);
    const secondaryArtifacts = artifacts.filter((a) => !isPrimaryArtifact(a));
    const showSeparation = primaryArtifacts.length > 0 && secondaryArtifacts.length > 0;
    return html `
        <div class="detail-tab-pane ${state.detailTab === 'overview' || state.detailTab === 'deliverables' ? 'is-active' : ''}" data-pane="overview">
            ${raw(waitingTestGuideHtml)}
            ${raw(renderTaskLineageCard(task, parsedTitle, reworkArtifactsHtml))}
            ${raw(renderTaskProgressBar(task, { agentName, attention: task?.presentation?.attention || null }))}
            ${raw(renderAcceptanceDetail(acceptanceTarget, acceptanceState, escapeHtml))}
            ${raw(outcomeHtml)}
            <section class="record-deliverables-full">
                <div class="deliverables-full-head">
                    <div>
                        <h3>交付成果 (${showSeparation ? primaryArtifacts.length : artifacts.length})</h3>
                    </div>
                </div>
                ${raw(artifacts.length ? (showSeparation ? html `
                    <ul class="record-artifact-list full-grid">
                        ${raw(primaryArtifacts.map((a) => renderArtifact(a, { isAccepted: isTaskAccepted, task })).join(''))}
                    </ul>
                    <details class="secondary-artifacts-disclosure" style="margin-top: 20px; border: 1px dashed var(--border-color, rgba(0,0,0,0.15)); border-radius: 8px; padding: 12px 16px; background: rgba(0,0,0,0.015);">
                        <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-secondary, #666); display: flex; align-items: center; justify-content: space-between; user-select: none;">
                            <span style="display: flex; align-items: center; gap: 6px;">
                                <svg width="14" height="14" aria-hidden="true"><use href="#icon-records"></use></svg>
                                📂 底层审计存证与技术底稿 (${secondaryArtifacts.length})
                            </span>
                            <svg class="chevron" width="14" height="14" aria-hidden="true"><use href="#icon-chevron"></use></svg>
                        </summary>
                        <p style="margin: 6px 0 12px; font-size: 12px; color: var(--text-muted, #888);">包含原始下载流数据、Whisper原始粗稿、CER质量评分及合规听审签名（供技术排错与合规存证，日常无需查阅）：</p>
                        <ul class="record-artifact-list full-grid">
                            ${raw(secondaryArtifacts.map((a) => renderArtifact(a, { isAccepted: isTaskAccepted, task })).join(''))}
                        </ul>
                    </details>
                ` : html `
                    <ul class="record-artifact-list full-grid">
                        ${raw(artifacts.map((a) => renderArtifact(a, { isAccepted: isTaskAccepted, task })).join(''))}
                    </ul>
                `) : html `
                    <div class="deliverables-empty">
                        <svg width="24" height="24" aria-hidden="true"><use href="#icon-records"></use></svg>
                        <p>本次任务暂未产生交付物文件</p>
                    </div>
                `)}
                ${raw(renderDeliverySink(task))}
            </section>
            ${raw(renderOriginCard(task, { hideIfInAttention: Boolean(outcomeHtml && task?.paperclipIssue) }))}
        </div>
    `;
}
export function renderCollaborationTab(options) {
    const { task, state, agentName, renderTaskWorkflowTree, renderCostSection, renderTechnicalDetails, presentation, attention, escapeHtml } = options;
    const costHtml = renderCostSection(task);
    const costCollapsible = costHtml
        ? html `<details class="record-cost-collapsible"><summary><span>执行开销与费用账本</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>${raw(costHtml)}</details>`
        : '';
    return html `
        <div class="detail-tab-pane ${state.detailTab === 'collaboration' ? 'is-active' : ''}" data-pane="collaboration">
            ${raw(renderTaskWorkflowTree(task, { agentName }))}
            <section class="collaboration-timeline-section" style="margin-top: 16px;">
                <details class="collaboration-timeline-details" style="border: 1px dashed var(--border-color, rgba(0,0,0,0.12)); border-radius: 8px; padding: 10px 14px; background: rgba(0,0,0,0.01);">
                    <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-secondary, #666); user-select: none;">
                        ⏱️ 实施过程流水记录
                    </summary>
                    <div style="margin-top: 10px;">
                        ${raw(state.timelineHtml || '<div class="timeline-loading-shell"><p>正在读取实施过程记录…</p></div>')}
                    </div>
                </details>
            </section>
            ${raw(costCollapsible)}
            ${raw(renderTechnicalDetails(task, presentation, attention, escapeHtml))}
        </div>
    `;
}
export function renderDetailHeader(options) {
    const { task, presentation, agentName, createdFull, durationText, relativeTime, displayTaskTitle } = options;
    const isTaskAccepted = task.acceptanceTarget?.decision === 'accepted' || task.status === 'succeeded';
    const headerTone = isTaskAccepted ? 'completed' : (presentation.tone || 'active');
    const headerStatusLabel = isTaskAccepted ? (task.status === 'succeeded' ? '已完成' : '已采纳') : (presentation.statusLabel || '');
    return html `
        <button class="record-detail-back" type="button">返回</button>
        <header class="record-detail-header">
            <div class="record-detail-title-row">
                <div class="record-detail-title-col">
                    <h2>${raw(displayTaskTitle(task))}</h2>
                    <p class="record-detail-meta">
                        <span class="meta-agent">${agentName(task.assigneeAgentId)}</span>
                        <span>·</span>
                        <span class="meta-created" title="任务创建时间">创建于 ${createdFull || '未记录'}</span>
                        ${raw(durationText ? html `<span>·</span><span class="meta-duration" title="执行耗时">耗时 ${durationText}</span>` : '')}
                        ${raw(presentation.taskRef ? html `<span>·</span><span class="meta-ref">${presentation.taskRef}</span>` : '')}
                    </p>
                </div>
                <div class="record-detail-header-actions">
                    <span class="record-row-status ${headerTone}">${headerStatusLabel}</span>
                </div>
            </div>
        </header>
    `;
}
export { bindDetailInteractions } from './task-record-workbench-interactions.js';
