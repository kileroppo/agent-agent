import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { displaySubtaskTitle } from './task-record-presentation.js';
import { cleanAttentionText } from './task-record-detail-view.js';
export function renderTaskLineageCard(task = {}, parsedTitle = null, artifactsHtml = '') {
    const rawTitle = String(task?.input?.title || task?.title || '').trim();
    const isRework = parsedTitle?.badges?.some((b) => b.tone === 'rework') || /定向返工/i.test(rawTitle);
    const isQuality = parsedTitle?.badges?.some((b) => b.tone === 'quality') || /质量(?:复核|审查)/i.test(rawTitle);
    const isFault = parsedTitle?.badges?.some((b) => b.tone === 'fault') || /故障(?:恢复|处理)/i.test(rawTitle);
    if (!isRework && !isQuality && !isFault && !task?.parentTaskId) {
        return '';
    }
    const reworkBadge = parsedTitle?.badges?.find((b) => b.tone === 'rework');
    const roundLabel = reworkBadge ? reworkBadge.label : (isRework ? '定向返工' : isQuality ? '质量复核' : '衍生任务');
    const mainGoal = parsedTitle?.cleanTitle || task?.input?.title || '原始任务诉求';
    const reasonText = task?.input?.description || task?.pendingApproval?.reason || task?.error?.message
        || (isRework ? '上一轮成果经质检或验收发现存在缺口，AI 员工正在针对性补充完善，以达成高质量最终交付。' : '本任务为主任务衍生出的专项协同环节。');
    return html `
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
            ${raw(artifactsHtml ? html `
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
export function renderSubtaskDrawer(subtask, options = {}) {
    if (!subtask)
        return '';
    const agentNameFn = options.agentName || ((id) => id || '未指派员工');
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
    const artifacts = rawArtifacts.filter((a) => {
        const type = String(a?.type || '');
        const title = String(a?.title || a?.name || '');
        return !/employee_(?:execution_|role_)?report|agent_audit|role_draft/i.test(type)
            && !/员工岗位回报|执行审计|岗位草案/i.test(title);
    });
    const taskRef = String(subtask.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    const rawInputDesc = String(subtask.input?.description || subtask.input?.focus || subtask.input?.title || '').trim();
    const humanFocus = humanizeFocusText(rawInputDesc);
    const statusLabel = subtask.presentation?.statusLabel || statusToChinese(subtask.status);
    const artifactItemsHtml = artifacts.map((a) => {
        const artTitle = cleanAttentionText(a.title || a.name || a.type || '交付成果', 50);
        const url = String(a.url || a.downloadUrl || a.location || a.path || a.detailUrl || '').trim();
        const isHttp = /^https?:\/\//i.test(url);
        const isRuntimeVirtual = url.startsWith('runtime://');
        const isRealFilePath = /^(?:\/|[a-zA-Z]:[/\\]|file:\/\/)/.test(url) && !isRuntimeVirtual;
        const rawSummary = a.summary || a.description || a.data?.summary || a.data?.conclusion || (typeof a.data?.text === 'string' ? a.data.text : '');
        const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 300).trim() : '';
        const rawInline = a.data?.markdown || a.data?.text || a.data?.content || a.content || '';
        const inlineContent = typeof rawInline === 'string' ? rawInline.trim() : '';
        const hasReadableContent = inlineContent.length > 20 && !inlineContent.startsWith('{') && inlineContent !== summary;
        const copyContent = hasReadableContent ? inlineContent : summary;
        return html `
            <li class="subtask-artifact-item">
                <div class="artifact-item-main">
                    <div class="artifact-item-header">
                        <svg width="14" height="14" aria-hidden="true"><use href="#icon-records"></use></svg>
                        <strong>${artTitle}</strong>
                        <span class="artifact-type-tag">交付产物</span>
                    </div>
                    ${raw(summary ? html `<p class="subtask-artifact-summary">${summary}</p>` : '')}
                    ${raw(hasReadableContent ? html `
                        <details class="artifact-inline-preview">
                            <summary><span>查看报告正文</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>
                            <div class="artifact-preview-body"><pre class="artifact-preview-text">${escapeHtml(inlineContent)}</pre></div>
                        </details>
                    ` : '')}
                    ${raw(isRealFilePath ? html `<div class="subtask-artifact-path"><span class="path-label">路径：</span><code>${url}</code></div>` : '')}
                </div>
                <div class="subtask-artifact-actions">
                    ${raw(isHttp ? html `<a href="${url}" target="_blank" rel="noopener noreferrer" class="artifact-action-btn primary">打开查看 ↗</a>` : '')}
                    ${raw(isRealFilePath ? html `<button type="button" class="artifact-action-btn secondary" data-copy-path="${url}">复制路径</button>` : '')}
                    ${raw(copyContent ? html `<button type="button" class="artifact-action-btn secondary" data-copy-text="${escapeHtml(copyContent)}">复制内容</button>` : '')}
                    ${raw(!isRealFilePath && !copyContent ? html `<button type="button" class="artifact-action-btn secondary" data-copy-text="${escapeHtml(artTitle)}">复制名称</button>` : '')}
                </div>
            </li>
        `;
    }).join('');
    return html `
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

                    ${raw(humanFocus ? html `
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
                        ${raw(artifacts.length > 0 ? html `
                            <ul class="subtask-artifacts-list">
                                ${raw(artifactItemsHtml)}
                            </ul>
                        ` : '<p class="subtask-empty-text">该环节暂未生成独立交付物（数据流已并入主报告）</p>')}
                    </div>
                </div>
                <div class="subtask-drawer-footer">
                    <button type="button" class="focus-primary-action subtask-drawer-done-btn" data-subtask-drawer-close>
                        ✓ 完成查看，返回主任务
                    </button>
                </div>
            </aside>
        </div>
    `;
}
function humanizeFocusText(text) {
    if (!text || typeof text !== 'string')
        return '';
    const raw = text.trim();
    if (raw.includes('{') || raw.includes('__schema') || raw.includes('taskType:'))
        return '';
    if (raw.includes('question_answered') || raw.includes('goal_coverage') || raw.includes('claims_evidence_bound') || raw.includes('counter_evidence_checked')) {
        return '根据上一轮质量门禁复核发现的缺口，对核心结论与支撑证据进行定向补充完善。';
    }
    if (raw.length < 4)
        return '';
    return cleanAttentionText(raw, 240);
}
function statusToChinese(status) {
    const map = {
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
