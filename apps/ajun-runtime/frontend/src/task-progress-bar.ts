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
  const isQueued = ['queued', 'waiting_worker'].includes(status);
  const isRunning = ['running', 'pausing'].includes(status);

  // 1. Origin
  const input = task.input || {};
  const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
  const originChannel = task.paperclipIssue ? 'Paperclip 治理工单' : (input.channel || (sourceUrl ? '外部链接' : '飞书'));
  const originTime = formatFullDateTime(task.createdAt);
  const originTooltip = [originChannel, originTime ? originTime.slice(5, 16) : ''].filter(Boolean).join(' · ') || '源头诉求已登记';

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
  const executionTooltip = [duration, tokenInfo].filter(Boolean).join(' · ') || (isRunning ? '正在分析与执行' : '执行完成');

  // 4. Deliverables
  const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
  const artifactCount = artifacts.length;
  const deliverablestooltip = artifactCount > 0 ? `${artifactCount} 项交付物` : (isSucceeded ? '产物已归档' : (isRunning ? '产物生成中' : '等待生成'));

  // 5. Acceptance
  const acceptance = task.acceptanceTarget || {};
  const decision = acceptance.decision;
  const acceptanceTooltip = decision === 'accepted'
    ? '已采纳满意'
    : decision === 'revision_required'
      ? '需针对性返工'
      : (status === 'waiting_test' ? '待人工核验' : (isSucceeded ? '已完成闭环' : (isFailed ? '任务中断' : '待前序完成')));

  // State calculations for each stage (Ensuring strictly ONE active node)
  const stage1Status = 'completed';
  const stage2Status = isQueued ? 'active' : 'completed';

  let stage3Status = 'muted';
  if (isFailed) {
    stage3Status = 'danger';
  } else if (isQueued) {
    stage3Status = 'muted';
  } else if (isSucceeded || artifactCount > 0) {
    stage3Status = 'completed';
  } else if (isRunning) {
    stage3Status = 'active';
  } else if (isActionNeeded && status !== 'waiting_test') {
    stage3Status = 'attention';
  } else {
    stage3Status = 'completed';
  }

  let stage4Status = 'muted';
  if (artifactCount > 0 || isSucceeded) {
    stage4Status = 'completed';
  } else if (isFailed) {
    stage4Status = 'muted';
  } else if (isRunning && stage3Status === 'completed') {
    stage4Status = 'active';
  } else {
    stage4Status = 'muted';
  }

  let stage5Status = 'muted';
  if (decision === 'accepted' || (isSucceeded && !isActionNeeded)) {
    stage5Status = 'success';
  } else if (decision === 'revision_required') {
    stage5Status = 'warning';
  } else if (status === 'waiting_test' || (isActionNeeded && artifactCount > 0)) {
    stage5Status = 'attention';
  } else {
    stage5Status = 'muted';
  }

  // Ensure strict single active stage
  if (stage3Status === 'active') {
    stage4Status = 'muted';
    stage5Status = 'muted';
  }

  const stages = [
    { label: '源头诉求', status: stage1Status, tooltip: originTooltip },
    { label: '指派执行', status: stage2Status, tooltip: routingTooltip },
    { label: '分析与生成', status: stage3Status, tooltip: executionTooltip },
    { label: '交付成果', status: stage4Status, tooltip: deliverablestooltip },
    { label: '业务验收', status: stage5Status, tooltip: acceptanceTooltip },
  ];

  const parts = stages.map((stage, index) => {
    const stageHtml = html`<div class="progress-stage is-${stage.status}" title="${escapeHtml(stage.tooltip)}" aria-label="${stage.label}"><span class="progress-dot"></span><span class="progress-label">${stage.label}</span></div>`;

    if (index < stages.length - 1) {
      const connectorStatus = stage.status === 'completed' || stage.status === 'success' ? 'completed' : (stage.status === 'active' ? 'active' : 'muted');
      const connectorHtml = `<div class="progress-connector is-${escapeHtml(connectorStatus)}"></div>`;
      return stageHtml + connectorHtml;
    }
    return stageHtml;
  }).join('');

  return html`<div class="task-progress-bar" aria-label="任务进度">${raw(parts)}</div>`;
}

function cleanText(value: any, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
