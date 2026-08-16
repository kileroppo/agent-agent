import assert from 'node:assert/strict';
import test from 'node:test';

import { parseUsageRange, TaskOverview } from '../src/task-overview.ts';

test('用量日期范围要求完整、递增且不超过 366 天', () => {
  const parsed = parseUsageRange(new URL('/api/usage?since=2026-08-15T16%3A00%3A00.000Z&until=2026-08-16T16%3A00%3A00.000Z', 'http://127.0.0.1'));
  assert.equal(parsed.since.toISOString(), '2026-08-15T16:00:00.000Z');
  assert.equal(parsed.until.toISOString(), '2026-08-16T16:00:00.000Z');
  assert.throws(() => parseUsageRange(new URL('/api/usage?since=2026-08-16T00:00:00.000Z', 'http://127.0.0.1')), /完整/);
  assert.throws(() => parseUsageRange(new URL('/api/usage?since=2026-08-17T00:00:00.000Z&until=2026-08-16T00:00:00.000Z', 'http://127.0.0.1')), /晚于/);
});

test('日期查询和首页使用同一组正式岗位，包含 A君管理岗用量', async () => {
  let selectedAgentIds = [];
  const overview = new TaskOverview({
    registry:{
      list:async () => [{ agentId:'operator', executionOwner:'paperclip-hermes' }],
      get:async (agentId) => agentId === 'ajun'
        ? { agentId:'ajun', executionOwner:'paperclip-hermes' }
        : null,
    },
    store:{ list:async () => [] },
    skillExecutionRegistry:{},
    usageLedger:{
      summarize:({ agentIds }) => {
        selectedAgentIds = agentIds;
        return {
          status:'ready', period:{}, totals:{}, profiles:[], entries:[],
          truncatedEntryCount:0, unavailableProfiles:[], limitations:[],
        };
      },
    },
  });

  await overview.usage({
    since:new Date('2026-08-10T00:00:00.000Z'),
    until:new Date('2026-08-17T00:00:00.000Z'),
  });

  assert.deepEqual(selectedAgentIds, ['operator', 'ajun']);
});

test('Provider 总账适配器使用同一日期范围并把账外调用交给健康策略', async () => {
  let providerRange = null;
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{ list:async () => [] },
    skillExecutionRegistry:{},
    usageLedger:{ summarize:() => ({
      status:'ready', period:{}, totals:{ apiCalls:0, tokens:{ total:0 }, cost:{} }, profiles:[], entries:[],
    }) },
    providerUsageLedger:{ summarize:(range) => {
      providerRange = range;
      return { status:'ready', provider:'stepfun', source:'provider_api', totals:{ apiCalls:827, tokens:{ total:27_781_756 } } };
    } },
  });
  const since = new Date('2026-08-16T00:00:00.000Z');
  const until = new Date('2026-08-17T00:00:00.000Z');
  const usage = await overview.usage({ since, until });

  assert.deepEqual(providerRange, { since, until });
  assert.equal(usage.billing.providerReconciliation.untrackedApiCalls, 827);
  assert.equal(usage.billing.health.alerts[0].code, 'provider_usage_gap');
});
