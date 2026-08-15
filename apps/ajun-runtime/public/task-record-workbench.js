import { cleanAttentionText, recoverySubmissionView, renderAttentionDetail, taskAttentionView, } from './task-record-detail-view.js';
import { createTaskTimelineLoader } from './task-timeline-view.js';
export { taskAttentionView } from './task-record-detail-view.js';
const VIEW_LABELS = Object.freeze({
    needs_action: '需要我处理',
    active: '处理中',
    completed: '已完成',
    all: '全部记录',
});
export function createTaskRecordWorkbench({ api, getAgents, taskTypeLabel, agentName, escapeHtml, initialTaskId = '', }) {
    const elements = recordElements();
    const timeline = createTaskTimelineLoader({ api, escapeHtml });
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
                if (state.view === button.dataset.recordView && !state.selectedTaskId)
                    return;
                state.view = button.dataset.recordView;
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
            Object.assign(state, { agentId: '', taskType: '', time: '30d', includeRoutine: false, autoExpanded: false });
            syncControls();
            replaceRecordUrl();
            await loadRecords();
        });
        elements.loadMore.addEventListener('click', async () => loadRecords({ append: true }));
        elements.newItems.addEventListener('click', async () => loadRecords());
        elements.list.addEventListener('click', async (event) => {
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
                elements.newItems.textContent = '有新的记录，点击更新';
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
            if (quiet && state.selectedDetailLoaded && payload.task.updatedAt === state.selectedTask?.updatedAt && payload.task.status === state.selectedTask?.status)
                return;
            const detailScrollTop = quiet ? elements.detail.scrollTop : 0;
            state.selectedTask = payload.task;
            state.timelineHtml = await loadTimeline(payload.task.taskId);
            state.selectedDetailLoaded = true;
            if (!payload.task?.presentation?.attention || payload.task.presentation.attention.verification) {
                state.actionState.delete(payload.task.taskId);
            }
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
        else {
            state.timelineHtml = await loadTimeline(task.taskId);
            renderDetail();
        }
    }
    function renderWorkbench(routineSummary) {
        renderTabs();
        renderFilters();
        renderList();
        renderRoutineSummary(routineSummary);
        renderDetail();
        elements.loadMore.hidden = !state.nextCursor;
        elements.loadMore.textContent = state.nextCursor ? `继续加载（已显示 ${state.items.length}/${state.total}）` : '已显示全部';
    }
    function renderTabs() {
        for (const button of elements.viewButtons) {
            const view = button.dataset.recordView;
            const active = view === state.view;
            button.textContent = `${VIEW_LABELS[view]} ${state.counts[view] ?? 0}`;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        elements.count.textContent = state.total ? `${state.total} 条记录` : emptyCountLabel();
        elements.listContext.textContent = state.autoExpanded
            ? '近 30 天未找到，已查询全部时间'
            : state.items.length < state.total ? `已显示 ${state.items.length} 条` : '按更新时间排列';
    }
    function renderList() {
        if (!state.items.length) {
            const filtered = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine);
            const title = filtered ? '没有匹配的记录' : state.view === 'needs_action' ? '目前没有需要你处理的事' : '这个分类暂时没有记录';
            const detail = filtered
                ? '调整搜索词或筛选条件后再试。'
                : state.view === 'needs_action' && state.counts.active ? `${state.counts.active} 项工作仍在处理中，你暂时不用操作。` : '新的记录出现后会自动提醒。';
            const nextView = !filtered && state.view === 'needs_action'
                ? state.counts.active ? 'active' : state.counts.completed ? 'completed' : state.counts.all ? 'all' : ''
                : '';
            elements.list.innerHTML = `<div class="record-list-empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p>${nextView ? `<button class="text-action" type="button" data-empty-view="${nextView}">${escapeHtml(nextView === 'active' ? '查看处理中' : nextView === 'completed' ? '查看最近完成' : '查看全部记录')}</button>` : ''}</div>`;
            return;
        }
        elements.list.innerHTML = state.items.map((task) => {
            const selected = state.selectedTaskId === task.taskId;
            const presentation = task.presentation || {};
            const tone = presentation.tone || 'active';
            const reason = compactAttentionReason(task);
            return `<button class="record-row${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-record-task-id="${escapeHtml(task.taskId)}">
        <span class="record-row-main">
          <span class="record-row-title">${escapeHtml(displayTaskTitle(task))}</span>
          ${reason ? `<span class="record-row-reason">${escapeHtml(reason)}</span>` : ''}
          <span class="record-row-meta"><span>${escapeHtml(agentName(task.assigneeAgentId))}</span><span>·</span><span>${escapeHtml(relativeTime(task.updatedAt || task.createdAt))}</span></span>
        </span>
        <span class="record-row-status ${escapeHtml(tone)}">${escapeHtml(presentation.statusLabel || '状态更新')}</span>
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
        elements.routineSummary.innerHTML = `例行巡检已自动归档 ${hidden} 条${today ? ` · 今日 ${today} 次` : ''}${attention ? ` · ${attention} 条异常历史已保留` : ''}<button type="button" data-show-routine>查看明细</button>`;
        elements.routineSummary.hidden = false;
    }
    function renderDetail() {
        const task = state.selectedTask;
        if (!task) {
            elements.detail.innerHTML = `<div class="record-detail-empty"><svg aria-hidden="true"><use href="#icon-records"></use></svg><p>${state.items.length ? '选择一条记录查看结果和下一步' : emptyDetailLabel()}</p></div>`;
            return;
        }
        const presentation = task.presentation || {};
        const taskView = task.recordView || stateForTask(task.status);
        const needsAction = taskView === 'needs_action';
        const attention = taskAttentionView(task);
        const result = resultSummary(task);
        const artifacts = artifactItems(task.artifactRefs || [], { hideEmployeeReport: Boolean(attention) });
        const actionState = state.actionState.get(task.taskId) || null;
        elements.detail.innerHTML = `
      <button class="record-detail-back" type="button">← 返回记录</button>
      <header class="record-detail-header">
        <div class="record-detail-kicker"><span class="record-row-status ${escapeHtml(presentation.tone || 'active')}">${escapeHtml(presentation.statusLabel || '状态更新')}</span><span>${escapeHtml(presentation.taskRef || '')}</span></div>
        <h2>${escapeHtml(displayTaskTitle(task))}</h2>
        <div class="record-detail-meta"><span>${escapeHtml(agentName(task.assigneeAgentId))}</span><span>${escapeHtml(taskTypeLabel(task.taskType))}</span><span>更新于 ${escapeHtml(relativeTime(task.updatedAt || task.createdAt))}</span></div>
      </header>
      ${attention
            ? renderAttentionDetail(attention, actionState, escapeHtml)
            : `<div class="record-decision${needsAction ? ' needs-action' : ''}">
            <span>${needsAction ? '你现在需要做什么' : taskView === 'active' ? '当前状态' : taskView === 'completed' ? '结果' : '历史状态'}</span>
            <strong>${escapeHtml(presentation.nextAction || '等待新的进度。')}</strong>
          </div>
          <section class="record-detail-section">
            <h3>发生了什么</h3>
            <p>${escapeHtml(presentation.summary || `${displayTaskTitle(task)}状态已更新。`)}</p>
          </section>
          ${result ? `<section class="record-detail-section"><h3>${escapeHtml(result.label)}</h3><p>${escapeHtml(result.text)}</p></section>` : ''}
          ${task.pendingApproval?.reason ? `<section class="record-detail-section"><h3>等待确认的原因</h3><p>${escapeHtml(task.pendingApproval.reason)}</p></section>` : ''}`}
      ${artifacts.length ? `<section class="record-detail-section"><h3>交付与证据</h3><ul class="record-artifact-list">${artifacts.map(renderArtifact).join('')}</ul></section>` : ''}
      ${state.timelineHtml}
      <div class="record-detail-actions"><button class="secondary-action record-copy-id" type="button">复制任务编号</button></div>
      ${renderTechnicalDetails(task, presentation, attention, escapeHtml)}`;
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
            return '<section class="record-detail-section task-timeline"><h3>运行过程</h3><p>运行记录暂时无法读取，不影响任务结果。</p></section>';
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
            message: action.confirmation || `确认执行“${action.label}”？系统只会执行这条明确的恢复动作。`,
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
        elements.activeFilters.innerHTML = chips.map((chip) => `<span class="record-filter-chip">${escapeHtml(chip)}</span>`).join('');
        elements.activeFilters.hidden = !chips.length;
        const changed = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine);
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
        url.hash = 'records';
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    function renderLoading() {
        elements.count.textContent = '正在读取…';
        elements.list.innerHTML = '<div class="record-list-empty"><strong>正在整理任务记录</strong><p>只读取当前需要的这一页。</p></div>';
    }
    function renderError(error) {
        elements.count.textContent = '读取失败';
        elements.list.innerHTML = `<div class="record-list-error"><strong>暂时无法读取任务记录</strong><p>${escapeHtml(error.message || '请稍后重试。')}</p></div>`;
    }
    function renderDetailError(error) {
        elements.detail.innerHTML = `<div class="record-list-error"><strong>无法打开这条记录</strong><p>${escapeHtml(error.message || '任务可能已经不存在。')}</p></div>`;
    }
    function emptyCountLabel() {
        return state.view === 'needs_action' ? '无需处理' : '0 条记录';
    }
    function emptyDetailLabel() {
        return state.view === 'needs_action' ? '目前没有需要你处理的事' : '当前条件下没有记录';
    }
}
function compactAttentionReason(task) {
    const attention = taskAttentionView(task);
    if (!attention)
        return '';
    return attention.cause;
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
        ['原始状态', values.status],
        ['当前阶段', values.stage],
        ['错误代码', values.errorCode],
    ].filter(([, value]) => value);
    if (!rows.length)
        return '';
    return `<details class="record-technical"><summary>技术详情</summary><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></details>`;
}
function newIdempotencyKey(taskId, actionKey) {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `ajun-console:${String(taskId).slice(0, 36)}:${String(actionKey).slice(0, 40)}:${random}`;
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
    return `<li><span>${escapeStatic(artifact.label)}</span>${artifact.url ? `<a href="${escapeStatic(artifact.url)}" target="_blank" rel="noopener noreferrer">打开</a>` : '<span>已记录</span>'}</li>`;
}
function escapeStatic(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
