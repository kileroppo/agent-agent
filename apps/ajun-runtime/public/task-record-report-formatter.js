export const ARTIFACT_TYPE_LABELS = {
    cross_agent_mission_plan: '多人分工计划',
    cross_agent_mission_summary: '协作汇报汇总',
    intel_research_report: '调研报告',
    video_content_analysis_report: '爆款拆解分析',
    content_performance_report: '内容复盘报告',
    visual_analysis_package: '画面证据',
    visual_evidence_package: '画面证据',
    confirmed_transcript: '确认逐字稿',
    source_evidence_record: '来源存证',
    raw_asr_transcript: '原始转录',
    transcript_quality_report: '质量报告',
    human_review_attestation: '听审存证',
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
const AGENT_NAMES_ZH = {
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
export function agentNameZh(id) {
    return AGENT_NAMES_ZH[id] || id || '协同员工';
}
const STATUS_NAMES_ZH = {
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
export function statusLabelZh(status) {
    return STATUS_NAMES_ZH[status] || status || '就绪';
}
export function formatArtifactLabel(artifact) {
    if (!artifact || typeof artifact !== 'object')
        return '交付产物';
    let title = artifact.title || artifact.name || artifact.label;
    if (typeof title === 'string' && title.trim()) {
        let clean = title.trim();
        if (clean.includes('｜')) {
            clean = clean.split('｜').pop()?.trim() || clean;
        }
        else if (clean.includes('|')) {
            clean = clean.split('|').pop()?.trim() || clean;
        }
        return clean;
    }
    if (artifact.type && typeof artifact.type === 'string' && artifact.type.trim()) {
        return ARTIFACT_TYPE_LABELS[artifact.type.trim()] || artifact.type.trim().replace(/[_-]/g, ' ');
    }
    if (artifact.artifactId && typeof artifact.artifactId === 'string' && artifact.artifactId.trim()) {
        return `交付产物 #${artifact.artifactId.trim().slice(0, 8)}`;
    }
    return '交付产物';
}
export function getArtifactPreviewTitle(artifact) {
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
export function formatStructuredReportText(data, artifactType = '') {
    if (!data || typeof data !== 'object')
        return '';
    if (typeof data.markdown === 'string' && data.markdown.trim().length > 20)
        return data.markdown.trim();
    if (typeof data.text === 'string' && data.text.trim().length > 20 && !data.text.trim().startsWith('{'))
        return data.text.trim();
    const sections = [];
    // 1. Cross-Agent Mission Plan
    if (artifactType === 'cross_agent_mission_plan' || Array.isArray(data.subtasks)) {
        if (data.summary)
            sections.push(`【总任务协同目标】\n${data.summary}`);
        if (Array.isArray(data.subtasks) && data.subtasks.length > 0) {
            const subtaskLines = data.subtasks.map((subtask, idx) => {
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
        if (sections.length > 1 || (Array.isArray(data.subtasks) && data.subtasks.length > 0)) {
            return sections.join('\n\n');
        }
        return '';
    }
    // 2. Cross-Agent Mission Summary
    if (artifactType === 'cross_agent_mission_summary' || (Array.isArray(data.statuses) && data.decision)) {
        if (data.summary)
            sections.push(`【协同汇总结论】\n${data.summary}`);
        if (data.decision?.outcome) {
            const outcomeText = data.decision.outcome === 'completed' ? '全部完成闭环' : (data.decision.outcome === 'partially_completed' ? '部分交付' : '正在执行中');
            sections.push(`【交付达成概况】\n  状态：${outcomeText}（已完成 ${data.decision.completedCount ?? 0} / 共 ${data.decision.totalCount ?? 0} 项）`);
        }
        if (Array.isArray(data.statuses) && data.statuses.length > 0) {
            const statusLines = data.statuses.map((s) => {
                const artifactsText = Array.isArray(s.artifactTypes) && s.artifactTypes.length > 0 ? ` · 产物：${s.artifactTypes.join(', ')}` : '';
                return `  - [${statusLabelZh(s.status)}] ${s.title}（责任人：${agentNameZh(s.employeeId)}${artifactsText}）`;
            }).join('\n');
            sections.push(`【各岗位交付状态明细】\n${statusLines}`);
        }
        if (data.decision?.briefing) {
            const b = data.decision.briefing;
            const bLines = [];
            if (b.title)
                bLines.push(`主题：${b.title}`);
            if (b.summary)
                bLines.push(`核心结论：${b.summary}`);
            if (b.keyFindings)
                bLines.push(`关键事实发现：\n${b.keyFindings}`);
            if (b.actionItems)
                bLines.push(`后续行动建议：\n${b.actionItems}`);
            if (bLines.length)
                sections.push(`【决策与行动建议】\n${bLines.join('\n\n')}`);
        }
        if (sections.length > 1 || (Array.isArray(data.statuses) && data.statuses.length > 0) || data.decision?.briefing) {
            return sections.join('\n\n');
        }
        return '';
    }
    // 3. Video Benchmark Analysis
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
            if (metaLines)
                sections.push(`【原作品基础信息】\n${metaLines}`);
        }
        if (data.summary)
            sections.push(`【拆解核心摘要】\n${data.summary}`);
        if (Array.isArray(data.actionItems) && data.actionItems.length > 0) {
            const actions = data.actionItems.map((a, idx) => `  ${idx + 1}. ${typeof a === 'string' ? a : (a.action || a.title || '')}`).join('\n');
            sections.push(`【实操行动建议清单】\n${actions}`);
        }
        if (Array.isArray(data.reusablePatterns) && data.reusablePatterns.length > 0) {
            const patterns = data.reusablePatterns.map((p, idx) => {
                const name = typeof p === 'string' ? p : (p.pattern || p.title || `模式 ${idx + 1}`);
                const usage = p.howToReuse ? `\n     💡 复用方法：${p.howToReuse}` : '';
                const caution = p.caution ? `\n     ⚠️ 注意事项：${p.caution}` : '';
                return `  ${idx + 1}. 【${name}】${usage}${caution}`;
            }).join('\n');
            sections.push(`【可复用爆款模式】\n${patterns}`);
        }
        if (Array.isArray(data.modules) && data.modules.length > 0) {
            const moduleLines = data.modules.map((m, idx) => {
                const mLines = [`  ▶ 模块 ${idx + 1}：${m.name || '核心结构'}`];
                if (m.finding)
                    mLines.push(`     分析结论：${m.finding}`);
                if (Array.isArray(m.originalAnalysis?.claims) && m.originalAnalysis.claims.length > 0) {
                    const claims = m.originalAnalysis.claims.map((c) => c.claim || c.text || c).join('；');
                    mLines.push(`     原文提炼：${claims}`);
                }
                if (Array.isArray(m.diagnosis?.issues) && m.diagnosis.issues.length > 0) {
                    const issues = m.diagnosis.issues.map((i) => i.issue || i.text || i).join('；');
                    mLines.push(`     诊断要点：${issues}`);
                }
                if (Array.isArray(m.optimization?.actions) && m.optimization.actions.length > 0) {
                    const opts = m.optimization.actions.map((o) => o.action || o.text || o).join('；');
                    mLines.push(`     优化建议：${opts}`);
                }
                return mLines.join('\n');
            }).join('\n\n');
            sections.push(`【逐项深度结构拆解】\n${moduleLines}`);
        }
        if (sections.length > 0)
            return sections.join('\n\n');
    }
    // 4. General Intel / Research / Public Report
    if (data.topic)
        sections.push(`【调研主题】${data.topic}`);
    if (data.summary || data.conclusion)
        sections.push(`【核心结论】\n${data.summary || data.conclusion}`);
    if (Array.isArray(data.opportunitySignals) && data.opportunitySignals.length > 0) {
        const signals = data.opportunitySignals.map((s, idx) => `  ${idx + 1}. ${s.signal || s.text || s.title || ''}`).join('\n');
        sections.push(`【热门选题机会信号】\n${signals}`);
    }
    else if (Array.isArray(data.claims) && data.claims.length > 0) {
        const claims = data.claims.map((c, idx) => `  ${idx + 1}. ${c.text || c.claim || c.statement || ''}`).join('\n');
        sections.push(`【关键事实与选题发现】\n${claims}`);
    }
    if (Array.isArray(data.originalAngles) && data.originalAngles.length > 0) {
        const angles = data.originalAngles.map((a, idx) => `  💡 角度 ${idx + 1}：${a.premise || a.angle || ''}\n     建议创作用法：${a.treatment || '提炼核心观点重新创作'}`).join('\n');
        sections.push(`【原创切入角度建议】\n${angles}`);
    }
    if (Array.isArray(data.sources) && data.sources.length > 0) {
        const sources = data.sources.map((s, idx) => `  🔗 [来源 ${idx + 1}] ${s.title || '公开资料'} ${s.url ? `(${s.url})` : ''}`).join('\n');
        sections.push(`【参考信源与数据支撑】\n${sources}`);
    }
    if (data.limitation) {
        sections.push(`【事实边界说明】\n${data.limitation}`);
    }
    return sections.join('\n\n');
}
