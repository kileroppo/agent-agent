import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalSpecError, normalizeGoalSpec } from '../src/goal-spec.ts';

test('目标规范会形成稳定契约，并且只能缩小调用方授予的权限', () => {
  const goal = normalizeGoalSpec({
    goalId:'campaign-1',
    objective:'完成一次有证据的内容调研',
    deliverables:['研究报告', '来源清单', '研究报告'],
    constraints:['不发送外部消息'],
    acceptanceCriteria:['每条结论都有来源'],
    priority:'high',
    requestedPermissions:['public-web:read']
  }, {
    allowedPermissions:['public-web:read', 'workspace:read'],
    now:'2026-07-29T10:00:00.000Z'
  });

  assert.deepEqual(goal, {
    schemaVersion:'agent.army/goal-spec/v1',
    goalId:'campaign-1',
    objective:'完成一次有证据的内容调研',
    deliverables:['研究报告', '来源清单'],
    constraints:['不发送外部消息'],
    acceptanceCriteria:['每条结论都有来源'],
    priority:'high',
    requestedPermissions:['public-web:read'],
    createdAt:'2026-07-29T10:00:00.000Z'
  });

  assert.throws(
    () => normalizeGoalSpec({
      goalId:'campaign-2',
      objective:'发布内容',
      deliverables:['发布结果'],
      acceptanceCriteria:['平台可见'],
      requestedPermissions:['external:write']
    }, { allowedPermissions:['public-web:read'] }),
    (error) => error instanceof GoalSpecError && error.code === 'permission_expansion'
  );
});

test('目标规范拒绝任何嵌套敏感字段或凭据文本', () => {
  const base = {
    goalId:'safe-goal',
    objective:'只处理脱敏信息',
    deliverables:['脱敏报告'],
    acceptanceCriteria:['报告不含凭据']
  };
  assert.throws(
    () => normalizeGoalSpec({ ...base, context:{ apiKey:'should-never-enter-a-task' } }),
    (error) => error instanceof GoalSpecError && error.code === 'sensitive_data_rejected'
  );
  assert.throws(
    () => normalizeGoalSpec({ ...base, constraints:['访问 https://example.test?a=1&token=should-not-be-here'] }),
    (error) => error instanceof GoalSpecError && error.code === 'sensitive_data_rejected'
  );
});
