import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutedPublicWebReader } from '../src/adapters/routed-public-web-reader.ts';

const TASK = Object.freeze({
  taskId:'11111111-1111-4111-8111-111111111111',
  assigneeAgentId:'intel-researcher',
  currentStage:'source-reading',
  workflow:{ workflowId:'workflow:test', step:{ stepId:'source-reading' } },
});

test('小R静态正文确定失败后切动态读取，并把回执写入任务事件账本', async () => {
  const events = [];
  const reader = new RoutedPublicWebReader({
    primary:{ async acquire() { throw Object.assign(new Error('unavailable'), { code:'source_unavailable' }); } },
    fallback:{ async read({ sourceUrl }) { return publicPage(sourceUrl); } },
    eventStore:{ appendTaskRunEvent(event) { events.push(event); } },
  });

  const result = await reader.acquire({ sourceUrl:'https://example.com/article', task:TASK });

  assert.equal(result.quality.evidenceEligible, true);
  assert.deepEqual(events.map((event) => event.eventType), [
    'capability_policy_decided',
    'capability_route_failed',
    'route_fallback_started',
    'capability_call_succeeded',
  ]);
  assert.equal(events[2].routeId, 'public-web-controlled-browser');
  assert.equal(events[3].taskId, TASK.taskId);
});

test('公开链接越界属于策略拒绝，不进入浏览器备用路线', async () => {
  let fallbackCalls = 0;
  const reader = new RoutedPublicWebReader({
    primary:{ async acquire() { throw Object.assign(new Error('denied'), { code:'source_not_public' }); } },
    fallback:{ async read() { fallbackCalls += 1; return publicPage('https://example.com/'); } },
  });

  await assert.rejects(
    reader.acquire({ sourceUrl:'http://127.0.0.1/private', task:TASK }),
    (error) => error.code === 'source_not_public' && error.executionReceipt.routeAttempts.length === 1,
  );
  assert.equal(fallbackCalls, 0);
});

function publicPage(sourceRef) {
  return {
    sourceRef,
    text:'已实际读取的公开正文。',
    contentHash:'a'.repeat(64),
    fetchedAt:'2026-08-13T00:00:00.000Z',
    validation:{ exists:true, readable:true, accessScope:'public_read' },
  };
}
