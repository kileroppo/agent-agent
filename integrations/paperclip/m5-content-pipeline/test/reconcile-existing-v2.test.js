import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpPaperclipAdapter,
  M5_EXISTING_V2_RECONCILE_CONFIRMATION,
  M5_EXISTING_V2_RECOVERY_CONFIRMATION,
  applyExistingM5V2Reconcile,
  buildBootstrapPlan,
  buildM5V2CloneDefinition,
  createM5V2ProgressJournalAppender,
  defaultDefinition,
  inspectExistingM5V2Reconcile,
  recoverExistingM5V2Reconcile,
  writeM5V2RollbackSnapshotFile,
} from '../src/index.ts';

test('existing v2 dry-run 精确报告三处 diff，且全程只有 GET', async () => {
  const fixture = buildFixture();
  const harness = createHttpHarness(fixture);
  const audit = await inspectExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
    now:() => new Date('2026-07-30T12:00:00.000Z'),
  });

  assert.equal(audit.preconditionsPassed, true);
  assert.equal(audit.writesToLivePaperclip, false);
  assert.deepEqual(audit.states, {
    assets:'legacy',
    visualAnalysis:'missing',
    transitions:'legacy',
    campaignGrantStatus:'draft',
    cronEnabled:false,
  });
  assert.deepEqual(audit.diff.createRoutine.map((item) => item.key), [
    'm5-visual-analysis',
  ]);
  assert.deepEqual(audit.diff.updateRoutine.map((item) => item.key), ['m5-assets']);
  assert.equal(audit.diff.updateTransitions, true);
  assert.equal(audit.diff.transitionCount, 18);
  assert.equal(audit.diff.unchangedRoutines, 16);
  assert.equal(audit.diff.unchangedStages, 16);
  assert.equal(audit.rollbackSnapshot.assetsRoutine.priorRevisionId, 'revision-assets-old');
  assert.equal(
    audit.rollbackSnapshot.pipelineTransitions.oldTransitions.find((item) =>
      item.fromStageKey === 'parallel_join_gate' && item.toStageKey === 'render'
    ).label,
    '四分支汇聚完成',
  );
  assert.match(audit.rollbackSnapshot.sha256, /^[a-f0-9]{64}$/);
  assert.ok(harness.calls.length > 0);
  assert.ok(harness.calls.every((call) => call.method === 'GET'));
});

test('existing v2 dry-run 忽略已归档的历史 Routine，但不删除其记录', async () => {
  const fixture = buildFixture();
  fixture.routines.push({
    id:uuid(999),
    companyId:fixture.companyId,
    projectId:fixture.project.id,
    goalId:fixture.project.goalId,
    title:'M5 / 历史研究入口',
    description:'[agent-army:m5:deployment:m5-ai-agent-content-v2:routine:m5-research] 已归档历史入口。',
    status:'archived',
    variables:[],
    triggers:[],
    latestRevisionId:'revision-archived-history',
  });
  const harness = createHttpHarness(fixture);
  const audit = await inspectExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
  });

  assert.equal(audit.preconditionsPassed, true);
  assert.equal(
    audit.blockers.some((item) => item.code === 'unexpected_v2_routine'),
    false,
  );
  assert.equal(audit.checks.routineCount, 17);
  assert.equal(
    fixture.routines.find((item) => item.id === uuid(999)).status,
    'archived',
  );
  assert.ok(harness.calls.every((call) => call.method === 'GET'));
});

