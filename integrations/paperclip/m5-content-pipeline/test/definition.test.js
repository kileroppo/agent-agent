import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReviewDecision,
  buildBootstrapPlan,
  buildCampaignCaseBatch,
  buildParallelWorkCaseBatch,
  defaultDefinition,
  platformCaseKey,
  ingestCampaignDraftCase,
  ingestCampaignCaseBatch,
  ingestParallelWorkCaseBatch,
  FakePaperclipAdapter,
  validateDefinition,
} from '../src/index.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('复盘和学习灰度是可执行工作阶段，完成后才进入独立done终态', () => {
  const valid = validateDefinition(defaultDefinition);
  assert.equal(valid.stages.length, 16);
  assert.equal(valid.stages[0].key, 'draft');
  assert.equal(valid.stages[0].routineKey, undefined);
  assert.equal(valid.stages[1].key, 'campaign_active');
  assert.equal(valid.stages[1].routineKey, undefined);
  assert.deepEqual(valid.stages.slice(2, 14).map((stage) => stage.name), [
    '选题', '并行工作汇聚门禁', '脚本', '渲染',
    '机器审核', '平台适配', '发布审批', '发布', '核验', '指标回流', '复盘', '学习灰度',
  ]);
  assert.deepEqual(
    valid.stages.find((stage) => stage.key === 'retrospective'),
    {
      key:'retrospective',
      name:'复盘',
      kind:'working',
      owner:'ajun',
      routineKey:'m5-retrospective',
    },
  );
  assert.equal(valid.stages.find((stage) => stage.key === 'done').kind, 'done');
  assert.equal(valid.stages.find((stage) => stage.key === 'parallel_join_gate').owner, 'operator');
  assert.equal(valid.stages[15].kind, 'cancelled');
  const routineIds = Object.fromEntries(
    valid.stages.filter((stage) => stage.routineKey).map((stage, index) => [stage.routineKey, uuid(index + 30)]),
  );
  for (const [index, key] of [
    'm5-evidence',
    'm5-assets',
    'm5-visual-analysis',
    'm5-image-generation',
    'm5-voice',
  ].entries()) routineIds[key] = uuid(index + 60);
  const agentIds = Object.fromEntries(
    [...new Set([
      ...valid.stages.map((stage) => stage.owner),
      'intel-researcher',
      'xiaod',
      'video-content-analyst',
      'content-creator',
    ])].map((owner, index) => [owner, uuid(index + 1)]),
  );
  const plan = buildBootstrapPlan(valid, {
    goalId: uuid(90),
    projectId: uuid(91),
    agentIds,
    routineIds,
    dailyControllerAgentId:uuid(92),
    metricsControllerAgentId:uuid(93),
    publisherControllerAgentId:uuid(94),
    retrospectiveControllerAgentId:uuid(95),
    parallelControllerAgentId:uuid(96),
    learningControllerAgentId:uuid(97),
  });
  assert.equal(plan.resources.pipeline.payload.stages.length, 16);
  assert.deepEqual(plan.resources.pipeline.payload.stages[0].config.onEnter, undefined);
  assert.equal(plan.resources.pipeline.payload.stages[0].config.autoAdvanceOnChildrenTerminal, null);
  assert.deepEqual(plan.resources.pipeline.payload.stages[1].config.onEnter, undefined);
  assert.equal(plan.resources.pipeline.payload.stages[1].config.autoAdvanceOnChildrenTerminal, null);
  assert.ok(plan.resources.pipeline.transitions.some((edge) =>
    edge.fromStageKey === 'draft' && edge.toStageKey === 'campaign_active',
  ));
  assert.ok(plan.resources.pipeline.transitions.some((edge) =>
    edge.fromStageKey === 'retrospective' && edge.toStageKey === 'done',
  ));
  assert.ok(plan.resources.pipeline.transitions.some((edge) =>
    edge.fromStageKey === 'retrospective' && edge.toStageKey === 'learning',
  ));
  assert.ok(plan.resources.pipeline.transitions.some((edge) =>
    edge.fromStageKey === 'script' && edge.toStageKey === 'parallel_join_gate',
  ));
  assert.ok(plan.resources.pipeline.transitions.some((edge) =>
    edge.fromStageKey === 'parallel_join_gate' && edge.toStageKey === 'render',
  ));
  assert.equal(plan.resources.pipeline.payload.enforceTransitions, true);
  assert.deepEqual(plan.unresolved.agentKeys, []);
  assert.equal(plan.unresolved.routineKeys.length, 0);
  assert.equal(plan.resources.scheduleRoutine.payload.concurrencyPolicy, 'skip_if_active');
  assert.equal(plan.resources.scheduleRoutine.payload.catchUpPolicy, 'skip_missed');
  assert.equal(plan.resources.scheduleRoutine.payload.assigneeAgentId, uuid(92));
  assert.equal(plan.resources.dailyController.payload.adapterType, 'http');
  assert.equal(
    plan.resources.dailyController.payload.adapterConfig.url,
    'http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat',
  );
  assert.equal(plan.resources.dailyController.payload.metadata.executionOwner, 'ajun-runtime-deterministic');
  assert.equal(plan.resources.publisherController.payload.adapterType, 'http');
  assert.equal(
    plan.resources.publisherController.payload.adapterConfig.url,
    'http://127.0.0.1:4321/api/paperclip/m5-publisher-heartbeat',
  );
  assert.equal(
    plan.resources.publisherController.payload.adapterConfig.forwardRunJwt,
    true,
  );
  assert.equal(
    plan.resources.metricsController.payload.adapterConfig.forwardRunJwt,
    true,
  );
  assert.equal(
    plan.resources.dailyController.payload.adapterConfig.forwardRunJwt,
    undefined,
  );
  assert.equal(
    plan.resources.publisherController.payload.metadata.agentArmySystemRole,
    'm5-publisher-controller',
  );
  assert.equal(
    plan.resources.routines.find((item) => item.key === 'm5-publish').payload.assigneeAgentId,
    uuid(94),
  );
  assert.equal(
    plan.resources.routines.find((item) => item.key === 'm5-publish').owner,
    'm5-publisher-controller',
  );
  assert.equal(
    plan.resources.scheduleRoutine.payload.variables.some((item) => item.required && item.defaultValue == null),
    false,
  );
  assert.deepEqual(
    plan.resources.routines[0].payload.variables.map((item) => item.name),
    ['case_id', 'case_version'],
  );
  assert.match(plan.resources.routines[0].payload.description, /\{\{case_id\}\}/);
  assert.match(plan.resources.routines[0].payload.description, /\{\{case_version\}\}/);
  assert.deepEqual(plan.resources.scheduleRoutine.payload.variables, []);
  assert.match(plan.resources.scheduleRoutine.payload.description, /无模型 HTTP 控制器/);
  assert.match(plan.resources.scheduleRoutine.payload.description, /不接收 campaignId、日期或 Case 参数/);
  assert.match(plan.resources.scheduleRoutine.payload.description, /不得批量激活其他日期或任何平台 Case/);
  const controllerShortnames = [
    plan.resources.dailyController,
    plan.resources.metricsController,
    plan.resources.publisherController,
    plan.resources.retrospectiveController,
    plan.resources.learningController,
    plan.resources.parallelController,
  ].map(({ payload }) => payload.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''));
  assert.deepEqual(controllerShortnames, [
    'm5-daily',
    'm5-metrics',
    'm5-publisher',
    'm5-retrospective',
    'm5-learning',
    'm5-parallel',
  ]);
  assert.equal(new Set(controllerShortnames).size, controllerShortnames.length);
  assert.deepEqual(
    [
      plan.resources.dailyController,
      plan.resources.metricsController,
      plan.resources.publisherController,
      plan.resources.retrospectiveController,
      plan.resources.learningController,
      plan.resources.parallelController,
    ].map(({ payload }) => payload.icon),
    ['cog', 'radar', 'rocket', 'brain', 'flask-conical', 'git-branch'],
  );
  assert.match(
    plan.resources.routines.find((item) => item.key === 'm5-render').payload.description,
    /才可将当前日期下仍为draft的抖音和小红书两个平台Case推进到machine_review/,
  );
  assert.equal(
    plan.resources.routines.find((item) => item.key === 'm5-assets').payload.assigneeAgentId,
    agentIds.xiaod,
  );
  assert.equal(
    plan.resources.routines.find((item) => item.key === 'm5-visual-analysis').payload.assigneeAgentId,
    agentIds['video-content-analyst'],
  );
  assert.equal(plan.resources.scheduleTrigger.enabled, false);
});

