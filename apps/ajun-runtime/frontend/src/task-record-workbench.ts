import { html, raw, escapeHtml } from './html.js';
import { statusLabel, stageLabel } from './console-labels.js';
import {
    acceptanceTargetView,
    cleanAttentionText,
    recoverySubmissionView,
    renderAcceptanceDetail,
    renderAttentionDetail,
    renderCostSection,
    renderDeliverySink,
    renderDetailTabNav,
    renderOriginCard,
    renderSubtaskDrawer,
    renderTaskLineageCard,
    taskAttentionView,
} from './task-record-detail-view.js';
import { bindSubtaskDrawerEvents } from './task-record-subtask-drawer.js';
import { createTaskTimelineLoader } from './task-timeline-view.js';
import { renderTaskProgressBar } from './task-progress-bar.js';
import { renderTaskWorkflowTree } from './task-tree-view.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import {
    artifactItems,
    displaySubtaskTitle,
    displayTaskTitle,
    parseTaskTitle,
    relativeTime,
    renderArtifact,
    resultSummary,
} from './task-record-presentation.js';
import {
    renderFilters as renderFiltersHelper,
    refreshFilterOptions as refreshFilterOptionsHelper,
    syncControls as syncControlsHelper,
    replaceRecordUrl as replaceRecordUrlHelper,
    renderBatchActions as renderBatchActionsHelper,
    handleBatchAcceptHelper,
} from './task-record-workbench-filters.js';
import {
    renderDetailHeader,
    renderCollaborationTab,
    renderOverviewTab,
    renderListRows,
    bindDetailInteractions,
} from './task-record-workbench-views.js';
import {
    VIEW_LABELS,
    BACKLOG_CATEGORY_LABELS,
    compactAttentionReason,
    recordElements,
    readUrlState,
    option,
    sinceFor,
    stateForTask,
    renderTechnicalDetails,
} from './task-record-workbench-helpers.js';
import {
    isTaskAdoptable,
    newIdempotencyKey,
    acceptanceRevision,
    confirmAttentionActionHelper,
    executeAttentionActionHelper,
    executeAcceptanceDecisionHelper,
    submitWorkflowAcceptance,
} from './task-record-workbench-acceptance.js';

