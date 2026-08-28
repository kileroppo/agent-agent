import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { displaySubtaskTitle } from './task-record-presentation.js';

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
    const taskType = String(task?.taskType || '').trim();
    const isOpsOrSystem = taskType.startsWith('operations.') || taskType.startsWith('system.') || /运维|巡检|检查军团状态/i.test(task?.input?.title || task?.title || '');
    if (isOpsOrSystem) {
        return null; // 系统运维与巡检任务由自动化流水线闭环，无需人工业务验收
    }

    // For child subtasks with a parent task, intermediate steps are managed by the orchestrator
    const isChildSubtask = Boolean(task?.parentTaskId);
    const source: any = task?.acceptanceTarget;
    if (isChildSubtask && !source?.actionable && task?.status !== 'waiting_test') {
        return null; // 中间子任务成果由流水线自动向下游传递，无需前置人工业务验收
    }

    const isRunning = ['running', 'planning', 'acquiring', 'analyzing', 'dispatching'].includes(task?.status);
    if (isRunning && !source?.actionable) {
        return null; // 任务正在执行中，尚未产出最终结果，不提前展示验收卡片
    }

    const workflowId: any = cleanAttentionText(source?.workflowId || task?.workflow?.workflowId || (task?.taskId ? `WF-${task.taskId.slice(0, 8)}` : ''), 160);
    const artifactsList = Array.isArray(task?.artifactRefs) ? task.artifactRefs : (Array.isArray(task?.artifacts) ? task.artifacts : []);
    const hasArtifacts = artifactsList.length > 0;
    const isUnsettled = ['waiting_test', 'waiting_acceptance', 'needs_action'].includes(task?.status);

    if (source && typeof source === 'object') {
        const decision: any = ['accepted', 'revision_required'].includes(source.decision)
            ? source.decision
            : null;
        const sourceRevision: any = source.revision ?? source.version;
        const revision: any = typeof sourceRevision === 'number' && Number.isFinite(sourceRevision)
            ? sourceRevision
            : (Number.isFinite(Number(sourceRevision)) ? Number(sourceRevision) : 0);
        const actionable = !decision && (source.actionable === true || hasArtifacts || isUnsettled);
        return {
            workflowId: workflowId || (task?.taskId ? `WF-${task.taskId.slice(0, 8)}` : 'WF-MAIN'),
            title: cleanAttentionText(source.title, 240) || cleanAttentionText(task?.input?.title, 240) || '本次业务结果',
            status: cleanAttentionText(source.status || source.workflowStatus, 80) || (decision ? 'decided' : 'waiting_acceptance'),
            decision,
            revision,
            actionable,
        };
    }

    // Only show acceptance when task is fully completed or explicitly waiting for test/acceptance
    const isFullyDelivered = task?.status === 'succeeded' || isUnsettled;
    if (isFullyDelivered || (hasArtifacts && !['failed', 'error'].includes(task?.status))) {
        const decision = task?.status === 'succeeded' ? 'accepted' : null;
        return {
            workflowId: workflowId || (task?.taskId ? `WF-${task.taskId.slice(0, 8)}` : 'WF-MAIN'),
            title: cleanAttentionText(task?.input?.title || task?.title, 240) || '本次业务结果',
            status: isUnsettled ? 'waiting_acceptance' : 'decided',
            decision,
            revision: 0,
            actionable: !decision,
        };
    }

    return null;
}

