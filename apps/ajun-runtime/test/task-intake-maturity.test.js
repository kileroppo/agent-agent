import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskIntake } from '../src/task-intake.ts';

test('产品成熟度总任务在 intake 阶段验签后不投影 Paperclip', async () => {
  const task = {
    taskId:'maturity-root-intake',
    taskType:'army.cross-agent-mission',
    assigneeAgentId:'ajun',
    status:'queued',
  };
  let projections = 0;
  const intake = new TaskIntake({
    registry:{},
    store:{},
    governance:{ async project() { projections += 1; return { paperclipIssueId:'forbidden' }; } },
    execute:async () => task,
  });
  intake.maturityExecutionGuard = {
    async verifyOrBlock(input) {
      assert.equal(input, task);
      return { executionMode:'mission_plan' };
    },
  };
  const result = await intake.projectGovernance(task, {
    agentId:'ajun', executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile' },
  });
  assert.equal(result, task);
  assert.equal(projections, 0);
});

test('产品成熟度 intake 验签阻断不会继续投影治理控制面', async () => {
  const task = { taskId:'maturity-child-intake', taskType:'content.video-script-package' };
  let projections = 0;
  const blockedTask = { ...task, status:'waiting_test' };
  const intake = new TaskIntake({
    registry:{}, store:{},
    governance:{ async project() { projections += 1; return {}; } },
    execute:async () => task,
  });
  intake.maturityExecutionGuard = {
    async verifyOrBlock() {
      const error = new Error('验签失败');
      error.blockedTask = blockedTask;
      throw error;
    },
  };
  await assert.rejects(() => intake.projectGovernance(task, { agentId:'content-creator' }), /验签失败/);
  assert.equal(projections, 0);
});
