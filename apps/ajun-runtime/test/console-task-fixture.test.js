import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsoleTaskScenarioState } from './fixtures/console-task-scenarios.js';

test('控制台隔离夹具提供五种老板需要核对的任务状态', () => {
  const state = buildConsoleTaskScenarioState();

  assert.deepEqual(
    state.tasks.map((task) => task.status).sort(),
    ['failed', 'needs_input', 'succeeded', 'waiting_approval', 'waiting_test'],
  );
  const failed = state.tasks.find((task) => task.status === 'failed');
  assert.deepEqual(
    failed.artifactRefs.find((artifact) => artifact.type === 'employee_role_report').data,
    {
      agentId:'reviewer',
      summary:'登录授权缺少可用的 Chrome 会话，本轮无法完成只读验证。',
      evidence:'账号列表返回 0 个可用会话。',
      remainingRisks:'尚未验证小红书账号的真实读取能力。',
    },
  );
  const waitingApproval = state.tasks.find((task) => task.status === 'waiting_approval');
  assert.equal(state.approvals[0].taskId, waitingApproval.taskId);
  assert.equal(state.approvals[0].status, 'pending');
  assert.doesNotMatch(JSON.stringify(state), /cookie|token|password|secret/i);
});
