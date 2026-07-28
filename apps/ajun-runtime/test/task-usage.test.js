import assert from 'node:assert/strict';
import test from 'node:test';
import { recordTaskUsage, summarizeTaskUsage } from '../src/task-usage.js';

test('工作使用记录只汇总实际报告的本机调用，不虚构模型或费用', () => {
  const usage = recordTaskUsage({
    task:{ assigneeAgentId:'public-reporter' },
    result:{ status:'succeeded', execution:{ executor:'public-reporter', outcome:'report_ready' }, usage:{ tools:[{ id:'public-web-fetch', name:'公开网页读取', calls:1 }] } },
    startedAt:new Date('2026-07-22T08:00:00.000Z'), finishedAt:new Date('2026-07-22T08:00:01.500Z')
  });
  assert.equal(usage.execution.durationMs, 1500);
  assert.deepEqual(usage.tools, [{ id:'public-web-fetch', name:'公开网页读取', calls:1 }]);
  assert.equal(usage.model.status, 'not_reported');
  assert.equal(usage.cost.status, 'not_reported');
});

test('只有执行方实际返回的模型和费用数据才允许进入汇总', () => {
  const tracked = recordTaskUsage({
    result:{ status:'succeeded', execution:{ executor:'worker' }, usage:{ model:{ provider:'local', model:'demo', inputTokens:12, outputTokens:8, apiCalls:1, cost:{ amount:0.02, currency:'USD' } }, tools:[{ id:'worker-api', name:'本机工作接口', calls:2 }] } },
    startedAt:new Date('2026-07-22T08:00:00.000Z'), finishedAt:new Date('2026-07-22T08:00:01.000Z')
  });
  const summary = summarizeTaskUsage([{ usage:tracked, updatedAt:'2026-07-22T08:00:01.000Z' }], { since:new Date('2026-07-22T00:00:00.000Z') });
  assert.equal(summary.actualToolCalls, 2);
  assert.equal(summary.model.reportedTaskCount, 1);
  assert.equal(tracked.model.apiCalls, 1);
  assert.deepEqual(summary.cost.totals, [{ currency:'USD', amount:0.02 }]);
});
