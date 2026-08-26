import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { cleanAttentionText } from './task-record-detail-view.js';

export interface ParsedTaskTitle {
    cleanTitle: string;
    badges: Array<{ label: string; tone: string }>;
}

export function parseTaskTitle(rawTitle: string): ParsedTaskTitle {
    let text = String(rawTitle || '未命名任务').trim();
    const badges: Array<{ label: string; tone: string }> = [];

    let matched = true;
    while (matched) {
        matched = false;
        // 1. 定向返工
        const reworkMatch = text.match(/^(?:第\s*(\d+)\s*轮)?定向返工[：:]\s*(.+)$/i);
        if (reworkMatch) {
            const round = reworkMatch[1] ? `#${reworkMatch[1]}` : '';
            badges.push({ label: `返工 ${round}`.trim(), tone: 'rework' });
            text = reworkMatch[2].trim();
            matched = true;
            continue;
        }
        // 2. 交付质量复核 / 质量审查
        const qualityMatch = text.match(/^(?:交付)?质量(?:复核|审查|检查)[：:]\s*(.+)$/i);
        if (qualityMatch) {
            badges.push({ label: '质量复核', tone: 'quality' });
            text = qualityMatch[1].trim();
            matched = true;
            continue;
        }
        // 3. 诊断任务故障 / 处理任务故障 / 故障恢复
        const faultMatch = text.match(/^(?:诊断|处理)?(?:任务)?故障(?:恢复)?[：:]\s*(.+)$/i);
        if (faultMatch) {
            badges.push({ label: '故障处理', tone: 'fault' });
            text = faultMatch[1].trim();
            matched = true;
            continue;
        }
        // 4. Paperclip 产能复盘
        const productivity = text.match(/^Review productivity for (AGE-\d+)$/i);
        if (productivity) {
            badges.push({ label: productivity[1].toUpperCase(), tone: 'paperclip' });
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
    const badgeSpans = parsed.badges.map((b) => `<span class="task-badge-pill badge-${b.tone}">${b.label}</span>`).join('');
    return `${badgeSpans}${parsed.cleanTitle}`;
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

export function artifactItems(artifacts: any, { hideEmployeeReport = false }: any = {}): any {
    return (Array.isArray(artifacts) ? artifacts : [])
        .filter((item: any): any => item && typeof item === 'object')
        .filter((item: any): any => !(hideEmployeeReport && item.type === 'employee_execution_report'));
}

export function renderTechnicalDetails(task: any, presentation: any, attention: any, escapeHtml: any): any {
    const attentionTechnicalView: any = attention?.technical || null;
    const presentationTechnical: any = presentation?.technical && typeof presentation.technical === 'object'
        ? presentation.technical
        : {};
    const values: any = {
        taskId: cleanAttentionText(presentationTechnical.taskId || task.taskId, 80),
        status: cleanAttentionText(presentationTechnical.status, 80),
        stage: cleanAttentionText(attentionTechnicalView?.stage || presentationTechnical.currentStage, 120),
        errorCode: cleanAttentionText(attentionTechnicalView?.code || presentationTechnical.errorCode, 120),
    };
    const rows: any = [
        ['完整编号', values.taskId],
        ['创建时间', formatFullDateTime(task.createdAt)],
        ['更新时间', formatFullDateTime(task.updatedAt)],
        ['完成时间', formatFullDateTime(task.completedAt)],
        ['Paperclip 运行', task.paperclipRun?.runId
            ? `${cleanAttentionText(task.paperclipRun.status, 40)} · ${cleanAttentionText(task.paperclipRun.runId, 80)}`
            : ''],
        ['原始状态', values.status],
        ['当前阶段', values.stage],
        ['错误代码', values.errorCode],
    ].filter(([, value]: any): any => value);
    if (!rows.length)
        return '';
    const paperclipIssue: any = (!attention?.paperclipIssue && task.paperclipIssue?.detailUrl)
        ? html`<a class="record-paperclip-link" href="${task.paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip ${task.paperclipIssue.identifier || '任务'}</a>`
        : '';
    const rowsHtml: string = rows.map(([label, value]: any): any => html`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    return html`<details class="record-technical" data-disclosure-key="record-technical:${values.taskId}"><summary><span>编号与审计</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><dl>${raw(rowsHtml)}</dl><div class="record-technical-actions">${raw(paperclipIssue)}<button class="text-action record-copy-id" type="button">复制编号</button></div></details>`;
}

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
    video_content_analysis_report: '分析报告',
    platform_content_draft: '内容草稿',
    article_outline: '文章大纲',
    social_media_copy: '社媒文案',
    health_report: '巡检报告',
    review_report: '审核报告',
    task_intake_record: '任务记录',
    transcript_artifact: '转录文本',
    public_web_report: '调研报告',
    summary_report: '总结报告',
    dataset: '数据集',
    file: '交付文件',
};

export function formatArtifactLabel(artifact: any): string {
    if (!artifact || typeof artifact !== 'object') return '交付产物';
    const title = artifact.title || artifact.name || artifact.label;
    if (typeof title === 'string' && title.trim()) {
        return title.trim();
    }
    if (artifact.type && typeof artifact.type === 'string' && artifact.type.trim()) {
        return ARTIFACT_TYPE_LABELS[artifact.type.trim()] || artifact.type.trim().replace(/[_-]/g, ' ');
    }
    if (artifact.artifactId && typeof artifact.artifactId === 'string' && artifact.artifactId.trim()) {
        return `交付产物 #${artifact.artifactId.trim().slice(0, 8)}`;
    }
    return '交付产物';
}

export function renderArtifact(artifact: any): any {
    if (!artifact || typeof artifact !== 'object') return '';
    const label = formatArtifactLabel(artifact);
    const typeLabel = (artifact.type && ARTIFACT_TYPE_LABELS[artifact.type]) || (artifact.type ? String(artifact.type).replace(/[_-]/g, ' ') : '');
    const url = String(artifact.url || artifact.location || artifact.detailUrl || artifact.downloadUrl || artifact.path || '').trim();
    const isHttp = /^https?:\/\//i.test(url);
    const rawSummary = artifact.summary || artifact.description || artifact.data?.summary || artifact.data?.conclusion || (typeof artifact.data?.text === 'string' ? artifact.data.text : '');
    const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 240).trim() : '';

    return html`<li class="record-artifact-item">
        <div class="artifact-item-main">
            <div class="artifact-item-header">
                <svg class="artifact-icon" aria-hidden="true"><use href="#icon-records"></use></svg>
                <strong class="artifact-title">${label}</strong>
                ${raw(typeLabel ? html`<span class="artifact-type-tag">${typeLabel}</span>` : '')}
            </div>
            ${raw(summary ? html`<p class="artifact-summary">${summary}</p>` : '')}
            ${raw(url && !isHttp ? html`<div class="artifact-path-row"><span class="artifact-path-label">存储路径：</span><code class="artifact-path" title="${escapeHtml(url)}">${url}</code></div>` : '')}
        </div>
        <div class="artifact-item-actions">
            ${raw(isHttp ? html`<a href="${url}" target="_blank" rel="noopener noreferrer" class="artifact-action-btn primary">打开查看 ↗</a>` : '')}
            ${raw(url && !isHttp ? html`<button type="button" class="artifact-action-btn secondary" data-copy-path="${url}">复制路径</button>` : '')}
        </div>
    </li>`;
}

