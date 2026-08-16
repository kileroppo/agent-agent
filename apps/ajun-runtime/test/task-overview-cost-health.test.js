import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskOverview } from '../src/task-overview.ts';

test('任务总览把 Hermes 账本健康结果附在同一份 billing 响应中', () => {
  const overview = new TaskOverview({
    registry:{},
    store:{},
    skillExecutionRegistry:{},
    usageLedger:{
      summarize() {
        return {
          status:'ready',
          period:{ since:'2026-08-01T00:00:00.000Z', until:'2026-08-08T00:00:00.000Z' },
          totals:{
            entryCount:1,
            sessionCount:1,
            apiCalls:20,
            tokens:{ input:9_000, output:10_000, cacheRead:1_000, cacheWrite:0, reasoning:8_000, total:28_000 },
            cost:{ knownUsd:0.1, actualEntryCount:1, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
          },
          profiles:[],
          entries:[],
          errors:[],
        };
      },
    },
  });

  const billing = overview.billing([], [], new Date('2026-08-01T00:00:00.000Z'));

  assert.equal(billing.status, 'ready');
  assert.equal(billing.health.schemaVersion, 'agent.army/hermes-cost-health/v1');
  assert.equal(billing.health.status, 'warning');
  assert.deepEqual(billing.health.alerts.map((alert) => alert.code), [
    'provider_total_not_reconciled',
    'low_cache_hit_ratio',
    'high_reasoning_output_ratio',
  ]);
});

test('账本不可读时仍返回 health 结构，但不会把未知费用写成零', () => {
  const overview = new TaskOverview({ registry:{}, store:{}, skillExecutionRegistry:{} });

  const billing = overview.billing([], [], new Date('2026-08-01T00:00:00.000Z'));

  assert.equal(billing.status, 'unavailable');
  assert.equal(billing.health.metrics.costStatus, 'unknown');
  assert.equal(billing.health.metrics.knownCostUsd, null);
});
