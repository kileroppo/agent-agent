import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityExecutionEngine } from '../src/workflow/capability-execution.ts';
import { createCapabilityEventRecorder } from '../src/workflow/capability-event-recorder.ts';

const request = {
  requestId:'request-route-1', workflowId:'workflow-route-1', stepId:'step-route-1',
  taskId:'task-route-1', agentId:'intel-researcher', capabilityId:'web.fetch',
  dataClass:'public', sideEffect:'read', maxCostUsd:1, costKnown:true,
  crossDevice:false, requiresCredentials:false,
};
const policy = {
  manifestCapabilities:['web.fetch'], taskBudgetUsd:1, agentApprovalThresholdUsd:1,
  projectBudgetRemainingUsd:10, companyBudgetRemainingUsd:10,
};

function route(routeId, invoke, extra = {}) {
  return { routeId, adapter:{ adapterId:`adapter-${routeId}`, invoke }, maxCostUsd:0, ...extra };
}

test('主路线确定失败后进入Plan B并生成完整路线凭证', async () => {
  const calls = [];
  const engine = new CapabilityExecutionEngine({
    routes:[
      route('primary', async () => { calls.push('primary'); throw Object.assign(new Error('down'), { code:'provider_unavailable' }); }),
      route('fallback', async () => { calls.push('fallback'); return { output:{ text:'ok' }, provider:'provider-b', costUsd:0.2 }; }),
    ],
    plan:{ primaryRouteId:'primary', fallbackRouteIds:['fallback'], maxRoutes:2 },
    now:() => new Date('2026-08-13T00:00:00.000Z'),
  });
  const result = await engine.invoke({ request, policy, payload:{ url:'https://example.com' } });
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.receipt.schemaVersion, 'agent.army/execution-receipt/v2');
  assert.equal(result.receipt.routeId, 'fallback');
  assert.equal(result.receipt.fallbackFrom, 'primary');
  assert.equal(result.receipt.outcome, 'success');
  assert.equal(result.receipt.totalAttempts, 2);
  assert.deepEqual(result.receipt.routeAttempts.map(({ routeId, outcome }) => ({ routeId, outcome })), [
    { routeId:'primary', outcome:'confirmed_failure' },
    { routeId:'fallback', outcome:'success' },
  ]);
});

test('结果未知时停止并在Error附带不可重复执行的失败凭证', async () => {
  let fallbackCalls = 0;
  const engine = new CapabilityExecutionEngine({ routes:[
    route('primary', async () => { throw Object.assign(new Error('status unknown'), { code:'provider_result_ambiguous', ambiguous:true }); }),
    route('fallback', async () => { fallbackCalls += 1; return { output:'duplicate', provider:'provider-b' }; }),
  ] });
  await assert.rejects(
    engine.invoke({ request, policy, payload:{ job:'paid-image' } }),
    (error) => {
      assert.equal(error.code, 'provider_result_ambiguous');
      assert.equal(error.failureKind, 'ambiguous_result');
      assert.equal(error.executionReceipt.outcome, 'ambiguous');
      assert.equal(error.executionReceipt.outputHash, null);
      assert.match(error.userMessage, /停止重复提交/);
      return true;
    },
  );
  assert.equal(fallbackCalls, 0);
});

test('预算、数据或副作用扩大的备用路线不会进入候选集', async () => {
  const calls = [];
  const engine = new CapabilityExecutionEngine({ routes:[
    route('primary', async () => { calls.push('primary'); throw Object.assign(new Error('down'), { code:'provider_unavailable' }); }, { maxCostUsd:0.1 }),
    route('over-budget', async () => { calls.push('over-budget'); return { output:'bad', provider:'paid' }; }, { maxCostUsd:2 }),
    route('private', async () => { calls.push('private'); return { output:'bad', provider:'private' }; }, { dataClass:'private' }),
    route('external-write', async () => { calls.push('write'); return { output:'bad', provider:'writer' }; }, { sideEffect:'external-write' }),
    route('safe', async () => { calls.push('safe'); return { output:'ok', provider:'public', costUsd:0.1 }; }, { maxCostUsd:0.1 }),
  ] });
  const result = await engine.invoke({ request, policy, payload:{ q:'public' }, routePlan:{
    primaryRouteId:'primary',
    fallbackRouteIds:['over-budget', 'private', 'external-write', 'safe'],
    maxRoutes:3,
  } });
  assert.deepEqual(calls, ['primary', 'safe']);
  assert.equal(result.receipt.routeId, 'safe');
});

