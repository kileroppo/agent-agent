import { html } from './html.js';
import { option, sinceFor } from './task-record-workbench-helpers.js';
export function renderFilters(state, elements, agentName, statusLabel, taskTypeLabel, backlogLabels) {
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
        chips.unshift(`状态：${backlogLabels[state.backlogCategory] || state.backlogCategory}`);
    elements.activeFilters.innerHTML = chips.map((chip) => html `<span class="record-filter-chip">${chip}</span>`).join('');
    elements.activeFilters.hidden = !chips.length;
    const changed = Boolean(state.q || state.agentId || state.status || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
    elements.filterToggle.classList.toggle('has-filters', changed);
}
export function refreshFilterOptions(state, elements, getAgents, taskTypeLabel) {
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
export function syncControls(state, elements, renderFiltersFn) {
    elements.search.value = state.q;
    elements.agentFilter.value = state.agentId;
    if (elements.statusFilter)
        elements.statusFilter.value = state.status;
    elements.typeFilter.value = state.taskType;
    elements.timeFilter.value = state.time;
    elements.routineFilter.checked = state.includeRoutine;
    renderFiltersFn();
}
export function replaceRecordUrl(state, backlogLabels) {
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
    if (state.backlogCategory && backlogLabels[state.backlogCategory])
        url.searchParams.set('recordCategory', state.backlogCategory);
    url.hash = 'records';
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
export function renderBatchActions(state, elements, isTaskAdoptable) {
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
export async function handleBatchAcceptHelper({ state, elements, isTaskAdoptable, acceptanceTargetView, newIdempotencyKey, submitAcceptance, api, loadRecords, renderBatchActions: updateBatchUI, }) {
    const adoptableTasks = state.items.filter((task) => isTaskAdoptable(task));
    if (!adoptableTasks.length || state.batchSubmitting)
        return;
    const count = adoptableTasks.length;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`确认批量采纳当前 ${count} 项待采纳任务产物？`))
        return;
    state.batchSubmitting = true;
    elements.batchAcceptBtn.disabled = true;
    let success = 0, failed = 0;
    for (let i = 0; i < adoptableTasks.length; i++) {
        const task = adoptableTasks[i];
        elements.batchAcceptBtn.innerHTML = `<span>正在采纳 (${i + 1}/${count})…</span>`;
        try {
            const target = acceptanceTargetView(task);
            const idempotencyKey = newIdempotencyKey(task.taskId, 'batch_accept');
            let itemSucceeded = false;
            // 1. 如果有真实的工作流 Target (不是虚拟WF-开头的伪Target)，先尝试工作流采纳
            if (target?.actionable && target.workflowId && !target.workflowId.startsWith('WF-')) {
                try {
                    await submitAcceptance({ target, decision: 'accepted', idempotencyKey });
                    itemSucceeded = true;
                }
                catch (wfErr) {
                    console.warn('Batch workflow acceptance fallback to recovery action:', task.taskId, wfErr);
                }
            }
            // 2. 双轨降级：如果工作流未命中或失败，调用受控恢复动作 accept_reviewed_artifact
            if (!itemSucceeded) {
                const session = await api('/api/owner-action-session');
                const nonce = String(session?.nonce || '').trim();
                if (!nonce)
                    throw new Error('暂时无法取得本机操作授权');
                try {
                    await api(`/api/tasks/${encodeURIComponent(task.taskId)}/recovery-actions/accept_reviewed_artifact`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-Ajun-Owner-Action': nonce },
                        body: JSON.stringify({ expectedUpdatedAt: task.updatedAt || null }),
                    });
                    itemSucceeded = true;
                }
                catch (recErr) {
                    // 如果 recovery-action 失败，再尝试一次 submitAcceptance (如果有 target)
                    if (target?.actionable) {
                        await submitAcceptance({ target, decision: 'accepted', idempotencyKey });
                        itemSucceeded = true;
                    }
                    else {
                        throw recErr;
                    }
                }
            }
            if (itemSucceeded) {
                success++;
            }
            else {
                failed++;
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
        setTimeout(() => { updateBatchUI(); }, 3000);
    }
}
