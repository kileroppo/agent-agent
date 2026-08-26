import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMissionPartialSuccess } from '../src/workflow/mission-partial-success.ts';

test('evaluateMissionPartialSuccess 全成时返回 succeeded 状态', () => {
  const plan = {
    subtasks: [
      { key: 'transcribe', title: '小D音视频转录' },
      { key: 'research', title: '小R背景调研' },
    ],
  };
  const children = [
    { key: 'transcribe', taskId: 't-1', status: 'succeeded', summary: '转录完成' },
    { key: 'research', taskId: 't-2', status: 'succeeded', summary: '研报完成' },
  ];

  const res = evaluateMissionPartialSuccess(children, plan);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.completedCount, 2);
  assert.equal(res.failedCount, 0);
});

test('evaluateMissionPartialSuccess 核心成功而辅助失败时返回 partial_success 并聚合可用成果', () => {
  const plan = {
    subtasks: [
      { key: 'transcribe', title: '小D音视频转录' },
      { key: 'research', title: '小R背景调研' },
      { key: 'pptx', title: '小办PPT生成' },
    ],
  };
  const children = [
    { key: 'transcribe', taskId: 't-1', status: 'succeeded', summary: '音视频转录完成' },
    { key: 'research', taskId: 't-2', status: 'succeeded', summary: '行业调研完成' },
    {
      key: 'pptx',
      taskId: 't-3',
      status: 'failed',
      error: { code: 'pptx_template_missing', message: '模板格式不兼容' },
    },
  ];

  const res = evaluateMissionPartialSuccess(children, plan);
  assert.equal(res.status, 'partial_success');
  assert.equal(res.completedCount, 2);
  assert.equal(res.failedCount, 1);
  assert.equal(res.succeededDeliverables.length, 2);
  assert.equal(res.failedItems.length, 1);
  assert.ok(res.summary.includes('部分交付'));
  assert.ok(res.summary.includes('小D音视频转录'));
  assert.ok(res.summary.includes('模板格式不兼容'));
});

test('evaluateMissionPartialSuccess 全部失败时返回 failed', () => {
  const plan = {
    subtasks: [{ key: 'task-a', title: '任务A' }],
  };
  const children = [{ key: 'task-a', taskId: 't-1', status: 'failed', error: { message: '不可达' } }];
  const res = evaluateMissionPartialSuccess(children, plan);
  assert.equal(res.status, 'failed');
  assert.equal(res.completedCount, 0);
  assert.equal(res.failedCount, 1);
});
