import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { cleanAttentionText } from './task-record-detail-view.js';
export function parseTaskTitle(rawTitle) {
    let text = String(rawTitle || '未命名任务').trim();
    const badges = [];
    let matched = true;
    while (matched) {
        matched = false;
        // 1. 定向返工 (第 N 轮定向返工：xxx 或 定向返工：xxx)
        const reworkMatch = text.match(/^(?:第\s*(\d+)\s*轮)?定向返工[：:]\s*(.+)$/i);
        if (reworkMatch) {
            const roundNum = reworkMatch[1] ? `#${reworkMatch[1]}` : '';
            const roundTooltip = reworkMatch[1] ? `第 ${reworkMatch[1]} 轮质量改进迭代` : '定向返工迭代';
            badges.push({
                label: `🔁 ${roundNum}`.trim(),
                tone: 'rework',
                tooltip: roundTooltip,
                icon: 'spark'
            });
            text = reworkMatch[2].trim();
            matched = true;
            continue;
        }
        // 2. 交付质量复核 / 质量审查
        const qualityMatch = text.match(/^(?:交付)?质量(?:复核|审查|检查)[：:]\s*(.+)$/i);
        if (qualityMatch) {
            badges.push({
                label: '🛡️ 质检',
                tone: 'quality',
                tooltip: '交付质量复核',
                icon: 'check'
            });
            text = qualityMatch[1].trim();
            matched = true;
            continue;
        }
        // 3. 诊断任务故障 / 处理任务故障 / 故障恢复
        const faultMatch = text.match(/^(?:诊断|处理)?(?:任务)?故障(?:恢复)?[：:]\s*(.+)$/i);
        if (faultMatch) {
            badges.push({
                label: '⚡ 恢复',
                tone: 'fault',
                tooltip: '任务故障自动恢复',
                icon: 'alert'
            });
            text = faultMatch[1].trim();
            matched = true;
            continue;
        }
        // 4. Paperclip 产能复盘
        const productivity = text.match(/^Review productivity for (AGE-\d+)$/i);
        if (productivity) {
            badges.push({
                label: productivity[1].toUpperCase(),
                tone: 'paperclip',
                tooltip: `Paperclip 产能复盘 · ${productivity[1].toUpperCase()}`
            });
            text = '产能复盘';
            matched = true;
            continue;
        }
    }
    return { cleanTitle: text || '未命名任务', badges };
}
export function displayTaskTitle(task) {
    const rawTitle = String(task?.input?.title || task?.title || '未命名任务').trim();
    const parsed = parseTaskTitle(rawTitle);
    if (!parsed.badges.length)
        return parsed.cleanTitle;
    const badgeSpans = parsed.badges.map((b) => `<span class="task-badge-pill badge-${b.tone}" title="${escapeHtml(b.tooltip)}">${b.label}</span>`).join(' ');
    return `<span class="task-title-wrapper">${badgeSpans} <span class="task-title-text">${escapeHtml(parsed.cleanTitle)}</span></span>`;
}
export function displaySubtaskTitle(childTask, _parentTask = null) {
    const rawTitle = String(childTask?.input?.title || childTask?.title || '子任务').trim();
    const parsed = parseTaskTitle(rawTitle);
    const reworkBadge = parsed.badges.find((b) => b.tone === 'rework');
    const qualityBadge = parsed.badges.find((b) => b.tone === 'quality');
    const faultBadge = parsed.badges.find((b) => b.tone === 'fault');
    // 只保留紧凑图标徽章，不加冗余汉字
    if (reworkBadge) {
        return `<span class="task-badge-pill badge-rework" title="${escapeHtml(reworkBadge.tooltip)}">${reworkBadge.label}</span>`;
    }
    if (qualityBadge) {
        return `<span class="task-badge-pill badge-quality" title="${escapeHtml(qualityBadge.tooltip)}">${qualityBadge.label}</span>`;
    }
    if (faultBadge) {
        return `<span class="task-badge-pill badge-fault" title="${escapeHtml(faultBadge.tooltip)}">${faultBadge.label}</span>`;
    }
    if (!childTask?.parentTaskId) {
        return `<span class="task-badge-pill badge-quality">🌱 初稿</span>`;
    }
    return `<span class="task-badge-pill badge-paperclip">🌱 协同</span>`;
}
export function relativeTime(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '时间未记录';
    const delta = timestamp - Date.now();
    const absolute = Math.abs(delta);
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (absolute < 60000)
        return '刚刚';
    if (absolute < 3600000)
        return formatter.format(Math.round(delta / 60000), 'minute');
    if (absolute < 86400000)
        return formatter.format(Math.round(delta / 3600000), 'hour');
    if (absolute < 7 * 86400000)
        return formatter.format(Math.round(delta / 86400000), 'day');
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
export function resultSummary(task) {
    const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const report = artifacts.find((item) => item?.type === 'health_report')?.data;
    if (report)
        return { label: '检查结果', text: `${report.overall === 'healthy' ? '运行正常' : '发现需要关注的项目'}${Array.isArray(report.components) ? `：${report.components.map((item) => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、')}` : ''}` };
    const intake = artifacts.find((item) => item?.type === 'task_intake_record')?.data;
    if (intake?.nextAction)
        return { label: '判断结果', text: intake.nextAction };
    const review = artifacts.find((item) => item?.type === 'review_report')?.data;
    if (review?.nextAction)
        return { label: '审核结论', text: review.nextAction };
    const publicReport = artifacts.find((item) => item?.type === 'public_web_report')?.data;
    if (publicReport?.summary)
        return { label: '结果摘要', text: publicReport.summary };
    if (task.status === 'succeeded')
        return { label: '完成情况', text: `任务已完成${artifacts.length ? `，留下 ${artifacts.length} 项交付或证据` : ''}。` };
    return null;
}
const INTERNAL_MACHINE_TYPES = new Set([
    'employee_execution_report',
    'employee_role_report',
    'employee_report',
    'role_draft',
    'role_definition',
    'agent_audit',
    'internal_review',
]);
export function artifactItems(artifacts, { hideEmployeeReport = true } = {}) {
    return (Array.isArray(artifacts) ? artifacts : [])
        .filter((item) => item && typeof item === 'object')
        .filter((item) => {
        if (!hideEmployeeReport)
            return true;
        const type = String(item.type || '').trim();
        const title = String(item.title || item.name || '').trim();
        if (INTERNAL_MACHINE_TYPES.has(type))
            return false;
        if (/员工岗位回报|执行审计|岗位草案/i.test(title))
            return false;
        return true;
    });
}
import { ARTIFACT_TYPE_LABELS, formatArtifactLabel, getArtifactPreviewTitle, formatStructuredReportText, agentNameZh, } from './task-record-report-formatter.js';
export { ARTIFACT_TYPE_LABELS, formatArtifactLabel, getArtifactPreviewTitle, formatStructuredReportText, agentNameZh, };
export function renderArtifact(artifact, options = {}) {
    if (!artifact || typeof artifact !== 'object')
        return '';
    const isAccepted = Boolean(options.isAccepted);
    const label = formatArtifactLabel(artifact);
    const typeLabel = (artifact.type && ARTIFACT_TYPE_LABELS[artifact.type]) || (artifact.type ? String(artifact.type).replace(/[_-]/g, ' ') : '交付物');
    const url = String(artifact.url || artifact.location || artifact.detailUrl || artifact.downloadUrl || artifact.path || '').trim();
    const isHttp = /^https?:\/\//i.test(url);
    const isRuntimeVirtual = url.startsWith('runtime://');
    const isRealFilePath = /^(?:\/|[a-zA-Z]:[/\\]|file:\/\/)/.test(url) && !isRuntimeVirtual;
    // Smart summary generation for specialized artifacts to avoid simply repeating parent task title
    let summary = '';
    if (artifact.type === 'cross_agent_mission_plan' && Array.isArray(artifact.data?.subtasks) && artifact.data.subtasks.length > 0) {
        summary = `共 ${artifact.data.subtasks.length} 个分工环节：${artifact.data.subtasks.map((s) => `${agentNameZh(s.agentId)} (${s.title || s.taskType || '分工'})`).join(' ➔ ')}`;
    }
    else if (artifact.type === 'cross_agent_mission_summary' && artifact.data) {
        const totalCount = artifact.data.decision?.totalCount ?? artifact.data.statuses?.length ?? 0;
        const completedCount = artifact.data.decision?.completedCount ?? (artifact.data.completed ? totalCount : 0);
        const outcomeText = artifact.data.completed ? '全部完成闭环' : (artifact.data.decision?.outcome === 'partially_completed' ? '部分完成 / 存在异常' : '进行中');
        summary = `交付达成概况：已完成 ${completedCount} / 共 ${totalCount} 项（${outcomeText}）`;
    }
    else {
        const rawSummary = artifact.summary || artifact.description || artifact.data?.summary || artifact.data?.conclusion || (typeof artifact.data?.text === 'string' ? artifact.data.text : '');
        summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 400).trim() : '';
    }
    const formattedFullReport = formatStructuredReportText(artifact.data || artifact, artifact.type);
    const rawInline = formattedFullReport || artifact.data?.markdown || artifact.data?.text || artifact.data?.content || artifact.content || '';
    const inlineContent = typeof rawInline === 'string' ? rawInline.trim() : '';
    const isReadableText = inlineContent.length > 20 && !inlineContent.startsWith('{') && inlineContent !== summary;
    const taskTitle = String(artifact.title || artifact.name || '').trim();
    const parentTaskTitle = String(options.task?.input?.title || options.task?.title || '').trim();
    const isSummaryTrivial = !summary || (taskTitle && (summary === taskTitle ||
        summary.startsWith(taskTitle) ||
        taskTitle.startsWith(summary) ||
        (parentTaskTitle && summary === parentTaskTitle) ||
        summary.length < 15));
    const displaySummary = (!isSummaryTrivial || isReadableText) ? summary : '';
    const copyContent = isReadableText ? inlineContent : (isSummaryTrivial ? '' : summary);
    const previewTitle = getArtifactPreviewTitle(artifact);
    const isOpsOrSystemArtifact = String(artifact?.type || '').startsWith('health_')
        || String(artifact?.type || '').startsWith('operations_')
        || /巡检|健康报告|执行审计/i.test(label || '');
    const isPlanOrSummary = ['cross_agent_mission_plan', 'cross_agent_mission_summary'].includes(String(artifact?.type || ''));
    const hasExpandableContent = isReadableText || isRealFilePath;
    return html `<li class="record-artifact-item ${hasExpandableContent ? 'is-expandable is-collapsed' : ''}" data-artifact-item ${isRealFilePath ? `data-file-path="${url}"` : ''}>
        <div class="artifact-item-header" data-artifact-toggle role="${hasExpandableContent ? 'button' : 'none'}" tabindex="${hasExpandableContent ? '0' : '-1'}" title="${hasExpandableContent ? '点击展开/收起预览' : ''}">
            <div class="artifact-title-wrapper">
                <svg class="artifact-icon" aria-hidden="true"><use href="#icon-records"></use></svg>
                <strong class="artifact-title">${label}</strong>
                <span class="artifact-type-tag">${typeLabel}</span>
                ${raw(artifact._fromAgentName ? html `<span class="artifact-source-tag"><svg width="12" height="12" aria-hidden="true"><use href="#icon-employees"></use></svg> 来自 ${escapeHtml(artifact._fromAgentName)}</span>` : '')}
            </div>
            <div class="artifact-header-actions" onclick="event.stopPropagation()">
                ${raw(isHttp ? html `<a href="${url}" target="_blank" rel="noopener noreferrer" class="artifact-micro-btn primary" title="打开查看">打开 ↗</a>` : '')}
                ${raw(copyContent ? html `<button type="button" class="artifact-micro-btn" data-copy-text="${escapeHtml(copyContent)}" title="复制正文内容"><svg width="12" height="12" aria-hidden="true"><use href="#icon-spark"></use></svg><span>复制</span></button>` : '')}
                ${raw(isRealFilePath ? html `<button type="button" class="artifact-micro-btn" data-copy-path="${url}" title="复制文件路径"><svg width="12" height="12" aria-hidden="true"><use href="#icon-share"></use></svg><span>路径</span></button>` : '')}
                ${raw(hasExpandableContent ? html `
                    <button type="button" class="artifact-toggle-chevron" aria-label="展开或收起预览" title="展开/收起">
                        <svg class="chevron-icon" width="14" height="14" aria-hidden="true"><use href="#icon-chevron"></use></svg>
                    </button>
                ` : '')}
            </div>
        </div>
        <div class="artifact-item-body">
            ${raw(displaySummary ? html `<div class="artifact-summary-box"><p class="artifact-summary">${displaySummary}</p></div>` : '')}
            ${raw(isReadableText ? html `
                <div class="artifact-inline-preview">
                    <div class="artifact-preview-body">
                        <pre class="artifact-preview-text">${escapeHtml(inlineContent)}</pre>
                    </div>
                </div>
            ` : '')}
            <div class="artifact-dynamic-preview" style="display:none; margin-top: 8px;"></div>
        </div>
    </li>`;
}
export function isPrimaryArtifact(artifact) {
    const type = String(artifact?.type || '').toLowerCase();
    const title = String(artifact?.title || artifact?.name || '').toLowerCase();
    if (type.includes('source_evidence') || type.includes('raw_asr') || type.includes('transcript_quality')
        || type.includes('human_review_attestation') || type.includes('xiaod_media_delivery')
        || type.includes('employee_role_report') || type.includes('agent_audit') || type.includes('role_draft')
        || type.includes('mission_plan') || type.includes('mission_summary')
        || title.includes('来源证据') || title.includes('机器原始转录') || title.includes('质量报告')
        || title.includes('听审记录') || title.includes('岗位回报') || title.includes('执行审计')
        || title.includes('多人协作分工') || title.includes('协作汇总') || title.includes('任务协作汇总')) {
        return false;
    }
    return true;
}
