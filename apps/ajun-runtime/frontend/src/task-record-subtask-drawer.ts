import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { displaySubtaskTitle } from './task-record-presentation.js';
import { cleanAttentionText } from './task-record-detail-view.js';
import { formatStructuredReportText } from './task-record-report-formatter.js';

export function renderTaskLineageCard(task: any = {}, parsedTitle: any = null, artifactsHtml: string = ''): string {
    const rawTitle = String(task?.input?.title || task?.title || '').trim();
    const isRework = parsedTitle?.badges?.some((b: any) => b.tone === 'rework') || /定向返工/i.test(rawTitle);
    const isQuality = parsedTitle?.badges?.some((b: any) => b.tone === 'quality') || /质量(?:复核|审查)/i.test(rawTitle);
    const isFault = parsedTitle?.badges?.some((b: any) => b.tone === 'fault') || /故障(?:恢复|处理)/i.test(rawTitle);

    if (!isRework && !isQuality && !isFault && !task?.parentTaskId) {
        return '';
    }

    const reworkBadge = parsedTitle?.badges?.find((b: any) => b.tone === 'rework');
    const roundLabel = reworkBadge ? reworkBadge.label : (isRework ? '定向返工' : isQuality ? '质量复核' : '衍生任务');
    const mainGoal = parsedTitle?.cleanTitle || task?.input?.title || '原始任务诉求';
    const reasonText = task?.input?.description || task?.pendingApproval?.reason || task?.error?.message 
        || (isRework ? '上一轮成果经质检或验收发现存在缺口，AI 员工正在针对性补充完善，以达成高质量最终交付。' : '本任务为主任务衍生出的专项协同环节。');

    return html`
        <section class="record-lineage-card" aria-label="任务衍生与返工脉络">
            <div class="lineage-card-badge-row">
                <span class="lineage-badge is-rework">
                    <svg width="12" height="12" aria-hidden="true"><use href="#icon-spark"></use></svg>
                    ${roundLabel}
                </span>
                <span class="lineage-goal-tag">主诉求目标：<strong>${mainGoal}</strong></span>
            </div>
            <div class="lineage-card-body">
                <div class="lineage-reason-item">
                    <span class="lineage-label">返工/衍生动因：</span>
                    <p class="lineage-text">${cleanAttentionText(reasonText, 300)}</p>
                </div>
            </div>
            ${raw(artifactsHtml ? html`
                <div class="lineage-artifacts-box">
                    <div class="lineage-artifacts-head">
                        <svg width="13" height="13" aria-hidden="true"><use href="#icon-records"></use></svg>
                        <span>本轮返工交付的修正产物</span>
                    </div>
                    <ul class="record-artifact-list">
                        ${raw(artifactsHtml)}
                    </ul>
                </div>
            ` : '')}
        </section>
    `;
}

