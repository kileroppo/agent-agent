import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTaskService } from './support/task-service-fixture.js';

test('TaskFeedback 只记录已结束工作的人工验收结果', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push(
    { taskId:'done-1', status:'succeeded', input:{ title:'整理公开网页' } },
    { taskId:'running-1', status:'running', input:{ title:'正在整理公开视频' } },
  );
  const recorded = await service.recordFeedback('done-1', { sentiment:'needs_improvement', note:'  重点不够清楚  ' });
  assert.equal(recorded.status, 'succeeded');
  assert.equal(recorded.feedback.sentiment, 'needs_improvement');
  assert.equal(recorded.feedback.note, '重点不够清楚');
  assert.equal(recorded.evaluation.humanAcceptance.status, 'revision_required');
  assert.equal(recorded.evaluation.humanAcceptance.source, 'feishu_feedback');
  await assert.rejects(() => service.recordFeedback('running-1', { sentiment:'useful' }), /还没有结束/);
  await assert.rejects(() => service.recordFeedback('done-1', { sentiment:'unknown' }), /无效/);
});
