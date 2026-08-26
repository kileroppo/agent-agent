import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';

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
        ? '已确认有用'
        : decision === 'revision_required'
            ? '已标记需改进'
            : '这次结果需要你验收';
    const feedback: any = submission?.message
        ? html`<p class="record-acceptance-message ${submission.status === 'failed' ? 'is-failed' : ''}" role="status">${submission.message}</p>`
        : '';
    const controls: any = target.actionable && !closed
        ? html`<label class="record-acceptance-note">说明（可选）<textarea rows="2" maxlength="1000" data-acceptance-note placeholder="哪里有用，或下次改什么"${raw(submitting ? ' disabled' : '')}>${submission?.note || ''}</textarea></label>
        <div class="record-acceptance-actions">
          <button type="button" data-acceptance-decision="accepted"${raw(submitting ? ' disabled' : '')}>${submitting && submission?.decision === 'accepted' ? '保存中…' : '有用'}</button>
          <button type="button" class="secondary-action" data-acceptance-decision="revision_required"${raw(submitting ? ' disabled' : '')}>${submitting && submission?.decision === 'revision_required' ? '保存中…' : '需改进'}</button>
        </div>`
        : '';
    return html`<section class="record-acceptance${raw(closed ? ' is-closed' : '')}" aria-label="业务结果验收">
      <h3>${headline}</h3>
      <p><strong>${target.title}</strong></p>
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
        ? html`<div class="record-attention-confirmation" role="alert"><p>${confirmation}</p><div class="record-attention-actions"><button type="button" class="record-attention-primary" data-attention-confirm="${confirmingAction.actionKey}">确认${confirmingAction.label}</button><button type="button" class="secondary-action" data-attention-cancel>取消</button></div></div>`
        : hasActions
            ? html`<div class="record-attention-actions">${raw(actions)}${raw(paperclipLink)}</div>`
            : fallbackNext;
    const cause: any = usefulAttentionCause(attention);
    const evidence: string = usefulAttentionEvidence(attention.evidence, cause);
    const extras: any = [
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

export function renderCostSection(detail: any): any {
    const cost: any = detail?.costAttribution;
    if (!cost)
        return '';
    const executor: any = cost.executor || '未知执行者';
    const duration: any = typeof cost.durationMs === 'number'
        ? cost.durationMs >= 60000
            ? `${(cost.durationMs / 60000).toFixed(1)} 分钟`
            : `${(cost.durationMs / 1000).toFixed(1)} 秒`
        : null;
    const tokens: any = (cost.inputTokens || cost.outputTokens)
        ? `输入 ${cost.inputTokens} / 输出 ${cost.outputTokens}`
        : null;
    const totalCost: any = cost.totalCost || null;
    return html`<section class="record-cost" aria-label="任务开销">
    <span>这次花了多少</span>
    <dl>
      <dt>执行者</dt><dd>${executor}</dd>
      ${raw(duration ? html`<dt>耗时</dt><dd>${duration}</dd>` : '')}
      ${raw(tokens ? html`<dt>Token</dt><dd>${tokens}</dd>` : '')}
      ${raw(totalCost ? html`<dt>费用</dt><dd>${totalCost} ${cost.currency || 'USD'}</dd>` : '')}
    </dl>
  </section>`;
}

export function renderWorkflowBreadcrumb(detail: any): any {
    const breadcrumb: any = detail?.workflowBreadcrumb;
    if (!breadcrumb)
        return '';
    const workflowLabel: any = breadcrumb.workflowId.slice(0, 8).toUpperCase();
    const stepLabel: any = breadcrumb.currentStepId || '';
    const parentLabel: any = breadcrumb.parentWorkflowId
        ? breadcrumb.parentWorkflowId.slice(0, 8).toUpperCase()
        : '';
    const siblings: any = Array.isArray(breadcrumb.siblings) ? breadcrumb.siblings.slice(0, 10) : [];
    const siblingItems: any = siblings.map((sibling: any): any => {
        const ref: any = String(sibling.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
        return html`<li><span class="breadcrumb-ref">#${ref}</span> ${sibling.title || '未命名'} <small>${sibling.status || ''}</small></li>`;
    }).join('');
    return html`<nav class="record-workflow-breadcrumb" aria-label="工作流上下文">
    ${raw(parentLabel ? html`<span class="breadcrumb-parent">#${parentLabel}</span> → ` : '')}
    <strong class="breadcrumb-current">#${workflowLabel}${raw(stepLabel ? html` / ${stepLabel}` : '')}</strong>
    ${raw(siblingItems ? html`<ul class="breadcrumb-siblings">${raw(siblingItems)}</ul>` : '')}
  </nav>`;
}

export function renderDetailTabNav(activeTab: string = 'overview', counts: { deliverablesCount: number; isWorkflow: boolean } = { deliverablesCount: 0, isWorkflow: false }): string {
    const tabs = [
        { key: 'overview', label: '概览与结果', icon: 'spark', badge: '' },
        { key: 'deliverables', label: '交付产物库', icon: 'records', badge: counts.deliverablesCount > 0 ? String(counts.deliverablesCount) : '' },
        { key: 'collaboration', label: counts.isWorkflow ? '协作与过程 (多Agent)' : '实施过程与审计', icon: 'connections', badge: '' },
    ];

    const buttons = tabs.map((tab) => {
        const active = activeTab === tab.key;
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

export function renderOriginCard(task: any = {}): string {
    const input = task?.input || {};
    const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
    const channel = task?.paperclipIssue ? 'Paperclip 治理工单' : (input.channel || (sourceUrl ? '外部内容链接' : '飞书交互'));
    const createdAt = formatFullDateTime(task?.createdAt);
    const desc = cleanAttentionText(input.description || input.focus, 400);

    return html`
        <section class="record-origin-card" aria-label="源头诉求与输入">
            <div class="origin-card-head">
                <div class="origin-badge-row">
                    <span class="origin-channel-badge"><svg class="origin-icon" aria-hidden="true"><use href="#icon-${task?.paperclipIssue ? 'shield' : 'message'}"></use></svg> ${channel}</span>
                    <span class="origin-time-tag">登记于 ${createdAt}</span>
                </div>
            </div>
            ${raw(sourceUrl ? html`
                <div class="origin-source-link">
                    <span class="origin-label">原始目标：</span>
                    <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" class="origin-link-text">${sourceUrl}</a>
                </div>
            ` : '')}
            ${raw(desc ? html`
                <div class="origin-desc">
                    <span class="origin-label">核心诉求：</span>
                    <p>${desc}</p>
                </div>
            ` : '')}
        </section>
    `;
}

export function renderDeliverySink(task: any = {}): string {
    const paperclipIssue = task?.paperclipIssue;
    const isCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(task?.status);
    if (!isCompleted) return '';

    const sinks = [];
    if (paperclipIssue?.identifier || paperclipIssue?.detailUrl) {
        sinks.push(html`<span class="delivery-sink-item">✓ 已回写 Paperclip 工单 <strong>#${paperclipIssue.identifier || 'ISSUE'}</strong></span>`);
    }
    sinks.push(html`<span class="delivery-sink-item">✓ 已同步并可供飞书原会话回读</span>`);
    return html`<div class="record-delivery-sink"><div class="delivery-sink-title"><svg aria-hidden="true"><use href="#icon-share"></use></svg> 交付去向与下游</div><div class="delivery-sink-list">${raw(sinks.join(''))}</div></div>`;
}