export function renderAcceptanceDetail(target: any, submission: any, _escapeHtml: any): any {
    if (!target || (!target.actionable && !target.decision))
        return '';
    const submitting: any = submission?.status === 'submitting';
    const decision: any = submission?.status === 'saved' ? submission.decision : target.decision;
    const closed: any = decision === 'accepted' || decision === 'revision_required';
    const feedback: any = submission?.message
        ? html`<p class="acceptance-inline-feedback ${submission.status === 'failed' ? 'is-failed' : ''}" role="status">${submission.message}</p>`
        : '';
    if (closed) {
        const closedLabel = decision === 'accepted' ? '● 已确认有用' : '● 已标记需改进';
        return html`<div class="acceptance-inline-bar is-closed" aria-label="业务结果验收"><span class="acceptance-inline-label">${closedLabel}</span></div>`;
    }
    const revisionInput: any = submission?.status === 'revision_input'
        ? html`<div class="acceptance-revision-input"><input type="text" maxlength="500" data-acceptance-note placeholder="哪里需要改进？" autofocus /><button type="button" class="acceptance-revision-submit" data-acceptance-decision="revision_required"${raw(submitting ? ' disabled' : '')}>${submitting ? '提交中…' : '提交'}</button></div>`
        : '';
    const controls: any = target.actionable && !closed
        ? html`<div class="acceptance-inline-actions">
          <button type="button" class="acceptance-btn-useful" data-acceptance-decision="accepted"${raw(submitting && submission?.decision === 'accepted' ? ' disabled' : '')}>${submitting && submission?.decision === 'accepted' ? '保存中…' : '👍 满意'}</button>
          <span class="acceptance-divider">·</span>
          <button type="button" class="acceptance-btn-revise" data-acceptance-show-revision${raw(submitting ? ' disabled' : '')}>需改进</button>
        </div>${raw(revisionInput)}`
        : '';
    return html`<div class="acceptance-inline-bar" aria-label="业务结果验收">
      <span class="acceptance-inline-label">本次结果满意吗？</span>
      ${raw(controls)}${raw(feedback)}
    </div>`;
}