test('existing v2 apply 先落回滚快照且只执行 assets PATCH、visual POST、18 transitions PUT', async () => {
  const fixture = buildFixture();
  const harness = createHttpHarness(fixture);
  const snapshots = [];
  const progressEvents = [];
  const result = await applyExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
    confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
    writeRollbackSnapshot:async (snapshot) => {
      assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
      snapshots.push(structuredClone(snapshot));
      return '/tmp/m5-v2-rollback.json';
    },
    appendRecoveryProgress:async (event) => {
      progressEvents.push(structuredClone(event));
      return '/tmp/m5-v2-progress.jsonl';
    },
    now:() => new Date('2026-07-30T12:00:00.000Z'),
  });

  assert.equal(snapshots.length, 1);
  assert.deepEqual(progressEvents.map((item) => item.type), [
    'apply_started',
    'operation_succeeded',
    'operation_succeeded',
    'operation_succeeded',
    'apply_completed',
  ]);
  assert.equal(result.alreadyReconciled, false);
  assert.deepEqual(result.operations.map((item) => `${item.method}:${item.resource}`), [
    'PATCH:routine',
    'POST:routine',
    'PUT:pipeline-transitions',
  ]);
  const writes = harness.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [
    `PATCH /api/routines/${fixture.assetsRoutineId}`,
    `POST /api/companies/${fixture.companyId}/routines`,
    `PUT /api/pipelines/${fixture.pipeline.id}/transitions`,
  ]);
  assert.equal(
    writes.some((call) =>
      /budget|trigger|case|campaign|agent/.test(call.path)
    ),
    false,
  );
  assert.equal(writes[0].body.baseRevisionId, 'revision-assets-old');
  assert.equal(writes[1].body.title, 'M5 / 并行画面分析');
  assert.equal(writes[1].body.assigneeAgentId, fixture.visualAgentId);
  assert.equal(writes[2].body.transitions.length, 18);
  assert.equal(writes[2].body.enforceTransitions, true);
  assert.deepEqual(result.verification, {
    preconditionsPassed:true,
    routineCount:18,
    stageCount:16,
    transitionCount:18,
    cronEnabled:false,
    campaignGrantStatus:'draft',
  });

  const writesBeforeReplay = harness.calls.filter((call) => call.method !== 'GET').length;
  let replaySnapshotCalls = 0;
  const replay = await applyExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
    confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
    writeRollbackSnapshot:async () => {
      replaySnapshotCalls += 1;
      return true;
    },
    appendRecoveryProgress:async () => true,
  });
  assert.equal(replay.alreadyReconciled, true);
  assert.deepEqual(replay.operations, []);
  assert.equal(replaySnapshotCalls, 0);
  assert.equal(
    harness.calls.filter((call) => call.method !== 'GET').length,
    writesBeforeReplay,
  );
});

test('existing v2 apply 缺确认、快照失败或 Campaign 非纯净草案时零写入', async (t) => {
  await t.test('缺精确确认串', async () => {
    const fixture = buildFixture();
    const harness = createHttpHarness(fixture);
    await assert.rejects(
      applyExistingM5V2Reconcile({
        adapter:harness.adapter,
        definition:defaultDefinition,
        pipelineId:fixture.pipeline.id,
        projectId:fixture.project.id,
        confirmation:'wrong',
        writeRollbackSnapshot:async () => true,
        appendRecoveryProgress:async () => true,
      }),
      /精确确认串/,
    );
    assert.equal(harness.calls.length, 0);
  });

  await t.test('回滚快照未落盘', async () => {
    const fixture = buildFixture();
    const harness = createHttpHarness(fixture);
    await assert.rejects(
      applyExistingM5V2Reconcile({
        adapter:harness.adapter,
        definition:defaultDefinition,
        pipelineId:fixture.pipeline.id,
        projectId:fixture.project.id,
        confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
        writeRollbackSnapshot:async () => false,
        appendRecoveryProgress:async () => true,
      }),
      /回滚快照未确认落盘/,
    );
    assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
  });

  await t.test('Campaign 已激活', async () => {
    const fixture = buildFixture();
    fixture.cases[0].case.fields.campaignGrant.status = 'active';
    const harness = createHttpHarness(fixture);
    let snapshotCalls = 0;
    await assert.rejects(
      applyExistingM5V2Reconcile({
        adapter:harness.adapter,
        definition:defaultDefinition,
        pipelineId:fixture.pipeline.id,
        projectId:fixture.project.id,
        confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
        writeRollbackSnapshot:async () => {
          snapshotCalls += 1;
          return true;
        },
        appendRecoveryProgress:async () => true,
      }),
      /campaign_not_pristine_draft/,
    );
    assert.equal(snapshotCalls, 0);
    assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
  });
});

