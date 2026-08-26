import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApprovalEscalationGovernor,
  evaluateApprovalEscalations,
} from '../src/approval-escalation-governor.ts';

test('evaluateApprovalEscalations 正确区分临期催办与已过期审批', () => {
  let now = 1700000000000;
  const approvals = [
    // 1. 正常远期 (5 小时后)
    {
      approvalId: 'app-1',
      taskId: 't-1',
      status: 'pending',
      action: '公开发布',
      validUntil: new Date(now + 5 * 3600_000).toISOString(),
    },
    // 2. 临期待催办 (30 分钟后)
    {
      approvalId: 'app-2',
      taskId: 't-2',
      status: 'pending',
      action: '大额付费',
      validUntil: new Date(now + 30 * 60_000).toISOString(),
    },
    // 3. 已过期 (10 分钟前)
    {
      approvalId: 'app-3',
      taskId: 't-3',
      status: 'pending',
      action: '删除数据',
      validUntil: new Date(now - 10 * 60_000).toISOString(),
    },
    // 4. 已处于终态的审批单 (忽略)
    {
      approvalId: 'app-4',
      taskId: 't-4',
      status: 'approved',
      action: '扩权',
      validUntil: new Date(now - 10 * 60_000).toISOString(),
    },
  ];

  const res = evaluateApprovalEscalations(approvals, {
    urgencyThresholdMs: 3600_000,
    now,
  });

  assert.equal(res.urgentReminders.length, 1);
  assert.equal(res.urgentReminders[0].approvalId, 'app-2');
  assert.equal(res.urgentReminders[0].remainingMinutes, 30);

  assert.equal(res.expiredApprovals.length, 1);
  assert.equal(res.expiredApprovals[0].approvalId, 'app-3');
});

test('ApprovalEscalationGovernor 自动熔断过期任务并触发催办回调', async () => {
  let now = 1700000000000;
  const updatedApprovals = [];
  const updatedTasks = [];
  const reminders = [];

  const fakeStore = {
    async listApprovals() {
      return [
        {
          approvalId: 'app-urgent',
          taskId: 'task-u',
          status: 'pending',
          action: '发布',
          validUntil: new Date(now + 20 * 60000).toISOString(),
        },
        {
          approvalId: 'app-expired',
          taskId: 'task-e',
          status: 'pending',
          action: '付费',
          validUntil: new Date(now - 5000).toISOString(),
        },
      ];
    },
    async updateApproval(id, patch) {
      updatedApprovals.push({ id, patch });
    },
    async getTask(taskId) {
      return { taskId, status: 'waiting_approval' };
    },
    async updateTask(taskId, patch) {
      updatedTasks.push({ taskId, patch });
    },
  };

  const governor = new ApprovalEscalationGovernor({
    store: fakeStore,
    onUrgentReminder: async (rem) => { reminders.push(rem); },
    now: () => now,
  });

  const result = await governor.reconcile({ now });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.urgentCount, 1);
  assert.equal(result.expiredCount, 1);

  assert.equal(updatedApprovals[0].patch.status, 'expired_cancelled');
  assert.equal(updatedTasks[0].patch.status, 'failed');
  assert.equal(updatedTasks[0].patch.currentStage, 'approval_expired');
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].approvalId, 'app-urgent');
});
