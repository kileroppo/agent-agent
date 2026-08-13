import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessPublicContentEvidence,
  assessPublicSearchDiscovery,
  createPublicDynamicWebReaderCapabilityAdapter,
  createPublicWebReadRoutes,
  createPublicWebFetchCapabilityAdapter,
  createPublicWebSearchCapabilityAdapter,
} from '../src/adapters/public-content-capability-adapters.ts';
import {
  createExternalDocumentDeliveryCapabilityAdapter,
  observeExternalWriteResult,
} from '../src/adapters/external-document-delivery-capability-adapter.ts';
import { CapabilityExecutionEngine } from '../src/workflow/capability-execution.ts';
import { classifyCapabilityFailure } from '../src/workflow/capability-failure.ts';

const HASH = 'a'.repeat(64);

function request(overrides = {}) {
  return {
    requestId:'request-1', workflowId:'workflow-1', stepId:'step-1', taskId:'task-1',
    agentId:'intel-researcher', capabilityId:'content.public.fetch', dataClass:'public',
    sideEffect:'read', maxCostUsd:0, costKnown:true, crossDevice:false,
    requiresCredentials:false, ...overrides,
  };
}

function page(overrides = {}) {
  return {
    sourceRef:'https://example.com/article', text:'真实读取的公开正文', contentHash:HASH,
    fetchedAt:'2026-08-13T00:00:00.000Z',
    validation:{ exists:true, readable:true, accessScope:'public_read' },
    ...overrides,
  };
}

test('搜索只产生发现候选，不能在正文未读取时计作证据', async () => {
  const adapter = createPublicWebSearchCapabilityAdapter({
    async search() {
      return { provider:'bing', results:[{ url:'https://example.com/a', title:'候选来源' }] };
    },
  });
  const result = await adapter.invoke({
    request:request({ capabilityId:'content.public.search' }), payload:{ query:'研究主题' },
    options:{}, attempt:1,
  });
  assert.equal(result.provider, 'bing');
  assert.equal(result.output.quality.passed, true);
  assert.equal(result.output.quality.evidenceEligible, false);
  assert.equal(assessPublicSearchDiscovery({ results:[] }).passed, false);
});

test('静态与动态读取复用既有客户端，并统一执行正文证据质量门', async () => {
  const calls = [];
  const staticAdapter = createPublicWebFetchCapabilityAdapter({
    async acquire(input) { calls.push(['static', input]); return page(); },
  });
  const dynamicAdapter = createPublicDynamicWebReaderCapabilityAdapter({
    async read(input) { calls.push(['dynamic', input]); return page({ text:'JS 渲染正文' }); },
  });
  const staticResult = await staticAdapter.invoke({
    request:request(), payload:{ sourceUrl:'https://example.com/article' }, options:{}, attempt:1,
  });
  const dynamicResult = await dynamicAdapter.invoke({
    request:request({ capabilityId:'content.public.dynamic.read' }),
    payload:{ url:'https://example.com/article' }, options:{}, attempt:1,
  });
  assert.deepEqual(calls, [
    ['static', { sourceUrl:'https://example.com/article' }],
    ['dynamic', { sourceUrl:'https://example.com/article' }],
  ]);
  assert.equal(staticResult.output.quality.evidenceEligible, true);
  assert.equal(dynamicResult.output.quality.evidenceEligible, true);
  assert.equal(staticResult.output.quality.contentHash, `sha256:${HASH}`);
});