test('审核决定只能走声明的approve/reject/request_changes路线', () => {
  assert.equal(assertReviewDecision(defaultDefinition, 'machine_review', 'approve'), 'platform_adapt');
  assert.equal(assertReviewDecision(defaultDefinition, 'machine_review', 'request_changes'), 'script');
  assert.equal(assertReviewDecision(defaultDefinition, 'publish_approval', 'request_changes'), 'platform_adapt');
  assert.throws(() => assertReviewDecision(defaultDefinition, 'render', 'approve'), /不是 review/);
});

test('caseKey生成父、7个日期和14个平台Case且稳定幂等', () => {
  const result = buildCampaignCaseBatch({
    campaignId: 'm5-demo',
    startDate: '2026-08-01',
    themes: Array.from({ length: 7 }, (_, index) => `主题${index + 1}`),
  });
  assert.equal(result.days.length, 7);
  assert.equal(result.platformCases.length, 14);
  assert.equal(result.parent.stageKey, 'draft');
  assert.equal(result.parent.activationStageKey, 'campaign_active');
  assert.deepEqual(result.parent.fields.campaignPlan.themes, Array.from({ length: 7 }, (_, index) => `主题${index + 1}`));
  assert.ok(result.platformCases.every((item) => item.stageKey === 'machine_review'));
  assert.equal(new Set([
    result.parent.caseKey,
    ...result.days.map((item) => item.caseKey),
    ...result.platformCases.map((item) => item.caseKey),
  ]).size, 22);
  assert.equal(
    platformCaseKey('m5-demo', '2026-08-01', 'douyin'),
    'm5-demo:2026-08-01:douyin:v1',
  );
});

