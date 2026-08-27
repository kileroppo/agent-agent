import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { cleanAttentionText } from './task-record-detail-view.js';

export function renderOriginCard(task: any = {}): string {
    const input = task?.input || {};
    const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
    const channel = task?.paperclipIssue ? 'Paperclip 治理工单' : (input.channel || (sourceUrl ? '外部内容链接' : '飞书交互'));
    const createdAt = formatFullDateTime(task?.createdAt);
    const rawDesc = String(input.description || input.focus || '').trim();

    if (!sourceUrl && !rawDesc && !task?.paperclipIssue) {
        return '';
    }

    const { steps, boomMetrics, caveat, cleanGoal } = parseOriginDescription(rawDesc, task);
    const issueId = task?.paperclipIssue?.identifier ? `#${task.paperclipIssue.identifier}` : '';

    return html`
        <section class="record-origin-card" aria-label="源头诉求与治理工单">
            <div class="origin-card-head">
                <div class="origin-badge-row">
                    <span class="origin-channel-badge ${task?.paperclipIssue ? 'is-paperclip' : ''}">
                        <svg class="origin-icon" aria-hidden="true"><use href="#icon-${task?.paperclipIssue ? 'shield' : 'message'}"></use></svg>
                        <span>${channel}</span>
                        ${raw(issueId ? html`<strong class="origin-issue-ref">${issueId}</strong>` : '')}
                    </span>
                    <span class="origin-time-tag">登记于 ${createdAt || '未记录'}</span>
                </div>
            </div>

            ${raw(sourceUrl ? html`
                <div class="origin-source-box">
                    <span class="origin-label">原始目标：</span>
                    <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" class="origin-link-text">
                        <span class="link-url">${escapeHtml(sourceUrl)}</span>
                        <svg class="external-icon" width="12" height="12" aria-hidden="true"><use href="#icon-share"></use></svg>
                    </a>
                </div>
            ` : '')}

            ${raw(cleanGoal ? html`
                <div class="origin-goal-box">
                    <span class="origin-label">核心诉求：</span>
                    <p class="origin-goal-text">${escapeHtml(cleanGoal)}</p>
                </div>
            ` : '')}

            ${raw(steps.length > 0 ? html`
                <div class="origin-steps-section">
                    <span class="origin-label">协同分步计划 (${steps.length} 个执行阶段)：</span>
                    <ol class="origin-steps-list">
                        ${raw(steps.map((step, idx) => html`
                            <li class="origin-step-item">
                                <span class="step-num">${idx + 1}</span>
                                <div class="step-content">
                                    <div class="step-head">
                                        <strong class="step-title">${escapeHtml(step.title)}</strong>
                                        ${raw(step.agentName ? html`<span class="step-agent-pill">${escapeHtml(step.agentName)}</span>` : '')}
                                    </div>
                                    ${raw(step.desc ? html`<p class="step-desc">${escapeHtml(step.desc)}</p>` : '')}
                                </div>
                            </li>
                        `).join(''))}
                    </ol>
                </div>
            ` : '')}

            ${raw(boomMetrics ? html`
                <div class="origin-metrics-section">
                    <div class="origin-metrics-head">
                        <span class="origin-label">爆款候选评级与关键观测指标：</span>
                        ${raw(boomMetrics.grade ? html`<span class="origin-grade-badge grade-${boomMetrics.grade.toLowerCase()}">${boomMetrics.grade} 爆款候选</span>` : '')}
                    </div>
                    <div class="origin-metrics-grid">
                        ${raw(boomMetrics.rValue ? html`<div class="origin-metric-card"><span class="metric-name">R 扩散倍数</span><strong class="metric-val highlight">${boomMetrics.rValue}</strong></div>` : '')}
                        ${raw(boomMetrics.mValue ? html`<div class="origin-metric-card"><span class="metric-name">M 互动率</span><strong class="metric-val">${boomMetrics.mValue}</strong></div>` : '')}
                        ${raw(boomMetrics.plays ? html`<div class="origin-metric-card"><span class="metric-name">播放量</span><strong class="metric-val">${boomMetrics.plays}</strong></div>` : '')}
                        ${raw(boomMetrics.likes ? html`<div class="origin-metric-card"><span class="metric-name">点赞数</span><strong class="metric-val">${boomMetrics.likes}</strong></div>` : '')}
                        ${raw(boomMetrics.favorites ? html`<div class="origin-metric-card"><span class="metric-name">收藏数</span><strong class="metric-val">${boomMetrics.favorites}</strong></div>` : '')}
                        ${raw(boomMetrics.followers ? html`<div class="origin-metric-card"><span class="metric-name">粉丝快照</span><strong class="metric-val">${boomMetrics.followers}</strong></div>` : '')}
                        ${raw(boomMetrics.baseline ? html`<div class="origin-metric-card is-wide"><span class="metric-name">历史基线中位数</span><strong class="metric-val">${boomMetrics.baseline}</strong></div>` : '')}
                    </div>
                </div>
            ` : '')}

            ${raw(caveat ? html`
                <div class="origin-caveat-box">
                    <svg width="14" height="14" aria-hidden="true"><use href="#icon-alert"></use></svg>
                    <span>${escapeHtml(caveat)}</span>
                </div>
            ` : '')}
        </section>
    `;
}

