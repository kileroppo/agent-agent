import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileUsageBilling, recordTaskUsage, summarizeTaskUsage } from '../src/task-usage.ts';

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

test('工作使用汇总按起止时间排除范围外任务', () => {
  const task = (taskId, recordedAt) => ({
    taskId,
    usage:{ schemaVersion:'agent.army/task-usage/v1', recordedAt, model:{ status:'reported', apiCalls:1 } },
  });
  const summary = summarizeTaskUsage([
    task('before', '2026-08-15T23:59:59.000Z'),
    task('inside', '2026-08-16T08:00:00.000Z'),
    task('after', '2026-08-17T00:00:00.000Z'),
  ], { since:new Date('2026-08-16T00:00:00.000Z'), until:new Date('2026-08-17T00:00:00.000Z') });
  assert.equal(summary.taskCount, 1);
  assert.equal(summary.model.apiCalls, 1);
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
  assert.equal(tracked.cost.basis, 'task_usage_reported');
});

test('任务用量保留缓存、推理、重试和凭据别名，且不保存真实密钥', () => {
  const usage = recordTaskUsage({
    task:{ taskId:'task-token-control', assigneeAgentId:'ajun' },
    result:{
      status:'succeeded',
      usage:{ model:{
        provider:'stepfun', model:'step-3.7-flash', apiCalls:2,
        inputTokens:100, outputTokens:20, cachedInputTokens:70, cacheWriteTokens:10,
        reasoningTokens:5, providerAttempts:3, rateLimitRejections:1,
        credentialAlias:'ajun-stepfun-primary', requestClass:'interactive', purpose:'用户任务分析',
        apiKey:'never-store-this-secret',
      } },
    },
    finishedAt:new Date('2026-08-16T08:00:00.000Z'),
  });
  const summary = summarizeTaskUsage([{ taskId:'task-token-control', usage }]);

  assert.deepEqual(usage.model, {
    status:'reported', provider:'stepfun', model:'step-3.7-flash',
    inputTokens:100, outputTokens:20, cacheReadTokens:70, cacheWriteTokens:10,
    reasoningTokens:5, apiCalls:2, providerAttempts:3, rateLimitRejections:1,
    credentialAlias:'ajun-stepfun-primary', requestClass:'interactive', purpose:'用户任务分析',
  });
  assert.equal(summary.model.totalTokens, 200);
  assert.equal(summary.model.providerAttempts, 3);
  assert.equal(summary.model.rateLimitRejections, 1);
  assert.equal(JSON.stringify(usage).includes('never-store-this-secret'), false);
  assert.equal('apiKey' in usage.model, false);
});

