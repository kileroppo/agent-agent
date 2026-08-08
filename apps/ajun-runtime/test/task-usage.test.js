import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileUsageBilling, recordTaskUsage, summarizeTaskUsage } from '../src/task-usage.js';

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
  assert.equal(summary.model.apiCalls, 1);
  assert.equal(summary.model.inputTokens, 12);
  assert.equal(summary.model.outputTokens, 8);
  assert.deepEqual(summary.cost.totals, [{ currency:'USD', amount:0.02 }]);
});

test('账单把完全一致的 Hermes 会话归到任务，其余调用明确列为未归属', () => {
  const usage = recordTaskUsage({
    task:{ taskId:'task-12345678', assigneeAgentId:'video-content-analyst', input:{ title:'拆解视频' } },
    result:{ status:'succeeded', usage:{ model:{ provider:'deepseek', model:'deepseek-v4-flash', inputTokens:12, outputTokens:8, apiCalls:1, cost:{ amount:0.02, currency:'USD' } } } },
    startedAt:new Date('2026-08-08T08:00:00.000Z'),
    finishedAt:new Date('2026-08-08T08:01:00.000Z'),
  });
  const task = { taskId:'task-12345678', assigneeAgentId:'video-content-analyst', input:{ title:'拆解视频' }, usage };
  const ledger = {
    status:'ready',
    period:{ since:'2026-08-08T00:00:00.000Z', until:'2026-08-08T09:00:00.000Z' },
    totals:{ entryCount:2, sessionCount:2, apiCalls:3, tokens:{ input:32, output:18, cacheRead:0, cacheWrite:0, reasoning:0, total:50 }, cost:{ knownUsd:0.03 } },
    profiles:[],
    entries:[
      { ledgerRef:'match', agentId:'video-content-analyst', occurredAt:'2026-08-08T08:00:30.000Z', provider:'deepseek', model:'deepseek-v4-flash', apiCalls:1, tokens:{ input:12, output:8 }, cost:{ status:'estimated', amountUsd:0.02 } },
      { ledgerRef:'other', agentId:'ajun', occurredAt:'2026-08-08T08:05:00.000Z', provider:'deepseek', model:'deepseek-v4-flash', apiCalls:2, tokens:{ input:20, output:10 }, cost:{ status:'estimated', amountUsd:0.01 } },
    ],
  };

  const billing = reconcileUsageBilling([task], ledger, { since:new Date('2026-08-08T00:00:00.000Z') });
  assert.equal(billing.attribution.attributedEntryCount, 1);
  assert.equal(billing.attribution.unattributedEntryCount, 1);
  assert.equal(billing.entries[0].attribution.taskId, 'task-12345678');
  assert.equal(billing.entries[1].attribution.status, 'unattributed');
  assert.equal(billing.taskEntries[0].ledgerRef, 'match');
});
