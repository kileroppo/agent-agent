import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalReviewer } from '../src/local-reviewer.js';

test('审核官只给出需要所有者决定的结论，不做最终授权或外部动作', async () => {
  const reviewer = new LocalReviewer({ now: () => new Date('2026-07-20T09:00:00.000Z') });
  const result = await reviewer.execute({ taskId: 'task-1', input: { title: '审核发布计划', description: '范围：一个内部草稿；有效期：今天。' }, execution: {} });
  const report = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(report.riskCategories, ['publish']);
  assert.equal(report.recommendation, 'human_owner_decision_required');
  assert.equal(report.finalDecisionMade, false);
  assert.equal(report.externalActionStarted, false);
});

test('审核官要求补齐范围，而不是把缺少说明的请求视为通过', async () => {
  const reviewer = new LocalReviewer();
  const result = await reviewer.execute({ taskId: 'task-2', input: { title: '审核外发', description: '' }, execution: {} });
  assert.equal(result.artifactRefs[0].data.recommendation, 'needs_scope_before_owner_decision');
});
