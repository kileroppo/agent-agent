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

export function isTaskTerminalStatus(status) {
  return taskStatusPolicy(status).terminal;
}

export function isTaskBlockedStatus(status) {
  return taskStatusPolicy(status).blocked;
}

export function isTaskNotificationTerminalStatus(status) {
  return taskStatusPolicy(status).notificationTerminal;
}

export function isTaskExecutionClosedStatus(status) {
  return taskStatusPolicy(status).executionClosed;
}

export function isTaskCardTerminalStatus(status) {
  return taskStatusPolicy(status).taskCardTerminal;
}

export function taskStatusLabel(status) {
  if (status === 'planned') return '待开始';
  return taskStatusPolicy(status).label;
}

export function taskStatusPriority(status) {
  return taskStatusPolicy(status).attentionPriority;
}

export function paperclipIssueStatusForTaskStatus(status) {
  return taskStatusPolicy(status).paperclipIssueStatus;
}

export function isPaperclipCompletionTaskStatus(status) {
  return taskStatusPolicy(status).paperclipCompletionEligible;
}

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
