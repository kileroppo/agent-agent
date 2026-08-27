import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';

export function renderListRows(options: {
    displayItems: any[];
    selectedTaskId: string;
    compactAttentionReason: (task: any) => string;
    agentName: (id: string) => string;
    relativeTime: (date: any) => string;
    displayTaskTitle: (task: any) => string;
}): string {
    const { displayItems, selectedTaskId, compactAttentionReason, agentName, relativeTime, displayTaskTitle } = options;
    const itemIds = new Set(displayItems.map((t: any) => t.taskId));
    const childrenMap = new Map<string, any[]>();
    const rootTasks: any[] = [];

    for (const item of displayItems) {
        if (item.parentTaskId && itemIds.has(item.parentTaskId)) {
            const arr = childrenMap.get(item.parentTaskId) || [];
            arr.push(item);
            childrenMap.set(item.parentTaskId, arr);
        } else {
            rootTasks.push(item);
        }
    }

    return rootTasks.map((task: any): any => {
        const selected: boolean = selectedTaskId === task.taskId;
        const presentation: any = task.presentation || {};
        const tone: string = presentation.tone || 'active';
        const reason: string = compactAttentionReason(task);
        const createdFull: string = formatFullDateTime(task.createdAt);
        const updatedFull: string = formatFullDateTime(task.updatedAt);
        const timeHover: string = `创建于 ${createdFull || '未记录'}${task.updatedAt && task.updatedAt !== task.createdAt ? ` · 更新于 ${updatedFull}` : ''}`;
        const timeDisplay: string = createdFull ? `${createdFull.slice(5, 16)} (${relativeTime(task.createdAt || task.updatedAt)})` : relativeTime(task.updatedAt || task.createdAt);
        const children = childrenMap.get(task.taskId) || [];
        const retryBadgeHtml = children.length ? `<span class="task-badge-pill badge-rework" title="该任务共产生 ${children.length} 轮重试/协同环节">🔁 ${children.length}</span>` : '';

        return html`
            <button class="record-row${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-record-task-id="${task.taskId}">
                <span class="record-row-main">
                    <span class="record-row-title"><span class="record-row-title-text">${raw(displayTaskTitle(task))}</span>${raw(retryBadgeHtml)}</span>
                    ${raw(reason ? html`<span class="record-row-reason">${reason}</span>` : '')}
                    <span class="record-row-meta" title="${escapeHtml(timeHover)}"><span>${agentName(task.assigneeAgentId)}</span><span>·</span><span>${timeDisplay}</span></span>
                </span>
                <span class="record-row-status ${tone}">${presentation.statusLabel || ''}</span>
            </button>
        `;
    }).join('');
}

