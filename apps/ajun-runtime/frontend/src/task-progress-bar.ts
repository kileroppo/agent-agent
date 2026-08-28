import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';

export interface TaskProgressOptions {
  agentName?: (id: string) => string;
  attention?: { headline?: string; cause?: string; actions?: any[] } | null;
}

export function renderTaskProgressBar(task: any = {}, options: TaskProgressOptions = {}): string {
  if (!task || !task.taskId) {
    return '';
  }

  const agentNameFn = options.agentName || ((id: string) => id || '未知员工');
  const attentionData = options.attention || null;
  const presentation = task.presentation || {};
  const status = task.status || 'unknown';
  const isAccepted = task.acceptanceTarget?.decision === 'accepted';
  const isSucceeded = status === 'succeeded' || isAccepted;
  const isCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(status) || isAccepted;
  const isFailed = ['failed', 'error'].includes(status) && !isAccepted;
  const isActionNeeded = ['needs_input', 'waiting_approval', 'pending_approval', 'waiting_test', 'paused', 'blocked'].includes(status) && !isAccepted;
  const isQueued = ['queued', 'waiting_worker'].includes(status) && !isAccepted;
  const isRunning = ['running', 'pausing'].includes(status) && !isAccepted;

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
  const duration = (isSucceeded && task.createdAt)
    ? formatDuration(task.createdAt, task.completedAt || (isCompleted ? task.updatedAt : null))
    : '';
  const tokenInfo = (cost.inputTokens || cost.outputTokens)
    ? `${Math.round((cost.inputTokens + cost.outputTokens) / 100) / 10}k Tokens`
    : '';
  const executionTooltip = isFailed
    ? '分析执行中断'
    : ([duration, tokenInfo].filter(Boolean).join(' · ') || (isRunning ? '正在分析与执行' : '执行完成'));

  // 4. Deliverables
  const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
  const artifactCount = artifacts.length;
  const deliverablestooltip = isFailed
    ? (artifactCount > 0 ? `任务中断（已暂存 ${artifactCount} 份阶段存证）` : '任务中断未交付')
    : (artifactCount > 0 ? `${artifactCount} 项交付物` : (isSucceeded ? '产物已归档' : (isRunning ? '产物生成中' : '等待生成')));

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
  if (isFailed) {
    stage4Status = 'muted';
  } else if (artifactCount > 0 || isSucceeded) {
    stage4Status = 'completed';
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

  const rawTitle = String(task?.input?.title || task?.title || '').trim();
  const coreVideoTitle = rawTitle.replace(/^(?:爆款候选拆解|视频分析|多人任务)[｜|：:\s]*/i, '').trim();

  let cleanCause = attentionData?.cause || attentionData?.headline || '任务中断';
  if (coreVideoTitle && coreVideoTitle.length > 3) {
    cleanCause = cleanCause.replaceAll(coreVideoTitle, '').replace(/\s*\|\s*/g, ' ').replace(/^[:：\s]+/, '').trim();
  }
  cleanCause = cleanCause.replace(/^获取并整理[：:\s]*(?:未完成[：:]\s*)?/i, '素材获取与转录未完成：');
  cleanCause = cleanCause.replace(/^拆解爆款候选[：:\s]*(?:未完成[：:]\s*)?/i, '爆款候选拆解未完成：');
  cleanCause = cleanCause.replace(/^[:：·\s]+/, '').trim();

  const STAGE_NAV_TARGETS = ['origin', 'collaboration', 'collaboration', 'deliverables', 'acceptance'];

  const parts = stages.map((stage, index) => {
    const isActionable = stage.status === 'danger' && attentionData && Array.isArray(attentionData.actions) && attentionData.actions.length > 0;
    const navTarget = STAGE_NAV_TARGETS[index];
    const actionAttr = isActionable
      ? ` data-pipeline-action="recovery" data-pipeline-cause="${escapeHtml(cleanCause)}" data-pipeline-action-key="${escapeHtml(attentionData!.actions![0]?.actionKey || '')}" data-pipeline-action-label="${escapeHtml(attentionData!.actions![0]?.label || '继续')}" role="button" tabindex="0"`
      : ` data-pipeline-nav="${navTarget}" role="button" tabindex="0"`;
    const actionableClass = isActionable ? ' is-actionable' : '';
    const stageHtml = html`<div class="progress-stage is-${stage.status}${raw(actionableClass)}"${raw(actionAttr)} title="${escapeHtml(stage.tooltip)}" aria-label="${stage.label}"><span class="progress-dot"></span><span class="progress-label">${stage.label}</span></div>`;

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