export function renderAttentionDetail(attention: any, actionState: any, _escapeHtml: any, options: any = {}): any {
    const task: any = options?.task || null;
    const isApprovalState: boolean = Boolean(task && (
        attention.kind === 'waiting_approval'
        || ['waiting_approval', 'pending_approval'].includes(task.status)
        || Boolean(task.pendingApproval)
    ));
    // Recovery actions are now handled by the pipeline progress bar popover;
    // skip rendering the large attention card unless it's an approval or has non-recovery actions.
    const PIPELINE_RECOVERY_ACTIONS = new Set(['request_safe_recovery', 'resume_approved_mission', 'use_confirmed_transcript_only', 'retry_visual_analysis_after_recovery']);
    const attentionActions: any[] = Array.isArray(attention?.actions) ? attention.actions : [];
    const allRecoverable = attentionActions.length > 0 && attentionActions.every((a: any) => PIPELINE_RECOVERY_ACTIONS.has(a.actionKey));
    if (allRecoverable && !isApprovalState && actionState?.status !== 'confirming' && actionState?.status !== 'submitting') {
        return '';
    }
    const recovery: any = actionState?.status === 'confirming' ? attention.verification : actionState || attention.verification;
    const diagnosis: any = actionState?.status === 'confirming' ? null : recoveryDiagnosis(recovery?.diagnosis);
    if (diagnosis)
        return renderDiagnosisOutcome(diagnosis, recovery, attention.paperclipIssue, _escapeHtml);
    const primaryIndex: any = Math.max(0, attention.actions.findIndex((action: any): any => action.emphasis === 'primary'));
    const submitting: any = actionState?.status === 'submitting';
    const confirmingAction: any = actionState?.status === 'confirming'
        ? attention.actions.find((action: any): any => action.actionKey === actionState.actionKey)
        : null;
    const primaryAction: any = attention.actions.find((action: any): any => action.emphasis === 'primary') || attention.actions[0];
    let actions: any = attention.actions.map((action: any, index: any): any => {
        const className: any = index === primaryIndex ? 'record-attention-primary' : 'secondary-action';
        return html`<button type="button" class="${className}" data-attention-action="${action.actionKey}"${raw(submitting ? ' disabled' : '')} title="${action.confirmation || ''}">${action.label}</button>`;
    }).join('');

    if (!actions && isApprovalState) {
        const pendingApprovalId: string = (task.pendingApproval?.approvalId)
            || (Array.isArray(task.approvalRefs) && task.approvalRefs.length ? task.approvalRefs[0] : '')
            || task.approvalId
            || '';
        const isWaitingTest: boolean = task.status === 'waiting_test';
        const approveBtnLabel: string = isWaitingTest ? '✓ 确认采纳并继续' : '✓ 确认执行';
        actions = html`
            <button type="button" class="record-attention-primary" data-task-approve="${task.taskId}" data-task-approval-id="${pendingApprovalId}" style="padding: 6px 14px; font-size: 13px; border-radius: 6px; cursor: pointer;">
                ${approveBtnLabel}
            </button>
            <button type="button" class="secondary-action" data-task-reject="${task.taskId}" data-task-approval-id="${pendingApprovalId}" style="padding: 6px 12px; font-size: 13px; color: #dc2626; border-color: rgba(220, 38, 38, 0.3); border-radius: 6px; cursor: pointer;">
                ✕ 拒绝
            </button>
        `;
    }

    const actionHelpNote: any = primaryAction?.confirmation ? html`<p class="record-attention-action-help" style="margin: 8px 0 0; font-size: 12px; color: var(--text-secondary, #666); line-height: 1.5;"><span style="font-weight: 600;">💡 动作说明：</span>${primaryAction.confirmation}</p>` : '';
    const confirmation: any = confirmingAction
        ? cleanAttentionText(actionState?.message, 500) || confirmingAction.confirmation || `确认执行“${confirmingAction.label}”？`
        : '';
    const paperclipLink: any = attention.paperclipIssue?.detailUrl
        ? html`<a class="record-paperclip-link" href="${attention.paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip ${attention.paperclipIssue.identifier || '任务'}</a>`
        : '';
    const hasActions: boolean = Boolean(actions || paperclipLink);
    const isGeneric: boolean = isGenericNextAction(attention.nextAction);
    const fallbackNext: any = !hasActions && !isGeneric && attention.nextAction
        ? html`<p>${attention.nextAction}</p>`
        : '';
    const actionContent: any = confirmingAction
        ? html`<div class="record-attention-confirmation" role="alert"><p style="font-size: 13px; line-height: 1.5; margin-bottom: 10px;"><strong>操作确认：</strong>${confirmation}</p><div class="record-attention-actions"><button type="button" class="record-attention-primary" data-attention-confirm="${confirmingAction.actionKey}">确认${confirmingAction.label}</button><button type="button" class="secondary-action" data-attention-cancel>取消</button></div></div>`
        : hasActions
            ? html`<div class="record-attention-actions">${raw(actions)}${raw(paperclipLink)}</div>${raw(actionHelpNote)}`
            : fallbackNext;
    const cause: any = usefulAttentionCause(attention);
    const evidence: string = usefulAttentionEvidence(attention.evidence, cause);
    const approvalReason: string = task?.pendingApproval?.reason
        ? html`<details class="record-attention-evidence" open><summary><span>待确认原因</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><p>${task.pendingApproval.reason}</p></details>`
        : '';
    const extras: any = [
        approvalReason,
        evidence ? html`<details class="record-attention-evidence"><summary><span>判断依据</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><p>${evidence}</p></details>` : '',
        attention.remainingRisks ? html`<details class="record-attention-evidence"><summary><span>剩余风险</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><p>${attention.remainingRisks}</p></details>` : '',
        usefulAttentionImpact(attention) ? html`<p class="record-attention-impact-line">${attention.impact}</p>` : '',
    ].filter(Boolean).join('');
    const recoveryPath: any = safeTaskDetailPath(recovery?.detailPath, recovery?.taskId);
    const recoveryLink: any = recoveryPath
        ? html`<a class="record-recovery-link" href="${recoveryPath}">恢复进度</a>`
        : '';
    const recoveryResult: any = recovery
        ? html`<div class="record-recovery-status ${recoveryTone(recovery.status)}" role="status"><p>${recovery.message}</p>${raw(recoveryLink)}</div>`
        : '';
    return html`<section class="record-attention" aria-label="任务处理说明">
    <div class="record-attention-head"><h3>${attention.headline}</h3>${raw(cause ? html`<p>${cause}</p>` : '')}</div>
    ${raw(actionContent ? html`<div class="record-attention-next">${raw(actionContent)}</div>` : '')}
    ${raw(extras)}
    ${raw(recoveryResult)}
  </section>`;
}

