import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackEvalDatasetService } from '../src/feedback-eval-dataset.ts';

test('FeedbackEvalDatasetService 自动从负向反馈任务提取脱敏案例', async () => {
  const service = new FeedbackEvalDatasetService();

  const task1 = {
    taskId: 'task-101',
    taskType: 'report.intel-research',
    input: { title: '调研竞品 Bearer secret_123456 手机 13812345678' },
    summary: '调研总结产物',
    feedback: {
      sentiment: 'needs_improvement',
      note: '分析不够深度，缺少海外市场对比',
    },
  };

  const case1 = service.recordFromTask(task1);
  assert.ok(case1);
  assert.equal(case1.caseId, 'eval-task-101');
  assert.equal(case1.inputPrompt.includes('secret_123456'), false);
  assert.equal(case1.inputPrompt.includes('138****0000'), true);
  assert.equal(case1.userFeedbackNote, '分析不够深度，缺少海外市场对比');

  // 正向反馈任务不入库
  const task2 = {
    taskId: 'task-102',
    feedback: { sentiment: 'useful' },
  };
  const case2 = service.recordFromTask(task2);
  assert.equal(case2, null);

  assert.equal(service.listCases().length, 1);
});

test('FeedbackEvalDatasetService 支持运行离线回测评估', async () => {
  const service = new FeedbackEvalDatasetService();
  service.recordFromTask({
    taskId: 'case-1',
    taskType: 'report.intel-research',
    input: { title: '小红书AI工具分析' },
    feedback: { sentiment: 'needs_improvement', note: '需要结构化表格' },
  });

  const benchmarkResult = await service.runOfflineBenchmark({
    executor: async (item) => ({ output: `关于 ${item.inputPrompt} 的优化版报告，包含完整对比表格` }),
    scoreEvaluator: async (output, item) => {
      const hasTable = output.includes('表格');
      return {
        passed: hasTable,
        score: hasTable ? 90 : 40,
        reason: hasTable ? '已补充表格' : '仍缺少表格',
      };
    },
  });

  assert.equal(benchmarkResult.totalCount, 1);
  assert.equal(benchmarkResult.passCount, 1);
  assert.equal(benchmarkResult.averageScore, 90);
  assert.equal(benchmarkResult.results[0].passed, true);
});
