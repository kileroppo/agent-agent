export function taskAttentionView(task = {}) {
    const source = task?.presentation?.attention;
    if (!source || typeof source !== 'object')
        return null;
    const actions = [];
    const seen = new Set();
    for (const candidate of Array.isArray(source.actions) ? source.actions : []) {
        const actionKey = String(candidate?.actionKey || '').trim();
        const label = cleanAttentionText(candidate?.label, 120);
        if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(actionKey) || !label || seen.has(actionKey))
            continue;
        seen.add(actionKey);
        actions.push({
            actionKey,
            label,
            emphasis: candidate.emphasis === 'primary' ? 'primary' : 'secondary',
            confirmation: cleanAttentionText(candidate.confirmation, 500),
        });
    }
    return {
        kind: cleanAttentionText(source.kind, 80) || 'attention',
        headline: cleanAttentionText(source.headline, 200) || '这项任务需要处理',
        cause: cleanAttentionText(source.cause, 1600) || '任务状态发生变化，但暂时没有更具体的用户可见原因。',
        impact: cleanAttentionText(source.impact, 1200) || '任务不会被视为已经完成。',
        evidence: cleanAttentionText(source.evidence, 2400),
        remainingRisks: cleanAttentionText(source.remainingRisks, 1800),
        nextAction: cleanAttentionText(source.nextAction, 1000) || '请根据当前原因决定下一步。',
        actions,
        verification: attentionVerification(source.verification),
        technical: attentionTechnical(source.technical),
    };
}
export function renderAttentionDetail(attention, actionState, escapeHtml) {
    const primaryIndex = Math.max(0, attention.actions.findIndex((action) => action.emphasis === 'primary'));
    const submitting = actionState?.status === 'submitting';
    const confirmingAction = actionState?.status === 'confirming'
        ? attention.actions.find((action) => action.actionKey === actionState.actionKey)
        : null;
    const actions = attention.actions.map((action, index) => {
        const className = index === primaryIndex ? 'record-attention-primary' : 'secondary-action';
        return `<button type="button" class="${className}" data-attention-action="${escapeHtml(action.actionKey)}"${submitting ? ' disabled' : ''}>${escapeHtml(action.label)}</button>`;
    }).join('');
    const confirmation = confirmingAction
        ? cleanAttentionText(actionState?.message, 500) || confirmingAction.confirmation || `确认执行“${confirmingAction.label}”？系统只会执行这条明确的恢复动作。`
        : '';
    const actionContent = confirmingAction
        ? `<div class="record-attention-confirmation" role="alert"><p>${escapeHtml(confirmation)}</p><div class="record-attention-actions"><button type="button" class="record-attention-primary" data-attention-confirm="${escapeHtml(confirmingAction.actionKey)}">确认${escapeHtml(confirmingAction.label)}</button><button type="button" class="secondary-action" data-attention-cancel>取消</button></div></div>`
        : actions
            ? `<div class="record-attention-actions">${actions}</div>`
            : `<p>${escapeHtml(attention.nextAction)}</p>`;
    const evidence = attention.evidence
        ? `<details class="record-attention-evidence"><summary>查看判断依据</summary><p>${escapeHtml(attention.evidence)}</p></details>`
        : '';
    const risks = attention.remainingRisks
        ? `<section class="record-attention-step"><span class="record-attention-number">4</span><div><h3>剩余风险</h3><p>${escapeHtml(attention.remainingRisks)}</p></div></section>`
        : `<section class="record-attention-step is-muted"><span class="record-attention-number">4</span><div><h3>剩余风险</h3><p>未提供剩余风险说明，不能据此判断为无风险。</p></div></section>`;
    const recovery = actionState?.status === 'confirming' ? attention.verification : actionState || attention.verification;
    const recoveryPath = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink = recoveryPath
        ? `<a class="record-recovery-link" href="${escapeHtml(recoveryPath)}">查看恢复进度</a>`
        : '';
    const recoveryResult = recovery
        ? `<section class="record-attention-step record-recovery-status ${escapeHtml(recoveryTone(recovery.status))}" role="status"><span class="record-attention-number">5</span><div><h3>恢复结果</h3><p>${escapeHtml(recovery.message)}</p>${recoveryLink}</div></section>`
        : `<section class="record-attention-step is-muted"><span class="record-attention-number">5</span><div><h3>恢复结果</h3><p>还没有执行恢复动作。</p></div></section>`;
    return `<section class="record-attention" aria-label="任务处理说明">
    <div class="record-attention-head"><span>需要处理</span><h3>${escapeHtml(attention.headline)}</h3></div>
    <section class="record-attention-step"><span class="record-attention-number">1</span><div><h3>发生了什么</h3><p>${escapeHtml(attention.cause)}</p>${evidence}</div></section>
    <section class="record-attention-step"><span class="record-attention-number">2</span><div><h3>影响什么</h3><p>${escapeHtml(attention.impact)}</p></div></section>
    <section class="record-attention-step is-action"><span class="record-attention-number">3</span><div><h3>现在怎么处理</h3>${actionContent}</div></section>
    ${risks}
    ${recoveryResult}
  </section>`;
}
export function recoverySubmissionView(payload, label) {
    const verification = payload?.recovery?.verification && typeof payload.recovery.verification === 'object'
        ? payload.recovery.verification
        : null;
    const status = cleanAttentionText(verification?.state || verification?.status || payload?.status, 80) || 'submitted';
    const message = cleanAttentionText(payload?.message || payload?.recovery?.message || payload?.task?.presentation?.attention?.verification?.message, 1000) || (payload?.status === 'requires_external'
        ? '这项恢复需要在原治理流程中继续；A君没有代替你扩权或重跑。'
        : verificationStateMessage(status) || `“${label}”已提交；正在重新读取任务状态。`);
    const taskId = cleanAttentionText(verification?.taskId || payload?.retryTaskId || payload?.technicalTaskId || payload?.operatorTaskId
        || payload?.recoveryTaskId || payload?.task?.presentation?.attention?.verification?.taskId, 80) || null;
    return {
        status,
        message,
        taskId,
        detailPath: safeTaskDetailPath(verification?.detailPath || payload?.detailPath || payload?.task?.presentation?.attention?.verification?.detailPath, taskId),
    };
}
export function cleanAttentionText(value, limit) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function attentionVerification(value) {
    if (!value || typeof value !== 'object')
        return null;
    const status = cleanAttentionText(value.status || value.state, 80) || 'pending';
    const message = cleanAttentionText(value.message || value.summary || value.label || value.detail, 1000)
        || verificationStateMessage(status);
    if (!message && !value.taskId && !value.detailPath)
        return null;
    return {
        status,
        message,
        taskId: cleanAttentionText(value.taskId, 80) || null,
        detailPath: safeTaskDetailPath(value.detailPath, value.taskId),
    };
}
function attentionTechnical(value) {
    if (!value || typeof value !== 'object')
        return null;
    return {
        code: cleanAttentionText(value.code, 120) || null,
        stage: cleanAttentionText(value.stage, 120) || null,
        retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
        occurredAt: cleanAttentionText(value.occurredAt, 80) || null,
    };
}
function verificationStateMessage(status) {
    return {
        accepted: '恢复请求已接受，正在重新读取任务状态。',
        submitted: '恢复请求已提交，正在重新读取任务状态。',
        pending: '恢复请求已经登记，等待受控处理。',
        retrying: '恢复任务正在执行，尚未完成验证。',
        running: '恢复任务正在执行，尚未完成验证。',
        escalated: '已转交技术处理，等待修复与验证。',
        diagnosed: '只读诊断已经创建，可查看恢复进度。',
        completed: '恢复已经完成。',
        succeeded: '恢复已经完成。',
        verified: '恢复已经验证完成。',
        failed: '恢复没有完成，请查看新的失败原因。',
    }[status] || '';
}
function recoveryTone(status) {
    if (['submitted', 'pending', 'retrying', 'running', 'submitting'].includes(status))
        return 'is-running';
    if (['succeeded', 'completed', 'verified'].includes(status))
        return 'is-success';
    if (['failed', 'rejected', 'blocked'].includes(status))
        return 'is-failed';
    return 'is-pending';
}
function safeTaskDetailPath(detailPath, taskId) {
    const path = cleanAttentionText(detailPath, 240);
    if (/^\/tasks\/[0-9a-f-]{36}$/i.test(path))
        return path;
    const normalizedTaskId = cleanAttentionText(taskId, 80);
    return /^[0-9a-f-]{36}$/i.test(normalizedTaskId) ? `/tasks/${normalizedTaskId}` : null;
}
