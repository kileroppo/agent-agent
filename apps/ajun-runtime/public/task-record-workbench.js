import { html, raw, escapeHtml } from './html.js';
import { acceptanceTargetView, cleanAttentionText, recoverySubmissionView, renderAcceptanceDetail, renderAttentionDetail, taskAttentionView, } from './task-record-detail-view.js';
import { createTaskTimelineLoader } from './task-timeline-view.js';
export { taskAttentionView } from './task-record-detail-view.js';
const VIEW_LABELS = Object.freeze({
    needs_action: '待处理',
    active: '进行中',
    completed: '已完成',
    all: '全部',
});
const BACKLOG_CATEGORY_LABELS = Object.freeze({
    owner_actionable: '待处理',
    business_active: '运行中',
    needs_reverification: '待复验',
    unresolved_failures: '仍失败',
    validated_by_later_evidence: '已有新证据',
    historical_archived: '历史归档',
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
        actionState: new Map(),
        acceptanceState: new Map(),
        timelineHtml: '',
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
            Object.assign(state, { agentId: '', taskType: '', time: '30d', includeRoutine: false, backlogCategory: '', autoExpanded: false });
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
        elements.loadMore.addEventListener('click', async () => loadRecords({ append: true }));
        elements.newItems.addEventListener('click', async () => loadRecords());
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
        elements.list.innerHTML = state.items.map((task) => {
            const selected = state.selectedTaskId === task.taskId;
            const presentation = task.presentation || {};
            const tone = presentation.tone || 'active';
            const reason = compactAttentionReason(task);
            return html `<button class="record-row${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-record-task-id="${task.taskId}">
        <span class="record-row-main">
          <span class="record-row-title">${displayTaskTitle(task)}</span>
          ${raw(reason ? html `<span class="record-row-reason">${reason}</span>` : '')}
          <span class="record-row-meta"><span>${agentName(task.assigneeAgentId)}</span><span>·</span><span>${relativeTime(task.updatedAt || task.createdAt)}</span></span>
        </span>
        <span class="record-row-status ${tone}">${presentation.statusLabel || ''}</span>
      </button>`;
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
        elements.routineSummary.innerHTML = html `例行巡检已自动归档 ${hidden} 条${today ? ` · 今日 ${today} 次` : ''}${attention ? ` · ${attention} 条异常历史已保留` : ''}<button type="button" data-show-routine>查看明细</button>`;
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
        const artifacts = artifactItems(task.artifactRefs || [], { hideEmployeeReport: Boolean(attention) });
        const actionState = state.actionState.get(task.taskId) || null;
        const acceptanceState = state.acceptanceState.get(task.taskId) || null;
        const summary = presentation.summary || '';
        const showNextAction = (needsAction || taskView === 'active') && !attention;
        const nextAction = showNextAction ? (presentation.nextAction || missingNextActionMessage(taskView)) : '';
        const distinctResult = result && result.text && result.text !== summary ? result : null;
        const outcomeLabel = taskView === 'completed' ? '结果' : taskView === 'active' ? '进度' : '下一步';
        const outcomeHtml = attention
            ? renderAttentionDetail(attention, actionState, escapeHtml)
            : (summary || distinctResult || nextAction || task.pendingApproval?.reason)
                ? html `<section class="record-primary-summary${needsAction ? ' needs-action' : ''}">
            <span class="record-outcome-label">${outcomeLabel}</span>
            ${raw(summary ? html `<p>${summary}</p>` : '')}
            ${raw(distinctResult ? html `<p>${distinctResult.text}</p>` : '')}
            ${raw(nextAction && nextAction !== summary ? html `<div class="record-primary-next"><strong>下一步</strong><p>${nextAction}</p></div>` : '')}
          </section>${raw(task.pendingApproval?.reason ? html `<details class="record-detail-section record-context-details"><summary>待确认原因</summary><p>${task.pendingApproval.reason}</p></details>` : '')}`
                : '';
        elements.detail.innerHTML = html `
      <button class="record-detail-back" type="button">返回</button>
      <header class="record-detail-header">
        <div class="record-detail-title-row"><h2>${displayTaskTitle(task)}</h2><span class="record-row-status ${presentation.tone || 'active'}">${presentation.statusLabel || ''}</span></div>
        <p class="record-detail-meta">${agentName(task.assigneeAgentId)} · ${relativeTime(task.updatedAt || task.createdAt)}${raw(presentation.taskRef ? html ` · ${presentation.taskRef}` : '')}</p>
      </header>
      ${raw(renderAcceptanceDetail(acceptanceTarget, acceptanceState, escapeHtml))}
      ${raw(outcomeHtml)}
      ${raw(artifacts.length ? `<section class="record-deliverables"><h3>交付</h3><ul class="record-artifact-list">${artifacts.map(renderArtifact).join('')}</ul></section>` : '')}
      ${raw(state.timelineHtml || '<details class="record-detail-section task-timeline" data-task-timeline-shell><summary>过程</summary></details>')}
      ${raw(renderTechnicalDetails(task, presentation, attention, escapeHtml))}`;
        elements.detail.querySelector('.record-detail-back')?.addEventListener('click', () => {
            elements.workbench.classList.remove('is-detail-open');
            replaceRecordUrl();
        });
        elements.detail.querySelector('.record-copy-id')?.addEventListener('click', async (event) => {
            try {
                await navigator.clipboard.writeText(task.taskId);
                event.currentTarget.textContent = '已复制';
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
            elements.detail.querySelector('[data-task-timeline]')?.setAttribute('open', '');
        });
        elements.detail.querySelector('[data-task-timeline-more]')?.addEventListener('click', async () => {
            try {
                state.timelineHtml = await timeline.loadMore();
            }
            catch { /* Keep the already loaded timeline page visible. */ }
            renderDetail();
            elements.detail.querySelector('[data-task-timeline]')?.setAttribute('open', '');
        });
    }
    async function loadTimeline(taskId) {
        try {
            return await timeline.load(taskId);
        }
        catch {
            return '<details class="record-detail-section task-timeline" data-task-timeline open><summary>过程</summary><p>过程读不了，结果不受影响。</p></details>';
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
            const payload = await submitAcceptance({ target, decision, note, idempotencyKey });
            state.acceptanceState.set(task.taskId, {
                status: 'saved',
                decision,
                message: decision === 'accepted' ? '已记为有用' : '已记为需改进',
            });
            if (payload?.task)
                state.selectedTask = withAcceptanceTarget(payload);
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
    function renderFilters() {
        const chips = [];
        if (state.q)
            chips.push(`搜索：${state.q}`);
        if (state.agentId)
            chips.push(agentName(state.agentId));
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
        const changed = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
        elements.filterToggle.classList.toggle('has-filters', changed);
    }
    function refreshFilterOptions() {
        const selectedAgent = state.agentId;
        const selectedType = state.taskType;
        const agents = [...(getAgents() || [])].sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN'));
        elements.agentFilter.replaceChildren(option('', '全部员工'), ...agents.map((agent) => option(agent.agentId, agent.name || agent.agentId)));
        const types = [...new Set(agents.flatMap((agent) => agent.acceptedTaskTypes || []))].sort((left, right) => taskTypeLabel(left).localeCompare(taskTypeLabel(right), 'zh-CN'));
        elements.typeFilter.replaceChildren(option('', '全部类型'), ...types.map((type) => option(type, taskTypeLabel(type))));
        elements.agentFilter.value = selectedAgent;
        elements.typeFilter.value = selectedType;
    }
    function syncControls() {
        elements.search.value = state.q;
        elements.agentFilter.value = state.agentId;
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
function renderTechnicalDetails(task, presentation, attention, escapeHtml) {
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
        ['Paperclip 运行', task.paperclipRun?.runId
                ? `${cleanAttentionText(task.paperclipRun.status, 40)} · ${cleanAttentionText(task.paperclipRun.runId, 80)}`
                : ''],
        ['原始状态', values.status],
        ['当前阶段', values.stage],
        ['错误代码', values.errorCode],
    ].filter(([, value]) => value);
    if (!rows.length)
        return '';
    const paperclipIssue = task.paperclipIssue?.detailUrl
        ? html `<a class="record-paperclip-link" href="${task.paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip ${task.paperclipIssue.identifier || '任务'}</a>`
        : '';
    return html `<details class="record-technical"><summary>编号与审计</summary><dl>${rows.map(([label, value]) => html `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>${raw(paperclipIssue)}<button class="text-action record-copy-id" type="button">复制编号</button></details>`;
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
        typeFilter: document.querySelector('#record-type-filter'),
        timeFilter: document.querySelector('#record-time-filter'),
        routineFilter: document.querySelector('#record-routine-filter'),
        filterApply: document.querySelector('#record-filter-apply'),
        filterReset: document.querySelector('#record-filter-reset'),
        activeFilters: document.querySelector('#record-active-filters'),
        newItems: document.querySelector('#record-new-items'),
        count: document.querySelector('#task-count'),
        listContext: document.querySelector('#record-list-context'),
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
function displayTaskTitle(task) {
    const title = String(task.input?.title || '未命名任务').trim();
    const productivity = title.match(/^Review productivity for (AGE-\d+)$/i);
    return productivity ? `${productivity[1].toUpperCase()} 产能复盘` : title;
}
function relativeTime(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '时间未记录';
    const delta = timestamp - Date.now();
    const absolute = Math.abs(delta);
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (absolute < 60000)
        return '刚刚';
    if (absolute < 3600000)
        return formatter.format(Math.round(delta / 60000), 'minute');
    if (absolute < 86400000)
        return formatter.format(Math.round(delta / 3600000), 'hour');
    if (absolute < 7 * 86400000)
        return formatter.format(Math.round(delta / 86400000), 'day');
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function resultSummary(task) {
    const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const report = artifacts.find((item) => item?.type === 'health_report')?.data;
    if (report)
        return { label: '检查结果', text: `${report.overall === 'healthy' ? '运行正常' : '发现需要关注的项目'}${Array.isArray(report.components) ? `：${report.components.map((item) => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、')}` : ''}` };
    const intake = artifacts.find((item) => item?.type === 'task_intake_record')?.data;
    if (intake?.nextAction)
        return { label: '判断结果', text: intake.nextAction };
    const review = artifacts.find((item) => item?.type === 'review_report')?.data;
    if (review?.nextAction)
        return { label: '审核结论', text: review.nextAction };
    const publicReport = artifacts.find((item) => item?.type === 'public_web_report')?.data;
    if (publicReport?.summary)
        return { label: '结果摘要', text: publicReport.summary };
    if (task.status === 'succeeded')
        return { label: '完成情况', text: `任务已完成${artifacts.length ? `，留下 ${artifacts.length} 项交付或证据` : ''}。` };
    return null;
}
function artifactItems(artifacts, { hideEmployeeReport = false } = {}) {
    return (Array.isArray(artifacts) ? artifacts : [])
        .filter((artifact) => !(hideEmployeeReport && artifact?.type === 'employee_role_report'))
        .map((artifact, index) => {
        if (typeof artifact === 'string')
            return { label: artifact, url: null };
        const label = String(artifact?.title || artifact?.name || artifact?.type || `产物 ${index + 1}`).replaceAll('_', ' ');
        const candidate = artifact?.url || artifact?.location || artifact?.href || '';
        let url = null;
        try {
            const parsed = new URL(candidate);
            if (['http:', 'https:'].includes(parsed.protocol))
                url = parsed.toString();
        }
        catch {
            // Local references remain evidence labels and are not exposed as unsafe links.
        }
        return { label, url };
    }).slice(0, 12);
}
function renderArtifact(artifact) {
    return artifact.url
        ? `<li><a href="${escapeStatic(artifact.url)}" target="_blank" rel="noopener noreferrer">${escapeStatic(artifact.label)}</a></li>`
        : `<li><span>${escapeStatic(artifact.label)}</span></li>`;
}
function escapeStatic(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
