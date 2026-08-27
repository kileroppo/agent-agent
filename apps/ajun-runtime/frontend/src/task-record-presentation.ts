import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { cleanAttentionText } from './task-record-detail-view.js';

export interface ParsedTaskTitle {
    cleanTitle: string;
    badges: Array<{ label: string; tone: string; tooltip: string; icon?: string }>;
}

export function parseTaskTitle(rawTitle: string): ParsedTaskTitle {
    let text = String(rawTitle || '未命名任务').trim();
    const badges: Array<{ label: string; tone: string; tooltip: string; icon?: string }> = [];

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

export function displayTaskTitle(task: any): string {
    const rawTitle: string = String(task?.input?.title || task?.title || '未命名任务').trim();
    const parsed = parseTaskTitle(rawTitle);
    if (!parsed.badges.length) return parsed.cleanTitle;
    const badgeSpans = parsed.badges.map((b) => 
        `<span class="task-badge-pill badge-${b.tone}" title="${escapeHtml(b.tooltip)}">${b.label}</span>`
    ).join(' ');
    return `<span class="task-title-wrapper">${badgeSpans} <span class="task-title-text">${escapeHtml(parsed.cleanTitle)}</span></span>`;
}

export function displaySubtaskTitle(childTask: any, _parentTask: any = null): string {
    const rawTitle: string = String(childTask?.input?.title || childTask?.title || '子任务').trim();
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

export function relativeTime(value: any): string {
    const timestamp: any = Date.parse(value || '');
    if (!Number.isFinite(timestamp))
        return '时间未记录';
    const delta: any = timestamp - Date.now();
    const absolute: any = Math.abs(delta);
    const formatter: any = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
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

export function resultSummary(task: any): any {
    const artifacts: any = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const report: any = artifacts.find((item: any): any => item?.type === 'health_report')?.data;
    if (report)
        return { label: '检查结果', text: `${report.overall === 'healthy' ? '运行正常' : '发现需要关注的项目'}${Array.isArray(report.components) ? `：${report.components.map((item: any): any => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、')}` : ''}` };
    const intake: any = artifacts.find((item: any): any => item?.type === 'task_intake_record')?.data;
    if (intake?.nextAction)
        return { label: '判断结果', text: intake.nextAction };
    const review: any = artifacts.find((item: any): any => item?.type === 'review_report')?.data;
    if (review?.nextAction)
        return { label: '审核结论', text: review.nextAction };
    const publicReport: any = artifacts.find((item: any): any => item?.type === 'public_web_report')?.data;
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

export function artifactItems(artifacts: any, { hideEmployeeReport = true }: any = {}): any {
    return (Array.isArray(artifacts) ? artifacts : [])
        .filter((item: any): any => item && typeof item === 'object')
        .filter((item: any): any => {
            if (!hideEmployeeReport) return true;
            const type = String(item.type || '').trim();
            const title = String(item.title || item.name || '').trim();
            if (INTERNAL_MACHINE_TYPES.has(type)) return false;
            if (/员工岗位回报|执行审计|岗位草案/i.test(title)) return false;
            return true;
        });
}


import {
    ARTIFACT_TYPE_LABELS,
    formatArtifactLabel,
    getArtifactPreviewTitle,
    formatStructuredReportText,
} from './task-record-report-formatter.js';

export {
    ARTIFACT_TYPE_LABELS,
    formatArtifactLabel,
    getArtifactPreviewTitle,
    formatStructuredReportText,
};

export function renderArtifact(artifact: any, options: any = {}): any {
    if (!artifact || typeof artifact !== 'object') return '';
    const isAccepted = Boolean(options.isAccepted);
    const label = formatArtifactLabel(artifact);
    const typeLabel = (artifact.type && ARTIFACT_TYPE_LABELS[artifact.type]) || (artifact.type ? String(artifact.type).replace(/[_-]/g, ' ') : '交付物');
    const url = String(artifact.url || artifact.location || artifact.detailUrl || artifact.downloadUrl || artifact.path || '').trim();
    const isHttp = /^https?:\/\//i.test(url);
    const isRuntimeVirtual = url.startsWith('runtime://');
    const isRealFilePath = /^(?:\/|[a-zA-Z]:[/\\]|file:\/\/)/.test(url) && !isRuntimeVirtual;

    const rawSummary = artifact.summary || artifact.description || artifact.data?.summary || artifact.data?.conclusion || (typeof artifact.data?.text === 'string' ? artifact.data.text : '');
    const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 400).trim() : '';
    const formattedFullReport = formatStructuredReportText(artifact.data || artifact, artifact.type);
    const rawInline = formattedFullReport || artifact.data?.markdown || artifact.data?.text || artifact.data?.content || artifact.content || '';
    const inlineContent = typeof rawInline === 'string' ? rawInline.trim() : '';
    const isReadableText = inlineContent.length > 20 && !inlineContent.startsWith('{') && inlineContent !== summary;
    const copyContent = isReadableText ? inlineContent : summary;
    const previewTitle = getArtifactPreviewTitle(artifact);

    const isOpsOrSystemArtifact = String(artifact?.type || '').startsWith('health_')
        || String(artifact?.type || '').startsWith('operations_')
        || /巡检|健康报告|执行审计/i.test(label || '');
    const isPlanOrSummary = ['cross_agent_mission_plan', 'cross_agent_mission_summary'].includes(String(artifact?.type || ''));

    return html`<li class="record-artifact-item">
        <div class="artifact-item-main">
            <div class="artifact-item-header">
                <div class="artifact-title-wrapper">
                    <svg class="artifact-icon" aria-hidden="true"><use href="#icon-records"></use></svg>
                    <strong class="artifact-title">${label}</strong>
                    <span class="artifact-type-tag">${typeLabel}</span>
                </div>
            </div>
            ${raw(summary ? html`<div class="artifact-summary-box"><p class="artifact-summary">${summary}</p></div>` : '')}
            ${raw(isReadableText ? html`
                <details class="artifact-inline-preview" open>
                    <summary><span>${previewTitle}</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary>
                    <div class="artifact-preview-body">
                        <pre class="artifact-preview-text">${escapeHtml(inlineContent)}</pre>
                    </div>
                </details>
            ` : '')}
            ${raw(isRealFilePath ? html`<div class="artifact-path-row"><span class="artifact-path-label">存储路径：</span><code class="artifact-path" title="${escapeHtml(url)}">${url}</code></div>` : '')}
        </div>
        <div class="artifact-item-actions">
            ${raw(isHttp ? html`<a href="${url}" target="_blank" rel="noopener noreferrer" class="artifact-action-btn primary">打开查看 ↗</a>` : '')}
            ${raw(isRealFilePath ? html`<button type="button" class="artifact-action-btn secondary" data-copy-path="${url}">复制路径</button>` : '')}
            ${raw(copyContent ? html`<button type="button" class="artifact-action-btn secondary" data-copy-text="${escapeHtml(copyContent)}">复制内容</button>` : '')}
            ${raw(!isOpsOrSystemArtifact && !isPlanOrSummary ? (isAccepted ? '<span class="artifact-accepted-pill">✓ 已采纳</span>' : '<button type="button" class="artifact-action-btn primary" data-acceptance-decision="accepted">✓ 采纳此产物</button>') : '')}
        </div>
    </li>`;
}

