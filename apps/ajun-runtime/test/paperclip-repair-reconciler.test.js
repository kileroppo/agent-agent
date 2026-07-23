import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipRepairReconciler } from '../src/paperclip-repair-reconciler.js';

function setup({ issue, products = [], issueError = null }) {
  let task = { taskId:'repair-1', taskType:'operations.technical-repair', status:'running', currentStage:'paperclip_engineering_assigned', execution:{ executor:'technical-expert' }, artifactRefs:[], governance:{ paperclipIssueId:'issue-1', paperclipIssueIdentifier:'AGE-1', paperclipAssigneeAgentId:'agent-1' } };
  const store = { async list(){ return [task]; }, async updateTask(id, patch){ assert.equal(id, task.taskId); task = { ...task, ...patch }; return task; } };
  const governance = { async getPaperclipIssue(){ if (issueError) throw issueError; return issue; }, async getIssueWorkProducts(){ return products; } };
  return { get task(){ return task; }, reconciler:new PaperclipRepairReconciler({ store, governance, now:() => Date.parse('2026-07-21T13:00:00.000Z') }) };
}

test('有完整修改、测试和恢复证据时才确认技术修复完成', async () => {
  const fixture = setup({ issue:{ status:'done' }, products:[{ id:'product-1', status:'approved', url:'http://127.0.0.1/work/product-1', metadata:{ agentArmyRepairEvidence:{ changedFiles:['src/fix.js'], testsPassed:true, testSummary:'3 项通过', recoveryVerified:true, recoverySummary:'服务检查通过', remainingTests:['真实飞书回归'] } } }] });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'succeeded');
  assert.equal(fixture.task.currentStage, 'repair_verified');
  assert.equal(fixture.task.artifactRefs.at(-1).validation.testsPassed, true);
  assert.deepEqual(fixture.task.artifactRefs.at(-1).data.remainingTests, ['真实飞书回归']);
});

test('Paperclip 任务关闭但缺少证据时不会冒充修好', async () => {
  const fixture = setup({ issue:{ status:'done' }, products:[{ id:'product-1', status:'ready_for_review', metadata:{ agentArmyRepairEvidence:{ changedFiles:['src/fix.js'], testsPassed:true, recoveryVerified:true } } }] });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
  assert.equal(fixture.task.currentStage, 'repair_evidence_missing');
});

test('Paperclip 暂时不可用时保留任务并等待重查', async () => {
  const fixture = setup({ issueError:new Error('connect refused') });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
  assert.equal(fixture.task.currentStage, 'paperclip_repair_status_unavailable');
});

test('Paperclip 明确失败时如实记录失败', async () => {
  const fixture = setup({ issue:{ status:'blocked' } });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.currentStage, 'paperclip_repair_failed');
});