test('existing v2 专用对账拒绝顺手修复其他 Routine 或未知 transition 漂移', async () => {
  const fixture = buildFixture();
  const unrelated = fixture.routines.find((item) =>
    item.description.includes(':routine:m5-script]')
  );
  unrelated.title = '被外部改过的脚本 Routine';
  fixture.pipeline.transitions[0].label = '未知路线';
  const harness = createHttpHarness(fixture);
  const audit = await inspectExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
  });

  assert.equal(audit.preconditionsPassed, false);
  assert.ok(audit.blockers.some((item) => item.code === 'unrelated_routine_drift'));
  assert.ok(audit.blockers.some((item) => item.code === 'transition_unexpected_drift'));
  assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
});

test('回滚快照文件使用绝对路径、0600 和 wx，拒绝覆盖既有文件', async () => {
  const fixture = buildFixture();
  const harness = createHttpHarness(fixture);
  const audit = await inspectExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
  });
  const directory = await mkdtemp(join(tmpdir(), 'm5-v2-reconcile-'));
  const output = join(directory, 'rollback.json');
  const progressOutput = join(directory, 'progress.jsonl');
  try {
    await assert.rejects(
      writeM5V2RollbackSnapshotFile('relative.json', audit.rollbackSnapshot),
      /绝对路径/,
    );
    await writeM5V2RollbackSnapshotFile(output, audit.rollbackSnapshot);
    const stored = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(stored.sha256, audit.rollbackSnapshot.sha256);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(
      writeM5V2RollbackSnapshotFile(output, audit.rollbackSnapshot),
      (error) => error?.code === 'EEXIST',
    );
    const appendProgress = createM5V2ProgressJournalAppender(progressOutput);
    await appendProgress({ type:'first', sequence:1 });
    await appendProgress({ type:'second', sequence:2 });
    await appendProgress.close();
    const progressLines = (await readFile(progressOutput, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(progressLines.map((item) => item.type), ['first', 'second']);
    assert.equal((await stat(progressOutput)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive:true, force:true });
  }
});

for (const scenario of [
  {
    fault:'assets_after_commit',
    expectedCompleted:[],
    expectedRecovery:['PATCH:routine:m5-assets'],
  },
  {
    fault:'visual_after_commit',
    expectedCompleted:['assets_patch'],
    expectedRecovery:[
      'PATCH:routine:m5-visual-analysis',
      'PATCH:routine:m5-assets',
    ],
  },
  {
    fault:'transitions_after_commit',
    expectedCompleted:['assets_patch', 'visual_create'],
    expectedRecovery:[
      'PUT:pipeline-transitions:',
      'PATCH:routine:m5-visual-analysis',
      'PATCH:routine:m5-assets',
    ],
  },
  {
    fault:'post_verification',
    expectedCompleted:['assets_patch', 'visual_create', 'transitions_put'],
    expectedRecovery:[
      'PUT:pipeline-transitions:',
      'PATCH:routine:m5-visual-analysis',
      'PATCH:routine:m5-assets',
    ],
  },
]) {
  test(`部分失败 ${scenario.fault} 生成 recovery_required 并可逆序幂等恢复`, async () => {
    const fixture = buildFixture();
    const harness = createHttpHarness(fixture, { fault:scenario.fault });
    const progressEvents = [];
    let snapshot = null;
    let error = null;
    await assert.rejects(
      applyExistingM5V2Reconcile({
        adapter:harness.adapter,
        definition:defaultDefinition,
        pipelineId:fixture.pipeline.id,
        projectId:fixture.project.id,
        confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
        writeRollbackSnapshot:async (value) => {
          snapshot = structuredClone(value);
          return '/tmp/m5-v2-rollback.json';
        },
        appendRecoveryProgress:async (event) => {
          progressEvents.push(structuredClone(event));
          return '/tmp/m5-v2-progress.jsonl';
        },
      }),
      (candidate) => {
        error = candidate;
        return candidate?.code === 'M5_V2_RECOVERY_REQUIRED';
      },
    );
    assert.equal(error.recovery_required, true);
    assert.deepEqual(
      error.recovery.completedOperations.map((item) =>
        item.resource === 'pipeline-transitions'
          ? 'transitions_put'
          : item.key === 'm5-assets'
            ? 'assets_patch'
            : 'visual_create'
      ),
      scenario.expectedCompleted,
    );
    assert.equal(progressEvents.at(-1).type, 'recovery_required');
    assert.equal(snapshot.schemaVersion, 'agent.army/m5-existing-v2-rollback/v2');
    assert.match(snapshot.assetsRoutine.oldPayloadSha256, /^[a-f0-9]{64}$/);
    assert.match(snapshot.assetsRoutine.targetPayloadSha256, /^[a-f0-9]{64}$/);
    assert.match(snapshot.visualRoutine.targetPayloadSha256, /^[a-f0-9]{64}$/);
    assert.match(snapshot.pipelineTransitions.oldTransitionsSha256, /^[a-f0-9]{64}$/);
    assert.match(snapshot.pipelineTransitions.targetTransitionsSha256, /^[a-f0-9]{64}$/);

    const writesBeforeRecovery = harness.calls.filter((call) => call.method !== 'GET').length;
    const recovered = await recoverExistingM5V2Reconcile({
      adapter:harness.adapter,
      snapshot,
      confirmation:M5_EXISTING_V2_RECOVERY_CONFIRMATION,
      appendRecoveryProgress:async (event) => {
        progressEvents.push(structuredClone(event));
        return '/tmp/m5-v2-progress.jsonl';
      },
    });
    assert.deepEqual(recovered.states, {
      transitions:'old',
      visual:'old',
      assets:'old',
    });
    assert.deepEqual(
      recovered.operations.map((item) =>
        `${item.method}:${item.resource}:${item.key ?? ''}`
      ),
      scenario.expectedRecovery,
    );
    const recoveryWrites = harness.calls
      .filter((call) => call.method !== 'GET')
      .slice(writesBeforeRecovery);
    for (const write of recoveryWrites.filter((item) => item.method === 'PATCH')) {
      assert.match(write.body.baseRevisionId, /^revision-/);
    }

    const writesBeforeReplay = harness.calls.filter((call) => call.method !== 'GET').length;
    const replay = await recoverExistingM5V2Reconcile({
      adapter:harness.adapter,
      snapshot,
      confirmation:M5_EXISTING_V2_RECOVERY_CONFIRMATION,
      appendRecoveryProgress:async () => true,
    });
    assert.equal(replay.alreadyRecovered, true);
    assert.deepEqual(replay.operations, []);
    assert.equal(
      harness.calls.filter((call) => call.method !== 'GET').length,
      writesBeforeReplay,
    );
  });
}