export function renderOverviewTab(options: {
    task: any;
    state: any;
    agentName: (id: string) => string;
    parsedTitle: any;
    reworkArtifactsHtml: string;
    isWaitingTest: boolean;
    acceptanceTarget: any;
    acceptanceState: any;
    outcomeHtml: string;
    artifacts: any[];
    isTaskAccepted: boolean;
    renderTaskLineageCard: any;
    renderTaskProgressBar: any;
    renderAcceptanceDetail: any;
    renderArtifact: any;
    renderDeliverySink: any;
    renderOriginCard: any;
    escapeHtml: any;
}): string {
    const {
        task,
        state,
        agentName,
        parsedTitle,
        reworkArtifactsHtml,
        isWaitingTest,
        acceptanceTarget,
        acceptanceState,
        outcomeHtml,
        artifacts,
        isTaskAccepted,
        renderTaskLineageCard,
        renderTaskProgressBar,
        renderAcceptanceDetail,
        renderArtifact,
        renderDeliverySink,
        renderOriginCard,
        escapeHtml,
    } = options;

    const waitingTestGuideHtml = isWaitingTest ? html`
        <div class="record-waiting-test-guide" role="status">
            <svg width="16" height="16" aria-hidden="true"><use href="#icon-shield"></use></svg>
            <div class="waiting-test-content">
                <strong>待人工核验确认</strong>
                <p>当前任务已执行完毕。请在下方交付产物中查验体验；核验满意后，点击下方「有用/采纳」完成任务验收闭环。</p>
            </div>
        </div>
    ` : '';

    return html`
        <div class="detail-tab-pane ${state.detailTab === 'overview' || state.detailTab === 'deliverables' ? 'is-active' : ''}" data-pane="overview">
            ${raw(waitingTestGuideHtml)}
            ${raw(renderTaskLineageCard(task, parsedTitle, reworkArtifactsHtml))}
            ${raw(renderTaskProgressBar(task, { agentName }))}
            ${raw(renderAcceptanceDetail(acceptanceTarget, acceptanceState, escapeHtml))}
            ${raw(outcomeHtml)}
            <section class="record-deliverables-full">
                <div class="deliverables-full-head">
                    <div>
                        <h3>交付产物成果 (${artifacts.length})</h3>
                        <p class="deliverables-full-desc">汇集本次任务生成的全部交付物、拆解分析与证据文件：</p>
                    </div>
                </div>
                ${raw(artifacts.length ? html`
                    <ul class="record-artifact-list full-grid">
                        ${raw(artifacts.map((a: any) => renderArtifact(a, { isAccepted: isTaskAccepted, task })).join(''))}
                    </ul>
                ` : html`
                    <div class="deliverables-empty">
                        <svg width="24" height="24" aria-hidden="true"><use href="#icon-records"></use></svg>
                        <p>本次任务暂未产生交付物文件</p>
                    </div>
                `)}
                ${raw(renderDeliverySink(task))}
            </section>
            ${raw(renderOriginCard(task))}
        </div>
    `;
}

export function renderCollaborationTab(options: {
    task: any;
    state: any;
    agentName: (id: string) => string;
    renderTaskWorkflowTree: (task: any, options: any) => string;
    renderCostSection: (task: any) => string;
    renderTechnicalDetails: (task: any, presentation: any, attention: any, escapeHtml: any) => string;
    presentation: any;
    attention: any;
    escapeHtml: any;
}): string {
    const { task, state, agentName, renderTaskWorkflowTree, renderCostSection, renderTechnicalDetails, presentation, attention, escapeHtml } = options;
    const costHtml: string = renderCostSection(task);
    const costCollapsible: string = costHtml
        ? html`<details class="record-cost-collapsible"><summary><span>执行开销与费用账本</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>${raw(costHtml)}</details>`
        : '';

    return html`
        <div class="detail-tab-pane ${state.detailTab === 'collaboration' ? 'is-active' : ''}" data-pane="collaboration">
            ${raw(renderTaskWorkflowTree(task, { agentName }))}
            <section class="collaboration-timeline-section">
                <h3 class="collaboration-section-title">实施过程流水</h3>
                ${raw(state.timelineHtml || '<div class="timeline-loading-shell"><p>正在读取实施过程记录…</p></div>')}
            </section>
            ${raw(costCollapsible)}
            ${raw(renderTechnicalDetails(task, presentation, attention, escapeHtml))}
        </div>
    `;
}

export function renderDetailHeader(options: {
    task: any;
    presentation: any;
    agentName: (id: string) => string;
    createdFull: string;
    durationText: string;
    relativeTime: (date: any) => string;
    displayTaskTitle: (task: any) => string;
}): string {
    const { task, presentation, agentName, createdFull, durationText, relativeTime, displayTaskTitle } = options;
    return html`
        <button class="record-detail-back" type="button">返回</button>
        <header class="record-detail-header">
            <div class="record-detail-title-row">
                <div class="record-detail-title-col">
                    <h2>${raw(displayTaskTitle(task))}</h2>
                    <p class="record-detail-meta">
                        <span class="meta-agent">${agentName(task.assigneeAgentId)}</span>
                        <span>·</span>
                        <span class="meta-created" title="任务创建时间">创建于 ${createdFull || '未记录'} (${relativeTime(task.createdAt || task.updatedAt)})</span>
                        ${raw(durationText ? html`<span>·</span><span class="meta-duration" title="执行耗时">耗时 ${durationText}</span>` : '')}
                        ${raw(presentation.taskRef ? html`<span>·</span><span class="meta-ref">${presentation.taskRef}</span>` : '')}
                    </p>
                </div>
                <div class="record-detail-header-actions">
                    <span class="record-row-status ${presentation.tone || 'active'}">${presentation.statusLabel || ''}</span>
                </div>
            </div>
        </header>
    `;
}

