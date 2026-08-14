import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_CONFIRMATION,
  FakePaperclipAdapter,
  applyBootstrap,
  defaultDefinition,
  dryRunBootstrap,
} from '../src/index.ts';

test('dry-run只写Fake adapter并生成Goal、Project、Routine、Pipeline和预算', async () => {
  const adapter = new FakePaperclipAdapter();
  const result = await dryRunBootstrap({ definition: defaultDefinition, adapter, budgetCents: 625 });
  assert.equal(result.mode, 'dry-run');
  assert.equal(adapter.state.goals.length, 1);
  assert.equal(adapter.state.projects.length, 1);
  assert.equal(adapter.state.routines.length, 18);
  assert.equal(
    adapter.state.agents.filter((item) => item.metadata?.agentArmySystemRole === 'm5-parallel-controller').length,
    1,
  );
  assert.equal(
    adapter.state.agents.filter((item) => item.metadata?.agentArmySystemRole === 'm5-retrospective-controller').length,
    1,
  );
  assert.equal(
    adapter.state.agents.filter((item) => item.metadata?.agentArmySystemRole === 'm5-learning-controller').length,
    1,
  );
  assert.equal(
    adapter.state.agents.filter((item) => item.metadata?.agentArmySystemRole === 'm5-publisher-controller').length,
    1,
  );
  const publisherController = adapter.state.agents.find(
    (item) => item.metadata?.agentArmySystemRole === 'm5-publisher-controller',
  );
  assert.equal(publisherController.role, 'devops');
  assert.equal(publisherController.icon, 'rocket');
  const publishRoutine = adapter.state.routines.find(
    (item) => item.description?.includes('[agent-army:m5:routine:m5-publish]'),
  );
  assert.equal(publishRoutine.assigneeAgentId, publisherController.id);
  const retrospectiveController = adapter.state.agents.find(
    (item) => item.metadata?.agentArmySystemRole === 'm5-retrospective-controller',
  );
  assert.equal(retrospectiveController.role, 'researcher');
  assert.equal(retrospectiveController.icon, 'brain');
  const retrospectiveRoutine = adapter.state.routines.find(
    (item) => item.description?.includes('[agent-army:m5:routine:m5-retrospective]'),
  );
  assert.equal(retrospectiveRoutine.assigneeAgentId, retrospectiveController.id);
  const learningController = adapter.state.agents.find(
    (item) => item.metadata?.agentArmySystemRole === 'm5-learning-controller',
  );
  const learningRoutine = adapter.state.routines.find(
    (item) => item.description?.includes('[agent-army:m5:routine:m5-learning]'),
  );
  assert.equal(learningRoutine.assigneeAgentId, learningController.id);
  assert.equal(adapter.state.triggers.length, 1);
  assert.equal(adapter.state.triggers[0].enabled, false);
  assert.equal(adapter.state.pipelines.length, 1);
  assert.equal(adapter.state.budgets[0].hardStopEnabled, true);
  assert.equal(adapter.state.budgets[0].amount, 625);
  assert.ok(adapter.state.pipelines[0].transitions.every((edge) =>
    typeof edge.fromStageKey === 'string' && typeof edge.toStageKey === 'string',
  ));
});

test('重复dry-run复用marker资源，不重复Goal/Project/Routine/Pipeline', async () => {
  const adapter = new FakePaperclipAdapter();
  await dryRunBootstrap({ definition: defaultDefinition, adapter });
  await dryRunBootstrap({ definition: defaultDefinition, adapter });
  assert.equal(adapter.state.goals.length, 1);
  assert.equal(adapter.state.projects.length, 1);
  assert.equal(adapter.state.routines.length, 18);
  assert.equal(adapter.state.pipelines.length, 1);
  assert.equal(adapter.state.budgets.length, 1);
});

