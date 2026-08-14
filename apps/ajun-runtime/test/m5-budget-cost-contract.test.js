import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertM5BudgetCoverage,
  createM5CostEventDraft,
} from '../src/m5-budget-cost-contract.ts';

const ids = Object.freeze({
  company:'11111111-1111-4111-8111-111111111111',
  agent:'22222222-2222-4222-8222-222222222222',
  project:'33333333-3333-4333-8333-333333333333',
  issue:'44444444-4444-4444-8444-444444444444',
  run:'55555555-5555-4555-8555-555555555555',
});

test('每笔M5付费动作必须同时被公司、岗位和Project预算覆盖', () => {
  const accepted = assertM5BudgetCoverage({
    overview:{ policies:budgetPolicies() },
    companyId:ids.company,
    agentId:ids.agent,
    projectId:ids.project,
    maximumCostCents:3,
  });
  assert.deepEqual(accepted.map((item) => item.scopeType), ['company', 'agent', 'project']);
});

test('缺任一预算、非硬停、暂停或余额不足都失败关闭', () => {
  for (const mutate of [
    (rows) => rows.filter((item) => item.scopeType !== 'company'),
    (rows) => rows.filter((item) => item.scopeType !== 'agent'),
    (rows) => rows.filter((item) => item.scopeType !== 'project'),
    (rows) => rows.map((item) => item.scopeType === 'agent' ? { ...item, hardStopEnabled:false } : item),
    (rows) => rows.map((item) => item.scopeType === 'project' ? { ...item, paused:true } : item),
    (rows) => rows.map((item) => item.scopeType === 'company' ? { ...item, remainingAmount:2 } : item),
  ]) {
    assert.throws(() => assertM5BudgetCoverage({
      overview:{ policies:mutate(budgetPolicies()) },
      companyId:ids.company,
      agentId:ids.agent,
      projectId:ids.project,
      maximumCostCents:3,
    }), { code:'paperclip_budget_insufficient' });
  }
});

test('内容插件和真实Publisher费用草稿都映射到Paperclip核心cost_event字段', () => {
  const plugin = createM5CostEventDraft({
    producer:'content-plugin',
    actionId:'campaign:vision:1',
    source:{
      kind:'provider-usage',
      receiptChecksum:`sha256:${'a'.repeat(64)}`,
    },
    runContext:runContext(),
    cost:cost({
      provider:'stepfun',
      biller:'stepfun',
      billingCode:'m5:vision',
      model:'step-1o-turbo-vision',
    }),
  });
  const publisher = createM5CostEventDraft({
    producer:'publisher',
    actionId:'campaign:douyin:publish:1',
    source:{
      kind:'publisher-receipt',
      receiptChecksum:`sha256:${'b'.repeat(64)}`,
      connectorMode:'real:douyin_official_api',
    },
    runContext:runContext(),
    cost:cost({
      provider:'douyin',
      biller:'douyin',
      billingCode:'m5:publisher:video',
      model:'douyin-publish-video',
    }),
  });

  for (const draft of [plugin, publisher]) {
    assert.equal(draft.event.agentId, ids.agent);
    assert.equal(draft.event.issueId, ids.issue);
    assert.equal(draft.event.projectId, ids.project);
    assert.equal(draft.event.heartbeatRunId, ids.run);
    assert.equal(draft.event.costCents, 3);
    assert.equal(Object.hasOwn(draft.event, 'accountRef'), false);
    assert.equal(Object.hasOwn(draft.event, 'prompt'), false);
  }
});

test('Fake Publisher、零费用、未知生产方和夹带自由字段不生成真实费用事件', () => {
  const publisherInput = {
    producer:'publisher',
    actionId:'campaign:douyin:publish:1',
    source:{
      kind:'publisher-receipt',
      receiptChecksum:`sha256:${'b'.repeat(64)}`,
      connectorMode:'fake',
    },
    runContext:runContext(),
    cost:cost({
      provider:'douyin',
      biller:'douyin',
      billingCode:'m5:publisher:video',
      model:'douyin-publish-video',
    }),
  };
  assert.throws(() => createM5CostEventDraft(publisherInput), { code:'cost_source_unverified' });
  assert.throws(() => createM5CostEventDraft({
    ...publisherInput,
    source:{ ...publisherInput.source, connectorMode:'real:douyin_official_api' },
    cost:{ ...publisherInput.cost, costCents:0 },
  }), { code:'cost_event_invalid' });
  assert.throws(() => createM5CostEventDraft({
    ...publisherInput,
    producer:'other',
  }), { code:'cost_producer_invalid' });
  assert.throws(() => createM5CostEventDraft({
    ...publisherInput,
    source:{ ...publisherInput.source, connectorMode:'real:douyin_official_api' },
    cost:{ ...publisherInput.cost, accessToken:'secret' },
  }), { code:'cost_event_extra_field' });
});

function budgetPolicies() {
  return [
    policy('company', ids.company),
    policy('agent', ids.agent),
    policy('project', ids.project),
  ];
}

function policy(scopeType, scopeId) {
  return {
    scopeType,
    scopeId,
    metric:'billed_cents',
    amount:30,
    observedAmount:0,
    remainingAmount:30,
    hardStopEnabled:true,
    isActive:true,
    status:'ok',
    paused:false,
  };
}

function runContext() {
  return {
    companyId:ids.company,
    agentId:ids.agent,
    issueId:ids.issue,
    projectId:ids.project,
    runId:ids.run,
  };
}

function cost(overrides) {
  return {
    billingType:'metered_api',
    inputTokens:0,
    cachedInputTokens:0,
    outputTokens:0,
    costCents:3,
    occurredAt:'2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}
