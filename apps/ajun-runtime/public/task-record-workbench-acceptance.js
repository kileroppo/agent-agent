import { cleanAttentionText, taskAttentionView, acceptanceTargetView } from './task-record-detail-view.js';
export function isTaskAdoptable(task) {
    if (!task)
        return false;
    if (task.status === 'succeeded' || task.acceptanceTarget?.decision === 'accepted')
        return false;
    if (['failed', 'error', 'cancelled', 'stopped', 'needs_input'].includes(task.status))
        return false;
    const attention = taskAttentionView(task);
    if (attention?.actions?.some((a) => a.actionKey === 'accept_reviewed_artifact')) {
        return true;
    }
    const target = acceptanceTargetView(task);
    if (target?.actionable) {
        return true;
    }
    const hasArtifacts = (Array.isArray(task.artifactRefs) && task.artifactRefs.length > 0)
        || (Array.isArray(task.artifacts) && task.artifacts.length > 0);
    if (task.status === 'waiting_test' && hasArtifacts) {
        return true;
    }
    return false;
}
export function newIdempotencyKey(taskId, actionKey) {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `ajun-console:${String(taskId).slice(0, 36)}:${String(actionKey).slice(0, 40)}:${random}`;
}
export function withAcceptanceTarget(payload) {
    const task = payload?.task && typeof payload.task === 'object' ? payload.task : {};
    const acceptanceTarget = task.acceptanceTarget || payload?.acceptanceTarget || null;
    return acceptanceTarget ? { ...task, acceptanceTarget } : task;
}
export function acceptanceRevision(task) {
    const target = acceptanceTargetView(task);
    return target
        ? `${String(target.revision ?? '')}:${String(target.decision || '')}:${String(target.actionable)}`
        : '';
}
export function acceptanceErrorMessage(error) {
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
export async function submitWorkflowAcceptance({ api, target, decision, note, idempotencyKey }) {
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
export function confirmAttentionActionHelper({ task, actionKey, state, renderDetail, elements }) {
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
export async function executeAttentionActionHelper({ task, actionKey, state, renderDetail, api, loadSelectedDetail, recoverySubmissionView }) {
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
export async function executeAcceptanceDecisionHelper({ task, decision, state, renderDetail, elements, submitAcceptance, api, loadRecords, withAcceptanceTarget }) {
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
    }
    finally {
        renderDetail();
    }
}
