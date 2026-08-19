import { html, raw, escapeHtml } from './html.js';
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
        paperclipIssue: safePaperclipIssue(task?.paperclipIssue),
        verification: attentionVerification(source.verification),
        technical: attentionTechnical(source.technical),
    };
}

export function acceptanceTargetView(task: any = {}): any {
    const source: any = task?.acceptanceTarget;
    if (!source || typeof source !== 'object')
        return null;
    const workflowId: any = cleanAttentionText(source.workflowId, 160);
    if (!workflowId)
        return null;
    const decision: any = ['accepted', 'revision_required'].includes(source.decision)
        ? source.decision
        : null;
    const sourceRevision: any = source.revision ?? source.version;
    const revision: any = typeof sourceRevision === 'number' && Number.isFinite(sourceRevision)
        ? sourceRevision
        : cleanAttentionText(sourceRevision, 120) || null;
    return {
        workflowId,
        title: cleanAttentionText(source.title, 240) || cleanAttentionText(task?.input?.title, 240) || '本次业务结果',
        status: cleanAttentionText(source.status || source.workflowStatus, 80) || (decision ? 'decided' : 'waiting_acceptance'),
        decision,
        revision,
        actionable: source.actionable === true && !decision,
    };
}

export function renderAcceptanceDetail(target: any, submission: any, _escapeHtml: any): any {
    if (!target || (!target.actionable && !target.decision))
        return '';
    const submitting: any = submission?.status === 'submitting';
    const decision: any = submission?.status === 'saved' ? submission.decision : target.decision;
    const closed: any = decision === 'accepted' || decision === 'revision_required';
    const headline: any = decision === 'accepted'
        ? '你已确认这次结果有用'
        : decision === 'revision_required'
            ? '你已标记这次结果需要改进'
            : '这次结果需要你验收';
    const description: any = decision === 'accepted'
        ? '本轮工作已经闭环，不需要继续处理。'
        : decision === 'revision_required'
            ? '本轮决定已经记录，系统不会把它伪装成成功，也不会自动反复重试。'
            : '请选择一个结果。无论选择哪项，本轮都会留下明确结论。';
    const feedback: any = submission?.message
        ? html`<p class="record-acceptance-message ${submission.status === 'failed' ? 'is-failed' : ''}" role="status">${submission.message}</p>`
        : '';
    const controls: any = target.actionable && !closed
        ? html`<label class="record-acceptance-note">补充说明（可选）<textarea rows="2" maxlength="1000" data-acceptance-note placeholder="例如：哪里有用，或下一次需要改进什么"${raw(submitting ? ' disabled' : '')}>${submission?.note || ''}</textarea></label>
        <div class="record-acceptance-actions">
          <button type="button" data-acceptance-decision="accepted"${raw(submitting ? ' disabled' : '')}>${submitting && submission?.decision === 'accepted' ? '正在保存…' : '有用'}</button>
          <button type="button" class="secondary-action" data-acceptance-decision="revision_required"${raw(submitting ? ' disabled' : '')}>${submitting && submission?.decision === 'revision_required' ? '正在保存…' : '需改进'}</button>
        </div>`
        : '';
    return html`<section class="record-acceptance${raw(closed ? ' is-closed' : '')}" aria-label="业务结果验收">
      <span>${closed ? '验收结果' : '需要你决定'}</span>
      <h3>${headline}</h3>
      <p><strong>${target.title}</strong></p>
      <p>${description}</p>
      ${raw(controls)}${raw(feedback)}
    </section>`;
}
export function renderAttentionDetail(attention: any, actionState: any, _escapeHtml: any): any {
    const recovery: any = actionState?.status === 'confirming' ? attention.verification : actionState || attention.verification;
    const diagnosis: any = actionState?.status === 'confirming' ? null : recoveryDiagnosis(recovery?.diagnosis);
    if (diagnosis)
        return renderDiagnosisOutcome(diagnosis, recovery, attention.paperclipIssue, _escapeHtml);
    const primaryIndex: any = Math.max(0, attention.actions.findIndex((action: any): any => action.emphasis === 'primary'));
    const submitting: any = actionState?.status === 'submitting';
    const confirmingAction: any = actionState?.status === 'confirming'
        ? attention.actions.find((action: any): any => action.actionKey === actionState.actionKey)
        : null;
    const actions: any = attention.actions.map((action: any, index: any): any => {
        const className: any = index === primaryIndex ? 'record-attention-primary' : 'secondary-action';
        return html`<button type="button" class="${className}" data-attention-action="${action.actionKey}"${raw(submitting ? ' disabled' : '')}>${action.label}</button>`;
    }).join('');
    const confirmation: any = confirmingAction
        ? cleanAttentionText(actionState?.message, 500) || confirmingAction.confirmation || `确认执行“${confirmingAction.label}”？系统只会执行这条明确的恢复动作。`
        : '';
    const actionContent: any = confirmingAction
        ? html`<div class="record-attention-confirmation" role="alert"><p>${confirmation}</p><div class="record-attention-actions"><button type="button" class="record-attention-primary" data-attention-confirm="${confirmingAction.actionKey}">确认${confirmingAction.label}</button><button type="button" class="secondary-action" data-attention-cancel>取消</button></div></div>`
        : actions
            ? html`<div class="record-attention-actions">${raw(actions)}</div>`
            : html`<p>${attention.nextAction}</p>`;
    const evidence: any = attention.evidence
        ? html`<details class="record-attention-evidence"><summary>查看判断依据</summary><p>${attention.evidence}</p></details>`
        : '';
    const risks: any = attention.remainingRisks
        ? html`<details class="record-attention-evidence"><summary>查看剩余风险</summary><p>${attention.remainingRisks}</p></details>`
        : '';
    const recoveryPath: any = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink: any = recoveryPath
        ? html`<a class="record-recovery-link" href="${recoveryPath}">查看恢复进度</a>`
        : '';
    const recoveryResult: any = recovery
        ? html`<div class="record-recovery-status ${recoveryTone(recovery.status)}" role="status"><strong>处理进度</strong><p>${recovery.message}</p>${raw(recoveryLink)}</div>`
        : '';
    return html`<section class="record-attention" aria-label="任务处理说明">
    <div class="record-attention-head"><span>需要你处理</span><h3>${attention.headline}</h3><p>${attention.cause}</p></div>
    <div class="record-attention-impact"><strong>影响</strong><p>${attention.impact}</p>${raw(evidence)}${raw(risks)}</div>
    <div class="record-attention-next"><strong>下一步</strong>${raw(actionContent)}</div>
    ${raw(recoveryResult)}
  </section>`;
}