test('recover 三态判定遇到未知 assets 漂移时在任何恢复写入前停止', async () => {
  const fixture = buildFixture();
  const harness = createHttpHarness(fixture);
  const audit = await inspectExistingM5V2Reconcile({
    adapter:harness.adapter,
    definition:defaultDefinition,
    pipelineId:fixture.pipeline.id,
    projectId:fixture.project.id,
  });
  const assets = fixture.routines.find((item) => item.id === fixture.assetsRoutineId);
  assets.title = '未知第三方修改';
  assets.latestRevisionId = 'revision-third-party';
  const writesBefore = harness.calls.filter((call) => call.method !== 'GET').length;
  await assert.rejects(
    recoverExistingM5V2Reconcile({
      adapter:harness.adapter,
      snapshot:audit.rollbackSnapshot,
      confirmation:M5_EXISTING_V2_RECOVERY_CONFIRMATION,
      appendRecoveryProgress:async () => true,
    }),
    (error) => error?.code === 'M5_V2_RECOVERY_BLOCKED'
      && error.recovery.blockers.some((item) =>
        item.code === 'recovery_assets_unexpected_drift'
      ),
  );
  assert.equal(
    harness.calls.filter((call) => call.method !== 'GET').length,
    writesBefore,
  );
});

function buildFixture() {
  const companyId = uuid(1);
  const projectId = uuid(2);
  const pipelineId = uuid(3);
  const goalId = uuid(4);
  const target = buildM5V2CloneDefinition(defaultDefinition);
  const businessOwners = [
    'ajun',
    'operator',
    'content-creator',
    'reviewer',
    'office-assistant',
    'intel-researcher',
    'xiaod',
    'video-content-analyst',
  ];
  const agentIds = Object.fromEntries(
    businessOwners.map((owner, index) => [owner, uuid(10 + index)]),
  );
  const controllerBindings = {
    dailyControllerAgentId:uuid(30),
    metricsControllerAgentId:uuid(31),
    publisherControllerAgentId:uuid(32),
    retrospectiveControllerAgentId:uuid(33),
    parallelControllerAgentId:uuid(34),
    learningControllerAgentId:uuid(35),
  };
  const baseBindings = {
    agentIds,
    ...controllerBindings,
    resourceNamespace:target.key,
    projectId,
    goalId,
  };
  const initialPlan = buildBootstrapPlan(target, baseBindings);
  const allDesiredRoutines = [
    ...initialPlan.resources.routines,
    initialPlan.resources.scheduleRoutine,
  ];
  const routineIds = Object.fromEntries(
    allDesiredRoutines.map((item, index) => [item.key, uuid(100 + index)]),
  );
  const plan = buildBootstrapPlan(target, { ...baseBindings, routineIds });
  const desiredRoutines = [
    ...plan.resources.routines,
    plan.resources.scheduleRoutine,
  ];
  const routines = desiredRoutines
    .filter((item) => item.key !== 'm5-visual-analysis')
    .map((item) => ({
      id:routineIds[item.key],
      companyId,
      ...structuredClone(item.payload),
      variables:item.payload.variables.map((variable) => ({
        ...structuredClone(variable),
        defaultValue:null,
      })),
      latestRevisionId:item.key === 'm5-assets'
        ? 'revision-assets-old'
        : `revision-${item.key}`,
      triggers:item.key === 'm5-daily-campaign'
        ? [{
          id:'trigger-daily',
          ...structuredClone(plan.resources.scheduleTrigger),
          lastFiredAt:null,
        }]
        : [],
    }));
  const assets = routines.find((item) =>
    item.description.includes(':routine:m5-assets]')
  );
  assets.title = 'M5 / 并行画面分析';
  assets.description = assets.description.replace(
    '只处理素材和关键帧并写回 AssetPackage，不输出画面分析结论。',
    '完成素材和视觉证据处理并写回 AssetPackage。',
  );
  const stages = plan.resources.pipeline.payload.stages.map((stage) => ({
    id:uuid(200 + stage.position),
    pipelineId,
    ...structuredClone(stage),
  }));
  const stageIds = Object.fromEntries(stages.map((stage) => [stage.key, stage.id]));
  const transitions = plan.resources.pipeline.transitions.map((item, index) => ({
    id:uuid(300 + index),
    pipelineId,
    fromStageId:stageIds[item.fromStageKey],
    toStageId:stageIds[item.toStageKey],
    label:item.fromStageKey === 'parallel_join_gate'
      && item.toStageKey === 'render'
      ? '四分支汇聚完成'
      : item.label,
  }));
  const agents = [
    ...Object.entries(agentIds).map(([owner, id]) => ({
      id,
      status:'idle',
      metadata:{ agentArmyId:owner },
    })),
    ...Object.entries({
      'm5-daily-controller':controllerBindings.dailyControllerAgentId,
      'm5-metrics-controller':controllerBindings.metricsControllerAgentId,
      'm5-publisher-controller':controllerBindings.publisherControllerAgentId,
      'm5-retrospective-controller':controllerBindings.retrospectiveControllerAgentId,
      'm5-parallel-controller':controllerBindings.parallelControllerAgentId,
      'm5-learning-controller':controllerBindings.learningControllerAgentId,
    }).map(([role, id]) => ({
      id,
      status:'idle',
      metadata:{ agentArmySystemRole:role },
    })),
  ];
  return {
    companyId,
    project:{
      id:projectId,
      companyId,
      goalId,
      goalIds:[goalId],
      name:target.project.name,
      description:`[agent-army:m5:project:${target.project.key}] ${target.project.description}`,
      status:target.project.status,
    },
    pipeline:{
      id:pipelineId,
      companyId,
      ...structuredClone(plan.resources.pipeline.payload),
      stages,
      transitions,
    },
    routines,
    agents,
    cases:[{
      case:{
        id:uuid(400),
        pipelineId,
        parentCaseId:null,
        childCount:0,
        leaseToken:null,
        terminalKind:null,
        fields:{
          projectId,
          deploymentKey:target.key,
          campaignGrant:{ status:'draft' },
        },
      },
      stage:stages.find((item) => item.key === 'draft'),
      activeWork:null,
      descendantActiveWorkCount:0,
    }],
    assetsRoutineId:routineIds['m5-assets'],
    visualAgentId:agentIds['video-content-analyst'],
  };
}

