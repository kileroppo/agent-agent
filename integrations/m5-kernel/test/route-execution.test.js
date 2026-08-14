import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertChangedM5RecoveryRoute,
  createM5ObservationDecision,
  createM5RouteExecution,
  routeDescriptorFingerprint,
} from '../src/route-execution.ts';

const rejectedExecution = {
  strategy:'default:m5_stage_execute',
  toolIds:['agent-army.content-autonomy:stepfun-tts'],
  inputHash:`sha256:${'a'.repeat(64)}`,
};
const recovery = {
  revisionId:'m5-plan-revision:11111111-1111-4111-8111-111111111111:r1',
  rejectedRoute:{
    execution:rejectedExecution,
    routeFingerprint:routeDescriptorFingerprint(rejectedExecution),
  },
  nextRoute:{ stageKey:'voice' },
};

test('routeChanged 只由真实输入、工具或策略差异产生', () => {
  const changed = createM5RouteExecution({
    runId:'run-route-changed', stageKey:'voice', recovery,
    strategy:'same_stage_rebuild_inputs', toolIds:rejectedExecution.toolIds,
    inputs:{ script:'重建后的旁白输入' },
    now:() => new Date('2026-07-30T00:00:00.000Z'),
  });
  assert.equal(changed.routeChanged, true);
  assert.ok(changed.changedDimensions.includes('strategy'));
  assert.ok(changed.changedDimensions.includes('inputs'));
  assert.equal(assertChangedM5RecoveryRoute(changed, recovery), changed);
  assert.equal(JSON.stringify(changed).includes('重建后的旁白输入'), false);
});

test('同一恢复版本再次使用同一路线时拒绝伪 routeChanged', () => {
  const first = createM5RouteExecution({
    runId:'run-route-first', stageKey:'voice', recovery,
    strategy:'same_stage_rebuild_inputs', toolIds:rejectedExecution.toolIds,
    inputs:{ script:'同一份输入' },
  });
  const repeated = createM5RouteExecution({
    runId:'run-route-repeat', stageKey:'voice', recovery, previousExecution:first,
    strategy:first.strategy, toolIds:first.toolIds, inputs:{ script:'同一份输入' },
  });
  assert.equal(repeated.routeChanged, false);
  assert.deepEqual(repeated.changedDimensions, []);
  assert.throws(() => assertChangedM5RecoveryRoute(repeated, recovery), /输入、工具或策略没有真实变化/);
});

test('Observation驱动决策保留Paperclip血缘但不复制真实工具正文', () => {
  const decision = createM5ObservationDecision({
    runId:'run-open-research', issueId:'issue-open-research',
    observation:{
      schemaVersion:'agent.army/tool-observation/v1', observationId:'observation-1',
      toolId:'content.public.fetch', outcome:'failed', classification:'dynamic_page_required',
      output:{ text:'真实网页正文不应进入路线回执' }, token:'never-copy',
    },
    action:'switch_adapter', selectedToolId:'content.public.dynamic.read',
    successCondition:'读取公开动态网页并得到可核验正文。',
    budget:{ stepsRemaining:6, safeRetriesRemaining:2, replansRemaining:3, remainingUnitsAfterDecision:8 },
    now:() => new Date('2026-07-31T02:00:00.000Z'),
  });
  assert.equal(decision.source.runId, 'run-open-research');
  assert.equal(decision.source.issueId, 'issue-open-research');
  assert.equal(decision.source.observationId, 'observation-1');
  assert.match(decision.source.observationHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(decision.decisionId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(decision.selectedToolId, 'content.public.dynamic.read');
  assert.equal(JSON.stringify(decision).includes('真实网页正文'), false);
  assert.equal(JSON.stringify(decision).includes('never-copy'), false);
});
