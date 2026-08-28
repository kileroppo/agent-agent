import { html, raw } from './html.js';
import { formatFullDateTime } from './format-utils.js';
import { cleanAttentionText, taskAttentionView, acceptanceTargetView } from './task-record-detail-view.js';

export const VIEW_LABELS: Record<string, string> = {
    needs_action: '需关注',
    active: '进行中',
    completed: '已完成',
    all: '全部',
};

export const BACKLOG_CATEGORY_LABELS: Record<string, string> = {
    waiting_test: '待核验',
    waiting_approval: '待审批',
    needs_action: '待补充',
    rework: '待重试',
};

export function missingNextActionMessage(taskView: any): string {
    if (taskView === 'needs_action')
        return '没有可执行动作，去飞书补充信息。';
    return '处理中，有进度会更新。';
}

export function compactAttentionReason(task: any): any {
    const isAccepted = task.acceptanceTarget?.decision === 'accepted' || task.status === 'succeeded';
    if (isAccepted)
        return '';
    const attention: any = taskAttentionView(task);
    if (!attention)
        return '';
    const rawCause = String(attention.cause || attention.headline || '').trim();
    if (!rawCause)
        return '';

    const rawTitle = String(task?.input?.title || task?.title || '').trim();
    const coreVideoTitle = rawTitle.replace(/^(?:爆款候选拆解|视频分析|多人任务)[｜|：:\s]*/i, '').trim();

    let cause = rawCause;
    if (coreVideoTitle && coreVideoTitle.length > 3) {
        cause = cause.replaceAll(coreVideoTitle, '').replace(/\s*\|\s*/g, ' ').replace(/^[:：\s]+/, '').trim();
    }

    if (/可在飞书回复[“"]([^”"]+)[”"]/i.test(cause)) {
        const feishuMatch = cause.match(/可在飞书回复[“"]([^”"]+)[”"]/i);
        const actionWord = feishuMatch ? feishuMatch[1] : '重试';
        return `小D素材转录未完成 · 可在飞书回复“${actionWord}”`;
    }

    cause = cause.replace(/^(?:获取并整理|拆解爆款候选|素材采集|视频拆解)[：:\s]*(?:未完成[：:]\s*)?/i, '执行未完成 · ');
    cause = cause.replace(/^[:：·\s]+/, '').replace(/[:：\s]+$/, '').trim();

    if (cause === rawTitle || (rawTitle && cause.startsWith(rawTitle.slice(0, 20)))) {
        return '';
    }
    if (cause.includes('本轮自动验证尚未完成') || cause.includes('不能把运行成功当成交付成功') || cause.includes('暂时没有更具体的用户可见原因')) {
        return '';
    }
    return cleanAttentionText(cause, 90);
}

export function renderTechnicalDetails(task: any, presentation: any, attention: any, _escapeHtml: any): any {
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
    ].filter(([, value]: any): any => Boolean(value));
    if (!rows.length)
        return '';
    const paperclipIssue: any = (!attention?.paperclipIssue && task.paperclipIssue?.detailUrl)
        ? html`<a class="record-paperclip-link" href="${task.paperclipIssue.detailUrl}" target="_blank" rel="noopener">打开 Paperclip ${task.paperclipIssue.identifier || '任务'}</a>`
        : '';
    const rowsHtml: string = rows.map(([label, value]: any): any => html`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    return html`<details class="record-technical" data-disclosure-key="record-technical:${values.taskId}"><summary><span>编号与审计</span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><dl>${raw(rowsHtml)}</dl><div class="record-technical-actions">${raw(paperclipIssue)}<button class="text-action record-copy-id" type="button">复制编号</button></div></details>`;
}

export function newIdempotencyKey(taskId: any, actionKey: any): any {
    const random: any = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `ajun-console:${String(taskId).slice(0, 36)}:${String(actionKey).slice(0, 40)}:${random}`;
}

export function withAcceptanceTarget(payload: any): any {
    const task: any = payload?.task && typeof payload.task === 'object' ? payload.task : {};
    const acceptanceTarget: any = task.acceptanceTarget || payload?.acceptanceTarget || null;
    return acceptanceTarget ? { ...task, acceptanceTarget } : task;
}

export function acceptanceRevision(task: any): any {
    const target: any = acceptanceTargetView(task);
    return target
        ? `${String(target.revision ?? '')}:${String(target.decision || '')}:${String(target.actionable)}`
        : '';
}

export function acceptanceErrorMessage(error: any): any {
    if (error?.status === 409)
        return '这项结果刚刚在其他入口被处理了。你的选择没有覆盖新结果，请刷新后查看最新状态。';
    if (error?.status === 401)
        return '当前页面缺少运行台访问授权。这项待办仍然保留，请重新打开运行台后重试。';
    if (error?.status === 403)
        return `${cleanAttentionText(error?.message, 400) || '本机操作授权刷新失败。'} 这项待办仍然保留，请重新打开任务详情后重试。`;
    if (error?.status === 404 || error?.status === 501)
        return '当前运行版本还不能在运行台保存验收。这项待办没有被更改，你仍可在飞书完成验收。';
    return cleanAttentionText(error?.message, 500) || '验收结果没有保存。这项待办仍然保留，请稍后重试。';
}

export function recordElements(): any {
    return {
        workbench: document.querySelector('#record-workbench'),
        viewButtons: [...document.querySelectorAll('[data-record-view]')],
        search: document.querySelector('#task-search'),
        filterToggle: document.querySelector('#record-filter-toggle'),
        filterPanel: document.querySelector('#record-filter-panel'),
        agentFilter: document.querySelector('#record-agent-filter'),
        statusFilter: document.querySelector('#record-status-filter'),
        typeFilter: document.querySelector('#record-type-filter'),
        timeFilter: document.querySelector('#record-time-filter'),
        routineFilter: document.querySelector('#record-routine-filter'),
        filterApply: document.querySelector('#record-filter-apply'),
        filterReset: document.querySelector('#record-filter-reset'),
        activeFilters: document.querySelector('#record-active-filters'),
        newItems: document.querySelector('#record-new-items'),
        count: document.querySelector('#task-count'),
        listContext: document.querySelector('#record-list-context'),
        batchActions: document.querySelector('#record-batch-actions'),
        batchAcceptBtn: document.querySelector('#record-batch-accept'),
        batchCount: document.querySelector('#batch-adoptable-count'),
        list: document.querySelector('#task-list'),
        loadMore: document.querySelector('#task-load-more'),
        routineSummary: document.querySelector('#record-routine-summary'),
        detail: document.querySelector('#record-detail'),
    };
}

export function readUrlState(): any {
    const params: any = new URLSearchParams(location.search);
    const explicitView: boolean = params.has('recordView') && Boolean(VIEW_LABELS[params.get('recordView')]);
    const view: any = explicitView ? params.get('recordView') : 'needs_action';
    const time: any = ['7d', '30d', 'all'].includes(params.get('recordTime')) ? params.get('recordTime') : '30d';
    return {
        view,
        explicitView,
        q: String(params.get('recordQuery') || '').slice(0, 160),
        agentId: String(params.get('recordAgent') || '').slice(0, 80),
        status: String(params.get('recordStatus') || '').slice(0, 80),
        taskType: String(params.get('recordType') || '').slice(0, 160),
        time,
        includeRoutine: params.get('recordRoutine') === '1',
        backlogCategory: Object.hasOwn(BACKLOG_CATEGORY_LABELS, String(params.get('recordCategory') || ''))
            ? String(params.get('recordCategory'))
            : '',
    };
}

export function option(value: any, label: any): any {
    const node: any = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
}

export function sinceFor(period: any): any {
    const days: any = period === '7d' ? 7 : 30;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function stateForTask(status: any): any {
    if (['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error'].includes(status))
        return 'needs_action';
    if (['succeeded', 'cancelled', 'rejected', 'stopped'].includes(status))
        return 'completed';
}

