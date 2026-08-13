import {
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
} from './task-lifecycle.js';

const TERMINAL_STATUS_SET = new Set(TERMINAL_TASK_STATUSES);
const BLOCKED_STATUS_SET = new Set([
  'needs_input',
  'paused',
  'waiting_approval',
  'waiting_test',
  'failed',
  'cancelled',
  'expired',
]);
const NOTIFICATION_TERMINAL_STATUS_SET = new Set([
  ...TERMINAL_TASK_STATUSES,
  'needs_input',
  'paused',
]);
const EXECUTION_CLOSED_STATUS_SET = new Set(['succeeded', 'failed', 'cancelled', 'waiting_test']);
export const PAPERCLIP_COMPLETION_TASK_STATUSES = Object.freeze(['succeeded', 'failed', 'waiting_test']);
const PAPERCLIP_COMPLETION_STATUS_SET = new Set(PAPERCLIP_COMPLETION_TASK_STATUSES);
const TASK_CARD_TERMINAL_STATUS_SET = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_FAILURE_TASK_STATUS_SET = new Set(['failed', 'cancelled', 'expired']);
const ACCEPTANCE_OWNER_ACTION = '验收已经生成的业务产物';
const WORKFLOW_OUTCOME_STATUS_SET = new Set(['received', 'planning', 'running', 'recovering', 'waiting_user', 'waiting_validation', 'waiting_acceptance', 'partial', 'succeeded', 'failed', 'cancelled']);
const DELIVERY_OUTCOME_PROJECTIONS = Object.freeze({
  delivery_quality_review_pending:['running', 'running', 'delivery_quality_review_pending'],
  delivery_quality_review_start_failed:['waiting_test', 'waiting_validation', 'delivery_quality_review_start_failed'],
  delivery_quality_passed:['succeeded', 'waiting_acceptance', 'succeeded'],
  delivery_quality_stopped:['waiting_test', 'waiting_validation', 'delivery_quality_stopped'],
});

const STATUS_DETAILS = Object.freeze({
  received:{ label:'已收到', attentionPriority:8, paperclipIssueStatus:'backlog' },
  needs_input:{ label:'等待补充信息', attentionPriority:1, paperclipIssueStatus:'blocked' },
  queued:{ label:'排队中', attentionPriority:7, paperclipIssueStatus:'backlog' },
  running:{ label:'处理中', attentionPriority:6, paperclipIssueStatus:'backlog' },
  waiting_worker:{ label:'等待 Mac工作间上线', attentionPriority:8, paperclipIssueStatus:'backlog' },
  pausing:{ label:'正在暂停', attentionPriority:4, paperclipIssueStatus:'backlog' },
  paused:{ label:'已暂停', attentionPriority:5, paperclipIssueStatus:'blocked' },
  waiting_approval:{ label:'等待批准', attentionPriority:0, paperclipIssueStatus:'blocked' },
  waiting_test:{ label:'等待验证', attentionPriority:3, paperclipIssueStatus:'blocked' },
  succeeded:{ label:'已完成', attentionPriority:8, paperclipIssueStatus:'done' },
  failed:{ label:'失败', attentionPriority:2, paperclipIssueStatus:'blocked' },
  cancelled:{ label:'已取消', attentionPriority:8, paperclipIssueStatus:'blocked' },
  expired:{ label:'已过期', attentionPriority:8, paperclipIssueStatus:'blocked' },
});

export const TASK_BLOCKED_STATUSES = Object.freeze(
  TASK_STATUSES.filter((status) => BLOCKED_STATUS_SET.has(status)),
);

export const TASK_STATUS_POLICIES = Object.freeze(Object.fromEntries(
  TASK_STATUSES.map((status) => {
    const detail = STATUS_DETAILS[status];
    if (!detail) throw new Error(`任务状态策略缺少状态：${status}`);
    return [status, Object.freeze({
      status,
      label:detail.label,
      terminal:TERMINAL_STATUS_SET.has(status),
      blocked:BLOCKED_STATUS_SET.has(status),
      notificationTerminal:NOTIFICATION_TERMINAL_STATUS_SET.has(status),
      executionClosed:EXECUTION_CLOSED_STATUS_SET.has(status),
      taskCardTerminal:TASK_CARD_TERMINAL_STATUS_SET.has(status),
      attentionPriority:detail.attentionPriority,
      paperclipIssueStatus:detail.paperclipIssueStatus,
      paperclipCompletionEligible:PAPERCLIP_COMPLETION_STATUS_SET.has(status),
    })];
  }),
));