export function renderSubtaskDrawer(subtask: any, options: { agentName?: (id: string) => string; parentAgent?: string } = {}): string {
    if (!subtask) return '';
    const agentNameFn = options.agentName || ((id: string) => id || '未指派员工');
    const rawAgent = subtask.assigneeAgentId ? agentNameFn(subtask.assigneeAgentId) : '';
    const isUnassigned = !rawAgent || rawAgent === '等待分配' || rawAgent === '未指派员工' || rawAgent === '未知员工';
    const agent = !isUnassigned
        ? rawAgent
        : (options.parentAgent && !['等待分配', '未指派员工', '未知员工'].includes(options.parentAgent)
            ? options.parentAgent
            : (['running', 'succeeded'].includes(subtask.status) ? '自动质检流水线' : '待指派员工'));
    const created = formatFullDateTime(subtask.createdAt);
    const duration = subtask.createdAt ? formatDuration(subtask.createdAt, subtask.completedAt || subtask.updatedAt) : '';
    const rawArtifacts = Array.isArray(subtask.artifactRefs) ? subtask.artifactRefs : [];
    const artifacts = rawArtifacts.filter((a: any) => {
        const type = String(a?.type || '');
        const title = String(a?.title || a?.name || '');
        return !/employee_(?:execution_|role_)?report|agent_audit|role_draft/i.test(type)
            && !/员工岗位回报|执行审计|岗位草案/i.test(title);
    });
    const taskRef = String(subtask.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    const rawInputDesc = String(subtask.input?.description || subtask.input?.focus || subtask.input?.title || '').trim();
    const humanFocus = humanizeFocusText(rawInputDesc);
    const statusLabel = subtask.presentation?.statusLabel || statusToChinese(subtask.status);

    const artifactItemsHtml = artifacts.map((a: any) => {
        const artTitle = cleanAttentionText(a.title || a.name || a.type || '交付成果', 50);
        const url = String(a.url || a.downloadUrl || a.location || a.path || a.detailUrl || '').trim();
        const isHttp = /^https?:\/\//i.test(url);
        const isRuntimeVirtual = url.startsWith('runtime://');
        const isRealFilePath = /^(?:\/|[a-zA-Z]:[/\\]|file:\/\/)/.test(url) && !isRuntimeVirtual;
        const rawSummary = a.summary || a.description || a.data?.summary || a.data?.conclusion || (typeof a.data?.text === 'string' ? a.data.text : '');
        const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 300).trim() : '';
        const formattedFullReport = formatStructuredReportText(a.data || a, a.type);
        const rawInline = formattedFullReport || a.data?.markdown || a.data?.text || a.data?.content || a.content || '';
        const inlineContent = typeof rawInline === 'string' ? rawInline.trim() : '';
        const hasReadableContent = inlineContent.length > 20 && !inlineContent.startsWith('{') && inlineContent !== summary;
        
        const taskTitle = String(a.title || a.name || '').trim();
        const isSummaryTrivial = !summary || (taskTitle && (
            summary === taskTitle ||
            summary.startsWith(taskTitle) ||
            taskTitle.startsWith(summary) ||
            summary.length < 15
        ));
        const copyContent = hasReadableContent ? inlineContent : (isSummaryTrivial ? '' : summary);

        return html`
            <li class="subtask-artifact-item">
                <div class="artifact-item-main">
                    <div class="artifact-item-header">
                        <svg width="14" height="14" aria-hidden="true"><use href="#icon-records"></use></svg>
                        <strong>${artTitle}</strong>
                        <span class="artifact-type-tag">交付产物</span>
                    </div>
                    ${raw(summary ? html`<p class="subtask-artifact-summary">${summary}</p>` : '')}
                    ${raw(hasReadableContent ? html`
                        <details class="artifact-inline-preview">
                            <summary><span>查看报告正文</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>
                            <div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(inlineContent)}</pre></div>
                        </details>
                    ` : '')}
                    ${raw(isRealFilePath ? html`<div class="subtask-artifact-path"><span class="path-label">路径：</span><code>${url}</code></div>` : '')}
                </div>
                <div class="subtask-artifact-actions">
                    ${raw(isHttp ? html`<a href="${url}" target="_blank" rel="noopener noreferrer" class="artifact-action-btn primary">打开查看 ↗</a>` : '')}
                    ${raw(isRealFilePath ? html`<button type="button" class="artifact-action-btn secondary" data-copy-path="${url}">复制路径</button>` : '')}
                    ${raw(copyContent ? html`<button type="button" class="artifact-action-btn secondary" data-copy-text="${escapeHtml(copyContent)}">复制内容</button>` : '')}
                    ${raw(!isRealFilePath && !copyContent ? html`<button type="button" class="artifact-action-btn secondary" data-copy-text="${escapeHtml(artTitle)}">复制名称</button>` : '')}
                </div>
            </li>
        `;
    }).join('');

    const isWaitingApproval = ['waiting_approval', 'pending_approval'].includes(subtask.status);
    const pendingApprovalId = Array.isArray(subtask.approvalRefs) && subtask.approvalRefs.length ? subtask.approvalRefs[0] : '';
    const approvalBannerHtml = isWaitingApproval ? html`
        <div class="subtask-approval-banner" style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
                <div>
                    <strong style="color: #b45309; display: flex; align-items: center; gap: 6px; font-size: 14px;">
                        <svg width="16" height="16" aria-hidden="true"><use href="#icon-shield"></use></svg>
                        等待人工确认执行
                    </strong>
                    <p style="margin: 4px 0 0; font-size: 13px; color: var(--text-secondary, #666);">该协作环节因涉及素材读取或内容处理已触发安全待办。确认后将立即指派员工开始执行。</p>
                </div>
                <div style="display: flex; gap: 8px; flex-shrink: 0;">
                    <button type="button" class="focus-primary-action" data-subtask-approve="${subtask.taskId}" data-subtask-approval-id="${pendingApprovalId}" style="padding: 6px 14px; font-size: 13px; border-radius: 6px; cursor: pointer;">
                        ✓ 确认执行
                    </button>
                    <button type="button" class="artifact-action-btn secondary" data-subtask-reject="${subtask.taskId}" data-subtask-approval-id="${pendingApprovalId}" style="padding: 6px 12px; font-size: 13px; color: #dc2626; border-color: rgba(220, 38, 38, 0.3); border-radius: 6px; cursor: pointer;">
                        ✕ 拒绝
                    </button>
                </div>
            </div>
        </div>
    ` : '';

    return html`
        <div class="subtask-drawer-overlay" data-subtask-drawer-overlay>
            <aside class="subtask-drawer" role="dialog" aria-label="协作任务预览">
                <div class="subtask-drawer-header">
                    <div>
                        <span class="subtask-drawer-ref">协作环节 #${taskRef}</span>
                        <h3 class="subtask-drawer-title">${raw(displaySubtaskTitle(subtask))}</h3>
                    </div>
                    <button type="button" class="subtask-drawer-close" data-subtask-drawer-close aria-label="关闭预览">✕</button>
                </div>
                <div class="subtask-drawer-body">
                    ${raw(approvalBannerHtml)}
                    <div class="subtask-meta-grid">
                        <div class="subtask-meta-item">
                            <span class="meta-label">负责员工</span>
                            <strong>${agent}</strong>
                        </div>
                        <div class="subtask-meta-item">
                            <span class="meta-label">当前状态</span>
                            <span class="record-row-status ${subtask.status || 'active'}">${statusLabel}</span>
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

                    ${raw(humanFocus ? html`
                        <div class="subtask-section">
                            <span class="subtask-section-title">环节重点</span>
                            <p class="subtask-section-text">${humanFocus}</p>
                        </div>
                    ` : '')}

                    <div class="subtask-section subtask-artifacts-container">
                        <div class="subtask-artifacts-head">
                            <svg width="14" height="14" aria-hidden="true"><use href="#icon-records"></use></svg>
                            <span class="subtask-section-title">本环节生成的交付产物 (${artifacts.length})</span>
                        </div>
                        ${raw(artifacts.length > 0 ? html`
                            <ul class="subtask-artifacts-list">
                                ${raw(artifactItemsHtml)}
                            </ul>
                        ` : '<p class="subtask-empty-text">该环节暂未生成独立交付物（数据流已并入主报告）</p>')}
                    </div>
                </div>
                <div class="subtask-drawer-footer">
                    ${raw(isWaitingApproval ? html`
                        <button type="button" class="focus-primary-action" data-subtask-approve="${subtask.taskId}" data-subtask-approval-id="${pendingApprovalId}" style="margin-right: 8px;">
                            ✓ 确认并开始执行
                        </button>
                    ` : '')}
                    <button type="button" class="focus-primary-action subtask-drawer-done-btn" data-subtask-drawer-close>
                        ✓ 完成查看，返回主任务
                    </button>
                </div>
            </aside>
        </div>
    `;
}

function humanizeFocusText(text: string): string {
    if (!text || typeof text !== 'string') return '';
    const raw = text.trim();
    if (raw.includes('{') || raw.includes('__schema') || raw.includes('taskType:')) return '';
    if (raw.includes('question_answered') || raw.includes('goal_coverage') || raw.includes('claims_evidence_bound') || raw.includes('counter_evidence_checked')) {
        return '根据上一轮质量门禁复核发现的缺口，对核心结论与支撑证据进行定向补充完善。';
    }
    if (raw.length < 4) return '';
    return cleanAttentionText(raw, 240);
}

function statusToChinese(status: string): string {
    const map: Record<string, string> = {
        running: '处理中',
        succeeded: '已完成',
        failed: '未完成',
        queued: '排队中',
        waiting_approval: '等待确认',
        pending_approval: '等待确认',
        waiting_test: '待验证',
        needs_input: '等待补充',
        paused: '已暂停',
        cancelled: '已关闭',
    };
    return map[status] || status || '处理中';
}
