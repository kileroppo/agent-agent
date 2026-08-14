import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskTimelineService,
  normalizeTaskTimelineQuery,
} from '../src/task-timeline-service.ts';

const taskId = '11111111-1111-4111-8111-111111111111';
const events = [
  {
    eventId:'event-1', eventType:'capability_call_failed', startedAt:'2026-08-13T02:00:00.000Z',
    capabilityId:'vision.analyze', routeId:'vision-primary', provider:'provider-a', model:'vision-a',
    attempt:1, durationMs:1234, errorCode:'provider_unavailable', safeSummary:'Provider 暂时不可用。',
    inputHash:'a'.repeat(64), artifactRefs:[{ artifactId:'artifact-1', title:'输入图片' }],
  },
  {
    eventId:'event-2', eventType:'route_fallback_started', startedAt:'2026-08-13T02:00:02.000Z',
    capabilityId:'vision.analyze', routeId:'vision-plan-b', provider:'provider-b', costAmount:0.02, costCurrency:'USD',
    publicSummary:'识图能力已自动切换，暂时不需要你操作。',
  },
  {
    eventId:'event-3', eventType:'quality_check_completed', finishedAt:'2026-08-13T02:00:05.000Z',
    status:'passed', qualityResult:{ status:'passed', gateId:'vision-evidence' },
  },
];

test('LAN 时间线只显示业务阶段且不泄露 Provider、费用和错误', async () => {
  const calls = [];
  const service = new TaskTimelineService({ eventStore:{
    async queryTaskRunEvents(query) { calls.push(query); return { items:events, nextCursor:'next_page' }; },
  } });
  const page = await service.read(taskId, { audience:'lan', limit:20, filters:['fallback'] });

  assert.deepEqual(calls, [{ taskId, cursor:null, limit:20, filters:['fallback'] }]);
  assert.equal(page.schemaVersion, 'agent.army/task-timeline/v1');
  assert.deepEqual(page.items.map((item) => item.eventType), ['route_fallback_started', 'quality_check_completed']);
  assert.equal(page.items[0].summary, '识图能力已自动切换，暂时不需要你操作。');
  assert.equal(page.items.some((item) => Object.hasOwn(item, 'technical')), false);
  assert.doesNotMatch(JSON.stringify(page), /provider-a|provider-b|0\.02|provider_unavailable/);
  assert.equal(page.nextCursor, 'next_page');
});

test('本机负责人投影保留脱敏排障字段但丢弃原始敏感和危险引用', async () => {
  const service = new TaskTimelineService({ eventStore:{
    async queryTaskRunEvents() {
      return { items:[{ ...events[0], secret:'sk-secret', rawPrompt:'完整提示词', checkpointRef:'file:///etc/passwd', providerRawError:'token=bad', safeSummary:'Provider 异常 token=should-not-leak' }] };
    },
  } });
  const page = await service.read(taskId, { audience:'local-owner' });
  const technical = page.items[0].technical;

  assert.equal(technical.provider, 'provider-a');
  assert.equal(technical.errorCode, 'provider_unavailable');
  assert.equal(technical.durationMs, 1234);
  assert.equal(technical.safeSummary, 'Provider 异常 token=[已脱敏]');
  assert.deepEqual(technical.artifactRefs, [{ artifactId:'artifact-1', type:'', title:'输入图片' }]);
  assert.equal(Object.hasOwn(technical, 'checkpointRef'), false);
  assert.doesNotMatch(JSON.stringify(page), /sk-secret|完整提示词|should-not-leak|token=bad|etc\/passwd/);
});

test('查询限制游标与筛选均采用小而稳定的接口约定', () => {
  assert.deepEqual(normalizeTaskTimelineQuery(taskId, {
    audience:'local-owner', cursor:'opaque_cursor', limit:500, filter:'failure,cost,failure',
  }), {
    taskId, audience:'local-owner', cursor:'opaque_cursor', limit:100, filters:['failure', 'cost'],
  });
  assert.throws(() => normalizeTaskTimelineQuery(taskId, { filter:'provider' }), { code:'invalid_filter' });
  assert.throws(() => normalizeTaskTimelineQuery(taskId, { cursor:'not a cursor' }), { code:'invalid_cursor' });
  assert.throws(() => normalizeTaskTimelineQuery('bad', {}), { code:'invalid_task_id' });
});