test('每日内容生成固定五个工作分支和一个显式汇聚Case，并发上限仍为4', () => {
  const first = buildParallelWorkCaseBatch({
    campaignId:'m5-parallel',
    scheduledDate:'2026-08-01',
    contentVersion:'v1',
  });
  const second = buildParallelWorkCaseBatch({
    campaignId:'m5-parallel',
    scheduledDate:'2026-08-01',
    contentVersion:'v1',
  });

  assert.deepEqual(second, first);
  assert.equal(first.maxConcurrency, 4);
  assert.equal(first.branches.length, 5);
  assert.deepEqual(first.branches.map((item) => item.fields.workBranch.kind), [
    'research',
    'assets',
    'image_generation',
    'visual_analysis',
    'voice',
  ]);
  assert.deepEqual(
    first.branches.find((item) => item.fields.workBranch.kind === 'visual_analysis')
      .fields.workBranch.requiredInputs,
    ['AssetPackage'],
  );
  assert.equal(first.join.parentLogicalId, 'm5-parallel:2026-08-01');
  assert.ok(first.branches.every((item) => item.parentLogicalId === first.join.logicalId));
  assert.ok(first.branches.every((item) => item.stageKey === 'draft'));
  assert.equal(new Set(first.branches.map((item) => item.caseKey)).size, 5);
  assert.deepEqual(first.join.blockedByCaseKeys, first.branches.map((item) => item.caseKey));
  assert.equal(first.join.fields.parallelJoin.completionRule, 'all_branches_terminal_and_outputs_verified');
  assert.equal(first.join.fields.parallelJoin.appsActivationRequired, true);
  assert.throws(() => buildParallelWorkCaseBatch({
    campaignId:'m5-parallel',
    scheduledDate:'2026-08-01',
    contentVersion:'v0',
  }), /内容版本/);
});