function createHttpHarness(fixture, { fault = null } = {}) {
  const calls = [];
  let nextRevision = 1;
  let faultFired = false;
  const fetchImpl = async (url, init) => {
    const parsedUrl = new URL(url);
    const call = {
      method:init.method,
      path:parsedUrl.pathname,
      body:init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    try {
      return jsonResponse(handle(call));
    } catch (error) {
      return jsonResponse({ error:error.message }, 500);
    }
  };
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId:fixture.companyId,
    fetchImpl,
  });

  function handle(call) {
    const { method, path, body } = call;
    if (method === 'GET' && path === `/api/pipelines/${fixture.pipeline.id}`) {
      return structuredClone(fixture.pipeline);
    }
    if (method === 'GET' && path === `/api/projects/${fixture.project.id}`) {
      return structuredClone(fixture.project);
    }
    if (
      method === 'GET'
      && path === `/api/companies/${fixture.companyId}/routines`
    ) return structuredClone(fixture.routines);
    if (
      method === 'GET'
      && path === `/api/companies/${fixture.companyId}/agents`
    ) {
      if (
        fault === 'post_verification'
        && !faultFired
        && calls.filter((item) => item.method !== 'GET').length >= 3
      ) {
        faultFired = true;
        throw new Error('injected post verification failure');
      }
      return structuredClone(fixture.agents);
    }
    if (
      method === 'GET'
      && path === `/api/pipelines/${fixture.pipeline.id}/cases`
    ) return structuredClone(fixture.cases);
    const routineMatch = path.match(/^\/api\/routines\/([^/]+)$/);
    if (method === 'GET' && routineMatch) {
      return structuredClone(findRoutine(routineMatch[1]));
    }
    const runMatch = path.match(/^\/api\/routines\/([^/]+)\/runs$/);
    if (method === 'GET' && runMatch) {
      findRoutine(runMatch[1]);
      return [];
    }
    if (method === 'PATCH' && routineMatch) {
      const routine = findRoutine(routineMatch[1]);
      assert.equal(body.baseRevisionId, routine.latestRevisionId);
      const { baseRevisionId: _baseRevisionId, ...patch } = body;
      Object.assign(routine, structuredClone(patch), {
        latestRevisionId:`revision-next-${nextRevision++}`,
        ...(patch.variables
          ? {
            variables:patch.variables.map((variable) => ({
              ...structuredClone(variable),
              defaultValue:null,
            })),
          }
          : {}),
      });
      if (
        fault === 'assets_after_commit'
        && !faultFired
        && routine.id === fixture.assetsRoutineId
      ) {
        faultFired = true;
        throw new Error('injected assets response loss');
      }
      return structuredClone(routine);
    }
    if (
      method === 'POST'
      && path === `/api/companies/${fixture.companyId}/routines`
    ) {
      const routine = {
        id:uuid(500),
        companyId:fixture.companyId,
        ...structuredClone(body),
        latestRevisionId:`revision-next-${nextRevision++}`,
        variables:body.variables.map((variable) => ({
          ...structuredClone(variable),
          defaultValue:null,
        })),
        triggers:[],
      };
      fixture.routines.push(routine);
      if (fault === 'visual_after_commit' && !faultFired) {
        faultFired = true;
        throw new Error('injected visual response loss');
      }
      return structuredClone(routine);
    }
    if (
      method === 'PUT'
      && path === `/api/pipelines/${fixture.pipeline.id}/transitions`
    ) {
      fixture.pipeline.transitions = body.transitions.map((item, index) => ({
        id:`transition-new-${index + 1}`,
        pipelineId:fixture.pipeline.id,
        fromStageKey:item.fromStageKey,
        toStageKey:item.toStageKey,
        label:item.label,
      }));
      if (fault === 'transitions_after_commit' && !faultFired) {
        faultFired = true;
        throw new Error('injected transitions response loss');
      }
      return { transitions:structuredClone(fixture.pipeline.transitions) };
    }
    throw new Error(`unexpected route: ${method} ${path}`);
  }

  function findRoutine(id) {
    const routine = fixture.routines.find((item) => item.id === id);
    if (!routine) throw new Error(`routine not found: ${id}`);
    return routine;
  }

  return { adapter, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers:{ 'content-type':'application/json' },
  });
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
