import { cleanAttentionText, recoverySubmissionView, renderAttentionDetail, taskAttentionView, } from './task-record-detail-view.js';
import { createTaskTimelineLoader } from './task-timeline-view.js';
export { taskAttentionView } from './task-record-detail-view.js';
const VIEW_LABELS = Object.freeze({
    needs_action: '需要我处理',
    active: '处理中',
    completed: '已完成',
    all: '全部记录',
});
const BACKLOG_CATEGORY_LABELS = Object.freeze({
    owner_actionable: '待处理',
    business_active: '运行中',
    needs_reverification: '待复验',
    unresolved_failures: '仍失败',
    validated_by_later_evidence: '已有新证据',
    historical_archived: '历史归档',
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
            const count = Number(state.counts[view] || 0);
            const showCount = ['needs_action', 'active'].includes(view) && count > 0;
            button.textContent = `${VIEW_LABELS[view]}${showCount ? ` ${count}` : ''}`;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        const activeLabel = BACKLOG_CATEGORY_LABELS[state.backlogCategory] || VIEW_LABELS[state.view];
        elements.count.textContent = state.total ? `${activeLabel} · ${state.total}` : emptyCountLabel();
        elements.listContext.textContent = state.autoExpanded
            ? '近 30 天未找到，已查询全部时间'
            : state.items.length < state.total ? `当前 ${state.items.length} 条` : '';
    }
    function renderList() {
        if (!state.items.length) {
            const filtered = Boolean(state.q || state.agentId || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
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
        const summary = presentation.summary || `${displayTaskTitle(task)}状态已更新。`;
        const showNextAction = needsAction || taskView === 'active';
        elements.detail.innerHTML = `
      <button class="record-detail-back" type="button">← 返回记录</button>
      <header class="record-detail-header">
        <div class="record-detail-kicker"><span class="record-row-status ${escapeHtml(presentation.tone || 'active')}">${escapeHtml(presentation.statusLabel || '状态更新')}</span><span>${escapeHtml(presentation.taskRef || '')}</span></div>
        <h2>${escapeHtml(displayTaskTitle(task))}</h2>
        <div class="record-detail-meta"><span>${escapeHtml(agentName(task.assigneeAgentId))}</span><span>更新于 ${escapeHtml(relativeTime(task.updatedAt || task.createdAt))}</span></div>
      </header>
      ${attention
            ? renderAttentionDetail(attention, actionState, escapeHtml)
            : `<section class="record-primary-summary${needsAction ? ' needs-action' : ''}">
            <span>${taskView === 'completed' ? '运行结果' : taskView === 'active' ? '当前进度' : needsAction ? '需要你处理' : '记录摘要'}</span>
            <h3>${escapeHtml(summary)}</h3>
            ${result && result.text !== summary ? `<p><strong>${escapeHtml(result.label)}</strong>${escapeHtml(result.text)}</p>` : ''}
            ${showNextAction ? `<div class="record-primary-next"><strong>下一步</strong><p>${escapeHtml(presentation.nextAction || '等待新的进度。')}</p></div>` : ''}
          </section>
          ${task.pendingApproval?.reason ? `<details class="record-detail-section record-context-details"><summary>为什么需要确认</summary><p>${escapeHtml(task.pendingApproval.reason)}</p></details>` : ''}`}
      ${artifacts.length ? `<section class="record-detail-section"><h3>交付与证据</h3><ul class="record-artifact-list">${artifacts.map(renderArtifact).join('')}</ul></section>` : ''}
      ${state.timelineHtml || '<details class="record-detail-section task-timeline" data-task-timeline-shell><summary><span>运行过程</span><small>按需查看</small></summary></details>'}
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
        const timelineShell = elements.detail.querySelector('[data-task-timeline-shell]');
        timelineShell?.addEventListener('toggle', async () => {
            if (!timelineShell.open || state.timelineHtml)
                return;
            timelineShell.querySelector('small').textContent = '正在读取…';
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
            return '<details class="record-detail-section task-timeline" data-task-timeline open><summary>运行过程</summary><p>运行记录暂时无法读取，不影响任务结果。</p></details>';
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
        if (state.backlogCategory)
            chips.unshift(`状态：${BACKLOG_CATEGORY_LABELS[state.backlogCategory]}`);
        elements.activeFilters.innerHTML = chips.map((chip) => `<span class="record-filter-chip">${escapeHtml(chip)}</span>`).join('');
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
        return state.backlogCategory ? `${BACKLOG_CATEGORY_LABELS[state.backlogCategory]} · 0` : state.view === 'needs_action' ? '无需处理' : '0 条记录';
    }
    function emptyDetailLabel() {
        return state.view === 'needs_action' ? '目前没有需要你处理的事' : '当前条件下没有记录';
    }
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
        ? `<a class="record-paperclip-link" href="${escapeHtml(task.paperclipIssue.detailUrl)}" target="_blank" rel="noopener">打开 Paperclip ${escapeHtml(task.paperclipIssue.identifier || '任务')}</a>`
        : '';
    return `<details class="record-technical"><summary>技术与审计信息</summary><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${paperclipIssue}<button class="text-action record-copy-id" type="button">复制完整编号</button></details>`;
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
    return `<li><span>${escapeStatic(artifact.label)}</span>${artifact.url ? `<a href="${escapeStatic(artifact.url)}" target="_blank" rel="noopener noreferrer">打开</a>` : '<span>已记录</span>'}</li>`;
}
function escapeStatic(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