test('草案入口只落父Case，不生成或启动任何执行Case', async () => {
  const adapter = new FakePaperclipAdapter();
  const batch = buildCampaignCaseBatch({
    campaignId: 'm5-draft-only',
    startDate: '2026-08-08',
    themes: Array.from({ length: 7 }, (_, index) => `主题${index + 1}`),
  });
  const first = await ingestCampaignDraftCase(adapter, uuid(99), batch);
  const second = await ingestCampaignDraftCase(adapter, uuid(99), batch);
  assert.equal(adapter.state.cases.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(first.stageKey, 'draft');
  assert.equal(adapter.calls.filter((call) => call.action === 'ingest-case').length, 1);
});

test('Fake adapter按父活动、日期、平台三层落22个Case并复用caseKey', async () => {
  const adapter = new FakePaperclipAdapter();
  const batch = buildCampaignCaseBatch({
    campaignId: 'm5-fake',
    startDate: '2026-08-08',
    themes: Array.from({ length: 7 }, (_, index) => `主题${index + 1}`),
  });
  const first = await ingestCampaignCaseBatch(adapter, uuid(99), batch);
  const second = await ingestCampaignCaseBatch(adapter, uuid(99), batch);
  assert.equal(adapter.state.cases.length, 22);
  assert.equal(first.parent.id, second.parent.id);
  assert.equal(first.days.length, 7);
  assert.equal(first.platformCases.length, 14);
  assert.ok(first.days.every((item) => item.parentCaseId === first.parent.id));
  assert.ok(adapter.state.cases.every((item) => item.stageKey === 'draft'));
});

test('并行工作批次按join父子树落Case、设置五项blocker并可幂等修复', async () => {
  const pipelineId = uuid(99);
  const dayCase = {
    id:uuid(80),
    pipelineId,
    caseKey:'m5-parallel-ingest:2026-08-08',
    stageKey:'draft',
    version:1,
  };
  const adapter = new FakePaperclipAdapter({ cases:[dayCase] });
  const batch = buildParallelWorkCaseBatch({
    campaignId:'m5-parallel-ingest',
    scheduledDate:'2026-08-08',
  });

  const first = await ingestParallelWorkCaseBatch(adapter, pipelineId, batch, dayCase);
  const second = await ingestParallelWorkCaseBatch(adapter, pipelineId, batch, dayCase);

  assert.equal(adapter.state.cases.length, 7);
  assert.equal(first.join.id, second.join.id);
  assert.equal(first.join.parentCaseId, dayCase.id);
  assert.equal(first.branches.length, 5);
  assert.ok(first.branches.every((item) => item.parentCaseId === first.join.id));
  assert.deepEqual(
    [...first.join.blockedByCaseIds].sort(),
    first.branches.map((item) => item.id).sort(),
  );
  assert.equal(
    adapter.calls.filter((call) => call.action === 'ingest-case').length,
    6,
  );

  const overflow = structuredClone(batch);
  overflow.branches.push({
    ...structuredClone(batch.branches[0]),
    caseKey:`${batch.branches[0].caseKey}:overflow`,
  });
  await assert.rejects(
    ingestParallelWorkCaseBatch(adapter, pipelineId, overflow, dayCase),
    /固定为5个分支/,
  );
  assert.equal(adapter.state.cases.length, 7);
});
