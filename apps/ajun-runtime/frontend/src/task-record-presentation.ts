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
        ['技术状态', values.status],
        ['执行阶段', values.stage],
        ['错误代码', values.errorCode],
        ['当前员工', cleanAttentionText(task.assigneeAgentId, 80)],
        ['任务类型', cleanAttentionText(task.taskType, 80)],
        ['创建时间', formatFullDateTime(task.createdAt)],
        ['更新时间', formatFullDateTime(task.updatedAt)],
        ['完成时间', formatFullDateTime(task.completedAt)],
    ].filter(([, value]: any): any => Boolean(value));
    const rowsHtml: any = rows.map(([label, value]: any): any => html`<dt>${label}</dt><dd>${value}</dd>`).join('');
    const paperclipIssue: any = presentationTechnical.paperclipIssueUrl
        ? html`<a class="record-paperclip-link" href="${presentationTechnical.paperclipIssueUrl}" target="_blank" rel="noopener">打开 Paperclip</a>`
        : '';
    return html`<details class="record-technical" data-disclosure-key="record-technical:${values.taskId}"><summary><span>编号与审计</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><dl>${raw(rowsHtml)}</dl><div class="record-technical-actions">${raw(paperclipIssue)}<button class="text-action record-copy-id" type="button">复制编号</button></div></details>`;
}

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
    cross_agent_mission_plan: '多人分工计划',
    cross_agent_mission_summary: '协作汇报汇总',
    intel_research_report: '调研报告',
    video_content_analysis_report: '爆款拆解分析',
    content_performance_report: '内容复盘报告',
    visual_analysis_package: '视觉分析包',
    platform_content_draft: '内容草稿',
    article_outline: '文章大纲',
    social_media_copy: '社媒文案',
    health_report: '巡检报告',
    review_report: '审核报告',
    task_intake_record: '任务记录',
    transcript_artifact: '转录文本',
    office_briefing_package: '办公汇报包',
    topic_selection: '选题方案',
    public_web_report: '调研报告',
    summary_report: '总结报告',
    dataset: '数据集',
    file: '交付文件',
};

const AGENT_NAMES_ZH: Record<string, string> = {
    ajun: 'A君 (指挥官)',
    xiaod: '小D (素材采集/转录)',
    'video-content-analyst': '小拆 (爆款拆解专家)',
    'content-creator': '小创 (内容创作者)',
    'intel-researcher': '小R (情报调研员)',
    'office-assistant': '小办 (办公执行助理)',
    architect: '架构师',
    reviewer: '质检复核员',
    operator: '运维官',
    'wechat-chat-retriever': '微信取件员',
};

function agentNameZh(id: string): string {
    return AGENT_NAMES_ZH[id] || id || '协同员工';
}

const STATUS_NAMES_ZH: Record<string, string> = {
    succeeded: '已完成',
    completed: '已完成',
    running: '执行中',
    queued: '排队中',
    waiting_test: '待核验',
    waiting_approval: '待审批',
    failed: '异常失败',
    cancelled: '已取消',
    planned: '已规划',
};

function statusLabelZh(status: string): string {
    return STATUS_NAMES_ZH[status] || status || '就绪';
}

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

export function getArtifactPreviewTitle(artifact: any): string {
    const type = String(artifact?.type || '').trim();
    const label = String(artifact?.title || artifact?.name || '').trim();
    if (type === 'cross_agent_mission_plan' || /分工|编排|计划/i.test(label)) {
        return '查看多人分工与协同编排明细';
    }
    if (type === 'cross_agent_mission_summary' || /任务协作汇总|协同汇总/i.test(label)) {
        return '查看协同交付明细与综合决策';
    }
    if (type === 'video_content_analysis_report' || /拆解|分析报告/i.test(label)) {
        return '查看完整爆款拆解与结构化分析报告';
    }
    if (type === 'transcript_artifact' || /转录|字幕|音频/i.test(label)) {
        return '查看完整音视频转录与素材清单';
    }
    if (type === 'office_briefing_package' || /汇报|简报/i.test(label)) {
        return '查看完整办公汇报包与决策建议';
    }
    if (type === 'task_intake_record' || /任务记录|接件/i.test(label)) {
        return '查看任务接收与能力研判记录';
    }
    if (type === 'topic_selection' || /选题/i.test(label)) {
        return '查看选题方案与受众价值分析';
    }
    return '查看完整报告与交付明细';
}

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

