import assert from 'node:assert/strict';
import test from 'node:test';

import { TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../src/task-lifecycle.js';
import {
  TASK_BLOCKED_STATUSES,
  PAPERCLIP_COMPLETION_TASK_STATUSES,
  TASK_STATUS_POLICIES,
  isPaperclipCompletionTaskStatus,
  isTaskBlockedStatus,
  isTaskExecutionClosedStatus,
  isTaskNotificationTerminalStatus,
  isTaskTerminalStatus,
  paperclipIssueStatusForTaskStatus,
  taskLifecycleEventPolicy,
  taskStatusLabel,
  taskStatusPriority,
} from '../src/task-status-policy.js';

test('状态策略完整覆盖生命周期状态且终态只复用生命周期真相', () => {
  assert.deepEqual(Object.keys(TASK_STATUS_POLICIES), TASK_STATUSES);
  assert.deepEqual(
    TASK_STATUSES.filter(isTaskTerminalStatus),
    TERMINAL_TASK_STATUSES,
  );
  assert.deepEqual(TASK_BLOCKED_STATUSES, [
    'needs_input', 'paused', 'waiting_approval', 'waiting_test',
    'failed', 'cancelled', 'expired',
  ]);
  assert.equal(isTaskBlockedStatus('waiting_worker'), false);
  assert.equal(isTaskNotificationTerminalStatus('needs_input'), true);
  assert.equal(isTaskTerminalStatus('needs_input'), false);
  assert.equal(isTaskExecutionClosedStatus('waiting_test'), true);
  assert.equal(isTaskExecutionClosedStatus('running'), false);
});

test('中文标签、关注优先级和 Paperclip 映射由同一策略提供', () => {
  assert.equal(taskStatusLabel('waiting_approval'), '等待批准');
  assert.equal(taskStatusLabel('waiting_worker'), '等待 Mac工作间上线');
  assert.equal(taskStatusLabel('planned'), '待开始');
  assert.ok(taskStatusPriority('waiting_approval') < taskStatusPriority('running'));
  assert.equal(paperclipIssueStatusForTaskStatus('succeeded'), 'done');
  assert.equal(paperclipIssueStatusForTaskStatus('needs_input'), 'blocked');
  assert.equal(paperclipIssueStatusForTaskStatus('running'), 'backlog');
  assert.equal(isPaperclipCompletionTaskStatus('waiting_test'), true);
  assert.equal(isPaperclipCompletionTaskStatus('cancelled'), false);
  assert.deepEqual(PAPERCLIP_COMPLETION_TASK_STATUSES, ['succeeded', 'failed', 'waiting_test']);
});

test('生命周期运行事件按统一阻塞语义选择类型和留存等级', () => {
  assert.deepEqual(taskLifecycleEventPolicy('running'), {
    eventType:'workflow_state_changed', retentionClass:'transient',
  });
  assert.deepEqual(taskLifecycleEventPolicy('succeeded'), {
    eventType:'workflow_completed', retentionClass:'audit',
  });
  assert.deepEqual(taskLifecycleEventPolicy('cancelled'), {
    eventType:'workflow_blocked', retentionClass:'audit',
  });
});