test('Hermes 估算费用保留估算依据，只有 apiCalls 也不会漏报模型调用', () => {
  const usage = recordTaskUsage({
    result:{
      status:'succeeded',
      usage:{
        model:{
          provider:'deepseek',
          model:'deepseek-v4-flash',
          apiCalls:1,
          cost:{
            amount:0.004501,
            currency:'USD',
            basis:'estimated',
            source:'hermes_estimated_cost_usd',
          },
        },
      },
    },
    startedAt:new Date('2026-08-10T06:21:00.000Z'),
    finishedAt:new Date('2026-08-10T06:22:00.000Z'),
  });

  assert.equal(usage.model.status, 'reported');
  assert.equal(usage.model.provider, 'deepseek');
  assert.equal(usage.model.apiCalls, 1);
  assert.equal(usage.cost.status, 'reported');
  assert.equal(usage.cost.amount, 0.004501);
  assert.equal(usage.cost.basis, 'estimated');
  assert.equal(usage.cost.source, 'hermes_estimated_cost_usd');
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

test('账单优先按 Hermes 会话绑定 Workflow，并区分系统与独立 Agent 会话', () => {
  const usage = recordTaskUsage({
    task:{
      taskId:'task-workflow', assigneeAgentId:'video-content-analyst',
      workflow:{ workflowId:'workflow:content', step:{ stepId:'step:analysis' } },
      source:{ channel:'feishu' },
    },
    result:{
      status:'succeeded',
      usage:{ model:{ provider:'deepseek', model:'deepseek-v4-flash', sessionId:'session-task', inputTokens:10, outputTokens:5, apiCalls:1 } },
    },
    finishedAt:new Date('2026-08-10T08:00:00.000Z'),
  });
  const billing = reconcileUsageBilling([{ taskId:'task-workflow', assigneeAgentId:'video-content-analyst', workflow:{ workflowId:'workflow:content', step:{ stepId:'step:analysis' } }, source:{ channel:'feishu' }, usage }], {
    status:'ready', entries:[
      { ledgerRef:'task-ledger', agentId:'video-content-analyst', sessionId:'session-task', source:'cli', occurredAt:'2026-08-10T08:00:10.000Z', provider:'deepseek', model:'deepseek-v4-flash', apiCalls:2, tokens:{ input:99, output:88 } },
      { ledgerRef:'system-ledger', agentId:'operator', sessionId:'session-system', source:'routine', usageClass:'health', occurredAt:'2026-08-10T08:01:00.000Z', apiCalls:1, tokens:{} },
      { ledgerRef:'agent-ledger', agentId:'architect', sessionId:'session-agent', source:'tool', usageClass:'main', occurredAt:'2026-08-10T08:02:00.000Z', apiCalls:3, tokens:{} },
    ],
  });
  assert.deepEqual(billing.entries[0].attribution, {
    status:'task', taskId:'task-workflow', taskTitle:'未命名任务', taskRef:'#TASKWORK',
    workflowId:'workflow:content', stepId:'step:analysis', sourceChannel:'feishu',
  });
  assert.equal(billing.entries[1].attribution.status, 'system');
  assert.equal(billing.entries[2].attribution.status, 'agent_session');
  assert.equal(billing.attribution.taskEntryCount, 1);
  assert.equal(billing.attribution.systemEntryCount, 1);
  assert.equal(billing.attribution.agentSessionEntryCount, 1);
  assert.equal(billing.attribution.unattributedEntryCount, 0);
});

test('账单同时统计输入上下文归属、记忆写入、历史检索和预算硬停', () => {
  const billing = reconcileUsageBilling([{
    taskId:'task-efficiency',
    error:{ code:'max_turn_hard_stop' },
    usage:{
      schemaVersion:'agent.army/task-usage/v1',
      recordedAt:'2026-08-13T08:00:00.000Z',
      execution:{ executor:'ajun' },
      model:{ status:'not_reported' },
      tools:[{ id:'memory', calls:2 }, { id:'session_search', calls:3 }],
    },
  }], {
    status:'ready',
    entries:[
      { ledgerRef:'system', source:'routine', occurredAt:'2026-08-13T08:00:00.000Z', tokens:{ input:40 } },
      { ledgerRef:'unattributed', occurredAt:'2026-08-13T08:00:01.000Z', tokens:{ input:60 } },
    ],
  });

  assert.deepEqual(billing.efficiency.inputTokensByAttribution, {
    task:0,
    system:40,
    agent_session:0,
    unattributed:60,
  });
  assert.equal(billing.efficiency.memoryWriteCount, 2);
  assert.equal(billing.efficiency.sessionSearchCount, 3);
  assert.equal(billing.efficiency.budgetStopCount, 1);
  assert.equal(billing.efficiency.toolCountCoverage, 'task_usage_only');
});

test('账单明确声明只覆盖受管 Hermes，未核 Provider 总账时不能断言账号总量', () => {
  const billing = reconcileUsageBilling([], {
    status:'ready',
    totals:{ entryCount:0, sessionCount:0, apiCalls:0, tokens:{ input:0, output:0, cacheRead:0, cacheWrite:0, reasoning:0, total:0 } },
    entries:[],
  });

  assert.deepEqual(billing.coverage, {
    scope:'managed_hermes_profiles',
    providerAccountIncluded:false,
    externalClientsIncluded:false,
    canAssertAccountTotal:false,
    taskModelRecordsComplete:true,
    credentialAliasesComplete:true,
  });
  assert.equal(billing.providerReconciliation.status, 'not_configured');
  assert.equal(billing.providerReconciliation.providerApiCalls, null);
});

test('回填 Provider 总量后计算账外调用差额，不把差额伪装成已归属流水', () => {
  const billing = reconcileUsageBilling([], {
    status:'ready',
    totals:{ entryCount:0, sessionCount:0, apiCalls:0, tokens:{ input:0, output:0, cacheRead:0, cacheWrite:0, reasoning:0, total:0 } },
    entries:[],
  }, {
    providerSnapshot:{
      status:'ready', provider:'stepfun', source:'provider_console', observedAt:'2026-08-16T12:00:00Z',
      totals:{ apiCalls:827, tokens:{ total:27_781_756 } },
    },
  });

  assert.equal(billing.entries.length, 0);
  assert.deepEqual(billing.providerReconciliation, {
    status:'gap', provider:'stepfun', source:'provider_console', observedAt:'2026-08-16T12:00:00.000Z',
    managedApiCalls:0, providerApiCalls:827, apiCallDifference:827, untrackedApiCalls:827,
    managedTokens:0, providerTokens:27_781_756, tokenDifference:27_781_756, untrackedTokens:27_781_756,
  });
  assert.equal(billing.coverage.providerAccountIncluded, true);
  assert.equal(billing.coverage.externalClientsIncluded, true);
  assert.equal(billing.coverage.canAssertAccountTotal, false);
});
