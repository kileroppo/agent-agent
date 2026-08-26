import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFault,
  TaskRecoveryBudgetGovernor,
} from '../src/task-recovery-budget-governor.ts';

test('classifyFault 准确分类四类故障', () => {
  assert.equal(classifyFault({ status: 401 }).category, 'missing_credential');
  assert.equal(classifyFault(new Error('bilibili cookie expired')).category, 'missing_credential');
  assert.equal(classifyFault({ code: 'ECONNREFUSED' }).category, 'service_offline');
  assert.equal(classifyFault({ status: 429 }).category, 'transient_retryable');
  assert.equal(classifyFault(new Error('Rate limit exceeded')).category, 'transient_retryable');
  assert.equal(classifyFault(new Error('Invalid arguments provided')).category, 'fatal_non_retryable');
});

test('TaskRecoveryBudgetGovernor 针对瞬时错误在预算内允许重试并在超限时熔断', () => {
  let now = 1000000;
  const governor = new TaskRecoveryBudgetGovernor({
    maxRetriesPerHour: 2,
    windowMs: 3600_000,
    now: () => now,
  });

  const err = { status: 429 };

  // 1. 首次重试 -> 允许 (剩余 2)
  const eval1 = governor.evaluateRecovery('task-100', err, now);
  assert.equal(eval1.allowed, true);
  assert.equal(eval1.remainingBudget, 2);
  governor.recordRetry('task-100', now);

  // 2. 第二次重试 -> 允许 (剩余 1)
  const eval2 = governor.evaluateRecovery('task-100', err, now + 1000);
  assert.equal(eval2.allowed, true);
  assert.equal(eval2.remainingBudget, 1);
  governor.recordRetry('task-100', now + 1000);

  // 3. 第三次重试 -> 超出预算，熔断
  const eval3 = governor.evaluateRecovery('task-100', err, now + 2000);
  assert.equal(eval3.allowed, false);
  assert.ok(eval3.reason.includes('最大重试上限'));

  // 4. 1 小时后窗口滑动 -> 恢复重试资格
  now += 3600_000 + 10;
  const eval4 = governor.evaluateRecovery('task-100', err, now);
  assert.equal(eval4.allowed, true);
});

test('TaskRecoveryBudgetGovernor 遇到缺凭据或致命错误直接禁止自动重试', () => {
  const governor = new TaskRecoveryBudgetGovernor();
  const res = governor.evaluateRecovery('task-200', { status: 403 });
  assert.equal(res.allowed, false);
  assert.equal(res.category, 'missing_credential');
  assert.ok(res.recommendedAction.includes('更新平台 Cookie/Token'));
});
