import { html } from './html.js';
import { option, sinceFor } from './task-record-workbench-helpers.js';

export function renderFilters(
    state: any, elements: any, agentName: (id: string) => string,
    statusLabel: (status: string) => string, taskTypeLabel: (type: string) => string,
    backlogLabels: Record<string, string>
): void {
    const chips: string[] = [];
    if (state.q) chips.push(`搜索：${state.q}`);
    if (state.agentId) chips.push(agentName(state.agentId));
    if (state.status) chips.push(`状态：${statusLabel(state.status)}`);
    if (state.taskType) chips.push(taskTypeLabel(state.taskType));
    if (state.time !== '30d') chips.push(state.time === 'all' ? '全部时间' : '近 7 天');
    if (state.includeRoutine) chips.push('包含例行巡检');
    if (state.backlogCategory) chips.unshift(`状态：${backlogLabels[state.backlogCategory] || state.backlogCategory}`);
    elements.activeFilters.innerHTML = chips.map((chip: any): any => html`<span class="record-filter-chip">${chip}</span>`).join('');
    elements.activeFilters.hidden = !chips.length;
    const changed: boolean = Boolean(state.q || state.agentId || state.status || state.taskType || state.time !== '30d' || state.includeRoutine || state.backlogCategory);
    elements.filterToggle.classList.toggle('has-filters', changed);
}

export function refreshFilterOptions(state: any, elements: any, getAgents: () => any[], taskTypeLabel: (type: string) => string): void {
    const selectedAgent: any = state.agentId;
    const selectedType: any = state.taskType;
    const selectedStatus: any = state.status;
    const agents: any = [...(getAgents() || [])].sort((left: any, right: any): any => String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN'));
    elements.agentFilter.replaceChildren(option('', '全部员工'), ...agents.map((agent: any): any => option(agent.agentId, agent.name || agent.agentId)));
    const types: any = [...new Set(agents.flatMap((agent: any): any => agent.acceptedTaskTypes || []))].sort((left: any, right: any): any => taskTypeLabel(left).localeCompare(taskTypeLabel(right), 'zh-CN'));
    elements.typeFilter.replaceChildren(option('', '全部类型'), ...types.map((type: any): any => option(type, taskTypeLabel(type))));
    elements.agentFilter.value = selectedAgent;
    elements.typeFilter.value = selectedType;
    if (elements.statusFilter) elements.statusFilter.value = selectedStatus;
}

export function syncControls(state: any, elements: any, renderFiltersFn: () => void): void {
    elements.search.value = state.q;
    elements.agentFilter.value = state.agentId;
    if (elements.statusFilter) elements.statusFilter.value = state.status;
    elements.typeFilter.value = state.taskType;
    elements.timeFilter.value = state.time;
    elements.routineFilter.checked = state.includeRoutine;
    renderFiltersFn();
}

export function replaceRecordUrl(state: any, backlogLabels: Record<string, string>): void {
    const url: any = new URL('/', location.origin);
    if (state.view !== 'needs_action') url.searchParams.set('recordView', state.view);
    if (state.q) url.searchParams.set('recordQuery', state.q);
    if (state.agentId) url.searchParams.set('recordAgent', state.agentId);
    if (state.status) url.searchParams.set('recordStatus', state.status);
    if (state.taskType) url.searchParams.set('recordType', state.taskType);
    if (state.time !== '30d') url.searchParams.set('recordTime', state.time);
    if (state.includeRoutine) url.searchParams.set('recordRoutine', '1');
    if (state.backlogCategory && backlogLabels[state.backlogCategory]) url.searchParams.set('recordCategory', state.backlogCategory);
    url.hash = 'records';
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function renderBatchActions(state: any, elements: any, isTaskAdoptable: (task: any) => boolean): void {
    if (!elements.batchActions || !elements.batchAcceptBtn || !elements.batchCount) return;
    const adoptableTasks = state.items.filter((task: any) => isTaskAdoptable(task));
    if (adoptableTasks.length > 0) {
        elements.batchActions.hidden = false;
        elements.batchCount.textContent = String(adoptableTasks.length);
        if (!state.batchSubmitting) {
            elements.batchAcceptBtn.disabled = false;
            elements.batchAcceptBtn.innerHTML = `<svg aria-hidden="true" width="12" height="12"><use href="#icon-shield"></use></svg><span>批量采纳 (<b id="batch-adoptable-count">${adoptableTasks.length}</b>)</span>`;
        }
    } else {
        elements.batchActions.hidden = true;
    }
}

export async function handleBatchAcceptHelper({
    state, elements, isTaskAdoptable, acceptanceTargetView, newIdempotencyKey, submitAcceptance, api, loadRecords, renderBatchActions: updateBatchUI,
}: any): Promise<void> {
    const adoptableTasks = state.items.filter((task: any) => isTaskAdoptable(task));
    if (!adoptableTasks.length || state.batchSubmitting) return;
    const count = adoptableTasks.length;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`确认批量采纳当前 ${count} 项待采纳任务产物？`)) return;
    state.batchSubmitting = true;
    elements.batchAcceptBtn.disabled = true;
    let success = 0, failed = 0;

    for (let i = 0; i < adoptableTasks.length; i++) {
        const task = adoptableTasks[i];
        elements.batchAcceptBtn.innerHTML = `<span>正在采纳 (${i + 1}/${count})…</span>`;
        try {
            const target: any = acceptanceTargetView(task);
            if (target?.actionable) {
                const idempotencyKey: any = newIdempotencyKey(target.workflowId, 'accepted');
                await submitAcceptance({ target, decision: 'accepted', idempotencyKey });
                success++;
            } else {
                const session: any = await api('/api/owner-action-session');
                const nonce: any = String(session?.nonce || '').trim();
                if (!nonce) throw new Error('暂时无法取得本机操作授权');
                const idempotencyKey: any = newIdempotencyKey(task.taskId, 'accept_reviewed_artifact');
                await api(`/api/tasks/${encodeURIComponent(task.taskId)}/recovery-actions/accept_reviewed_artifact`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-Ajun-Owner-Action': nonce },
                    body: JSON.stringify({ expectedUpdatedAt: task.updatedAt || null }),
                });
                success++;
            }
        } catch (err) {
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