export function formatNumberZh(num: number): string {
    if (!Number.isFinite(num) || num === 0) return '0';
    if (num >= 10000) {
        return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    }
    return num.toLocaleString('zh-CN');
}

export function parseOriginDescription(desc: string, task: any = {}): {
    steps: Array<{ title: string; agentName: string; desc: string }>;
    boomMetrics: { grade?: string; rValue?: string; mValue?: string; likes?: string; plays?: string; favorites?: string; followers?: string; baseline?: string } | null;
    caveat?: string;
    cleanGoal?: string;
} {
    const text = String(desc || '').trim();
    if (!text) {
        return { steps: [], boomMetrics: null, caveat: undefined, cleanGoal: undefined };
    }

    const boomSignal = task?.input?.context?.boomSignal || task?.context?.boomSignal;
    let boomMetrics: any = null;

    if (boomSignal && typeof boomSignal === 'object') {
        boomMetrics = {
            grade: boomSignal.grade || 'T1',
            rValue: Number.isFinite(boomSignal.rValue) ? boomSignal.rValue.toFixed(2) : undefined,
            mValue: Number.isFinite(boomSignal.mValue) ? boomSignal.mValue.toFixed(4) : undefined,
            likes: Number.isFinite(boomSignal.observedMetrics?.likes) ? formatNumberZh(boomSignal.observedMetrics.likes) : undefined,
            plays: Number.isFinite(boomSignal.observedMetrics?.plays) ? formatNumberZh(boomSignal.observedMetrics.plays) : undefined,
            favorites: Number.isFinite(boomSignal.observedMetrics?.favorites) ? formatNumberZh(boomSignal.observedMetrics.favorites) : undefined,
            followers: Number.isFinite(boomSignal.observedMetrics?.followers) ? formatNumberZh(boomSignal.observedMetrics.followers) : undefined,
            baseline: boomSignal.baseline?.metricMedian ? `${formatNumberZh(boomSignal.baseline.metricMedian)} (前 ${boomSignal.baseline.sampleCount || 20} 条)` : undefined,
        };
    } else {
        const gradeMatch = text.match(/命中\s*(T[123])/i);
        const rMatch = text.match(/R=([\d.]+)/i);
        const mMatch = text.match(/M=([\d.]+)/i);
        const likesMatch = text.match(/点赞=(\d+)/);
        const playsMatch = text.match(/播放=(\d+)/);
        const favsMatch = text.match(/收藏=(\d+)/);
        const fansMatch = text.match(/粉丝(?:快照)?=(\d+)/);
        const baselineMatch = text.match(/基准为该作品之前最近\s*([\d/]+)\s*条作品核心指标中位数\s*([\d.]+)/);

        if (gradeMatch || rMatch || likesMatch) {
            boomMetrics = {
                grade: gradeMatch ? gradeMatch[1].toUpperCase() : undefined,
                rValue: rMatch ? Number(rMatch[1]).toFixed(2) : undefined,
                mValue: mMatch ? Number(mMatch[1]).toFixed(4) : undefined,
                likes: likesMatch ? formatNumberZh(Number(likesMatch[1])) : undefined,
                plays: playsMatch ? formatNumberZh(Number(playsMatch[1])) : undefined,
                favorites: favsMatch ? formatNumberZh(Number(favsMatch[1])) : undefined,
                followers: fansMatch ? formatNumberZh(Number(fansMatch[1])) : undefined,
                baseline: baselineMatch ? `${formatNumberZh(Number(baselineMatch[2]))} (${baselineMatch[1]} 条)` : undefined,
            };
        }
    }

    const steps: Array<{ title: string; agentName: string; desc: string }> = [];
    const rawStepMatches = text.split(/(?=\b\d+\.\s*)/g).filter((s) => /^\d+\.\s*/.test(s.trim()));
    let hasNumberedSteps = false;

    if (rawStepMatches.length >= 2) {
        hasNumberedSteps = true;
        for (const rawStep of rawStepMatches) {
            const stepText = rawStep.replace(/^\d+\.\s*/, '').trim();
            const colonIdx = stepText.indexOf('：') !== -1 ? stepText.indexOf('：') : stepText.indexOf(':');
            let title = colonIdx !== -1 ? stepText.slice(0, colonIdx).trim() : stepText.slice(0, 40);
            let sDesc = colonIdx !== -1 ? stepText.slice(colonIdx + 1).trim() : '';

            let agentName = '';
            if (/获取|整理|素材|转录|字幕/i.test(title)) {
                agentName = '小D (素材采集/转录)';
                if (title.length > 25) title = '获取并整理素材与证据';
            } else if (/拆解|分析|爆款/i.test(title)) {
                agentName = '小拆 (爆款拆解专家)';
                if (title.length > 25) title = '拆解爆款候选逻辑与结构';
            } else if (/写作|创作|草稿/i.test(title)) {
                agentName = '小创 (内容创作者)';
            } else if (/汇报|简报|汇总/i.test(title)) {
                agentName = '小办 (办公助理)';
            }

            sDesc = sDesc.replace(/命中\s*T[123].*$/s, '').trim();
            sDesc = sDesc.replace(/该评分用于筛选.*$/s, '').trim();
            if (sDesc.startsWith('【') && sDesc.includes('】')) {
                sDesc = sDesc.replace(/【[^】]+】\s*/, '').trim();
            }

            steps.push({
                title: title.slice(0, 80),
                agentName,
                desc: sDesc.slice(0, 200),
            });
        }
    }

    let caveat: string | undefined;
    if (text.includes('该评分只用于筛选') || text.includes('该评分用于筛选') || text.includes('不构成传播因果判断')) {
        caveat = '该评分仅由监控系统用于爆款筛选与排序，不构成传播因果判断；实际效果请以全量业务数据为准。';
    }

    let cleanGoal: string | undefined;
    if (!hasNumberedSteps) {
        cleanGoal = cleanAttentionText(text.replace(/该评分用于.*$/, ''), 300);
    } else {
        const firstLine = text.split('\n')[0].replace(/^\d+\.\s*/, '').trim();
        if (firstLine && !firstLine.includes('命中 T') && firstLine.length < 120) {
            cleanGoal = firstLine.slice(0, 120);
        }
    }

    return { steps, boomMetrics, caveat, cleanGoal };
}
