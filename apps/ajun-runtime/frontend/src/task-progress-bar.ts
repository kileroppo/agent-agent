import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';

export interface TaskProgressOptions {
  agentName?: (id: string) => string;
}

export function renderTaskProgressBar(task: any = {}, options: TaskProgressOptions = {}): string {
  if (!task || !task.taskId) {
    return '';
  }

  const agentNameFn = options.agentName || ((id: string) => id || '未知员工');
  const presentation = task.presentation || {};
  const status = task.status || 'unknown';
  const isCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(status);
  const isSucceeded = status === 'succeeded';
  const isFailed = ['failed', 'error'].includes(status);
  const isActionNeeded = ['needs_input', 'waiting_approval', 'pending_approval', 'waiting_test', 'paused', 'blocked'].includes(status);
  const isRunning = ['running', 'queued', 'waiting_worker', 'pausing'].includes(status);

  // 1. Origin
  const input = task.input || {};
  const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
  const originChannel = task.paperclipIssue ? 'Paperclip' : (input.channel || (sourceUrl ? '外部链接' : '飞书'));
  const originTime = formatFullDateTime(task.createdAt);
  const originTooltip = [originChannel, originTime ? originTime.slice(5, 16) : ''].filter(Boolean).join(' · ') || '源头';

  // 2. Routing
  const assignee = agentNameFn(task.assigneeAgentId);
  const taskTypeLabel = cleanText(task.taskType || '通用任务', 20);
  const routingTooltip = `${assignee} · ${taskTypeLabel}`;

  // 3. Execution & Cost
  const cost = task.costAttribution || {};
  const duration = task.createdAt
    ? formatDuration(task.createdAt, task.completedAt || (isCompleted ? task.updatedAt : null))
    : '';
  const tokenInfo = (cost.inputTokens || cost.outputTokens)
    ? `${Math.round((cost.inputTokens + cost.outputTokens) / 100) / 10}k Tokens`
    : '';
  const executionTooltip = [duration, tokenInfo].filter(Boolean).join(' · ') || (isRunning ? '正在执行' : '已就绪');

  // 4. Deliverables
  const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
  const artifactCount = artifacts.length;
  const deliverablestooltip = artifactCount > 0 ? `${artifactCount} 项产物` : (isSucceeded ? '产物已归档' : (isRunning ? '等待生成' : '无产物'));

  // 5. Acceptance
  const acceptance = task.acceptanceTarget || {};
  const decision = acceptance.decision;
  const acceptanceTooltip = decision === 'accepted'
    ? '已采纳'
    : decision === 'revision_required'
      ? '需改进'
      : (isSucceeded ? '待验收' : (isFailed ? '未完成' : '流转中'));
  const acceptanceTone = decision === 'accepted' ? 'success' : (decision === 'revision_required' ? 'warning' : (isSucceeded ? 'attention' : 'muted'));

  const stages = [
    { label: '源头诉求', status: 'completed' as string, tooltip: originTooltip },
    { label: '指派执行', status: isRunning ? 'active' : 'completed', tooltip: routingTooltip },
    { label: '过程开销', status: isFailed ? 'danger' : (isRunning ? 'active' : 'completed'), tooltip: executionTooltip },
    { label: '交付成果', status: artifactCount > 0 ? 'completed' : (isSucceeded ? 'completed' : (isRunning ? 'active' : 'muted')), tooltip: deliverablestooltip },
    { label: '业务验收', status: acceptanceTone, tooltip: acceptanceTooltip },
  ];

  const parts = stages.map((stage, index) => {
    const stageHtml = html`<div class="progress-stage is-${stage.status}" title="${escapeHtml(stage.tooltip)}" aria-label="${stage.label}"><span class="progress-dot"></span><span class="progress-label">${stage.label}</span></div>`;

    if (index < stages.length - 1) {
      const connectorHtml = `<div class="progress-connector is-${escapeHtml(stage.status)}"></div>`;
      return stageHtml + connectorHtml;
    }
    return stageHtml;
  }).join('');

  return html`<div class="task-progress-bar" aria-label="任务进度">${raw(parts)}</div>`;
}

function cleanText(value: any, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
