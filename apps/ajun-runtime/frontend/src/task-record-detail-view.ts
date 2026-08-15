export function taskAttentionView(task: any = {}): any {
    const source: any = task?.presentation?.attention;
    if (!source || typeof source !== 'object')
        return null;
    const actions: any = [];
    const seen: any = new Set();
    for (const candidate of Array.isArray(source.actions) ? source.actions : []) {
        const actionKey: any = String(candidate?.actionKey || '').trim();
        const label: any = cleanAttentionText(candidate?.label, 120);
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
export function renderAttentionDetail(attention: any, actionState: any, escapeHtml: any): any {
    const recovery: any = actionState?.status === 'confirming' ? attention.verification : actionState || attention.verification;
    const diagnosis: any = actionState?.status === 'confirming' ? null : recoveryDiagnosis(recovery?.diagnosis);
    if (diagnosis)
        return renderDiagnosisOutcome(diagnosis, recovery, escapeHtml);
    const primaryIndex: any = Math.max(0, attention.actions.findIndex((action: any): any => action.emphasis === 'primary'));
    const submitting: any = actionState?.status === 'submitting';
    const confirmingAction: any = actionState?.status === 'confirming'
        ? attention.actions.find((action: any): any => action.actionKey === actionState.actionKey)
        : null;
    const actions: any = attention.actions.map((action: any, index: any): any => {
        const className: any = index === primaryIndex ? 'record-attention-primary' : 'secondary-action';
        return `<button type="button" class="${className}" data-attention-action="${escapeHtml(action.actionKey)}"${submitting ? ' disabled' : ''}>${escapeHtml(action.label)}</button>`;
    }).join('');
    const confirmation: any = confirmingAction
        ? cleanAttentionText(actionState?.message, 500) || confirmingAction.confirmation || `确认执行“${confirmingAction.label}”？系统只会执行这条明确的恢复动作。`
        : '';
    const actionContent: any = confirmingAction
        ? `<div class="record-attention-confirmation" role="alert"><p>${escapeHtml(confirmation)}</p><div class="record-attention-actions"><button type="button" class="record-attention-primary" data-attention-confirm="${escapeHtml(confirmingAction.actionKey)}">确认${escapeHtml(confirmingAction.label)}</button><button type="button" class="secondary-action" data-attention-cancel>取消</button></div></div>`
        : actions
            ? `<div class="record-attention-actions">${actions}</div>`
            : `<p>${escapeHtml(attention.nextAction)}</p>`;
    const evidence: any = attention.evidence
        ? `<details class="record-attention-evidence"><summary>查看判断依据</summary><p>${escapeHtml(attention.evidence)}</p></details>`
        : '';
    const risks: any = attention.remainingRisks
        ? `<details class="record-attention-evidence"><summary>查看剩余风险</summary><p>${escapeHtml(attention.remainingRisks)}</p></details>`
        : '';
    const recoveryPath: any = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink: any = recoveryPath
        ? `<a class="record-recovery-link" href="${escapeHtml(recoveryPath)}">查看恢复进度</a>`
        : '';
    const recoveryResult: any = recovery
        ? `<div class="record-recovery-status ${escapeHtml(recoveryTone(recovery.status))}" role="status"><strong>处理进度</strong><p>${escapeHtml(recovery.message)}</p>${recoveryLink}</div>`
        : '';
    return `<section class="record-attention" aria-label="任务处理说明">
    <div class="record-attention-head"><span>需要你处理</span><h3>${escapeHtml(attention.headline)}</h3><p>${escapeHtml(attention.cause)}</p></div>
    <div class="record-attention-impact"><strong>影响</strong><p>${escapeHtml(attention.impact)}</p>${evidence}${risks}</div>
    <div class="record-attention-next"><strong>下一步</strong>${actionContent}</div>
    ${recoveryResult}
  </section>`;
}

function renderDiagnosisOutcome(diagnosis: any, recovery: any, escapeHtml: any): any {
    const recoveryPath: any = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink: any = recoveryPath
        ? `<a class="record-recovery-link" href="${escapeHtml(recoveryPath)}">查看诊断任务</a>`
        : '';
    return `<section class="record-diagnosis-outcome" aria-label="只读诊断结果">
    <span class="record-outcome-label">诊断完成</span>
    <h3>${escapeHtml(diagnosis.conclusion)}</h3>
    <div class="record-outcome-impact"><strong>影响</strong><p>${escapeHtml(diagnosis.impact)}</p></div>
    <div class="record-outcome-next"><strong>下一步</strong><p>${escapeHtml(diagnosis.nextAction)}</p></div>
    <details class="record-attention-evidence"><summary>为什么这样判断</summary><p>${escapeHtml(diagnosis.evidence)}</p></details>
    ${recoveryLink}
  </section>`;
}
export function recoverySubmissionView(payload: any, label: any): any {
    const verification: any = payload?.recovery?.verification && typeof payload.recovery.verification === 'object'
        ? payload.recovery.verification
        : null;
    const status: any = cleanAttentionText(verification?.state || verification?.status || payload?.status, 80) || 'submitted';
    const message: any = cleanAttentionText(payload?.message || payload?.recovery?.message || payload?.task?.presentation?.attention?.verification?.message, 1000) || (payload?.status === 'requires_external'
        ? '这项恢复需要在原治理流程中继续；A君没有代替你扩权或重跑。'
        : verificationStateMessage(status) || `“${label}”已提交；正在重新读取任务状态。`);
    const taskId: any = cleanAttentionText(verification?.taskId || payload?.retryTaskId || payload?.technicalTaskId || payload?.operatorTaskId
        || payload?.recoveryTaskId || payload?.task?.presentation?.attention?.verification?.taskId, 80) || null;
    return {
        status,
        message,
        taskId,
        detailPath: safeTaskDetailPath(verification?.detailPath || payload?.detailPath || payload?.task?.presentation?.attention?.verification?.detailPath, taskId),
        ...(recoveryDiagnosis(verification?.diagnosis || payload?.task?.presentation?.attention?.verification?.diagnosis)
            ? { diagnosis: recoveryDiagnosis(verification?.diagnosis || payload?.task?.presentation?.attention?.verification?.diagnosis) }
            : {}),
    };
}
export function cleanAttentionText(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function attentionVerification(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const status: any = cleanAttentionText(value.status || value.state, 80) || 'pending';
    const message: any = cleanAttentionText(value.message || value.summary || value.label || value.detail, 1000)
        || verificationStateMessage(status);
    if (!message && !value.taskId && !value.detailPath)
        return null;
    const diagnosis: any = recoveryDiagnosis(value.diagnosis);
    return {
        status,
        message,
        taskId: cleanAttentionText(value.taskId, 80) || null,
        detailPath: safeTaskDetailPath(value.detailPath, value.taskId),
        ...(diagnosis ? { diagnosis } : {}),
    };
}
function recoveryDiagnosis(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const diagnosis: any = {
        conclusion: cleanAttentionText(value.conclusion, 800),
        evidence: cleanAttentionText(value.evidence, 1200),
        impact: cleanAttentionText(value.impact, 800),
        nextAction: cleanAttentionText(value.nextAction, 1000),
    };
    return Object.values(diagnosis).every(Boolean) ? diagnosis : null;
}
function attentionTechnical(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    return {
        code: cleanAttentionText(value.code, 120) || null,
        stage: cleanAttentionText(value.stage, 120) || null,
        retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
        occurredAt: cleanAttentionText(value.occurredAt, 80) || null,
    };
}
function verificationStateMessage(status: any): any {
    return ({
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
    } as Record<string, string>)[status] || '';
}
function recoveryTone(status: any): any {
    if (['submitted', 'pending', 'retrying', 'running', 'submitting'].includes(status))
        return 'is-running';
    if (['succeeded', 'completed', 'verified'].includes(status))
        return 'is-success';
    if (['failed', 'rejected', 'blocked'].includes(status))
        return 'is-failed';
    return 'is-pending';
}
function safeTaskDetailPath(detailPath: any, taskId: any): any {
    const path: any = cleanAttentionText(detailPath, 240);
    if (/^\/tasks\/[0-9a-f-]{36}$/i.test(path))
        return path;
    const normalizedTaskId: any = cleanAttentionText(taskId, 80);
    return /^[0-9a-f-]{36}$/i.test(normalizedTaskId) ? `/tasks/${normalizedTaskId}` : null;
}