function renderDiagnosisOutcome(diagnosis: any, recovery: any, paperclipIssue: any, _escapeHtml: any): any {
    const recoveryPath: any = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink: any = recoveryPath
        ? html`<a class="record-recovery-link" href="${recoveryPath}">诊断记录</a>`
        : '';
    const paperclipLink: any = paperclipIssue?.detailUrl
        ? html`<a class="record-attention-primary record-paperclip-link" href="${paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip 失败记录</a>`
        : '';
    const fallbackNext: any = paperclipLink
        ? ''
        : html`<p class="record-outcome-fallback">${diagnosis.nextAction}</p>`;
    return html`<section class="record-diagnosis-outcome" aria-label="只读诊断结果">
    <h3>${diagnosisHeadline(diagnosis)}</h3>
    <p class="record-outcome-summary">${diagnosisSummary(diagnosis)}</p>
    ${raw(paperclipLink)}${raw(fallbackNext)}
    <details class="record-attention-evidence"><summary>诊断依据</summary><p>${diagnosis.evidence}</p>${raw(recoveryLink)}</details>
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
function safePaperclipIssue(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    try {
        const url: any = new URL(cleanAttentionText(value.detailUrl, 1000));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^\/issues\/[a-z0-9-]+\/?$/i.test(url.pathname))
            return null;
        return {
            identifier: cleanAttentionText(value.identifier, 120) || null,
            detailUrl: url.toString(),
        };
    }
    catch {
        return null;
    }
}
function diagnosisHeadline(diagnosis: any): any {
    const conclusion: any = cleanAttentionText(diagnosis?.conclusion, 800);
    return /paperclip/i.test(conclusion) && /(失败|结束)/.test(conclusion)
        ? 'Paperclip 执行失败'
        : conclusion;
}
function diagnosisSummary(diagnosis: any): any {
    const conclusion: any = cleanAttentionText(diagnosis?.conclusion, 800);
    const evidence: any = cleanAttentionText(diagnosis?.evidence, 1200);
    if (/(没有形成|未生成|没有生成).{0,12}可验证/.test(conclusion) || /可验证产物\s*0\s*份/.test(evidence))
        return '未生成可验证产物，原任务未完成。';
    return cleanAttentionText(diagnosis?.impact, 800);
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
