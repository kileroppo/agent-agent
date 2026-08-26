import { html, raw, escapeHtml } from './html.js';
import { statusLabel, stageLabel } from './console-labels.js';
import { acceptanceTargetView, cleanAttentionText, recoverySubmissionView, renderAcceptanceDetail, renderAttentionDetail, renderCostSection, renderDeliverySink, renderDetailTabNav, renderOriginCard, renderSubtaskDrawer, renderTaskLineageCard, taskAttentionView, } from './task-record-detail-view.js';
import { createTaskTimelineLoader } from './task-timeline-view.js';
import { renderTaskProgressBar } from './task-progress-bar.js';
import { renderTaskWorkflowTree } from './task-tree-view.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { artifactItems, displaySubtaskTitle, displayTaskTitle, parseTaskTitle, relativeTime, renderArtifact, resultSummary, } from './task-record-presentation.js';
export { taskAttentionView } from './task-record-detail-view.js';
export { parseTaskTitle, displayTaskTitle, displaySubtaskTitle } from './task-record-presentation.js';
const VIEW_LABELS = Object.freeze({
    needs_action: '待处理',
    active: '进行中',
    completed: '已完成',
    all: '全部',
});
const BACKLOG_CATEGORY_LABELS = Object.freeze({
    owner_actionable: '待我处理',
    business_active: '正在运行',
    needs_reverification: '待重新验证',
    unresolved_failures: '仍需排查的失败',
    validated_by_later_evidence: '已被后续任务补充交付',
    historical_archived: '已闭环历史归档',
});
export function createTaskRecordWorkbench({ api, getAgents, taskTypeLabel, agentName, initialTaskId = '', }) {
    const elements = recordElements();
    const timeline = createTaskTimelineLoader({ api });
    const urlState = readUrlState();
    const state = {
        active: false,
        loaded: false,
        loading: false,
        view: initialTaskId ? 'all' : urlState.view,
        q: urlState.q,
        agentId: urlState.agentId,
        status: urlState.status,
        taskType: urlState.taskType,
        time: urlState.time,
        includeRoutine: urlState.includeRoutine,
        backlogCategory: urlState.backlogCategory,
        items: [],
        counts: { needs_action: 0, active: 0, completed: 0, all: 0 },
        total: 0,
        nextCursor: null,
        revision: '',
        selectedTaskId: initialTaskId,
        selectedTask: null,
        selectedDetailLoaded: false,
        autoExpanded: false,
        batchSubmitting: false,
        actionState: new Map(),
        acceptanceState: new Map(),
        timelineHtml: '',
        detailTab: 'overview',
        previewSubtaskData: null,
    };
    let searchTimer;
    bindEvents();
    syncControls();
    return {
        async setActive(active) {
            state.active = Boolean(active);
            if (!state.active)
                return;
            refreshFilterOptions();
            if (!state.loaded)
                await loadRecords();
        },
        async refresh({ background = false } = {}) {
            if (!state.active || !state.loaded)
                return;
            if (background) {
                await checkForUpdates();
                return;
            }
            await loadRecords();
        },
        updateFilterOptions: refreshFilterOptions,
    };
    function bindEvents() {
        for (const button of elements.viewButtons)
            button.addEventListener('click', async () => {
                if (state.view === button.dataset.recordView && !state.selectedTaskId && !state.backlogCategory)
                    return;
                state.view = button.dataset.recordView;
                state.backlogCategory = '';
                state.selectedTaskId = '';
                state.selectedTask = null;
                state.autoExpanded = false;
                replaceRecordUrl();
                syncControls();
                await loadRecords();
            });
        elements.search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async () => {
                state.q = elements.search.value.trim();
                if (state.q)
                    state.view = 'all';
                state.selectedTaskId = '';
                state.selectedTask = null;
                state.autoExpanded = false;
                replaceRecordUrl();
                await loadRecords();
            }, 260);
        });
        elements.filterToggle.addEventListener('click', () => {
            const expanded = elements.filterPanel.hidden;
            elements.filterPanel.hidden = !expanded;
            elements.filterToggle.setAttribute('aria-expanded', String(expanded));
        });
        elements.filterApply.addEventListener('click', async () => {
            state.agentId = elements.agentFilter.value;
            state.status = elements.statusFilter?.value || '';
            state.taskType = elements.typeFilter.value;
            state.time = elements.timeFilter.value;
            state.includeRoutine = elements.routineFilter.checked;
            state.selectedTaskId = '';
            state.selectedTask = null;
            state.autoExpanded = false;
            elements.filterPanel.hidden = true;
            elements.filterToggle.setAttribute('aria-expanded', 'false');
            replaceRecordUrl();
            syncControls();
            await loadRecords();
        });
        elements.filterReset.addEventListener('click', async () => {
            Object.assign(state, { agentId: '', status: '', taskType: '', time: '30d', includeRoutine: false, backlogCategory: '', autoExpanded: false });
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
        elements.loadMore.addEventListener('click', async () => loadRecords({ append: true }));
        elements.newItems.addEventListener('click', async () => loadRecords());
        elements.batchAcceptBtn?.addEventListener('click', async () => handleBatchAccept());
        elements.list.addEventListener('click', async (event) => {
            if (event.target.closest('[data-record-retry]')) {
                await loadRecords();
                return;
            }
            const emptyView = event.target.closest('[data-empty-view]');
            if (emptyView) {
                state.view = emptyView.dataset.emptyView;
                state.selectedTaskId = '';
                state.selectedTask = null;
                syncControls();
                replaceRecordUrl();
                loadRecords();
                return;
            }
            const row = event.target.closest('[data-record-task-id]');
            if (!row)
                return;
            const task = state.items.find((item) => item.taskId === row.dataset.recordTaskId);
            if (task)
                await selectTask(task, { updateUrl: true, revealDetail: true });
        });
        elements.routineSummary.addEventListener('click', async (event) => {
            if (!event.target.closest('[data-show-routine]'))
                return;
            state.includeRoutine = true;
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
    }
    async function loadRecords({ append = false } = {}) {
        if (state.loading)
            return;
        state.loading = true;
        if (!append)
            renderLoading();
        else
            elements.loadMore.disabled = true;
        try {
            let page = await api(recordQueryUrl(append ? state.nextCursor : ''));
            if (!append && state.q && state.time !== 'all' && page.total === 0) {
                state.time = 'all';
                state.autoExpanded = true;
                syncControls();
                replaceRecordUrl();
                page = await api(recordQueryUrl(''));
            }
            state.items = append ? [...state.items, ...page.items] : page.items;
            state.counts = page.counts;
            state.total = page.total;
            state.nextCursor = page.nextCursor;
            state.revision = page.revision;
            state.loaded = true;
            elements.newItems.hidden = true;
            renderWorkbench(page.routineSummary);
            if (state.selectedTaskId) {
                const selected = state.items.find((item) => item.taskId === state.selectedTaskId);
                if (selected)
                    await selectTask(selected, { updateUrl: false, revealDetail: Boolean(initialTaskId) });
                else
                    await loadSelectedDetail({ revealDetail: Boolean(initialTaskId) });
            }
            else if (!state.selectedTask && state.items[0]) {
                await selectTask(state.items[0], { updateUrl: false, revealDetail: false });
            }
            else if (!state.items.length) {
                state.selectedTask = null;
                renderDetail();
            }
        }
        catch (error) {
            renderError(error);
        }
        finally {
            state.loading = false;
            elements.loadMore.disabled = false;
        }
    }
    async function checkForUpdates() {
        try {
            const page = await api(recordQueryUrl(''));
            if (page.revision !== state.revision) {
                elements.newItems.textContent = '有更新';
                elements.newItems.hidden = false;
            }
            if (state.selectedTaskId)
                await loadSelectedDetail({ revealDetail: false, quiet: true });
        }
        catch {
            // Background refresh stays quiet; the global sync state already reports connectivity.
        }
    }
    async function loadSelectedDetail({ revealDetail = false, quiet = false } = {}) {
        if (!state.selectedTaskId)
            return;
        try {
            const payload = await api(`/api/tasks/${encodeURIComponent(state.selectedTaskId)}`);
            const nextTask = withAcceptanceTarget(payload);
            if (quiet && state.selectedDetailLoaded && nextTask.updatedAt === state.selectedTask?.updatedAt && nextTask.status === state.selectedTask?.status
                && acceptanceRevision(nextTask) === acceptanceRevision(state.selectedTask))
                return;
            const detailScrollTop = quiet ? elements.detail.scrollTop : 0;
            state.selectedTask = nextTask;
            state.selectedDetailLoaded = true;
            if (!nextTask?.presentation?.attention || nextTask.presentation.attention.verification) {
                state.actionState.delete(nextTask.taskId);
            }
            if (!acceptanceTargetView(nextTask)?.actionable)
                state.acceptanceState.delete(nextTask.taskId);
            if (!quiet)
                renderList();
            renderDetail();
            if (quiet)
                elements.detail.scrollTop = detailScrollTop;
            if (revealDetail)
                elements.workbench.classList.add('is-detail-open');
        }
        catch (error) {
            if (!quiet)
                renderDetailError(error);
            if (revealDetail)
                elements.workbench.classList.add('is-detail-open');
        }
    }
    async function selectTask(task, { updateUrl, revealDetail }) {
        state.selectedTaskId = task.taskId;
        state.selectedTask = task;
        state.timelineHtml = '';
        state.previewSubtaskData = null;
        state.detailTab = 'overview';
        state.selectedDetailLoaded = task.recordSummary !== true;
        renderList();
        renderDetail();
        if (updateUrl)
            history.replaceState(null, '', `/tasks/${encodeURIComponent(task.taskId)}`);
        if (revealDetail)
            elements.workbench.classList.add('is-detail-open');
        if (!state.selectedDetailLoaded)
            await loadSelectedDetail({ revealDetail, quiet: true });
    }
    function renderWorkbench(routineSummary) {
        renderTabs();
        renderFilters();
        renderList();
        renderRoutineSummary(routineSummary);
        renderDetail();
        renderBatchActions();
        elements.loadMore.hidden = !state.nextCursor;
        elements.loadMore.textContent = state.nextCursor ? `更多 ${state.items.length}/${state.total}` : '已全部显示';
    }
    function renderTabs() {
        for (const button of elements.viewButtons) {
            const view = button.dataset.recordView;
            const active = view === state.view;
            const count = Number(state.counts[view] || 0);
            const showCount = ['needs_action', 'active'].includes(view) && count > 0;
            button.textContent = `${VIEW_LABELS[view]}${showCount ? ` ${count}` : ''}`;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        const activeLabel = BACKLOG_CATEGORY_LABELS[state.backlogCategory] || VIEW_LABELS[state.view];
        elements.count.textContent = state.total ? `${state.total}` : emptyCountLabel();
        elements.listContext.textContent = state.autoExpanded
            ? '已扩到全部时间'
            : state.backlogCategory ? activeLabel : '';
    }
    function renderList() {
        if (!state.items.length) {
            const filtered = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
            const title = filtered ? '没有匹配' : state.view === 'needs_action' ? '没有待处理' : '暂无记录';
            const nextView = !filtered && state.view === 'needs_action'
                ? state.counts.active ? 'active' : state.counts.completed ? 'completed' : state.counts.all ? 'all' : ''
                : '';
            const nextLabel = nextView === 'active' ? `进行中 ${state.counts.active}` : nextView === 'completed' ? '看已完成' : nextView === 'all' ? '看全部' : '';
            elements.list.innerHTML = html `<div class="record-list-empty"><strong>${title}</strong>${raw(nextView ? html `<button class="text-action" type="button" data-empty-view="${nextView}">${nextLabel}</button>` : '')}</div>`;
            return;
        }
        const displayItems = state.view === 'all'
            ? [...state.items].sort((left, right) => {
                const leftCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(left?.status) ? 1 : 0;
                const rightCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(right?.status) ? 1 : 0;
                return leftCompleted - rightCompleted;
            })
            : state.items;
        // Group tasks into tree hierarchy: root tasks vs child rework tasks
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
        elements.list.innerHTML = rootTasks.map((task) => {
            const selected = state.selectedTaskId === task.taskId;
            const presentation = task.presentation || {};
            const tone = presentation.tone || 'active';
            const reason = compactAttentionReason(task);
            const createdFull = formatFullDateTime(task.createdAt);
            const updatedFull = formatFullDateTime(task.updatedAt);
            const timeHover = `创建于 ${createdFull || '未记录'}${task.updatedAt && task.updatedAt !== task.createdAt ? ` · 更新于 ${updatedFull}` : ''}`;
            const timeDisplay = createdFull ? `${createdFull.slice(5, 16)} (${relativeTime(task.createdAt || task.updatedAt)})` : relativeTime(task.updatedAt || task.createdAt);
            const children = childrenMap.get(task.taskId) || [];
            const retryBadgeHtml = children.length ? `<span class="task-badge-pill badge-rework" title="该任务共产生 ${children.length} 轮重试/协同环节">🔁 ${children.length}</span>` : '';
            return html `
                <button class="record-row${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-record-task-id="${task.taskId}">
                    <span class="record-row-main">
                        <span class="record-row-title"><span class="record-row-title-text">${raw(displayTaskTitle(task))}</span>${raw(retryBadgeHtml)}</span>
                        ${raw(reason ? html `<span class="record-row-reason">${reason}</span>` : '')}
                        <span class="record-row-meta" title="${escapeHtml(timeHover)}"><span>${agentName(task.assigneeAgentId)}</span><span>·</span><span>${timeDisplay}</span></span>
                    </span>
                    <span class="record-row-status ${tone}">${presentation.statusLabel || ''}</span>
                </button>
            `;
        }).join('');
    }
    function renderRoutineSummary(summary = {}) {
        const hidden = Number(summary.hidden || 0);
        if (!hidden || state.includeRoutine) {
            elements.routineSummary.hidden = true;
            elements.routineSummary.replaceChildren();
            return;
        }
        const today = Number(summary.today || 0);
        const attention = Number(summary.attention || 0);
        elements.routineSummary.innerHTML = html `🛡️ 例行巡检已自动归档 ${hidden} 条${today ? ` · 今日 ${today} 次` : ''}${attention ? ` · ${attention} 条异常已保留` : ''}（系统环境自检 · 0 模型 Token 消耗 · 不占用主任务列表）<button type="button" data-show-routine>查看明细</button>`;
        elements.routineSummary.hidden = false;
    }
    function renderDetail() {
        const task = state.selectedTask;
        if (!task) {
            elements.detail.innerHTML = html `<div class="record-detail-empty"><p>${state.items.length ? '选一条记录' : emptyDetailLabel()}</p></div>`;
            return;
        }
        const presentation = task.presentation || {};
        const taskView = task.recordView || stateForTask(task.status);
        const needsAction = taskView === 'needs_action';
        const attention = taskAttentionView(task);
        const acceptanceTarget = acceptanceTargetView(task);
        const result = resultSummary(task);
        const artifacts = artifactItems(task.artifactRefs || [], { hideEmployeeReport: true });
        const actionState = state.actionState.get(task.taskId) || null;
        const acceptanceState = state.acceptanceState.get(task.taskId) || null;
        const summary = presentation.summary || '';
        const distinctResult = result && result.text && result.text !== summary ? result : null;
        const parsedTitle = parseTaskTitle(task?.input?.title || task?.title || '');
        // Pure high-value business outcome (No robotic "progress" or "next action" tags)
        const outcomeContent = distinctResult?.text || (summary && taskView === 'completed' ? summary : '');
        const outcomeHtml = attention
            ? renderAttentionDetail(attention, actionState, escapeHtml)
            : (outcomeContent || task.pendingApproval?.reason)
                ? html `${raw(outcomeContent ? html `
                    <section class="record-primary-summary${needsAction ? ' needs-action' : ''}">
                        <p class="record-pure-result">${outcomeContent}</p>
                    </section>
                ` : '')}${raw(task.pendingApproval?.reason ? html `<details class="record-detail-section record-context-details"><summary>待确认原因</summary><p>${task.pendingApproval.reason}</p></details>` : '')}`
                : '';
        const isWorkflow = Boolean(task.workflowBreadcrumb && (task.workflowBreadcrumb.workflowId || (task.workflowBreadcrumb.siblings && task.workflowBreadcrumb.siblings.length > 0)));
        const createdFull = formatFullDateTime(task.createdAt);
        const durationText = task.createdAt ? formatDuration(task.createdAt, task.completedAt || (taskView === 'completed' ? task.updatedAt : null)) : '';
        const isTaskAccepted = acceptanceTarget?.decision === 'accepted' || task.status === 'succeeded';
        const tabNavHtml = renderDetailTabNav(state.detailTab, { deliverablesCount: artifacts.length, isWorkflow });
        const isReworkTask = parsedTitle?.badges?.some((b) => b.tone === 'rework') || /定向返工/i.test(task?.input?.title || task?.title || '');
        const reworkArtifactsHtml = isReworkTask && artifacts.length ? artifacts.map((a) => renderArtifact(a, { isAccepted: isTaskAccepted })).join('') : '';
        const isWaitingTest = task.status === 'waiting_test';
        const waitingTestGuideHtml = isWaitingTest ? html `
            <div class="record-waiting-test-guide" role="status">
                <svg width="16" height="16" aria-hidden="true"><use href="#icon-shield"></use></svg>
                <div class="waiting-test-content">
                    <strong>待人工核验确认</strong>
                    <p>当前任务已执行完毕。请在下方交付产物中查验体验；核验满意后，点击下方「有用/采纳」完成任务验收闭环。</p>
                </div>
            </div>
        ` : '';
        // Tab 1: Combined Overview & Deliverables Panel
        const overviewTabHtml = html `
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
                    ${raw(artifacts.length ? html `
                        <ul class="record-artifact-list full-grid">
                            ${raw(artifacts.map((a) => renderArtifact(a, { isAccepted: isTaskAccepted })).join(''))}
                        </ul>
                    ` : html `
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
        // Tab 2: Collaboration & Trace Panel
        const costHtml = renderCostSection(task);
        const costCollapsible = costHtml
            ? html `<details class="record-cost-collapsible"><summary><span>执行开销与费用账本</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>${raw(costHtml)}</details>`
            : '';
        const collaborationTabHtml = html `
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
        // Drawer overlay for subtask preview
        const subtaskDrawerHtml = state.previewSubtaskData
            ? renderSubtaskDrawer(state.previewSubtaskData, { agentName, parentAgent: agentName(task.assigneeAgentId) })
            : '';
        elements.detail.innerHTML = html `
      <button class="record-detail-back" type="button">返回</button>
      <header class="record-detail-header">
        <div class="record-detail-title-row">
          <div class="record-detail-title-col">
            <h2>${raw(displayTaskTitle(task))}</h2>
            <p class="record-detail-meta">
              <span class="meta-agent">${agentName(task.assigneeAgentId)}</span>
              <span>·</span>
              <span class="meta-created" title="任务创建时间">创建于 ${createdFull || '未记录'} (${relativeTime(task.createdAt || task.updatedAt)})</span>
              ${raw(durationText ? html `<span>·</span><span class="meta-duration" title="执行耗时">耗时 ${durationText}</span>` : '')}
              ${raw(presentation.taskRef ? html `<span>·</span><span class="meta-ref">${presentation.taskRef}</span>` : '')}
            </p>
          </div>
          <div class="record-detail-header-actions">
            <span class="record-row-status ${presentation.tone || 'active'}">${presentation.statusLabel || ''}</span>
          </div>
        </div>
      </header>
      ${raw(tabNavHtml)}
      <div class="detail-tab-content">
        ${raw(overviewTabHtml)}
        ${raw(collaborationTabHtml)}
      </div>
      ${raw(subtaskDrawerHtml)}`;
        // Tab Switching Handler
        for (const tabBtn of elements.detail.querySelectorAll('[data-detail-tab]')) {
            tabBtn.addEventListener('click', async (e) => {
                const targetTab = e.currentTarget.dataset.detailTab;
                if (targetTab && targetTab !== state.detailTab) {
                    state.detailTab = targetTab;
                    if (targetTab === 'collaboration' && !state.timelineHtml) {
                        state.timelineHtml = await loadTimeline(task.taskId);
                    }
                    renderDetail();
                }
            });
        }
        // Subtask preview drawer handlers
        for (const previewBtn of elements.detail.querySelectorAll('[data-subtask-preview]')) {
            previewBtn.addEventListener('click', async (e) => {
                const subtaskId = e.currentTarget.dataset.subtaskPreview;
                if (!subtaskId)
                    return;
                try {
                    previewBtn.disabled = true;
                    const payload = await api(`/api/tasks/${encodeURIComponent(subtaskId)}`);
                    state.previewSubtaskData = payload?.task || payload;
                    renderDetail();
                }
                catch (err) {
                    console.error('Failed to preview subtask:', err);
                }
                finally {
                    previewBtn.disabled = false;
                }
            });
        }
        // Close drawer handlers
        for (const closeBtn of elements.detail.querySelectorAll('[data-subtask-drawer-close]')) {
            closeBtn.addEventListener('click', () => {
                state.previewSubtaskData = null;
                renderDetail();
            });
        }
        elements.detail.querySelector('[data-subtask-drawer-overlay]')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                state.previewSubtaskData = null;
                renderDetail();
            }
        });
        // Trigger timeline loading automatically when collaboration tab opens
        if (state.detailTab === 'collaboration' && !state.timelineHtml) {
            loadTimeline(task.taskId).then((htmlStr) => {
                state.timelineHtml = htmlStr;
                renderDetail();
            });
        }
        elements.detail.querySelector('.record-detail-back')?.addEventListener('click', () => {
            elements.workbench.classList.remove('is-detail-open');
            replaceRecordUrl();
        });
        for (const copyBtn of elements.detail.querySelectorAll('[data-copy-path]')) {
            copyBtn.addEventListener('click', async (event) => {
                const path = event.currentTarget.dataset.copyPath;
                if (!path)
                    return;
                try {
                    await navigator.clipboard.writeText(path);
                    const originalText = event.currentTarget.textContent;
                    event.currentTarget.textContent = '已复制路径';
                    setTimeout(() => {
                        if (event.currentTarget && event.currentTarget.isConnected) {
                            event.currentTarget.textContent = originalText;
                        }
                    }, 2000);
                }
                catch {
                    event.currentTarget.textContent = '复制失败';
                }
            });
        }
        for (const copyTextBtn of elements.detail.querySelectorAll('[data-copy-text]')) {
            copyTextBtn.addEventListener('click', async (event) => {
                const text = event.currentTarget.dataset.copyText;
                if (!text)
                    return;
                try {
                    await navigator.clipboard.writeText(text);
                    const originalText = event.currentTarget.textContent;
                    event.currentTarget.textContent = '已复制内容';
                    setTimeout(() => {
                        if (event.currentTarget && event.currentTarget.isConnected) {
                            event.currentTarget.textContent = originalText;
                        }
                    }, 2000);
                }
                catch {
                    event.currentTarget.textContent = '复制失败';
                }
            });
        }
        for (const switchBtn of elements.detail.querySelectorAll('.tree-switch-btn')) {
            switchBtn.addEventListener('click', async () => {
                const targetId = switchBtn.dataset.recordTaskId;
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
        elements.detail.querySelector('.record-copy-id')?.addEventListener('click', async (event) => {
            try {
                await navigator.clipboard.writeText(task.taskId);
                const button = event.currentTarget;
                if (button) {
                    button.textContent = '已复制';
                    setTimeout(() => {
                        if (button && button.isConnected && button.textContent === '已复制') {
                            button.textContent = '复制编号';
                        }
                    }, 2000);
                }
            }
            catch {
                event.currentTarget.textContent = '复制失败';
            }
        });
        for (const button of elements.detail.querySelectorAll('[data-attention-action]')) {
            button.addEventListener('click', () => confirmAttentionAction(task, button.dataset.attentionAction));
        }
        elements.detail.querySelector('[data-attention-confirm]')?.addEventListener('click', (event) => executeAttentionAction(task, event.currentTarget.dataset.attentionConfirm));
        elements.detail.querySelector('[data-attention-cancel]')?.addEventListener('click', () => {
            state.actionState.delete(task.taskId);
            renderDetail();
        });
        for (const button of elements.detail.querySelectorAll('[data-acceptance-decision]')) {
            button.addEventListener('click', () => executeAcceptanceDecision(task, button.dataset.acceptanceDecision));
        }
        const timelineShell = elements.detail.querySelector('[data-task-timeline-shell]');
        timelineShell?.addEventListener('toggle', async () => {
            if (!timelineShell.open || state.timelineHtml)
                return;
            const summaryNode = timelineShell.querySelector('summary');
            if (summaryNode)
                summaryNode.textContent = '读取中…';
            state.timelineHtml = await loadTimeline(task.taskId);
            renderDetail();
        });
        elements.detail.querySelector('[data-task-timeline-more]')?.addEventListener('click', async () => {
            try {
                state.timelineHtml = await timeline.loadMore();
            }
            catch { /* Keep the already loaded timeline page visible. */ }
            renderDetail();
        });
    }
    async function loadTimeline(taskId) {
        try {
            return await timeline.load(taskId);
        }
        catch {
            return '<div class="timeline-empty-card"><p>过程读取失败，业务结果不受影响。</p></div>';
        }
    }
    function confirmAttentionAction(task, actionKey) {
        const attention = taskAttentionView(task);
        const action = attention?.actions.find((item) => item.actionKey === actionKey);
        if (!action || state.actionState.get(task.taskId)?.status === 'submitting')
            return;
        state.actionState.set(task.taskId, {
            status: 'confirming',
            actionKey: action.actionKey,
            message: action.confirmation || `确认执行“${action.label}”？`,
        });
        renderDetail();
        elements.detail.querySelector('[data-attention-confirm]')?.focus();
    }
    async function executeAttentionAction(task, actionKey) {
        const attention = taskAttentionView(task);
        const action = attention?.actions.find((item) => item.actionKey === actionKey);
        if (!action || state.actionState.get(task.taskId)?.status === 'submitting')
            return;
        state.actionState.set(task.taskId, { status: 'submitting', message: `正在${action.label}…` });
        renderDetail();
        try {
            const session = await api('/api/owner-action-session');
            const nonce = String(session?.nonce || '').trim();
            if (!nonce)
                throw new Error('暂时无法取得本机操作授权，请刷新后重试。');
            const idempotencyKey = newIdempotencyKey(task.taskId, action.actionKey);
            const payload = await api(`/api/tasks/${encodeURIComponent(task.taskId)}/recovery-actions/${encodeURIComponent(action.actionKey)}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'Idempotency-Key': idempotencyKey,
                    'X-Ajun-Owner-Action': nonce,
                },
                body: JSON.stringify({ expectedUpdatedAt: task.updatedAt || null }),
            });
            if (payload?.task) {
                state.selectedTask = payload.task;
                state.selectedTaskId = task.taskId;
                state.selectedDetailLoaded = true;
            }
            state.actionState.set(task.taskId, recoverySubmissionView(payload, action.label));
            await loadSelectedDetail({ revealDetail: false, quiet: false });
        }
        catch (error) {
            state.actionState.set(task.taskId, {
                status: 'failed',
                message: error?.status === 404 || error?.status === 501
                    ? '当前运行版本尚未接入这项恢复动作；任务没有被更改，请按提示前往飞书补充信息。'
                    : error.message || '恢复请求没有提交，请稍后重试。',
            });
            renderDetail();
        }
    }
    async function executeAcceptanceDecision(task, decision) {
        const target = acceptanceTargetView(task);
        if (!target?.actionable || !['accepted', 'revision_required'].includes(decision)
            || state.acceptanceState.get(task.taskId)?.status === 'submitting')
            return;
        const note = cleanAttentionText(elements.detail.querySelector('[data-acceptance-note]')?.value, 1000);
        const previous = state.acceptanceState.get(task.taskId);
        const idempotencyKey = previous?.status === 'failed'
            && previous.decision === decision
            && previous.note === note
            && previous.revision === target.revision
            ? previous.idempotencyKey
            : newIdempotencyKey(target.workflowId, decision);
        state.acceptanceState.set(task.taskId, { status: 'submitting', decision, note, revision: target.revision, idempotencyKey });
        renderDetail();
        try {
            if (target.workflowId && !target.workflowId.startsWith('WF-')) {
                const payload = await submitAcceptance({ target, decision, note, idempotencyKey });
                if (payload?.task)
                    state.selectedTask = withAcceptanceTarget(payload);
            }
            else {
                const session = await api('/api/owner-action-session');
                const nonce = String(session?.nonce || '').trim();
                if (!nonce)
                    throw new Error('暂时无法取得本机操作授权');
                const actionKey = decision === 'accepted' ? 'accept_reviewed_artifact' : 'retry_task';
                try {
                    await api(`/api/tasks/${encodeURIComponent(task.taskId)}/recovery-actions/${actionKey}`, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'Idempotency-Key': idempotencyKey,
                            'X-Ajun-Owner-Action': nonce,
                        },
                        body: JSON.stringify({ expectedUpdatedAt: task.updatedAt || null, note }),
                    });
                }
                catch {
                    await submitAcceptance({ target, decision, note, idempotencyKey });
                }
            }
            state.acceptanceState.set(task.taskId, {
                status: 'saved',
                decision,
                message: decision === 'accepted' ? '已记为有用，任务已满意闭环' : '已记为需改进，系统将发起修正',
            });
            await loadRecords();
        }
        catch (error) {
            state.acceptanceState.set(task.taskId, {
                status: 'failed',
                decision,
                note,
                revision: target.revision,
                idempotencyKey,
                message: acceptanceErrorMessage(error),
            });
            renderDetail();
        }
    }
    async function submitAcceptance({ target, decision, note, idempotencyKey }) {
        const url = `/api/workflows/${encodeURIComponent(target.workflowId)}/acceptance`;
        const body = JSON.stringify({ decision, note: note || undefined, expectedRevision: target.revision });
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const session = await api('/api/owner-action-session');
            const nonce = String(session?.nonce || '').trim();
            if (!nonce)
                throw new Error('暂时无法取得本机操作授权，请重新打开任务详情后重试。');
            try {
                return await api(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'Idempotency-Key': idempotencyKey,
                        'X-Ajun-Owner-Action': nonce,
                    },
                    body,
                });
            }
            catch (error) {
                const expired = error?.status === 403 && /动作会话.*(?:无效|过期)/.test(String(error?.message || ''));
                if (!expired || attempt > 0)
                    throw error;
            }
        }
        throw new Error('本机操作授权刷新失败，请重新打开任务详情后重试。');
    }
    function isTaskAdoptable(task) {
        if (!task)
            return false;
        const attention = taskAttentionView(task);
        if (attention?.actions?.some((a) => a.actionKey === 'accept_reviewed_artifact')) {
            return true;
        }
        if (task.status === 'waiting_test') {
            return true;
        }
        const target = acceptanceTargetView(task);
        if (target?.actionable) {
            return true;
        }
        return false;
    }
    function renderBatchActions() {
        if (!elements.batchActions || !elements.batchAcceptBtn || !elements.batchCount)
            return;
        const adoptableTasks = state.items.filter((task) => isTaskAdoptable(task));
        if (adoptableTasks.length > 0) {
            elements.batchActions.hidden = false;
            elements.batchCount.textContent = String(adoptableTasks.length);
            if (!state.batchSubmitting) {
                elements.batchAcceptBtn.disabled = false;
                elements.batchAcceptBtn.innerHTML = `<svg aria-hidden="true" width="12" height="12"><use href="#icon-shield"></use></svg><span>批量采纳 (<b id="batch-adoptable-count">${adoptableTasks.length}</b>)</span>`;
            }
        }
        else {
            elements.batchActions.hidden = true;
        }
    }
    async function handleBatchAccept() {
        const adoptableTasks = state.items.filter((task) => isTaskAdoptable(task));
        if (!adoptableTasks.length || state.batchSubmitting)
            return;
        const count = adoptableTasks.length;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`确认批量采纳当前 ${count} 项待采纳任务产物？`)) {
            return;
        }
        state.batchSubmitting = true;
        elements.batchAcceptBtn.disabled = true;
        let success = 0;
        let failed = 0;
        for (let i = 0; i < adoptableTasks.length; i++) {
            const task = adoptableTasks[i];
            elements.batchAcceptBtn.innerHTML = `<span>正在采纳 (${i + 1}/${count})…</span>`;
            try {
                const target = acceptanceTargetView(task);
                if (target?.actionable) {
                    const idempotencyKey = newIdempotencyKey(target.workflowId, 'accepted');
                    await submitAcceptance({ target, decision: 'accepted', idempotencyKey });
                    success++;
                }
                else {
                    const session = await api('/api/owner-action-session');
                    const nonce = String(session?.nonce || '').trim();
                    if (!nonce)
                        throw new Error('暂时无法取得本机操作授权');
                    const idempotencyKey = newIdempotencyKey(task.taskId, 'accept_reviewed_artifact');
                    await api(`/api/tasks/${encodeURIComponent(task.taskId)}/recovery-actions/accept_reviewed_artifact`, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'Idempotency-Key': idempotencyKey,
                            'X-Ajun-Owner-Action': nonce,
                        },
                        body: JSON.stringify({ expectedUpdatedAt: task.updatedAt || null }),
                    });
                    success++;
                }
            }
            catch (err) {
                console.error('Batch accept task error:', task.taskId, err);
                failed++;
            }
        }
        state.batchSubmitting = false;
        await loadRecords();
        if (elements.batchAcceptBtn) {
            elements.batchAcceptBtn.innerHTML = `<svg aria-hidden="true" width="12" height="12"><use href="#icon-shield"></use></svg><span>${failed === 0 ? `已成功采纳 ${success} 项` : `完成：成功 ${success}，失败 ${failed}`}</span>`;
            setTimeout(() => {
                renderBatchActions();
            }, 3000);
        }
    }
    function renderFilters() {
        const chips = [];
        if (state.q)
            chips.push(`搜索：${state.q}`);
        if (state.agentId)
            chips.push(agentName(state.agentId));
        if (state.status)
            chips.push(`状态：${statusLabel(state.status)}`);
        if (state.taskType)
            chips.push(taskTypeLabel(state.taskType));
        if (state.time !== '30d')
            chips.push(state.time === 'all' ? '全部时间' : '近 7 天');
        if (state.includeRoutine)
            chips.push('包含例行巡检');
        if (state.backlogCategory)
            chips.unshift(`状态：${BACKLOG_CATEGORY_LABELS[state.backlogCategory]}`);
        elements.activeFilters.innerHTML = chips.map((chip) => html `<span class="record-filter-chip">${chip}</span>`).join('');
        elements.activeFilters.hidden = !chips.length;
        const changed = Boolean(state.q || state.agentId || state.status || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
        elements.filterToggle.classList.toggle('has-filters', changed);
    }
    function refreshFilterOptions() {
        const selectedAgent = state.agentId;
        const selectedType = state.taskType;
        const selectedStatus = state.status;
        const agents = [...(getAgents() || [])].sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN'));
        elements.agentFilter.replaceChildren(option('', '全部员工'), ...agents.map((agent) => option(agent.agentId, agent.name || agent.agentId)));
        const types = [...new Set(agents.flatMap((agent) => agent.acceptedTaskTypes || []))].sort((left, right) => taskTypeLabel(left).localeCompare(taskTypeLabel(right), 'zh-CN'));
        elements.typeFilter.replaceChildren(option('', '全部类型'), ...types.map((type) => option(type, taskTypeLabel(type))));
        elements.agentFilter.value = selectedAgent;
        elements.typeFilter.value = selectedType;
        if (elements.statusFilter)
            elements.statusFilter.value = selectedStatus;
    }
    function syncControls() {
        elements.search.value = state.q;
        elements.agentFilter.value = state.agentId;
        if (elements.statusFilter)
            elements.statusFilter.value = state.status;
        elements.typeFilter.value = state.taskType;
        elements.timeFilter.value = state.time;
        elements.routineFilter.checked = state.includeRoutine;
        renderFilters();
    }
    function recordQueryUrl(cursor) {
        const params = new URLSearchParams({ view: state.view, limit: '24' });
        if (state.backlogCategory)
            params.set('backlogCategory', state.backlogCategory);
        if (state.q)
            params.set('q', state.q);
        if (state.agentId)
            params.set('agentId', state.agentId);
        if (state.status)
            params.set('status', state.status);
        if (state.taskType)
            params.set('taskType', state.taskType);
        if (state.time !== 'all')
            params.set('since', sinceFor(state.time));
        if (state.includeRoutine)
            params.set('includeRoutine', '1');
        if (cursor)
            params.set('cursor', cursor);
        return `/api/task-records?${params}`;
    }
    function replaceRecordUrl() {
        const url = new URL('/', location.origin);
        if (state.view !== 'needs_action')
            url.searchParams.set('recordView', state.view);
        if (state.q)
            url.searchParams.set('recordQuery', state.q);
        if (state.agentId)
            url.searchParams.set('recordAgent', state.agentId);
        if (state.status)
            url.searchParams.set('recordStatus', state.status);
        if (state.taskType)
            url.searchParams.set('recordType', state.taskType);
        if (state.time !== '30d')
            url.searchParams.set('recordTime', state.time);
        if (state.includeRoutine)
            url.searchParams.set('recordRoutine', '1');
        if (state.backlogCategory)
            url.searchParams.set('recordCategory', state.backlogCategory);
        url.hash = 'records';
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    function renderLoading() {
        elements.count.textContent = '读取中';
        elements.list.innerHTML = '<div class="record-list-empty"><strong>读取中</strong></div>';
    }
    function renderError(error) {
        elements.count.textContent = '读取失败';
        elements.list.innerHTML = html `<div class="record-list-error"><strong>读不到记录</strong><p>${error.message || '本次没有读完。'}</p><button class="focus-primary-action" type="button" data-record-retry>重试</button></div>`;
    }
    function renderDetailError(error) {
        elements.detail.innerHTML = html `<div class="record-list-error"><strong>打不开这条记录</strong><p>${error.message || '任务没有被更改。'}</p><button class="focus-primary-action" type="button" data-record-detail-retry>重试</button></div>`;
        elements.detail.querySelector('[data-record-detail-retry]')?.addEventListener('click', () => {
            loadSelectedDetail({ revealDetail: false, quiet: false });
        });
    }
    function emptyCountLabel() {
        return state.backlogCategory ? `${BACKLOG_CATEGORY_LABELS[state.backlogCategory]} · 0` : '0';
    }
    function emptyDetailLabel() {
        return state.view === 'needs_action' ? '没有待处理' : '没有记录';
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && state.previewSubtaskData) {
                state.previewSubtaskData = null;
                renderDetail();
            }
        });
    }
}
function missingNextActionMessage(taskView) {
    if (taskView === 'needs_action')
        return '没有可执行动作，去飞书补充信息。';
    return '处理中，有进度会更新。';
}
function compactAttentionReason(task) {
    const attention = taskAttentionView(task);
    if (!attention)
        return '';
    return cleanAttentionText(attention.cause, 90);
}
export function renderTechnicalDetails(task, presentation, attention, escapeHtml) {
    const attentionTechnicalView = attention?.technical || null;
    const presentationTechnical = presentation?.technical && typeof presentation.technical === 'object'
        ? presentation.technical
        : {};
    const values = {
        taskId: cleanAttentionText(presentationTechnical.taskId || task.taskId, 80),
        status: cleanAttentionText(presentationTechnical.status, 80),
        stage: cleanAttentionText(attentionTechnicalView?.stage || presentationTechnical.currentStage, 120),
        errorCode: cleanAttentionText(attentionTechnicalView?.code || presentationTechnical.errorCode, 120),
    };
    const rows = [
        ['完整编号', values.taskId],
        ['创建时间', formatFullDateTime(task.createdAt)],
        ['更新时间', formatFullDateTime(task.updatedAt)],
        ['完成时间', formatFullDateTime(task.completedAt)],
        ['Paperclip 运行', task.paperclipRun?.runId
                ? `${cleanAttentionText(task.paperclipRun.status, 40)} · ${cleanAttentionText(task.paperclipRun.runId, 80)}`
                : ''],
        ['原始状态', values.status],
        ['当前阶段', values.stage],
        ['错误代码', values.errorCode],
    ].filter(([, value]) => value);
    if (!rows.length)
        return '';
    const paperclipIssue = (!attention?.paperclipIssue && task.paperclipIssue?.detailUrl)
        ? html `<a class="record-paperclip-link" href="${task.paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip ${task.paperclipIssue.identifier || '任务'}</a>`
        : '';
    const rowsHtml = rows.map(([label, value]) => html `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    return html `<details class="record-technical" data-disclosure-key="record-technical:${values.taskId}"><summary><span>编号与审计</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><dl>${raw(rowsHtml)}</dl><div class="record-technical-actions">${raw(paperclipIssue)}<button class="text-action record-copy-id" type="button">复制编号</button></div></details>`;
}
function newIdempotencyKey(taskId, actionKey) {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `ajun-console:${String(taskId).slice(0, 36)}:${String(actionKey).slice(0, 40)}:${random}`;
}
function withAcceptanceTarget(payload) {
    const task = payload?.task && typeof payload.task === 'object' ? payload.task : {};
    const acceptanceTarget = task.acceptanceTarget || payload?.acceptanceTarget || null;
    return acceptanceTarget ? { ...task, acceptanceTarget } : task;
}
function acceptanceRevision(task) {
    const target = acceptanceTargetView(task);
    return target
        ? `${String(target.revision ?? '')}:${String(target.decision || '')}:${String(target.actionable)}`
        : '';
}
function acceptanceErrorMessage(error) {
    if (error?.status === 409)
        return '这项结果刚刚在其他入口被处理了。你的选择没有覆盖新结果，请刷新后查看最新状态。';
    if (error?.status === 401)
        return '当前页面缺少运行台访问授权。这项待办仍然保留，请重新打开运行台后重试。';
    if (error?.status === 403)
        return `${cleanAttentionText(error?.message, 400) || '本机操作授权刷新失败。'} 这项待办仍然保留，请重新打开任务详情后重试。`;
    if (error?.status === 404 || error?.status === 501)
        return '当前运行版本还不能在运行台保存验收。这项待办没有被更改，你仍可在飞书完成验收。';
    return cleanAttentionText(error?.message, 500) || '验收结果没有保存。这项待办仍然保留，请稍后重试。';
}
function recordElements() {
    return {
        workbench: document.querySelector('#record-workbench'),
        viewButtons: [...document.querySelectorAll('[data-record-view]')],
        search: document.querySelector('#task-search'),
        filterToggle: document.querySelector('#record-filter-toggle'),
        filterPanel: document.querySelector('#record-filter-panel'),
        agentFilter: document.querySelector('#record-agent-filter'),
        statusFilter: document.querySelector('#record-status-filter'),
        typeFilter: document.querySelector('#record-type-filter'),
        timeFilter: document.querySelector('#record-time-filter'),
        routineFilter: document.querySelector('#record-routine-filter'),
        filterApply: document.querySelector('#record-filter-apply'),
        filterReset: document.querySelector('#record-filter-reset'),
        activeFilters: document.querySelector('#record-active-filters'),
        newItems: document.querySelector('#record-new-items'),
        count: document.querySelector('#task-count'),
        listContext: document.querySelector('#record-list-context'),
        batchActions: document.querySelector('#record-batch-actions'),
        batchAcceptBtn: document.querySelector('#record-batch-accept'),
        batchCount: document.querySelector('#batch-adoptable-count'),
        list: document.querySelector('#task-list'),
        loadMore: document.querySelector('#task-load-more'),
        routineSummary: document.querySelector('#record-routine-summary'),
        detail: document.querySelector('#record-detail'),
    };
}
function readUrlState() {
    const params = new URLSearchParams(location.search);
    const view = VIEW_LABELS[params.get('recordView')] ? params.get('recordView') : 'needs_action';
    const time = ['7d', '30d', 'all'].includes(params.get('recordTime')) ? params.get('recordTime') : '30d';
    return {
        view,
        q: String(params.get('recordQuery') || '').slice(0, 160),
        agentId: String(params.get('recordAgent') || '').slice(0, 80),
        status: String(params.get('recordStatus') || '').slice(0, 80),
        taskType: String(params.get('recordType') || '').slice(0, 160),
        time,
        includeRoutine: params.get('recordRoutine') === '1',
        backlogCategory: Object.hasOwn(BACKLOG_CATEGORY_LABELS, String(params.get('recordCategory') || ''))
            ? String(params.get('recordCategory'))
            : '',
    };
}
function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
}
function sinceFor(period) {
    const days = period === '7d' ? 7 : 30;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function stateForTask(status) {
    if (['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error'].includes(status))
        return 'needs_action';
    if (['succeeded', 'cancelled', 'rejected', 'stopped'].includes(status))
        return 'completed';
    return 'active';
}
