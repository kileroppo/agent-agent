import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCostEventSchema,
  upsertBudgetPolicySchema,
} from '@paperclipai/shared';
import {
  createM5CostEventDraft,
} from '../../../../apps/ajun-runtime/src/m5-budget-cost-contract.ts';

const ids = Object.freeze({
  company:'11111111-1111-4111-8111-111111111111',
  agent:'22222222-2222-4222-8222-222222222222',
  project:'33333333-3333-4333-8333-333333333333',
  issue:'44444444-4444-4444-8444-444444444444',
  run:'55555555-5555-4555-8555-555555555555',
});

test('公司、岗位和Project预算契约都使用Paperclip原生policy schema且不执行live写入', () => {
  const policies = [
    ['company', ids.company],
    ['agent', ids.agent],
    ['project', ids.project],
  ].map(([scopeType, scopeId]) => upsertBudgetPolicySchema.parse({
    scopeType,
    scopeId,
    metric:'billed_cents',
    windowKind:'lifetime',
    amount:625,
    warnPercent:80,
    hardStopEnabled:true,
    notifyEnabled:true,
    isActive:true,
  }));

  assert.deepEqual(policies.map((item) => item.scopeType), ['company', 'agent', 'project']);
  assert.ok(policies.every((item) => item.hardStopEnabled));
});

test('内容插件与Publisher真实费用草稿都可被Paperclip核心cost_event schema接收', () => {
  const common = {
    actionId:'campaign:billable:1',
    runContext:{
      companyId:ids.company,
      agentId:ids.agent,
      issueId:ids.issue,
      projectId:ids.project,
      runId:ids.run,
    },
  };
  const drafts = [
    createM5CostEventDraft({
      ...common,
      producer:'content-plugin',
      source:{
        kind:'provider-usage',
        receiptChecksum:`sha256:${'a'.repeat(64)}`,
      },
      cost:cost('stepfun', 'm5:vision', 'step-1o-turbo-vision'),
    }),
    createM5CostEventDraft({
      ...common,
      producer:'publisher',
      source:{
        kind:'publisher-receipt',
        receiptChecksum:`sha256:${'b'.repeat(64)}`,
        connectorMode:'real:douyin_official_api',
      },
      cost:cost('douyin', 'm5:publisher:video', 'douyin-publish-video'),
    }),
  ];

  for (const draft of drafts) {
    const parsed = createCostEventSchema.parse(draft.event);
    assert.equal(parsed.agentId, ids.agent);
    assert.equal(parsed.issueId, ids.issue);
    assert.equal(parsed.projectId, ids.project);
    assert.equal(parsed.heartbeatRunId, ids.run);
    assert.equal(parsed.costCents, 3);
  }
});

function cost(provider, billingCode, model) {
  return {
    provider,
    biller:provider,
    billingType:'metered_api',
    billingCode,
    model,
    inputTokens:0,
    cachedInputTokens:0,
    outputTokens:0,
    costCents:3,
    occurredAt:'2026-07-30T00:00:00.000Z',
  };
}
