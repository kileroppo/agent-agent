import assert from 'node:assert/strict';
import test from 'node:test';
import {
  externalCapabilityEvidence,
  runExternalCapabilityWithEvents,
} from '../src/adapters/external-capability-run-event-bridge.ts';

const context = Object.freeze({
  taskId:'task-events-1', workflowId:'workflow-events-1', stepId:'step-events-1',
  agentId:'intel-researcher', capabilityId:'content.public.search',
  routeId:'public-web-search', provider:'public-search',
});

test('外部能力事件桥只输出白名单字段并复用已确认费用与哈希血缘', async () => {
  const events = [];
  const times = ['2026-08-13T01:00:00.000Z', '2026-08-13T01:00:00.025Z'];
  const result = await runExternalCapabilityWithEvents({
    onRunEvent:(event) => events.push(event),
    context,
    now:() => new Date(times.shift()),
    execute:async () => ({
      prompt:'绝不能进入日志 token=private-value',
      model:'step-image-v1',
      checksum:'a'.repeat(64),
      callRecord:{
        actionId:'campaign:day1:image:cover',
        model:'step-image-v1',
        promptChecksum:`sha256:${'b'.repeat(64)}`,
      },
      costCommit:{
        status:'confirmed',
        costEventId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        costEvent:{ costCents:3, provider:'stepfun' },
      },
    }),
    evidence:externalCapabilityEvidence,
  });
  assert.equal(result.model, 'step-image-v1');
  assert.deepEqual(events.map((event) => event.eventType), [
    'capability_call_started', 'capability_call_succeeded',
  ]);
  assert.equal(events[1].durationMs, 25);
  assert.equal(events[1].model, 'step-image-v1');
  assert.equal(events[1].costAmount, 0.03);
  assert.equal(events[1].checkpointRef, 'cost-event:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(events[1].inputHash, `sha256:${'b'.repeat(64)}`);
  assert.equal(events[1].outputHash, `sha256:${'a'.repeat(64)}`);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private-value|"prompt"|costCents/);
});

test('无备用Provider的确认失败与结果不确定都记录安全停止且不抛出原始错误信息', async () => {
  for (const fixture of [
    {
      error:Object.assign(new Error('Authorization: Bearer private-token'), { code:'provider_down' }),
      eventType:'capability_call_failed', status:'failed', summary:/未登记安全备用 Provider，已停止/,
    },
    {
      error:Object.assign(new Error('Cookie=session-private'), { code:'provider_timeout', outcome:'ambiguous' }),
      eventType:'capability_result_ambiguous', status:'ambiguous', summary:/已停止备用调用/,
    },
  ]) {
    const events = [];
    await assert.rejects(() => runExternalCapabilityWithEvents({
      onRunEvent:(event) => events.push(event),
      context,
      execute:async () => { throw fixture.error; },
    }), (error) => error === fixture.error);
    assert.equal(events.at(-1).eventType, fixture.eventType);
    assert.equal(events.at(-1).status, fixture.status);
    assert.match(events.at(-1).safeSummary, fixture.summary);
    assert.doesNotMatch(JSON.stringify(events), /private-token|session-private/);
  }
});

test('日志接收器异常不会改变外部能力业务结果', async () => {
  const result = await runExternalCapabilityWithEvents({
    onRunEvent:async () => { throw new Error('event store unavailable'); },
    context,
    execute:async () => 'business-result',
  });
  assert.equal(result, 'business-result');
});