export function formatStructuredReportText(data: any, artifactType: string = ''): string {
    if (!data || typeof data !== 'object') return '';
    if (typeof data.markdown === 'string' && data.markdown.trim().length > 20) return data.markdown.trim();
    if (typeof data.text === 'string' && data.text.trim().length > 20 && !data.text.trim().startsWith('{')) return data.text.trim();

    const sections: string[] = [];

    // 1. Cross-Agent Mission Plan (多人协作分工)
    if (artifactType === 'cross_agent_mission_plan' || Array.isArray(data.subtasks)) {
        if (data.summary) sections.push(`【总任务协同目标】\n${data.summary}`);
        if (Array.isArray(data.subtasks) && data.subtasks.length > 0) {
            const subtaskLines = data.subtasks.map((subtask: any, idx: number) => {
                const lines = [
                    `  📌 分工 ${idx + 1}：${subtask.title || '未命名环节'}`,
                    `     责任员工：${agentNameZh(subtask.agentId)}（任务类型：${subtask.taskType || '通用'}）`,
                ];
                if (subtask.description) {
                    lines.push(`     具体诉求：${subtask.description}`);
                }
                if (subtask.acceptance) {
                    lines.push(`     验收标准：${subtask.acceptance}`);
                }
                if (Array.isArray(subtask.dependsOn) && subtask.dependsOn.length > 0) {
                    lines.push(`     前置依赖：${subtask.dependsOn.join('、')}`);
                }
                return lines.join('\n');
            }).join('\n\n');
            sections.push(`【多人协同分工执行清单】\n${subtaskLines}`);
        }
        if (Array.isArray(data.prohibitedActions) && data.prohibitedActions.length > 0) {
            sections.push(`【安全合规红线】\n  ⛔ 严格禁止以下非授权操作：\n  ${data.prohibitedActions.join('、')}`);
        }
        return sections.join('\n\n');
    }

    // 2. Cross-Agent Mission Summary (老板任务协作汇总)
    if (artifactType === 'cross_agent_mission_summary' || (Array.isArray(data.statuses) && data.decision)) {
        if (data.summary) sections.push(`【协同汇总结论】\n${data.summary}`);
        if (data.decision?.outcome) {
            const outcomeText = data.decision.outcome === 'completed' ? '全部完成闭环' : (data.decision.outcome === 'partially_completed' ? '部分交付' : '正在执行中');
            sections.push(`【交付达成概况】\n  状态：${outcomeText}（已完成 ${data.decision.completedCount ?? 0} / 共 ${data.decision.totalCount ?? 0} 项）`);
        }
        if (Array.isArray(data.statuses) && data.statuses.length > 0) {
            const statusLines = data.statuses.map((s: any) => {
                const artifactsText = Array.isArray(s.artifactTypes) && s.artifactTypes.length > 0 ? ` · 产物：${s.artifactTypes.join(', ')}` : '';
                return `  - [${statusLabelZh(s.status)}] ${s.title}（责任人：${agentNameZh(s.employeeId)}${artifactsText}）`;
            }).join('\n');
            sections.push(`【各岗位交付状态明细】\n${statusLines}`);
        }
        if (data.decision?.briefing) {
            const b = data.decision.briefing;
            const bLines: string[] = [];
            if (b.title) bLines.push(`主题：${b.title}`);
            if (b.summary) bLines.push(`核心结论：${b.summary}`);
            if (b.keyFindings) bLines.push(`关键事实发现：\n${b.keyFindings}`);
            if (b.actionItems) bLines.push(`后续行动建议：\n${b.actionItems}`);
            if (bLines.length) sections.push(`【决策与行动建议】\n${bLines.join('\n\n')}`);
        }
        return sections.join('\n\n');
    }

    // 3. Video Benchmark Analysis / Video Content Analyst Report (爆款拆解报告)
    if (artifactType === 'video_content_analysis_report' || Array.isArray(data.modules) || data.sourceMetadata) {
        if (data.sourceMetadata) {
            const sm = data.sourceMetadata;
            const metaLines = [
                sm.title ? `  - 作品标题：${sm.title}` : '',
                sm.author ? `  - 创作者：${sm.author}` : '',
                sm.platform ? `  - 发布平台：${sm.platform}` : '',
                sm.durationSeconds ? `  - 作品时长：${sm.durationSeconds} 秒` : '',
                sm.canonicalUrl ? `  - 原始链接：${sm.canonicalUrl}` : '',
            ].filter(Boolean).join('\n');
            if (metaLines) sections.push(`【原作品基础信息】\n${metaLines}`);
        }
        if (data.summary) sections.push(`【拆解核心摘要】\n${data.summary}`);
        if (Array.isArray(data.actionItems) && data.actionItems.length > 0) {
            const actions = data.actionItems.map((a: any, idx: number) => `  ${idx + 1}. ${typeof a === 'string' ? a : (a.action || a.title || '')}`).join('\n');
            sections.push(`【实操行动建议清单】\n${actions}`);
        }
        if (Array.isArray(data.reusablePatterns) && data.reusablePatterns.length > 0) {
            const patterns = data.reusablePatterns.map((p: any, idx: number) => {
                const name = typeof p === 'string' ? p : (p.pattern || p.title || `模式 ${idx + 1}`);
                const usage = p.howToReuse ? `\n     💡 复用方法：${p.howToReuse}` : '';
                const caution = p.caution ? `\n     ⚠️ 注意事项：${p.caution}` : '';
                return `  ${idx + 1}. 【${name}】${usage}${caution}`;
            }).join('\n');
            sections.push(`【可复用爆款模式】\n${patterns}`);
        }
        if (Array.isArray(data.modules) && data.modules.length > 0) {
            const moduleLines = data.modules.map((m: any, idx: number) => {
                const mLines = [`  ▶ 模块 ${idx + 1}：${m.name || '核心结构'}`];
                if (m.finding) mLines.push(`     分析结论：${m.finding}`);
                if (Array.isArray(m.originalAnalysis?.claims) && m.originalAnalysis.claims.length > 0) {
                    const claims = m.originalAnalysis.claims.map((c: any) => c.claim || c.text || c).join('；');
                    mLines.push(`     原文提炼：${claims}`);
                }
                if (Array.isArray(m.diagnosis?.issues) && m.diagnosis.issues.length > 0) {
                    const issues = m.diagnosis.issues.map((i: any) => i.issue || i.text || i).join('；');
                    mLines.push(`     诊断要点：${issues}`);
                }
                if (Array.isArray(m.optimization?.actions) && m.optimization.actions.length > 0) {
                    const opts = m.optimization.actions.map((o: any) => o.action || o.text || o).join('；');
                    mLines.push(`     优化建议：${opts}`);
                }
                return mLines.join('\n');
            }).join('\n\n');
            sections.push(`【逐项深度结构拆解】\n${moduleLines}`);
        }
        if (sections.length > 0) return sections.join('\n\n');
    }

    // 4. General Intel / Research / Public Report
    if (data.topic) sections.push(`【调研主题】${data.topic}`);
    if (data.summary || data.conclusion) sections.push(`【核心结论】\n${data.summary || data.conclusion}`);

    if (Array.isArray(data.opportunitySignals) && data.opportunitySignals.length > 0) {
        const signals = data.opportunitySignals.map((s: any, idx: number) => `  ${idx + 1}. ${s.signal || s.text || s.title || ''}`).join('\n');
        sections.push(`【热门选题机会信号】\n${signals}`);
    } else if (Array.isArray(data.claims) && data.claims.length > 0) {
        const claims = data.claims.map((c: any, idx: number) => `  ${idx + 1}. ${c.text || c.claim || c.statement || ''}`).join('\n');
        sections.push(`【关键事实与选题发现】\n${claims}`);
    }

    if (Array.isArray(data.originalAngles) && data.originalAngles.length > 0) {
        const angles = data.originalAngles.map((a: any, idx: number) => `  💡 角度 ${idx + 1}：${a.premise || a.angle || ''}\n     建议创作用法：${a.treatment || '提炼核心观点重新创作'}`).join('\n');
        sections.push(`【原创切入角度建议】\n${angles}`);
    }

    if (Array.isArray(data.sources) && data.sources.length > 0) {
        const sources = data.sources.map((s: any, idx: number) => `  🔗 [来源 ${idx + 1}] ${s.title || '公开资料'} ${s.url ? `(${s.url})` : ''}`).join('\n');
        sections.push(`【参考信源与数据支撑】\n${sources}`);
    }

    if (data.limitation) {
        sections.push(`【事实边界说明】\n${data.limitation}`);
    }

    return sections.join('\n\n');
}