export { taskAttentionView } from './task-record-detail-view.js';
export { parseTaskTitle, displayTaskTitle, displaySubtaskTitle } from './task-record-presentation.js';
export { renderTechnicalDetails } from './task-record-workbench-helpers.js';
// Paperclip 运行 audit projection marker
export function createTaskRecordWorkbench({ api, getAgents, taskTypeLabel, agentName, initialTaskId = '', }: any): any {
    const elements: any = recordElements();
    const timeline: any = createTaskTimelineLoader({ api });
    const urlState: any = readUrlState();
    const state: any = {
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
        detailTab: 'overview' as 'overview' | 'deliverables' | 'collaboration',
        previewSubtaskData: null as any | null,
    };

    let searchTimer: any;
    bindEvents();
    syncControls();
    return {
        async setActive(active: any): Promise<any> {
            state.active = Boolean(active);
            if (!state.active)
                return;
            refreshFilterOptions();
            if (!state.loaded)
                await loadRecords();
        },
        async refresh({ background = false }: any = {}): Promise<any> {
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
    function bindEvents(): any {
        for (const button of elements.viewButtons)
            button.addEventListener('click', async (): Promise<any> => {
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
        elements.search.addEventListener('input', (): any => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async (): Promise<any> => {
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
        elements.filterToggle.addEventListener('click', (): any => {
            const expanded: any = elements.filterPanel.hidden;
            elements.filterPanel.hidden = !expanded;
            elements.filterToggle.setAttribute('aria-expanded', String(expanded));
        });
        elements.filterApply.addEventListener('click', async (): Promise<any> => {
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
        elements.filterReset.addEventListener('click', async (): Promise<any> => {
            Object.assign(state, { agentId: '', status: '', taskType: '', time: '30d', includeRoutine: false, backlogCategory: '', autoExpanded: false });
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
        elements.loadMore.addEventListener('click', async (): Promise<any> => loadRecords({ append: true }));
        elements.newItems.addEventListener('click', async (): Promise<any> => loadRecords());
        elements.batchAcceptBtn?.addEventListener('click', async (): Promise<any> => handleBatchAccept());
        elements.list.addEventListener('click', async (event: any): Promise<any> => {
            if (event.target.closest('[data-record-retry]')) {
                await loadRecords();
                return;
            }
            const emptyView: any = event.target.closest('[data-empty-view]');
            if (emptyView) {
                state.view = emptyView.dataset.emptyView;
                state.selectedTaskId = '';
                state.selectedTask = null;
                syncControls();
                replaceRecordUrl();
                loadRecords();
                return;
            }
            const row: any = event.target.closest('[data-record-task-id]');
            if (!row)
                return;
            const task: any = state.items.find((item: any): any => item.taskId === row.dataset.recordTaskId);
            if (task)
                await selectTask(task, { updateUrl: true, revealDetail: true });
        });
        elements.routineSummary.addEventListener('click', async (event: any): Promise<any> => {
            if (!event.target.closest('[data-show-routine]'))
                return;
            state.includeRoutine = true;
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
    }
    async function loadRecords({ append = false }: any = {}): Promise<any> {
        if (state.loading)
            return;
        state.loading = true;
        if (!append)
            renderLoading();
        else
            elements.loadMore.disabled = true;
        try {
            let page: any = await api(recordQueryUrl(append ? state.nextCursor : ''));
            if (!append && state.q && state.time !== 'all' && page.total === 0) {
                state.time = 'all';
                state.autoExpanded = true;
                syncControls();
                replaceRecordUrl();
                page = await api(recordQueryUrl(''));
            }
            if (!append && !urlState.explicitView && state.view === 'needs_action' && page.counts?.needs_action === 0 && (page.counts?.all > 0 || page.counts?.completed > 0)) {
                state.view = 'all';
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
                const selected: any = state.items.find((item: any): any => item.taskId === state.selectedTaskId);
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
        catch (error: any) {
            renderError(error);
        }
        finally {
            state.loading = false;
            elements.loadMore.disabled = false;
        }
    }
    async function checkForUpdates(): Promise<any> {
        try {
            const page: any = await api(recordQueryUrl(''));
            if (page.revision !== state.revision) {
                const currentIds = new Set(state.items.map((i: any): string => String(i.taskId)));
                const hasNewTasks = Array.isArray(page.items) && page.items.some((i: any): boolean => !currentIds.has(String(i.taskId)));
                elements.newItems.textContent = '有更新';
                elements.newItems.hidden = !hasNewTasks;
            }
            else {
                elements.newItems.hidden = true;
            }
            state.counts = page.counts || state.counts;
            state.total = page.total ?? state.total;
            state.revision = page.revision ?? state.revision;
            renderTabs();
            if (Array.isArray(page.items)) {
                for (const updatedItem of page.items) {
                    const existing = state.items.find((item: any): boolean => item.taskId === updatedItem.taskId);
                    if (existing) {
                        Object.assign(existing, updatedItem);
                    }
                }
            }
            renderList({ quiet: true });
            if (state.selectedTaskId)
                await loadSelectedDetail({ revealDetail: false, quiet: true });
        }
        catch {
            // Background refresh stays quiet; the global sync state already reports connectivity.
        }
    }
    async function loadSelectedDetail({ revealDetail = false, quiet = false }: any = {}): Promise<any> {
        if (!state.selectedTaskId)
            return;
        try {
            const payload: any = await api(`/api/tasks/${encodeURIComponent(state.selectedTaskId)}`);
            const nextTask: any = withAcceptanceTarget(payload);
            if (quiet && state.selectedDetailLoaded && nextTask.updatedAt === state.selectedTask?.updatedAt && nextTask.status === state.selectedTask?.status
                && acceptanceRevision(nextTask) === acceptanceRevision(state.selectedTask))
                return;
            if (quiet && state.selectedDetailLoaded) {
                const prevTask: any = state.selectedTask;
                const sameStatus: boolean = nextTask.status === prevTask?.status;
                const sameApproval: boolean = nextTask.pendingApproval?.approvalId === prevTask?.pendingApproval?.approvalId;
                const sameAcceptance: boolean = acceptanceRevision(nextTask) === acceptanceRevision(prevTask);
                const prevArtifacts: number = (prevTask?.artifactRefs || prevTask?.artifacts || []).length;
                const nextArtifacts: number = (nextTask?.artifactRefs || nextTask?.artifacts || []).length;
                const sameArtifacts: boolean = prevArtifacts === nextArtifacts;
                const prevSubtasks: number = (prevTask?.children || []).length;
                const nextSubtasks: number = (nextTask?.children || []).length;
                const sameSubtasks: boolean = prevSubtasks === nextSubtasks;

                if (sameStatus && sameApproval && sameAcceptance && sameArtifacts && sameSubtasks && nextTask.taskId === prevTask?.taskId) {
                    state.selectedTask = nextTask;
                    const durationSpan: any = elements.detail.querySelector('.record-header-meta');
                    if (durationSpan) {
                        const createdFull: string = formatFullDateTime(nextTask.createdAt);
                        const durationText: string = nextTask.createdAt ? formatDuration(nextTask.createdAt, nextTask.completedAt || (nextTask.recordView === 'completed' ? nextTask.updatedAt : null)) : '';
                        const relativeTimeStr: string = relativeTime(nextTask.createdAt || nextTask.updatedAt);
                        durationSpan.textContent = `${createdFull ? `${createdFull} · ` : ''}${durationText ? `耗时 ${durationText} · ` : ''}${relativeTimeStr}`;
                    }
                    return;
                }
            }
            const detailScrollTop: any = quiet ? elements.detail.scrollTop : 0;
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
        catch (error: any) {
            if (!quiet)
                renderDetailError(error);
            if (revealDetail)
                elements.workbench.classList.add('is-detail-open');
        }
    }
    async function selectTask(task: any, { updateUrl, revealDetail }: any): Promise<any> {
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
    function renderWorkbench(routineSummary: any): any {
        renderTabs();
        renderFilters();
        renderList();
        renderRoutineSummary(routineSummary);
        renderDetail();
        renderBatchActions();
        elements.loadMore.hidden = !state.nextCursor;
        elements.loadMore.textContent = state.nextCursor ? `更多 ${state.items.length}/${state.total}` : '已全部显示';
    }
    function renderTabs(): any {
        for (const button of elements.viewButtons) {
            const view: any = button.dataset.recordView;
            const active: any = view === state.view;
            const count: any = Number(state.counts[view] || 0);
            const showCount: any = ['needs_action', 'active'].includes(view) && count > 0;
            button.textContent = `${VIEW_LABELS[view]}${showCount ? ` ${count}` : ''}`;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        const activeLabel: any = BACKLOG_CATEGORY_LABELS[state.backlogCategory] || VIEW_LABELS[state.view];
        elements.count.textContent = state.total ? `${state.total}` : emptyCountLabel();
        elements.listContext.textContent = state.autoExpanded
            ? '已扩到全部时间'
            : state.backlogCategory ? activeLabel : '';
    }
    function renderList({ quiet = false }: { quiet?: boolean } = {}): any {
        if (!state.items.length) {
            const filtered: any = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
            const title: any = filtered ? '没有匹配' : state.view === 'needs_action' ? '没有待处理' : '暂无记录';
            const nextView: any = !filtered && state.view === 'needs_action'
                ? state.counts.active ? 'active' : state.counts.completed ? 'completed' : state.counts.all ? 'all' : ''
                : '';
            const nextLabel: any = nextView === 'active' ? `进行中 ${state.counts.active}` : nextView === 'completed' ? '看已完成' : nextView === 'all' ? '看全部' : '';
            elements.list.innerHTML = html`<div class="record-list-empty"><strong>${title}</strong>${raw(nextView ? html`<button class="text-action" type="button" data-empty-view="${nextView}">${nextLabel}</button>` : '')}</div>`;
            return;
        }
        const displayItems: any[] = state.view === 'all'
            ? [...state.items].sort((left: any, right: any): any => {
                const leftCompleted: number = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(left?.status) ? 1 : 0;
                const rightCompleted: number = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(right?.status) ? 1 : 0;
                return leftCompleted - rightCompleted;
            })
            : state.items;

        const currentButtons: any[] = [...elements.list.querySelectorAll('[data-record-task-id]')];
        const currentTaskIds: string[] = currentButtons.map((btn: any): string => String(btn.dataset.recordTaskId));
        const rootDisplayTasks: any[] = displayItems.filter((i: any): boolean => !i.parentTaskId);
        const nextTaskIds: string[] = rootDisplayTasks.map((i: any): string => String(i.taskId));

        if (currentTaskIds.length === nextTaskIds.length && currentTaskIds.every((id: string, idx: number): boolean => id === nextTaskIds[idx])) {
            for (const task of rootDisplayTasks) {
                const btn: any = elements.list.querySelector(`[data-record-task-id="${task.taskId}"]`);
                if (!btn) continue;
                const isSelected: boolean = state.selectedTaskId === task.taskId;
                btn.classList.toggle('is-selected', isSelected);
                btn.setAttribute('aria-selected', String(isSelected));
                const statusEl: any = btn.querySelector('.record-row-status');
                if (statusEl) {
                    const presentation: any = task.presentation || {};
                    const tone: string = presentation.tone || 'active';
                    statusEl.className = `record-row-status ${tone}`;
                    statusEl.textContent = presentation.statusLabel || '';
                }
            }
            return;
        }

        const nextListHtml = renderListRows({
            displayItems,
            selectedTaskId: state.selectedTaskId,
            compactAttentionReason,
            agentName,
            relativeTime,
            displayTaskTitle,
        });

        if (elements.list.innerHTML !== nextListHtml) {
            elements.list.innerHTML = nextListHtml;
        }
    }

    function renderRoutineSummary(summary: any = {}): any {
        const hidden: any = Number(summary.hidden || 0);
        if (!hidden || state.includeRoutine) {
            elements.routineSummary.hidden = true;
            elements.routineSummary.replaceChildren();
            return;
        }
        const today: any = Number(summary.today || 0);
        const attention: any = Number(summary.attention || 0);
        elements.routineSummary.innerHTML = html`🛡️ 例行巡检已自动归档 ${hidden} 条${today ? ` · 今日 ${today} 次` : ''}${attention ? ` · ${attention} 条异常已保留` : ''}（系统环境自检 · 0 模型 Token 消耗 · 不占用主任务列表）<button type="button" data-show-routine>查看明细</button>`;
        elements.routineSummary.hidden = false;
    }
    function renderDetail(): any {
        const task: any = state.selectedTask;
        if (!task) {
            elements.detail.innerHTML = html`<div class="record-detail-empty"><p>${state.items.length ? '选一条记录' : emptyDetailLabel()}</p></div>`;
            return;
        }
        const presentation: any = task.presentation || {};
        const taskView: any = task.recordView || stateForTask(task.status);
        const needsAction: any = taskView === 'needs_action';
        const attention: any = taskAttentionView(task);
        const acceptanceTarget: any = acceptanceTargetView(task);
        const result: any = resultSummary(task);
        const ownArtifacts: any[] = artifactItems(task.artifactRefs || [], { hideEmployeeReport: true });
        const siblingArtifacts: any[] = [];
        const seenArtifactKeys = new Set(ownArtifacts.map((a: any) => a.artifactId || `${a.type}:${a.title || a.name || ''}`));

        if (task.workflowBreadcrumb && Array.isArray(task.workflowBreadcrumb.siblings)) {
            for (const sibling of task.workflowBreadcrumb.siblings) {
                const subArtifacts = artifactItems(sibling.artifactRefs || [], { hideEmployeeReport: true });
                const siblingAgent = sibling.assigneeAgentId ? agentName(sibling.assigneeAgentId) : '';
                for (const art of subArtifacts) {
                    const artType = String(art?.type || '');
                    if (['cross_agent_mission_plan', 'cross_agent_mission_summary'].includes(artType)) {
                        continue;
                    }
                    const key = art.artifactId || `${art.type}:${art.title || art.name || ''}`;
                    if (seenArtifactKeys.has(key)) continue;
                    seenArtifactKeys.add(key);
                    siblingArtifacts.push({
                        ...art,
                        _fromAgentName: siblingAgent,
                        _fromSubtaskTitle: sibling.title,
                        _fromTaskId: sibling.taskId,
                    });
                }
            }
        }

        const artifacts: any[] = [...ownArtifacts, ...siblingArtifacts];
        const actionState: any = state.actionState.get(task.taskId) || null;
        const acceptanceState: any = state.acceptanceState.get(task.taskId) || null;
        const summary: any = presentation.summary || '';
        const distinctResult: any = result && result.text && result.text !== summary ? result : null;
        const parsedTitle: any = parseTaskTitle(task?.input?.title || task?.title || '');
        
        // Pure high-value business outcome (No robotic "progress" or "next action" tags)
        const isTaskAccepted = acceptanceTarget?.decision === 'accepted' || task.status === 'succeeded';
        const hasActionableAttention = attention && (!isTaskAccepted || (Array.isArray(attention.actions) && attention.actions.length > 0));
        const outcomeContent = distinctResult?.text || (summary && taskView === 'completed' ? summary : '');
        const outcomeHtml: any = hasActionableAttention
            ? renderAttentionDetail(attention, actionState, escapeHtml, { task })
            : (outcomeContent || task.pendingApproval?.reason)
                ? html`${raw(outcomeContent ? html`
                    <section class="record-primary-summary${needsAction ? ' needs-action' : ''}">
                        <p class="record-pure-result">${outcomeContent}</p>
                    </section>
                ` : '')}${raw(task.pendingApproval?.reason ? html`<details class="record-detail-section record-context-details"><summary>待确认原因</summary><p>${task.pendingApproval.reason}</p></details>` : '')}`
                : '';

        const isWorkflow: boolean = Boolean(task.workflowBreadcrumb && (task.workflowBreadcrumb.workflowId || (task.workflowBreadcrumb.siblings && task.workflowBreadcrumb.siblings.length > 0)));
        const createdFull: string = formatFullDateTime(task.createdAt);
        const durationText: string = task.createdAt ? formatDuration(task.createdAt, task.completedAt || (taskView === 'completed' ? task.updatedAt : null)) : '';
        const tabNavHtml = renderDetailTabNav(state.detailTab, { deliverablesCount: artifacts.length, isWorkflow });
        const isReworkTask = parsedTitle?.badges?.some((b: any) => b.tone === 'rework') || /定向返工/i.test(task?.input?.title || task?.title || '');
        const reworkArtifactsHtml = isReworkTask && artifacts.length ? artifacts.map((a: any) => renderArtifact(a, { isAccepted: isTaskAccepted })).join('') : '';
        const isWaitingTest = task.status === 'waiting_test';

        // Tab 1: Combined Overview & Deliverables Panel
        const overviewTabHtml = renderOverviewTab({
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
        });


        // Tab 2: Collaboration & Trace Panel
        const collaborationTabHtml = renderCollaborationTab({
            task,
            state,
            agentName,
            renderTaskWorkflowTree,
            renderCostSection,
            renderTechnicalDetails,
            presentation,
            attention,
            escapeHtml,
        });

        // Drawer overlay for subtask preview
        const subtaskDrawerHtml = state.previewSubtaskData
            ? renderSubtaskDrawer(state.previewSubtaskData, { agentName, parentAgent: agentName(task.assigneeAgentId) })
            : '';

        const headerHtml = renderDetailHeader({
            task,
            presentation,
            agentName,
            createdFull,
            durationText,
            relativeTime,
            displayTaskTitle,
        });

        const nextDetailHtml = html`
      ${raw(headerHtml)}
      ${raw(tabNavHtml)}
      <div class="detail-tab-content">
        ${raw(overviewTabHtml)}
        ${raw(collaborationTabHtml)}
      </div>
      ${raw(subtaskDrawerHtml)}`;


        if (elements.detail.innerHTML === nextDetailHtml) {
            return;
        }

        const activeElem: any = document.activeElement;
        const noteEl: any = elements.detail.querySelector('[data-acceptance-note]');
        const savedNoteValue: any = noteEl ? noteEl.value : null;
        const isNoteFocused: boolean = activeElem === noteEl;
        const noteSelStart: any = noteEl?.selectionStart;
        const noteSelEnd: any = noteEl?.selectionEnd;

        const prevScrollTop: any = elements.detail.scrollTop;
        const openDisclosures: any = new Set([...elements.detail.querySelectorAll('details')].filter((d: any): boolean => d.open).map((d: any): string => d.querySelector('summary')?.textContent?.trim() || ''));

        elements.detail.innerHTML = nextDetailHtml;

        for (const details of elements.detail.querySelectorAll('details')) {
            const sumText: any = details.querySelector('summary')?.textContent?.trim() || '';
            if (openDisclosures.has(sumText)) {
                details.open = true;
            }
        }
        elements.detail.scrollTop = prevScrollTop;

        if (savedNoteValue !== null) {
            const newNoteEl: any = elements.detail.querySelector('[data-acceptance-note]');
            if (newNoteEl && savedNoteValue) {
                newNoteEl.value = savedNoteValue;
                if (isNoteFocused) {
                    newNoteEl.focus();
                    if (noteSelStart != null && noteSelEnd != null) {
                        newNoteEl.setSelectionRange(noteSelStart, noteSelEnd);
                    }
                }
            }
        }

        // Tab Switching Handler
        for (const tabBtn of elements.detail.querySelectorAll('[data-detail-tab]')) {
            tabBtn.addEventListener('click', async (e: any): Promise<any> => {
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
        bindSubtaskDrawerEvents({ elements, state, api, loadSelectedDetail, loadRecords, renderDetail });

        // Trigger timeline loading automatically when collaboration tab opens
        if (state.detailTab === 'collaboration' && !state.timelineHtml) {
            loadTimeline(task.taskId).then((htmlStr: string) => {
                state.timelineHtml = htmlStr;
                renderDetail();
            });
        }

        bindDetailInteractions({
            elements,
            state,
            task,
            renderDetail,
            replaceRecordUrl,
            loadSelectedDetail,
            api,
            loadRecords,
        });

        for (const approveBtn of elements.detail.querySelectorAll('[data-task-approve]')) {
            approveBtn.addEventListener('click', async (e: any): Promise<any> => {
                const taskId = e.currentTarget.dataset.taskApprove;
                let approvalId = e.currentTarget.dataset.taskApprovalId;
                if (!taskId) return;
                try {
                    approveBtn.disabled = true;
                    approveBtn.textContent = '正在确认…';
                    if (!approvalId) {
                        const taskPayload = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
                        approvalId = taskPayload?.pendingApproval?.approvalId
                            || (Array.isArray(taskPayload?.task?.approvalRefs) && taskPayload.task.approvalRefs[0])
                            || '';
                    }
                    if (approvalId) {
                        await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({}),
                        });
                    } else {
                        await api(`/api/tasks/${encodeURIComponent(taskId)}/continue`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({}),
                        });
                    }
                    await loadSelectedDetail({ revealDetail: false, quiet: false });
                    await loadRecords();
                } catch (err: any) {
                    console.error('Failed to approve task:', err);
                    alert(err?.message || '确认失败，请重试');
                } finally {
                    approveBtn.disabled = false;
                }
            });
        }

        for (const rejectBtn of elements.detail.querySelectorAll('[data-task-reject]')) {
            rejectBtn.addEventListener('click', async (e: any): Promise<any> => {
                const taskId = e.currentTarget.dataset.taskReject;
                let approvalId = e.currentTarget.dataset.taskApprovalId;
                if (!taskId) return;
                if (!confirm('确定要拒绝并关闭这项任务吗？')) return;
                try {
                    rejectBtn.disabled = true;
                    rejectBtn.textContent = '正在拒绝…';
                    if (!approvalId) {
                        const taskPayload = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
                        approvalId = taskPayload?.pendingApproval?.approvalId
                            || (Array.isArray(taskPayload?.task?.approvalRefs) && taskPayload.task.approvalRefs[0])
                            || '';
                    }
                    if (approvalId) {
                        await api(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({}),
                        });
                    }
                    await loadSelectedDetail({ revealDetail: false, quiet: false });
                    await loadRecords();
                } catch (err: any) {
                    console.error('Failed to reject task:', err);
                    alert(err?.message || '拒绝失败，请重试');
                } finally {
                    rejectBtn.disabled = false;
                }
            });
        }

        for (const button of elements.detail.querySelectorAll('[data-attention-action]')) {
            button.addEventListener('click', (): any => confirmAttentionAction(task, button.dataset.attentionAction));
        }
        elements.detail.querySelector('[data-attention-confirm]')?.addEventListener('click', (event: any): any => executeAttentionAction(task, event.currentTarget.dataset.attentionConfirm));
        elements.detail.querySelector('[data-attention-cancel]')?.addEventListener('click', (): any => {
            state.actionState.delete(task.taskId);
            renderDetail();
        });
        for (const button of elements.detail.querySelectorAll('[data-acceptance-decision]')) {
            button.addEventListener('click', (): any => executeAcceptanceDecision(task, button.dataset.acceptanceDecision));
        }
        const timelineShell: any = elements.detail.querySelector('[data-task-timeline-shell]');
        timelineShell?.addEventListener('toggle', async (): Promise<any> => {
            if (!timelineShell.open || state.timelineHtml)
                return;
            const summaryNode: any = timelineShell.querySelector('summary');
            if (summaryNode)
                summaryNode.textContent = '读取中…';
            state.timelineHtml = await loadTimeline(task.taskId);
            renderDetail();
        });
        elements.detail.querySelector('[data-task-timeline-more]')?.addEventListener('click', async (): Promise<any> => {
            try {
                state.timelineHtml = await timeline.loadMore();
            }
            catch { /* Keep the already loaded timeline page visible. */ }
            renderDetail();
        });
    }
    async function loadTimeline(taskId: any): Promise<any> {
        try {
            return await timeline.load(taskId);
        }
        catch {
            return '<div class="timeline-empty-card"><p>过程读取失败，业务结果不受影响。</p></div>';
        }
    }
    function confirmAttentionAction(task: any, actionKey: any): any {
        confirmAttentionActionHelper({ task, actionKey, state, renderDetail, elements });
    }
    async function executeAttentionAction(task: any, actionKey: any): Promise<any> {
        await executeAttentionActionHelper({ task, actionKey, state, renderDetail, api, loadSelectedDetail, recoverySubmissionView });
    }
    async function executeAcceptanceDecision(task: any, decision: any): Promise<any> {
        await executeAcceptanceDecisionHelper({
            task, decision, state, renderDetail, elements, submitAcceptance, api, loadRecords, withAcceptanceTarget,
        });
    }
    async function submitAcceptance({ target, decision, note, idempotencyKey }: any): Promise<any> {
        return submitWorkflowAcceptance({ api, target, decision, note, idempotencyKey });
    }

    function renderBatchActions(): void {
        renderBatchActionsHelper(state, elements, isTaskAdoptable);
    }

    async function handleBatchAccept(): Promise<any> {
        await handleBatchAcceptHelper({
            state,
            elements,
            isTaskAdoptable,
            acceptanceTargetView,
            newIdempotencyKey,
            submitAcceptance,
            api,
            loadRecords,
            renderBatchActions,
        });
    }


    function renderFilters(): void {
        renderFiltersHelper(state, elements, agentName, statusLabel, taskTypeLabel, BACKLOG_CATEGORY_LABELS);
    }

    function refreshFilterOptions(): void {
        refreshFilterOptionsHelper(state, elements, getAgents, taskTypeLabel);
    }

    function syncControls(): void {
        syncControlsHelper(state, elements, renderFilters);
    }

    function recordQueryUrl(cursor: any): string {
        const params: any = new URLSearchParams({ view: state.view, limit: '24' });
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

    function replaceRecordUrl(): void {
        replaceRecordUrlHelper(state, BACKLOG_CATEGORY_LABELS);
    }

    function renderLoading(): any {
        if (!state.items.length) {
            elements.count.textContent = '读取中';
            elements.list.innerHTML = '<div class="record-list-empty"><strong>读取中</strong></div>';
        }
    }
    function renderError(error: any): any {
        elements.count.textContent = '读取失败';
        elements.list.innerHTML = html`<div class="record-list-error"><strong>读不到记录</strong><p>${error.message || '本次没有读完。'}</p><button class="focus-primary-action" type="button" data-record-retry>重试</button></div>`;
    }
    function renderDetailError(error: any): any {
        elements.detail.innerHTML = html`<div class="record-list-error"><strong>打不开这条记录</strong><p>${error.message || '任务没有被更改。'}</p><button class="focus-primary-action" type="button" data-record-detail-retry>重试</button></div>`;
        elements.detail.querySelector('[data-record-detail-retry]')?.addEventListener('click', (): any => {
            loadSelectedDetail({ revealDetail: false, quiet: false });
        });
    }
    function emptyCountLabel(): any {
        return state.backlogCategory ? `${BACKLOG_CATEGORY_LABELS[state.backlogCategory]} · 0` : '0';
    }
    function emptyDetailLabel(): any {
        return state.view === 'needs_action' ? '没有待处理' : '没有记录';
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && state.previewSubtaskData) {
                state.previewSubtaskData = null;
                renderDetail();
            }
        });
    }
}

function missingNextActionMessage(taskView: any): string {
    if (taskView === 'needs_action')
        return '没有可执行动作，去飞书补充信息。';
    return '处理中，有进度会更新。';
}

function withAcceptanceTarget(payload: any): any {
    const task: any = payload?.task && typeof payload.task === 'object' ? payload.task : {};
    const acceptanceTarget: any = task.acceptanceTarget || payload?.acceptanceTarget || null;
    return acceptanceTarget ? { ...task, acceptanceTarget } : task;
}

function acceptanceErrorMessage(error: any): any {
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





