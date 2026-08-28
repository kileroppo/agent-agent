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
