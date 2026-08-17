import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../src/task-lifecycle.ts';
import * as taskStatusPolicyModule from '../src/task-status-policy.ts';
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
  ownerActionForWorkflowOutcome,
  taskOutcomePolicy,
  taskLifecycleEventPolicy,
  taskStatusLabel,
  taskStatusPolicy,
  taskStatusPriority,
  workflowStatusForStepOutcomes,
  workflowStatusForTaskOutcome,
} from '../src/task-status-policy.ts';

test('TypeScript声明完整覆盖运行时状态策略Interface', () => {
  const declaration = readFileSync(new URL('../src/task-status-policy.d.ts', import.meta.url), 'utf8');
  const declaredValues = [...new Set([...declaration.matchAll(/^export (?:const|function) ([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map((match) => match[1]))]
    .sort();
  assert.deepEqual(declaredValues, Object.keys(taskStatusPolicyModule).sort());
});

test('状态策略声明保留已知状态全覆盖，并把未知字符串隔离在运行时边界', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p', fileURLToPath(new URL('../typecheck-fixtures/task-status-policy.typecheck.json', import.meta.url)),
  ], { stdio:'pipe' });
});

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
  assert.strictEqual(taskStatusPolicy('running'), TASK_STATUS_POLICIES.running);
  assert.deepEqual(taskStatusPolicy(undefined), {
    status:'unknown', label:'未知', terminal:false, blocked:false,
    notificationTerminal:false, executionClosed:false, taskCardTerminal:false,
    attentionPriority:8, paperclipIssueStatus:'backlog', paperclipCompletionEligible:false,
  });
  assert.equal(Object.isFrozen(taskStatusPolicy('legacy_unknown_status')), true);
  assert.equal(taskStatusPolicy('legacy_unknown_status').label, 'legacy_unknown_status');
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

test('任务结果策略集中投影执行、任务、Workflow与负责人动作', () => {
  assert.deepEqual(taskOutcomePolicy('delivery_quality_review_start_failed'), {
    outcome:'delivery_quality_review_start_failed',
    taskStatus:'waiting_test',
    executionOutcome:'delivery_quality_review_start_failed',
    workflowStatus:'waiting_validation',
    ownerAction:null,
    ownerActionable:false,
  });
  assert.deepEqual(taskOutcomePolicy('delivery_quality_passed'), {
    outcome:'delivery_quality_passed',
    taskStatus:'succeeded',
    executionOutcome:'succeeded',
    workflowStatus:'waiting_acceptance',
    ownerAction:'验收已经生成的业务产物',
    ownerActionable:true,
  });
  assert.equal(taskOutcomePolicy('delivery_quality_stopped').workflowStatus, 'waiting_validation');
  assert.equal(taskOutcomePolicy('delivery_quality_stopped', { hasUsableArtifact:true }).workflowStatus, 'partial');
  assert.equal(taskOutcomePolicy('legacy_unknown_outcome').workflowStatus, 'running');
});

test('任务与步骤事实只通过结果策略派生Workflow状态和负责人动作', () => {
  assert.equal(workflowStatusForTaskOutcome({
    taskStatus:'succeeded', verified:true, requiresAcceptance:true,
  }), 'waiting_acceptance');
  assert.equal(workflowStatusForTaskOutcome({
    taskStatus:'succeeded', verified:true, partial:true,
  }), 'partial');
  assert.equal(workflowStatusForTaskOutcome({ taskStatus:'waiting_test' }), 'waiting_validation');
  assert.equal(workflowStatusForTaskOutcome({ taskStatus:'failed', recoveryPending:true }), 'recovering');
  assert.equal(workflowStatusForTaskOutcome({ taskStatus:'needs_input', recoveryPending:true }), 'waiting_user');
  assert.equal(workflowStatusForTaskOutcome({ taskStatus:'failed', verified:true }), 'succeeded');

  const steps = [{ stepId:'step-1', required:true, status:'partial', failureCode:null }];
  assert.equal(workflowStatusForStepOutcomes(steps, {
    requiredStepsComplete:true,
    humanAcceptanceRequired:true,
    humanAccepted:false,
  }), 'partial');
  assert.equal(ownerActionForWorkflowOutcome([], 'waiting_acceptance'), '验收已经生成的业务产物');
  assert.equal(ownerActionForWorkflowOutcome([{
    stepId:'step-input', status:'waiting_user', failureCode:'source_required',
  }], 'waiting_acceptance'), '处理步骤 step-input 的 source_required');
});