test('重复apply语义会修复已有Routine变量与Pipeline声明漂移，不重建资源', async () => {
  const adapter = new FakePaperclipAdapter();
  await dryRunBootstrap({ definition:defaultDefinition, adapter });
  const routine = adapter.state.routines.find((item) => item.title === 'M5 / 选题');
  const pipeline = adapter.state.pipelines[0];
  const routineId = routine.id;
  const pipelineId = pipeline.id;
  routine.description = '[agent-army:m5:routine:m5-topic] 旧描述';
  routine.variables = [];
  pipeline.name = '旧流水线';
  pipeline.stages.find((stage) => stage.key === 'topic').config.m5Policy.maxConcurrency = 99;
  pipeline.transitions = [{ fromStageKey:'topic', toStageKey:'cancelled', label:'错误路线' }];

  const result = await dryRunBootstrap({ definition:defaultDefinition, adapter });
  const repairedRoutine = adapter.state.routines.find((item) => item.id === routineId);
  const repairedPipeline = adapter.state.pipelines.find((item) => item.id === pipelineId);

  assert.equal(adapter.state.routines.length, 18);
  assert.equal(adapter.state.pipelines.length, 1);
  assert.match(repairedRoutine.description, /\{\{case_id\}\}/);
  assert.deepEqual(repairedRoutine.variables.map((item) => item.name), ['case_id', 'case_version']);
  assert.equal(repairedPipeline.name, defaultDefinition.name);
  assert.equal(
    repairedPipeline.stages.find((stage) => stage.key === 'topic').config.m5Policy.maxConcurrency,
    4,
  );
  assert.ok(repairedPipeline.transitions.some((edge) =>
    edge.fromStageKey === 'topic' && edge.toStageKey === 'parallel_join_gate',
  ));
  assert.ok(result.operations.some((item) => item.type === 'routine' && item.key === 'm5-topic' && item.updated));
  assert.ok(result.operations.some((item) => item.type === 'pipeline' && item.updated));
});

test('Pipeline出现未声明阶段时拒绝自动删除', async () => {
  const adapter = new FakePaperclipAdapter();
  await dryRunBootstrap({ definition:defaultDefinition, adapter });
  adapter.state.pipelines[0].stages.push({
    id:'unexpected-stage',
    key:'unexpected',
    name:'未声明阶段',
    kind:'working',
    position:99,
    config:{},
  });
  await assert.rejects(
    () => dryRunBootstrap({ definition:defaultDefinition, adapter }),
    /拒绝自动删除/,
  );
});

test('apply没有精确确认串、真实adapter和显式预算时一律拒绝', async () => {
  await assert.rejects(
    applyBootstrap({ definition: defaultDefinition, adapter: {}, budgetCents: 625 }),
    /必须显式传入/,
  );
  await assert.rejects(
    applyBootstrap({
      definition: defaultDefinition,
      adapter: new FakePaperclipAdapter(),
      budgetCents: 625,
      confirmLiveWrite: APPLY_CONFIRMATION,
    }),
    /非 Fake/,
  );
  await assert.rejects(
    applyBootstrap({
      definition: defaultDefinition,
      adapter: { findByMarker() {} },
      confirmLiveWrite: APPLY_CONFIRMATION,
    }),
    /budgetCents/,
  );
});

test('apply缺少仅并行Routine使用的小R或小D绑定时在任何写入前拒绝', async () => {
  let writes = 0;
  const adapter = {
    async ensureSystemAgent() {
      writes += 1;
      throw new Error('不应执行');
    },
  };
  const stageOwners = [...new Set(defaultDefinition.stages.map((stage) => stage.owner))];
  const agentIds = Object.fromEntries(stageOwners.map((owner, index) => [
    owner,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ]));

  await assert.rejects(
    applyBootstrap({
      definition:defaultDefinition,
      adapter,
      bindings:{ agentIds },
      budgetCents:625,
      confirmLiveWrite:APPLY_CONFIRMATION,
    }),
    /intel-researcher, xiaod/,
  );
  assert.equal(writes, 0);
});