function usefulAttentionCause(attention: any): string {
    const cause: any = String(attention?.cause || '').trim();
    if (!cause || cause === attention.headline)
        return '';
    if (cause === '任务状态发生变化，但暂时没有更具体的用户可见原因。')
        return '';
    return cause;
}

const GENERIC_NEXT_ACTIONS = new Set([
    '请根据当前原因决定下一步。',
    '请根据失败原因决定补充信息、调整范围或暂不处理。',
    '当前不应原样重试；请根据失败原因补充信息或调整范围。',
    '请先确认相关依赖已经恢复，再决定是否重新尝试。',
    '请查看任务详情。',
    '请查看已有结果和验证缺口，再决定是否采用。',
    '请核对范围并完成确认。',
    '如需继续，请确认恢复任务。',
    '请补充任务继续所需的信息。',
]);

function isGenericNextAction(text: any): boolean {
    const clean: string = String(text || '').trim();
    if (!clean)
        return true;
    return GENERIC_NEXT_ACTIONS.has(clean);
}

const GENERIC_IMPACTS = new Set([
    '任务不会被视为已经完成。',
    '当前结果尚未通过完整验证，不能视为已经完成。',
    '本轮任务没有完成；已有产物和审计记录仍会保留。',
    '补充继续所需的信息前，任务不会继续执行。',
    '确认完成前，任务不会继续执行受控步骤。',
    '确认继续前，任务不会开始新的处理步骤。',
    '目前还没有生成素材或拆解报告；继续处理也不会自动发布。',
]);

function usefulAttentionImpact(attention: any): boolean {
    const impact: string = String(attention?.impact || '').trim();
    if (!impact || impact === attention.headline || impact === attention.cause)
        return false;
    return !GENERIC_IMPACTS.has(impact);
}

function usefulAttentionEvidence(evidence: any, cause: any): string {
    const text: string = String(evidence || '').trim();
    if (!text)
        return '';
    const cleanCause: string = String(cause || '').trim();
    if (text === cleanCause)
        return '';
    return text;
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

export function renderDetailTabNav(activeTab: string = 'overview', counts: { deliverablesCount: number; isWorkflow: boolean } = { deliverablesCount: 0, isWorkflow: false }): string {
    const tabs = [
        { key: 'overview', label: '概览与交付产物', icon: 'spark', badge: counts.deliverablesCount > 0 ? String(counts.deliverablesCount) : '' },
        { key: 'collaboration', label: counts.isWorkflow ? '协作与过程 (多Agent)' : '实施过程与审计', icon: 'connections', badge: '' },
    ];

    const currentActiveTab = activeTab === 'deliverables' ? 'overview' : activeTab;

    const buttons = tabs.map((tab) => {
        const active = currentActiveTab === tab.key;
        return html`
            <button type="button" class="detail-tab-btn ${active ? 'is-active' : ''}" data-detail-tab="${tab.key}" aria-selected="${active ? 'true' : 'false'}" role="tab">
                <svg width="14" height="14" aria-hidden="true"><use href="#icon-${tab.icon}"></use></svg>
                <span>${tab.label}</span>
                ${raw(tab.badge ? html`<span class="detail-tab-badge">${tab.badge}</span>` : '')}
            </button>
        `;
    }).join('');

    return html`<nav class="detail-tab-nav" role="tablist" aria-label="任务详情分类">${raw(buttons)}</nav>`;
}

export { renderCostSection, renderDeliverySink, renderOriginCard } from './task-record-origin-view.js';
export { renderTaskLineageCard, renderSubtaskDrawer } from './task-record-subtask-drawer.js';
