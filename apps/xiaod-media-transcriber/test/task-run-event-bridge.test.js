import assert from 'node:assert/strict';
import test from 'node:test';
import { asrRouteAttempt, buildAsrExecutionReceipt } from '../src/asr-capability-adapter.ts';
import { createTaskRunEventBridge } from '../src/task-run-event-bridge.ts';

test('ASR 每次路由尝试、fallback 与质量门输出统一脱敏事件', async () => {
  const events = [];
  const bridge = createTaskRunEventBridge({ onRunEvent:async (event) => events.push(event) });
  const receipt = buildAsrExecutionReceipt({
    job:{ id:'job-event-1', workflowId:'workflow-event-1', requestId:'request-event-1' },
    routing:{ selectedProvider:'faster-whisper', selectedModel:'safe-model', fallbackFrom:'mlx-whisper' },
    input:{ transcript:'password=never-log-this' },
    payload:{ text:'secret source content' },
    startedAt:'2026-08-13T01:00:00.000Z',
    completedAt:'2026-08-13T01:00:02.000Z',
    routeAttempts:[
      asrRouteAttempt({ provider:'mlx-whisper', outcome:'confirmed_failure', failureCode:'provider_unavailable' }),
      asrRouteAttempt({ provider:'faster-whisper', outcome:'success' })
    ]
  });
  await bridge.recordExecutionReceipt(receipt, {
    qualityResult:{ status:'review_required', passed:false, reasons:['human_review_required'] }
  });

  assert.deepEqual(events.map((event) => event.eventType), [
    'capability_policy_decided',
    'capability_call_failed',
    'route_fallback_started',
    'capability_call_succeeded',
    'quality_check_completed'
  ]);
  assert.deepEqual(events.filter((event) => event.eventType.startsWith('capability_call_')).map((event) => event.attempt), [1, 2]);
  assert.equal(events.at(-1).status, 'review_required');
  assert.ok(events.every((event) => event.schemaVersion === 'agent.army/task-run-event/v1'));
  assert.ok(events.every((event) => event.taskId === 'job-event-1'));
  assert.doesNotMatch(JSON.stringify(events), /never-log-this|secret source content/);
});

test('事件接收端故障不会改变能力执行结果', async () => {
  const bridge = createTaskRunEventBridge({ onRunEvent:async () => { throw new Error('event sink unavailable'); } });
  const receipt = buildAsrExecutionReceipt({
    job:{ id:'job-event-sink-failure' },
    routing:{ selectedProvider:'source-subtitle' },
    input:{ subtitleText:'正文' },
    payload:{ text:'正文' }
  });
  await assert.doesNotReject(bridge.recordExecutionReceipt(receipt, {
    qualityResult:{ status:'passed', passed:true, reasons:[] }
  }));
});

test('MediaCrawlerPro确认失败后切yt-dlp按同一receipt输出路由时间线', async () => {
  const events = [];
  const bridge = createTaskRunEventBridge({ onRunEvent:(event) => events.push(event) });
  await bridge.recordExecutionReceipt({
    schemaVersion:'agent.army/execution-receipt/v2',
    receiptId:'receipt:content-acquisition:fixture', requestId:'request-acquisition',
    workflowId:'workflow:xiaod-media:job-acquisition',
    stepId:'step:content.acquire:job-acquisition', taskId:'job-acquisition', agentId:'xiaod',
    capabilityId:'content.acquire', policyDecisionId:'policy:content-acquisition:fixture',
    routeId:'yt-dlp-general-media', adapterId:'yt-dlp-general-media', provider:'public_media', model:null,
    inputHash:`sha256:${'a'.repeat(64)}`, outputHash:`sha256:${'b'.repeat(64)}`,
    outcome:'success', fallbackFrom:'mediacrawlerpro-specialized-content',
    routeAttempts:[
      { routeId:'mediacrawlerpro-specialized-content', adapterId:'mediacrawlerpro-specialized-content', attempts:1, recovered:false, outcome:'confirmed_failure', failureCode:'adapter_unavailable' },
      { routeId:'yt-dlp-general-media', adapterId:'yt-dlp-general-media', attempts:1, recovered:false, outcome:'success', failureCode:null },
    ],
    attempts:2, totalAttempts:2, recovered:false, failureCode:null, costUsd:0,
    startedAt:'2026-08-13T02:00:00.000Z', completedAt:'2026-08-13T02:00:03.000Z',
  });
  assert.deepEqual(events.map((event) => [event.eventType, event.routeId, event.provider, event.status]), [
    ['capability_policy_decided', 'mediacrawlerpro-specialized-content', null, 'allowed'],
    ['capability_call_failed', 'mediacrawlerpro-specialized-content', 'mediacrawlerpro', 'confirmed_failure'],
    ['route_fallback_started', 'yt-dlp-general-media', 'yt-dlp', 'fallback'],
    ['capability_call_succeeded', 'yt-dlp-general-media', 'public_media', 'success'],
  ]);
  assert.ok(events.every((event) => event.taskId === 'job-acquisition'));
  assert.doesNotMatch(JSON.stringify(events), /sourceUrl|cookie|private/);
});

test('视觉失败与飞书不确定结果使用相同事件契约且不泄露原始异常', async () => {
  const events = [];
  const bridge = createTaskRunEventBridge({ onRunEvent:(event) => events.push(event) });
  const visualError = Object.assign(new Error('token=visual-secret'), { code:'visual_evidence_unavailable' });
  await bridge.recordVisualResult({
    job:{ id:'job-multimodal' },
    startedAt:'2026-08-13T01:00:00.000Z',
    completedAt:'2026-08-13T01:00:01.000Z',
    error:visualError
  });
  await bridge.recordLarkDelivery({
    job:{ id:'job-multimodal' },
    delivery:{
      deliveryId:'delivery-1', state:'uncertain', startedAt:'2026-08-13T01:00:02.000Z',
      updatedAt:'2026-08-13T01:00:03.000Z', lastError:'Bearer lark-secret'
    }
  });
  await bridge.recordLarkDelivery({
    job:{ id:'job-multimodal' },
    delivery:{
      deliveryId:'delivery-2', state:'failed_before_create', configured:false,
      startedAt:'2026-08-13T01:00:04.000Z', updatedAt:'2026-08-13T01:00:05.000Z'
    }
  });

  assert.deepEqual(events.map((event) => [event.capabilityId, event.eventType, event.status]), [
    ['vision.extract-evidence', 'capability_call_failed', 'confirmed_failure'],
    ['vision.extract-evidence', 'quality_check_completed', 'failed'],
    ['document.deliver', 'capability_result_ambiguous', 'ambiguous'],
    ['document.deliver', 'capability_call_failed', 'confirmed_failure']
  ]);
  assert.doesNotMatch(JSON.stringify(events), /visual-secret|lark-secret/);
});
