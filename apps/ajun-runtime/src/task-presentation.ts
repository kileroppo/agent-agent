import { presentTaskAttention } from './task-attention-presentation.ts';
const STATUS_PRESENTATION: Record<string, any> = {
    queued: { label: '等待开始', tone: 'active', summary: '任务已登记，正在等待开始。', nextAction: '无需重复提交；开始处理后会更新进度。' },
    running: { label: '处理中', tone: 'active', summary: '任务正在处理中。', nextAction: '等待新的进度或结果即可。' },
    pausing: { label: '正在暂停', tone: 'attention', summary: '任务正在寻找安全位置暂停。', nextAction: '当前步骤结束后会暂停，不会再开始新的步骤。' },
    paused: { label: '已暂停', tone: 'attention', summary: '任务已经暂停。', nextAction: '确认继续后，系统才会恢复处理。' },
    pending_approval: { label: '等待确认', tone: 'attention', summary: '任务正在等待你的确认。', nextAction: '请在发起任务的原会话确认范围。' },
    waiting_approval: { label: '等待确认', tone: 'attention', summary: '任务正在等待你的确认。', nextAction: '请在发起任务的原会话确认范围。' },
    waiting_worker: { label: '等待 Mac', tone: 'active', summary: '任务已安全排队，正在等待 Mac 工作间。', nextAction: 'Mac 上线后会自动继续，无需重复提交。' },
    waiting_test: { label: '待验证', tone: 'attention', summary: '本轮自动验证尚未完成。', nextAction: '当前结果已保留，验证恢复后可继续。' },
    needs_input: { label: '等待补充', tone: 'attention', summary: '任务缺少继续所需的信息。', nextAction: '请补充目标、范围或必要素材。' },
    recovery_pending: { label: '正在恢复', tone: 'attention', summary: '任务遇到问题，运维官正在判断恢复办法。', nextAction: '暂时无需重复提交，系统会从安全位置继续。' },
    technical_repair: { label: '正在修复', tone: 'attention', summary: '任务未完成，已经进入技术修复。', nextAction: '等待修复和验证证据完整后再确认结果。' },
    succeeded: { label: '已完成', tone: 'success', summary: '任务已经完成。', nextAction: '可以查看交付结果；如不符合预期，直接说明要调整的地方。' },
    failed: { label: '未完成', tone: 'danger', summary: '任务本轮没有完成。', nextAction: '查看原因后补充信息或重新发起。' },
    cancelled: { label: '已关闭', tone: 'muted', summary: '任务已经关闭。', nextAction: '如仍需处理，请重新说明目标和范围。' },
    rejected: { label: '已拒绝', tone: 'muted', summary: '任务请求已被拒绝，未继续执行。', nextAction: '如需继续，请调整范围后重新发起。' }
};
export function presentTask(task: any = {}, { approvals = [], detailBaseUrl = '', recoveryView = null }: any = {}): any {
    const taskId: any = String(task.taskId || '').trim();
    const title: any = cleanText(task.input?.title || task.title, 160) || '未命名任务';
    const status: any = String(task.status || 'unknown').trim() || 'unknown';
    const pendingApproval: any = approvals.some((approval: any): any => approval?.status === 'pending' && (task.approvalRefs || []).includes(approval.approvalId));
    const base: any = pendingApproval ? STATUS_PRESENTATION.waiting_approval : (STATUS_PRESENTATION as any)[status];
    const attention: any = presentTaskAttention(task, { pendingApproval, recoveryView });
    const effectiveBase: any = attention?.kind === 'approved_not_started'
        ? { label: '需要继续', tone: 'attention' }
        : base;
    const analysisReport: any = (task.artifactRefs || []).find((artifact: any): any => artifact?.type === 'video_content_analysis_report')?.data;
    const analysisIntent: any = cleanText(analysisReport?.analysisIntent || task.input?.analysisIntent, 20);
    const analysisNextAction: any = cleanText(analysisReport?.nextAction?.label, 500);
    const analysisSummary: any = analysisReport && analysisIntent
        ? `${title}：${analysisIntentLabel(analysisIntent)}报告已完成。`
        : null;
    const summary: any = attention?.cause
        ? `${title}：${attention.cause}`
        : analysisSummary || (effectiveBase?.summary
            ? `${title}：${effectiveBase.summary}`
            : `${title}：状态已更新。`);
    const nextAction: any = attention?.nextAction
        || analysisNextAction
        || effectiveBase?.nextAction
        || '等待新的进度；无需重复提交。';
    const detailPath: any = taskId ? `/tasks/${encodeURIComponent(taskId)}` : null;
    return {
        taskRef: shortTaskRef(taskId),
        statusLabel: effectiveBase?.label || '状态更新',
        tone: effectiveBase?.tone || 'active',
        summary,
        nextAction,
        detailPath,
        detailUrl: detailPath ? taskDetailUrl(detailBaseUrl, detailPath) : null,
        attention,
        technical: {
            taskId: taskId || null,
            status,
            currentStage: cleanText(task.currentStage, 120) || null,
            errorCode: cleanText(task.error?.code, 120) || null,
            analysisIntent: analysisIntent || null,
            reportVersion: cleanText(analysisReport?.reportVersion, 80) || null
        }
    };
}
export function shortTaskRef(taskId: any): any {
    const compact: any = String(taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    return compact ? `#${compact}` : '#未编号';
}
export function formatTaskPresentation(value: any): any {
    const presentation: any = value?.presentation;
    if (!presentation)
        return '';
    const lines: any[] = [
        `${presentation.statusLabel} · ${presentation.summary}`,
        `任务 ${presentation.taskRef}`,
        `下一步：${presentation.nextAction}`
    ];
    if (presentation.detailUrl)
        lines.push(`查看任务：${presentation.detailUrl}`);
    return lines.join('\n');
}
export function taskDetailBaseUrl(value: any, fallback: any = ''): any {
    for (const candidate of [value, fallback]) {
        const text: any = String(candidate || '').trim();
        if (!text)
            continue;
        try {
            const url: any = new URL(text);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                continue;
            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/$/, '');
        }
        catch {
            // Invalid configuration is ignored instead of leaking it into a link.
        }
    }
    return '';
}
function taskDetailUrl(baseUrl: any, detailPath: any): any {
    const base: any = taskDetailBaseUrl(baseUrl);
    return base ? new URL(detailPath, `${base}/`).toString() : null;
}
function cleanText(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function analysisIntentLabel(value: any): any {
    return (({ digest: '精华提炼', deep: '深度拆解', template: '模板学习', style: '风格探索' }) as any)[value] || '视频分析';
}