export function bindDetailInteractions(options: {
    elements: any;
    state: any;
    task: any;
    renderDetail: () => void;
    replaceRecordUrl: () => void;
    loadSelectedDetail: (opts: any) => Promise<void>;
}): void {
    const { elements, state, task, renderDetail, replaceRecordUrl, loadSelectedDetail } = options;

    for (const closeBtn of elements.detail.querySelectorAll('[data-subtask-drawer-close]')) {
        closeBtn.addEventListener('click', (): any => {
            state.previewSubtaskData = null;
            renderDetail();
        });
    }
    elements.detail.querySelector('[data-subtask-drawer-overlay]')?.addEventListener('click', (e: any): any => {
        if (e.target === e.currentTarget) {
            state.previewSubtaskData = null;
            renderDetail();
        }
    });

    elements.detail.querySelector('.record-detail-back')?.addEventListener('click', (): any => {
        elements.workbench.classList.remove('is-detail-open');
        replaceRecordUrl();
    });

    for (const copyBtn of elements.detail.querySelectorAll('[data-copy-path]')) {
        copyBtn.addEventListener('click', async (event: any): Promise<any> => {
            const path = event.currentTarget.dataset.copyPath;
            if (!path) return;
            try {
                await navigator.clipboard.writeText(path);
                const originalText = event.currentTarget.textContent;
                event.currentTarget.textContent = '已复制路径';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        event.currentTarget.textContent = originalText;
                    }
                }, 2000);
            } catch {
                event.currentTarget.textContent = '复制失败';
            }
        });
    }

    for (const copyTextBtn of elements.detail.querySelectorAll('[data-copy-text]')) {
        copyTextBtn.addEventListener('click', async (event: any): Promise<any> => {
            const text = event.currentTarget.dataset.copyText;
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                const originalText = event.currentTarget.textContent;
                event.currentTarget.textContent = '已复制内容';
                setTimeout(() => {
                    if (event.currentTarget && event.currentTarget.isConnected) {
                        event.currentTarget.textContent = originalText;
                    }
                }, 2000);
            } catch {
                event.currentTarget.textContent = '复制失败';
            }
        });
    }

    for (const switchBtn of elements.detail.querySelectorAll('.tree-switch-btn')) {
        switchBtn.addEventListener('click', async (): Promise<any> => {
            const targetId: any = switchBtn.dataset.recordTaskId;
            if (targetId && targetId !== state.selectedTaskId) {
                state.selectedTaskId = targetId;
                state.selectedTask = null;
                state.previewSubtaskData = null;
                state.detailTab = 'overview';
                state.selectedDetailLoaded = false;
                await loadSelectedDetail({ revealDetail: true });
            }
        });
    }

    elements.detail.querySelector('.record-copy-id')?.addEventListener('click', async (event: any): Promise<any> => {
        try {
            await navigator.clipboard.writeText(task.taskId);
            const button: any = event.currentTarget;
            if (button) {
                button.textContent = '已复制';
                setTimeout(() => {
                    if (button && button.isConnected && button.textContent === '已复制') {
                        button.textContent = '复制编号';
                    }
                }, 2000);
            }
        } catch {
            event.currentTarget.textContent = '复制失败';
        }
    });
}
