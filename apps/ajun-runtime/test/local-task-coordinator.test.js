import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTaskCoordinator } from '../src/local-task-coordinator.js';

test('协调官把带公开链接的素材请求建议给小D，且不发起外部动作', async () => {
  const coordinator = new LocalTaskCoordinator({ now: () => new Date('2026-07-20T08:00:00.000Z') });
  const result = await coordinator.execute({ taskId: 'task-1', createdAt: '2026-07-20T07:59:00.000Z', input: { title: '整理这个视频', description: '', sourceUrl: 'https://example.com/video' }, execution: {} });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'task_intake_record');
  assert.equal(result.artifactRefs[0].data.recommendedAgentId, 'xiaod');
  assert.equal(result.artifactRefs[0].data.externalActionStarted, false);
});

test('协调官不会把未知请求伪装成已路由', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-2', input: { title: '做一个新方向', description: '', sourceUrl: null }, execution: {} });
  assert.equal(result.artifactRefs[0].data.recommendedAgentId, null);
  assert.match(result.artifactRefs[0].data.nextAction, /没有唯一可执行岗位/);
});

test('协调官把审核和高风险描述交给审核官，只形成审查建议', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-3', input: { title: '审核发布范围', description: '', sourceUrl: null }, execution: {} });
  const record = result.artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.approval-review');
  assert.equal(record.recommendedAgentId, 'reviewer');
  assert.equal(record.externalActionStarted, false);
});

test('协调官把岗位能力评估交给架构师', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-4', input: { title: '评估现有岗位能力', description: '', sourceUrl: null }, execution: {} });
  const record = result.artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.architecture-review');
  assert.equal(record.recommendedAgentId, 'architect');
  assert.equal(record.externalActionStarted, false);
});