export function renderSubtaskDrawer(subtask: any, options: { agentName?: (id: string) => string } = {}): string {
    if (!subtask) return '';
    const agentNameFn = options.agentName || ((id: string) => id || '未知员工');
    const agent = agentNameFn(subtask.assigneeAgentId);
    const created = formatFullDateTime(subtask.createdAt);
    const duration = subtask.createdAt ? formatDuration(subtask.createdAt, subtask.completedAt || subtask.updatedAt) : '';
    const artifacts = Array.isArray(subtask.artifactRefs) ? subtask.artifactRefs : [];
    const taskRef = String(subtask.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    const inputDesc = cleanAttentionText(subtask.input?.description || subtask.input?.focus || subtask.input?.title, 200);

    return html`
        <div class="subtask-drawer-overlay" data-subtask-drawer-overlay>
            <aside class="subtask-drawer" role="dialog" aria-label="协作任务预览">
                <div class="subtask-drawer-header">
                    <div>
                        <span class="subtask-drawer-ref">协作环节 #${taskRef}</span>
                        <h3 class="subtask-drawer-title">${cleanAttentionText(subtask.input?.title || subtask.title || '协作子任务', 80)}</h3>
                    </div>
                    <button type="button" class="subtask-drawer-close" data-subtask-drawer-close aria-label="关闭预览">✕</button>
                </div>
                <div class="subtask-drawer-body">
                    <div class="subtask-meta-grid">
                        <div class="subtask-meta-item">
                            <span class="meta-label">负责员工</span>
                            <strong>${agent}</strong>
                        </div>
                        <div class="subtask-meta-item">
                            <span class="meta-label">当前状态</span>
                            <span class="record-row-status ${subtask.status || 'active'}">${subtask.status || '执行中'}</span>
                        </div>
                        <div class="subtask-meta-item">
                            <span class="meta-label">创建时间</span>
                            <span>${created || '未记录'}</span>
                        </div>
                        <div class="subtask-meta-item">
                            <span class="meta-label">执行耗时</span>
                            <span>${duration || '计算中'}</span>
                        </div>
                    </div>

                    ${raw(inputDesc ? html`
                        <div class="subtask-section">
                            <span class="subtask-section-title">环节诉求</span>
                            <p class="subtask-section-text">${inputDesc}</p>
                        </div>
                    ` : '')}

                    <div class="subtask-section">
                        <span class="subtask-section-title">产生产物 (${artifacts.length})</span>
                        ${raw(artifacts.length > 0 ? html`
                            <ul class="subtask-artifacts-list">
                                ${artifacts.map((a: any) => {
                                    const artTitle = cleanAttentionText(a.title || a.name || a.type || '交付产物', 50);
                                    const url = a.url || a.downloadUrl || a.location || a.path || '';
                                    return html`
                                        <li class="subtask-artifact-item">
                                            <div class="artifact-item-main">
                                                <svg width="14" height="14" aria-hidden="true"><use href="#icon-records"></use></svg>
                                                <span>${artTitle}</span>
                                            </div>
                                            ${raw(url ? html`<button type="button" class="text-action" data-copy-path="${url}">复制路径</button>` : '')}
                                        </li>
                                    `;
                                }).join('')}
                            </ul>
                        ` : '<p class="subtask-empty-text">该环节暂未生成产物文件</p>')}
                    </div>
                </div>
                <div class="subtask-drawer-footer">
                    <button type="button" class="secondary-action" data-subtask-drawer-close>返回当前任务</button>
                    <button type="button" class="focus-primary-action tree-switch-btn" data-record-task-id="${subtask.taskId}">设为主视角打开 ↗</button>
                </div>
            </aside>
        </div>
    `;
}