test('认证失败既不恢复也不切换备用路线', async () => {
  let fallbackCalls = 0;
  const engine = new CapabilityExecutionEngine({ routes:[
    route('primary', async () => { throw Object.assign(new Error('expired'), { code:'credential_expired' }); }),
    route('fallback', async () => { fallbackCalls += 1; return { output:'bad', provider:'provider-b' }; }),
  ] });
  await assert.rejects(engine.invoke({ request, policy, payload:{} }), (error) => {
    assert.equal(error.failureKind, 'authentication_failed');
    assert.equal(error.executionReceipt.routeAttempts.length, 1);
    return true;
  });
  assert.equal(fallbackCalls, 0);
});

test('Plan B按最坏路线费用累计预留预算而不是逐条重复占满额度', async () => {
  let expensiveFallbackCalls = 0;
  const engine = new CapabilityExecutionEngine({ routes:[
    route('primary', async () => { throw Object.assign(new Error('down'), { code:'provider_unavailable', costUsd:0.6 }); }, { maxCostUsd:0.6 }),
    route('fallback', async () => { expensiveFallbackCalls += 1; return { output:'bad', provider:'paid' }; }, { maxCostUsd:0.6 }),
  ] });
  await assert.rejects(engine.invoke({ request, policy, payload:{} }), (error) => {
    assert.equal(error.executionReceipt.costUsd, 0.6);
    assert.equal(error.executionReceipt.routeAttempts.length, 1);
    return true;
  });
  assert.equal(expensiveFallbackCalls, 0);
});

test('有限预算拒绝成本上限未知的路线', async () => {
  let unknownCostCalls = 0;
  const engine = new CapabilityExecutionEngine({ routes:[
    route('unknown-cost', async () => { unknownCostCalls += 1; return { output:'bad', provider:'paid' }; }, { maxCostUsd:null }),
  ] });
  await assert.rejects(
    engine.invoke({ request, policy, payload:{} }),
    (error) => error.code === 'capability_route_unavailable',
  );
  assert.equal(unknownCostCalls, 0);
});

test('Adapter质量门确定失败时切Plan B，不把未通过输出当成功', async () => {
  const engine = new CapabilityExecutionEngine({ routes:[
    route('low-quality', async () => ({
      output:'unusable', provider:'provider-a', costUsd:0,
      qualityResult:{ passed:false, status:'failed', gateId:'transcript-quality' },
    })),
    route('quality-fallback', async () => ({
      output:'usable', provider:'provider-b', costUsd:0,
      qualityResult:{ passed:true, status:'passed', gateId:'transcript-quality' },
    })),
  ] });
  const result = await engine.invoke({ request, policy, payload:{} });
  assert.equal(result.output, 'usable');
  assert.deepEqual(result.receipt.routeAttempts.map((attempt) => [attempt.outcome, attempt.failureCode]), [
    ['confirmed_failure', 'capability_quality_failed'],
    ['success', null],
  ]);
});

test('Adapter质量结果待复核时记为ambiguous并停止切换', async () => {
  let fallbackCalls = 0;
  const engine = new CapabilityExecutionEngine({ routes:[
    route('review-required', async () => ({
      output:'machine-draft', provider:'provider-a', costUsd:0,
      qualityResult:{ passed:false, status:'review_required', gateId:'transcript-quality' },
    })),
    route('fallback', async () => { fallbackCalls += 1; return { output:'duplicate', provider:'provider-b', costUsd:0 }; }),
  ] });
  await assert.rejects(engine.invoke({ request, policy, payload:{} }), (error) => {
    assert.equal(error.code, 'capability_quality_ambiguous');
    assert.equal(error.executionReceipt.outcome, 'ambiguous');
    return true;
  });
  assert.equal(fallbackCalls, 0);
});

test('路线事件保存失败码、切换原因和脱敏回执引用', async () => {
  const events = [];
  const engine = new CapabilityExecutionEngine({
    routes:[
      route('primary', async () => { throw Object.assign(new Error('token=should-not-leak'), { code:'provider_unavailable' }); }),
      route('fallback', async () => ({ output:'ok', provider:'provider-b', costUsd:0 })),
    ],
    onReceipt:createCapabilityEventRecorder({ appendTaskRunEvent(event) { events.push(event); } }),
  });
  const result = await engine.invoke({ request, policy, payload:{} });
  assert.deepEqual(events.map((event) => event.eventType), [
    'capability_policy_decided',
    'capability_route_failed',
    'route_fallback_started',
    'capability_call_succeeded',
  ]);
  assert.equal(events[1].errorCode, 'provider_unavailable');
  assert.equal(events[2].errorCode, 'provider_unavailable');
  assert.match(events[2].safeSummary, /切换到 fallback/);
  assert.equal(events[1].receiptId, result.receipt.receiptId);
  assert.doesNotMatch(JSON.stringify(events), /should-not-leak/);
});