export function taskStatusPolicy(status) {
  const value = String(status || '').trim();
  return TASK_STATUS_POLICIES[value] || Object.freeze({
    status:value || 'unknown',
    label:value || '未知',
    terminal:false,
    blocked:false,
    notificationTerminal:false,
    executionClosed:false,
    taskCardTerminal:false,
    attentionPriority:8,
    paperclipIssueStatus:'backlog',
    paperclipCompletionEligible:false,
  });
}

export function taskOutcomePolicy(outcome, { hasUsableArtifact = false } = {}) {
  const value = String(outcome || '').trim();
  const projection = DELIVERY_OUTCOME_PROJECTIONS[value] || [null, WORKFLOW_OUTCOME_STATUS_SET.has(value) ? value : 'running', null];
  const workflowStatus = value === 'delivery_quality_stopped' && hasUsableArtifact ? 'partial' : projection[1];
  const ownerActionable = workflowStatus === 'waiting_acceptance';
  return Object.freeze({
    outcome:value || 'running',
    taskStatus:projection[0],
    executionOutcome:projection[2],
    workflowStatus,
    ownerAction:ownerActionable ? ACCEPTANCE_OWNER_ACTION : null,
    ownerActionable,
  });
}

export function workflowStatusForTaskOutcome({
  taskStatus,
  verified = false,
  partial = false,
  requiresAcceptance = false,
  humanAccepted = false,
  recoveryPending = false,
} = {}) {
  if (verified && requiresAcceptance && !humanAccepted) return 'waiting_acceptance';
  if (verified) return partial ? 'partial' : 'succeeded';
  if (taskStatus === 'needs_input' || taskStatus === 'waiting_approval') return 'waiting_user';
  if (recoveryPending) return 'recovering';
  if (TERMINAL_FAILURE_TASK_STATUS_SET.has(taskStatus)) return taskStatus === 'cancelled' ? 'cancelled' : 'failed';
  if (taskStatus === 'waiting_test' || taskStatus === 'succeeded') return 'waiting_validation';
  if (taskStatus === 'received') return 'received';
  return taskStatus === 'queued' ? 'planning' : 'running';
}

export function workflowStatusForStepOutcomes(steps, {
  requiredStepsComplete = false,
  humanAcceptanceRequired = false,
  humanAccepted = false,
} = {}) {
  const has = (status, required = false) => steps.some((step) => step.status === status && (!required || step.required));
  if (has('recovering')) return 'recovering';
  if (has('waiting_user')) return 'waiting_user';
  if (has('failed', true)) return 'failed';
  if (has('cancelled', true)) return 'cancelled';
  if (!requiredStepsComplete) {
    if (has('running')) return 'running';
    return has('planning') ? 'planning' : 'waiting_validation';
  }
  if (has('partial')) return 'partial';
  return humanAcceptanceRequired && !humanAccepted ? 'waiting_acceptance' : 'succeeded';
}

export function ownerActionForWorkflowOutcome(steps, status) {
  const blocked = steps.find((step) => step.status === 'waiting_user');
  if (blocked) {
    return blocked.failureCode
      ? `处理步骤 ${blocked.stepId} 的 ${blocked.failureCode}`
      : `补充步骤 ${blocked.stepId} 所需信息`;
  }
  return taskOutcomePolicy(status).ownerAction;
}

export const isTaskTerminalStatus = (status) => taskStatusPolicy(status).terminal;
export const isTaskBlockedStatus = (status) => taskStatusPolicy(status).blocked;
export const isTaskNotificationTerminalStatus = (status) => taskStatusPolicy(status).notificationTerminal;
export const isTaskExecutionClosedStatus = (status) => taskStatusPolicy(status).executionClosed;
export const isTaskCardTerminalStatus = (status) => taskStatusPolicy(status).taskCardTerminal;

export function taskStatusLabel(status) {
  if (status === 'planned') return '待开始';
  return taskStatusPolicy(status).label;
}

export const taskStatusPriority = (status) => taskStatusPolicy(status).attentionPriority;
export const paperclipIssueStatusForTaskStatus = (status) => taskStatusPolicy(status).paperclipIssueStatus;
export const isPaperclipCompletionTaskStatus = (status) => taskStatusPolicy(status).paperclipCompletionEligible;

export function taskLifecycleEventPolicy(status) {
  const policy = taskStatusPolicy(status);
  return Object.freeze({
    eventType:status === 'succeeded'
      ? 'workflow_completed'
      : policy.blocked
        ? 'workflow_blocked'
        : 'workflow_state_changed',
    retentionClass:status === 'succeeded' || policy.blocked ? 'audit' : 'transient',
  });
}