test('统一Route执行时静态正文失败会切隔离浏览器Plan B并保留v2回执', async () => {
  const routes = createPublicWebReadRoutes({
    publicWebFetch:{
      async acquire() { throw Object.assign(new Error('static unavailable'), { code:'source_unavailable' }); },
    },
    publicDynamicWebReader:{
      async read() { return page({ text:'浏览器读取到的正文' }); },
    },
  });
  const engine = new CapabilityExecutionEngine({ routes });
  const result = await engine.invoke({
    request:request(),
    policy:{
      manifestCapabilities:['content.public.fetch'], taskBudgetUsd:0,
      agentApprovalThresholdUsd:0, projectBudgetRemainingUsd:0,
      companyBudgetRemainingUsd:0,
    },
    payload:{ sourceUrl:'https://example.com/article' },
  });
  assert.equal(result.receipt.schemaVersion, 'agent.army/execution-receipt/v2');
  assert.equal(result.receipt.routeId, 'public-web-controlled-browser');
  assert.equal(result.receipt.fallbackFrom, 'public-web-static');
  assert.deepEqual(result.receipt.routeAttempts.map(({ routeId, outcome }) => ({ routeId, outcome })), [
    { routeId:'public-web-static', outcome:'confirmed_failure' },
    { routeId:'public-web-controlled-browser', outcome:'success' },
  ]);
  assert.equal(result.output.quality.evidenceEligible, true);
});

test('正文、抓取时间、哈希或公开可读校验缺失时拒绝计作来源证据', async () => {
  for (const incomplete of [
    page({ text:'' }),
    page({ contentHash:null }),
    page({ fetchedAt:null }),
    page({ validation:{ exists:true, readable:false, accessScope:'public_read' } }),
  ]) {
    const quality = assessPublicContentEvidence(incomplete);
    assert.equal(quality.passed, false);
    assert.equal(quality.evidenceEligible, false);
  }
  const adapter = createPublicWebFetchCapabilityAdapter({ async acquire() { return page({ text:'' }); } });
  await assert.rejects(
    () => adapter.invoke({ request:request(), payload:{ sourceUrl:'https://example.com' }, options:{}, attempt:1 }),
    { code:'quality_failed' },
  );
});

test('外部文档写入结果不确定时停止，禁止切换备用写入通道', async () => {
  const events = [];
  const observation = observeExternalWriteResult({ deliveryState:'unknown', code:'provider_timeout' });
  assert.equal(observation.outcome, 'ambiguous');
  assert.equal(observation.fallbackAllowed, false);
  const adapter = createExternalDocumentDeliveryCapabilityAdapter({
    adapterId:'existing-feishu-document-provider', provider:'feishu',
    async deliver() {
      throw Object.assign(new Error('timeout'), { deliveryState:'unknown', code:'provider_timeout' });
    },
    onRunEvent:(event) => events.push(event),
  });
  await assert.rejects(
    () => adapter.invoke({
      request:request({ capabilityId:'feishu.document.deliver', sideEffect:'external-write' }),
      payload:{ documentRef:'artifact-1' }, options:{}, attempt:1,
    }),
    (error) => {
      const failure = classifyCapabilityFailure(error);
      return error.code === 'provider_timeout'
        && error.outcome === 'ambiguous'
        && error.failureKind === 'ambiguous_result'
        && error.ambiguous === true
        && error.fallbackAllowed === false
        && error.retryable === false
        && failure.outcome === 'ambiguous'
        && failure.allowFallback === false
        && failure.recoverCurrentRoute === false;
    },
  );
  assert.equal(events.at(-1).eventType, 'capability_result_ambiguous');
  assert.match(events.at(-1).safeSummary, /已停止备用调用/);
  assert.equal(events.some((event) => event.eventType === 'route_fallback_started'), false);
});

test('只有确认未开始的外部写入才允许Plan B，确认送达则形成成功输出', async () => {
  const failed = observeExternalWriteResult({ deliveryState:'not_started', code:'provider_unavailable' });
  assert.equal(failed.outcome, 'confirmed_failure');
  assert.equal(failed.fallbackAllowed, true);
  const adapter = createExternalDocumentDeliveryCapabilityAdapter({
    adapterId:'existing-document-provider', provider:'document-provider',
    async deliver({ idempotencyKey }) {
      return { deliveryState:'delivered', documentUrl:'https://docs.example.com/1', idempotencyKey };
    },
  });
  const result = await adapter.invoke({
    request:request({ capabilityId:'document.deliver', sideEffect:'external-write' }),
    payload:{ artifactRef:'artifact-1' }, options:{}, attempt:1,
  });
  assert.equal(result.output.deliveryObservation.outcome, 'success');
  assert.equal(result.output.idempotencyKey, 'request-1');
});
