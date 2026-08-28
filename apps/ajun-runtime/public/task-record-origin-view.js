import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, isValidHttpUrl } from './format-utils.js';
import { cleanAttentionText } from './task-record-detail-view.js';
export function humanizePaperclipText(text) {
    if (!text || typeof text !== 'string')
        return '';
    let result = text.trim();
    // Check if it's a Paperclip automated monitoring/governance report
    if (/Paperclip detected|unusual productivity|progression pattern|Primary trigger|Trigger reasons/i.test(result)) {
        const issueMatch = result.match(/Source issue:\s*\[?(AGE-\d+)\]?(?:\([^)]+\))?/i);
        const agentMatch = result.match(/Assigned agent:\s*([^-\n]+)/i);
        const triggerMatch = result.match(/Primary trigger:\s*['"]?([^'"\n]+)['"]?/i);
        const durationMatch = result.match(/has lasted\s*([\d\w\s]+?)(?:\s*-|\s*$|\.)/i);
        const issueId = issueMatch ? issueMatch[1].toUpperCase() : '';
        const agent = agentMatch ? agentMatch[1].trim() : '';
        let trigger = triggerMatch ? triggerMatch[1].trim() : '';
        if (/long_active_duration/i.test(trigger)) {
            trigger = '单次持续活跃耗时超限';
        }
        else if (/no_progress|stagnant/i.test(trigger)) {
            trigger = '推进停滞无有效产出';
        }
        else if (/high_failure_rate|repeated_failure/i.test(trigger)) {
            trigger = '多次重复失败';
        }
        else if (/budget_exceeded|cost_limit/i.test(trigger)) {
            trigger = '超出开销/Token限制';
        }
        const duration = durationMatch ? durationMatch[1].replace(/h\s*/, '小时 ').replace(/m\s*/, '分钟').trim() : '';
        const parts = [];
        parts.push(`系统监测到关联工单${issueId ? ` #${issueId}` : ''}存在推进异常${agent ? `（负责员工：${agent}）` : ''}。`);
        if (trigger) {
            parts.push(`主要触发动因：${trigger}${duration ? `（已持续 ${duration}）` : ''}。`);
        }
        return parts.join(' ');
    }
    return result;
}
export function renderOriginCard(task = {}, options = {}) {
    if (options?.hideIfInAttention && task?.paperclipIssue) {
        return '';
    }
    const input = task?.input || {};
    const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
    const channel = task?.paperclipIssue ? 'Paperclip 治理工单' : (input.channel || (sourceUrl ? '外部内容链接' : '飞书交互'));
    const createdAt = formatFullDateTime(task?.createdAt);
    const rawDesc = String(input.description || input.focus || '').trim();
    if (!sourceUrl && !rawDesc && !task?.paperclipIssue) {
        return '';
    }
    const { steps, boomMetrics, caveat, cleanGoal } = parseOriginDescription(rawDesc, task);
    const validSteps = steps.filter((step) => step.title && !/^\d+|M=|R=|播放=|点赞=|platform_/i.test(step.title) && step.title.length > 2);
    const issueId = task?.paperclipIssue?.identifier ? `#${task.paperclipIssue.identifier}` : '';
    const issueUrl = task?.paperclipIssue?.detailUrl || '';
    return html `
        <section class="record-origin-card" aria-label="源头诉求与治理工单">
            <div class="origin-card-head">
                <div class="origin-badge-row">
                    <span class="origin-channel-badge ${task?.paperclipIssue ? 'is-paperclip' : ''}">
                        <svg class="origin-icon" aria-hidden="true"><use href="#icon-${task?.paperclipIssue ? 'shield' : 'message'}"></use></svg>
                        <span>${channel}</span>
                        ${raw(issueId ? (issueUrl ? html `<a href="${issueUrl}" target="_blank" rel="noopener noreferrer" class="origin-issue-ref is-link" title="点击打开 Paperclip 工单">${issueId} ↗</a>` : html `<strong class="origin-issue-ref">${issueId}</strong>`) : '')}
                    </span>
                </div>
            </div>

            ${raw(sourceUrl ? html `
                <div class="origin-info-row">
                    <span class="origin-label">原始目标：</span>
                    <div class="origin-info-val">
                        ${raw(isValidHttpUrl(sourceUrl) ? html `
                            <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" class="origin-link-text">
                                <span class="link-url">${escapeHtml(sourceUrl)}</span>
                                <svg class="external-icon" width="12" height="12" aria-hidden="true"><use href="#icon-share"></use></svg>
                            </a>
                        ` : html `
                            <span class="origin-link-text is-plain">
                                <span class="link-url">${escapeHtml(sourceUrl)}</span>
                            </span>
                        `)}
                    </div>
                </div>
            ` : '')}

            ${raw(cleanGoal && cleanGoal !== sourceUrl ? html `
                <div class="origin-info-row">
                    <span class="origin-label">核心诉求：</span>
                    <p class="origin-goal-plain">${escapeHtml(cleanGoal)}</p>
                </div>
            ` : '')}

            ${raw(validSteps.length > 0 ? html `
                <div class="origin-steps-section">
                    <span class="origin-label">协同分步计划 (${validSteps.length} 个执行阶段)：</span>
                    <ol class="origin-steps-timeline">
                        ${raw(validSteps.map((step, idx) => html `
                            <li class="origin-step-timeline-item">
                                <span class="step-dot">${idx + 1}</span>
                                <div class="step-timeline-body">
                                    <div class="step-head">
                                        <strong class="step-title">${escapeHtml(step.title)}</strong>
                                        ${raw(step.agentName ? html `<span class="step-agent-pill">${escapeHtml(step.agentName)}</span>` : '')}
                                    </div>
                                    ${raw(step.desc ? html `<p class="step-desc">${escapeHtml(step.desc)}</p>` : '')}
                                </div>
                            </li>
                        `).join(''))}
                    </ol>
                </div>
            ` : '')}

            ${raw(boomMetrics ? html `
                <div class="origin-metrics-section">
                    <div class="origin-metrics-head">
                        <span class="origin-label">爆款候选评级与关键观测指标：</span>
                        ${raw(boomMetrics.grade ? html `<span class="origin-grade-badge grade-${boomMetrics.grade.toLowerCase()}">${boomMetrics.grade} 爆款候选</span>` : '')}
                    </div>
                    <div class="origin-metrics-board">
                        ${raw(boomMetrics.rValue ? html `<div class="origin-metric-stat"><span class="metric-name">R 扩散倍数</span><strong class="metric-val highlight">${boomMetrics.rValue}</strong></div>` : '')}
                        ${raw(boomMetrics.mValue ? html `<div class="origin-metric-stat"><span class="metric-name">M 互动率</span><strong class="metric-val">${boomMetrics.mValue}</strong></div>` : '')}
                        ${raw(boomMetrics.plays ? html `<div class="origin-metric-stat"><span class="metric-name">播放量</span><strong class="metric-val">${boomMetrics.plays}</strong></div>` : '')}
                        ${raw(boomMetrics.likes ? html `<div class="origin-metric-stat"><span class="metric-name">点赞数</span><strong class="metric-val">${boomMetrics.likes}</strong></div>` : '')}
                        ${raw(boomMetrics.favorites ? html `<div class="origin-metric-stat"><span class="metric-name">收藏数</span><strong class="metric-val">${boomMetrics.favorites}</strong></div>` : '')}
                        ${raw(boomMetrics.followers ? html `<div class="origin-metric-stat"><span class="metric-name">粉丝快照</span><strong class="metric-val">${boomMetrics.followers}</strong></div>` : '')}
                        ${raw(boomMetrics.baseline ? html `<div class="origin-metric-stat is-wide"><span class="metric-name">历史基线中位数</span><strong class="metric-val">${boomMetrics.baseline}</strong></div>` : '')}
                    </div>
                </div>
            ` : '')}

            ${raw(caveat ? html `
                <div class="origin-caveat-box">
                    <svg width="14" height="14" aria-hidden="true"><use href="#icon-alert"></use></svg>
                    <span>${escapeHtml(caveat)}</span>
                </div>
            ` : '')}
        </section>
    `;
}
export function formatNumberZh(num) {
    if (!Number.isFinite(num) || num === 0)
        return '0';
    if (num >= 10000) {
        return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    }
    return num.toLocaleString('zh-CN');
}
export function parseOriginDescription(desc, task = {}) {
    const text = String(desc || '').trim();
    if (!text) {
        return { steps: [], boomMetrics: null, caveat: undefined, cleanGoal: undefined };
    }
    const boomSignal = task?.input?.context?.boomSignal || task?.context?.boomSignal;
    let boomMetrics = null;
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
    }
    else {
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
    const rawParentTitle = String(task?.input?.title || task?.title || '').trim();
    const coreVideoTitle = rawParentTitle.replace(/^(?:爆款候选拆解|视频分析|多人任务)[｜|：:\s]*/i, '').trim();
    const steps = [];
    const rawStepMatches = text.split(/(?:^|\n)(?=\s*\d+\.\s*)/g).map(s => s.trim()).filter((s) => /^\d+\.\s*/.test(s));
    let hasNumberedSteps = false;
    if (rawStepMatches.length >= 2) {
        hasNumberedSteps = true;
        for (const rawStep of rawStepMatches) {
            const stepText = rawStep.replace(/^\d+\.\s*/, '').trim();
            const colonIdx = stepText.indexOf('：') !== -1 ? stepText.indexOf('：') : stepText.indexOf(':');
            let title = colonIdx !== -1 ? stepText.slice(0, colonIdx).trim() : stepText.slice(0, 40);
            let sDesc = colonIdx !== -1 ? stepText.slice(colonIdx + 1).trim() : '';
            // Strip video title prefix if nested in sDesc (e.g. "<video_title>：<actual_desc>")
            if (coreVideoTitle && sDesc.startsWith(coreVideoTitle)) {
                sDesc = sDesc.slice(coreVideoTitle.length).replace(/^[:：\s]+/, '').trim();
            }
            const nextColon = sDesc.indexOf('：') !== -1 ? sDesc.indexOf('：') : sDesc.indexOf(':');
            if (nextColon !== -1 && nextColon < 100 && sDesc.slice(nextColon + 1).trim().length > 5) {
                const prefixPart = sDesc.slice(0, nextColon).trim();
                if (coreVideoTitle && (prefixPart === coreVideoTitle || prefixPart.includes(coreVideoTitle) || coreVideoTitle.includes(prefixPart))) {
                    sDesc = sDesc.slice(nextColon + 1).trim();
                }
            }
            let agentName = '';
            if (/获取|整理|素材|转录|字幕/i.test(title)) {
                agentName = '小D (素材采集/转录)';
                title = '获取并整理素材与证据';
                if (!sDesc) {
                    sDesc = '通过内容获取中心获取公开或已授权素材，生成来源证据、质量报告、确认稿和可用的关键帧证据。';
                }
            }
            else if (/拆解|分析|爆款/i.test(title)) {
                agentName = '小拆 (爆款拆解专家)';
                title = '拆解爆款候选逻辑与结构';
                if (/命中\s*T|R=|M=|指标证据|点赞=|播放=|基准为该作品/i.test(sDesc)) {
                    sDesc = '';
                }
                sDesc = sDesc.replace(/[:：；;，,\s]+$/, '').trim();
                if (!sDesc || sDesc === coreVideoTitle || sDesc.length < 5) {
                    sDesc = String(task?.input?.focus || task?.focus || '解释开场钩子、内容结构、受众触发点、可复制要素和不可复制上下文。').trim();
                }
            }
            else if (/写作|创作|草稿/i.test(title)) {
                agentName = '小创 (内容创作者)';
            }
            else if (/汇报|简报|汇总/i.test(title)) {
                agentName = '小办 (办公助理)';
            }
            sDesc = sDesc.replace(/命中\s*T[123].*$/s, '').trim();
            sDesc = sDesc.replace(/该评分用于筛选.*$/s, '').trim();
            if (sDesc.startsWith('【') && sDesc.includes('】')) {
                sDesc = sDesc.replace(/【[^】]+】\s*/, '').trim();
            }
            sDesc = sDesc.replace(/[:：；;，,\s]+$/, '').trim();
            if (coreVideoTitle && sDesc === coreVideoTitle) {
                sDesc = '';
            }
            steps.push({
                title: title.slice(0, 80),
                agentName,
                desc: sDesc.slice(0, 200),
            });
        }
    }
    let caveat;
    if (text.includes('该评分只用于筛选') || text.includes('该评分用于筛选') || text.includes('不构成传播因果判断')) {
        caveat = '该评分仅由监控系统用于爆款筛选与排序，不构成传播因果判断；实际效果请以全量业务数据为准。';
    }
    let cleanGoal;
    if (!hasNumberedSteps) {
        cleanGoal = humanizePaperclipText(cleanAttentionText(text.replace(/该评分用于.*$/, ''), 500));
    }
    else {
        const firstLine = text.split('\n')[0].replace(/^\d+\.\s*/, '').trim();
        if (firstLine && !firstLine.includes('命中 T') && firstLine.length < 120) {
            cleanGoal = humanizePaperclipText(firstLine.slice(0, 120));
        }
    }
    return { steps, boomMetrics, caveat, cleanGoal };
}
export function renderCostSection(detail) {
    const cost = detail?.costAttribution;
    if (!cost)
        return '';
    const executor = cost.executor || '未知执行者';
    const duration = typeof cost.durationMs === 'number'
        ? cost.durationMs >= 60000
            ? `${(cost.durationMs / 60000).toFixed(1)} 分钟`
            : `${(cost.durationMs / 1000).toFixed(1)} 秒`
        : null;
    const tokens = (cost.inputTokens || cost.outputTokens)
        ? `输入 ${cost.inputTokens} / 输出 ${cost.outputTokens}`
        : null;
    const totalCost = cost.totalCost || null;
    return html `<section class="record-cost" aria-label="任务开销">
    <span>这次花了多少</span>
    <dl>
      <dt>执行者</dt><dd>${executor}</dd>
      ${raw(duration ? html `<dt>耗时</dt><dd>${duration}</dd>` : '')}
      ${raw(tokens ? html `<dt>Token</dt><dd>${tokens}</dd>` : '')}
      ${raw(totalCost ? html `<dt>费用</dt><dd>${totalCost} ${cost.currency || 'USD'}</dd>` : '')}
    </dl>
  </section>`;
}
export function renderDeliverySink(task = {}) {
    const paperclipIssue = task?.paperclipIssue;
    const isCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(task?.status);
    if (!isCompleted)
        return '';
    const sinks = [];
    if (paperclipIssue?.identifier || paperclipIssue?.detailUrl) {
        sinks.push(html `<span class="delivery-sink-item">✓ 已回写 Paperclip 工单 <strong>#${paperclipIssue.identifier || 'ISSUE'}</strong></span>`);
    }
    sinks.push(html `<span class="delivery-sink-item">✓ 已同步并可供飞书原会话回读</span>`);
    return html `<div class="record-delivery-sink"><div class="delivery-sink-title"><svg aria-hidden="true"><use href="#icon-share"></use></svg> 交付去向与下游</div><div class="delivery-sink-list">${raw(sinks.join(''))}</div></div>`;
}
