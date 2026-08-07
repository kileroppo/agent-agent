import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultDefinition } from '@agent-army/m5-content-pipeline';
import {
  INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT,
  assertM5RoutineExecutionContracts,
  getM5RoutineExecutionContract,
} from '../src/routine-execution-contract.js';

test('全部 M5 业务 Routine 都有唯一 Hermes 或 system controller 执行契约', () => {
  const contracts = assertM5RoutineExecutionContracts(defaultDefinition);
  assert.equal(contracts.length, 18);
  assert.equal(new Set(contracts.map((item) => item.routineKey)).size, contracts.length);
  assert.equal(new Set(contracts.map((item) => item.stageKey)).size, contracts.length);
  assert.deepEqual(
    contracts.filter((item) => item.executionMode === 'system_controller').map((item) => item.routineKey),
    ['m5-parallel-join', 'm5-publish', 'm5-metrics', 'm5-retrospective', 'm5-learning'],
  );
  for (const contract of contracts) {
    assert.ok(contract.expectedWorkProduct.type);
    assert.match(contract.expectedWorkProduct.schemaVersion, /^agent\.army\//);
    assert.ok(contract.expectedWorkProduct.artifactKinds.length);
    if (contract.executionMode === 'hermes') {
      assert.ok(contract.agentId);
      assert.ok(contract.taskType);
      assert.ok(contract.executionTool?.id);
      assert.equal(contract.completionTool, 'paperclip_assignment_complete');
    } else {
      assert.ok(contract.systemController);
      assert.equal(contract.taskType, null);
    }
  }
});

test('缺少或漂移的 Pipeline 阶段不能通过唯一执行契约检查', () => {
  const missing = structuredClone(defaultDefinition);
  missing.stages = missing.stages.filter((stage) => stage.key !== 'render');
  assert.throws(() => assertM5RoutineExecutionContracts(missing), /m5-render 没有对应 Pipeline 阶段/);
  const drifted = structuredClone(defaultDefinition);
  drifted.stages.find((stage) => stage.key === 'render').owner = 'reviewer';
  assert.throws(() => assertM5RoutineExecutionContracts(drifted), /m5-render 的岗位契约不是 reviewer/);
});

test('高风险内容插件阶段统一走无参数 m5_stage_execute 且 toolId 固定在契约', () => {
  const expected = {
    'm5-image-generation':'stepfun-image-generate',
    'm5-voice':'stepfun-tts',
    'm5-render':'remotion-render',
    'm5-machine-review':'media-validate',
    'm5-publish-approval':'publish-preflight',
  };
  for (const [routineKey, pluginEntryTool] of Object.entries(expected)) {
    const contract = getM5RoutineExecutionContract(routineKey);
    assert.deepEqual(contract.executionTool, { kind:'agent_army_mcp', id:'m5_stage_execute' });
    assert.equal(contract.pluginEntryTool, pluginEntryTool);
  }
  assert.ok(
    getM5RoutineExecutionContract('m5-render').pluginTools.includes('social-card-render'),
  );
});

test('小拆 M5 画面分析契约只消费 AssetPackage 并输出 VisualAnalysisPackage', () => {
  const contract = getM5RoutineExecutionContract('m5-visual-analysis');
  assert.equal(contract.agentId, 'video-content-analyst');
  assert.equal(contract.taskType, 'content.campaign-visual-analysis');
  assert.deepEqual(contract.executionTool, { kind:'agent_army_mcp', id:'video_content_analyze_execute' });
  assert.equal(contract.expectedWorkProduct.type, 'VisualAnalysisPackage');
  assert.deepEqual(contract.expectedWorkProduct.artifactKinds, ['visual_analysis_package']);
});

test('小R开放研究契约固定Observation上限、只读Adapter和Paperclip写回Seam', () => {
  const contract = INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT;
  assert.equal(contract.agentId, 'intel-researcher');
  assert.equal(contract.taskType, 'research.open-investigation');
  assert.equal(contract.maxSteps, 8);
  assert.equal(contract.maxSafeRetries, 2);
  assert.equal(contract.maxReplans, 3);
  assert.deepEqual(contract.toolIds, [
    'content.public.search', 'content.public.fetch', 'content.public.dynamic.read',
    'content.public.pdf.read', 'github.public.search', 'github.public.read',
  ]);
  assert.deepEqual(contract.paperclipWriteKinds, [
    'append_run_observation', 'request_plan_revision', 'block_issue', 'create_work_product',
  ]);
  assert.equal(contract.liveWiring, 'employee_assignment_execute');
  assert.equal(contract.toolIds.some((item) => /browser|terminal|publish/i.test(item)), false);
});
