import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { buildM5V2CloneDefinition } from './migration.js';
import { buildBootstrapPlan, listM5RequiredAgentKeys } from './plan.js';
import {
  containsDeclared,
  pipelineHeaderMatchesDeclaration,
  routineMatchesDeclaration,
  stageMatchesDeclaration,
} from './reconcile.js';

export const M5_EXISTING_V2_RECONCILE_CONFIRMATION =
  'APPLY_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE';
export const M5_EXISTING_V2_RECOVERY_CONFIRMATION =
  'RECOVER_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE';

export class M5V2RecoveryRequiredError extends Error {
  constructor(message, recovery) {
    super(message);
    this.name = 'M5V2RecoveryRequiredError';
    this.code = 'M5_V2_RECOVERY_REQUIRED';
    this.recovery_required = true;
    this.recovery = recovery;
  }
}

const SYSTEM_CONTROLLER_BINDINGS = {
  'm5-daily-controller':'dailyControllerAgentId',
  'm5-metrics-controller':'metricsControllerAgentId',
  'm5-publisher-controller':'publisherControllerAgentId',
  'm5-retrospective-controller':'retrospectiveControllerAgentId',
  'm5-learning-controller':'learningControllerAgentId',
  'm5-parallel-controller':'parallelControllerAgentId',
};

export async function writeM5V2RollbackSnapshotFile(filePath, snapshot) {
  if (!isAbsolute(filePath)) throw new Error('回滚快照路径必须是绝对路径');
  if (
    snapshot?.schemaVersion !== 'agent.army/m5-existing-v2-rollback/v2'
    || !/^[a-f0-9]{64}$/.test(String(snapshot?.sha256 || ''))
  ) {
    throw new Error('回滚快照结构或哈希无效');
  }
  await writeFile(
    filePath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { encoding:'utf8', flag:'wx', mode:0o600 },
  );
  return filePath;
}

export function createM5V2ProgressJournalAppender(filePath, { append = false } = {}) {
  if (!isAbsolute(filePath)) throw new Error('进度 journal 路径必须是绝对路径');
  let handle = null;
  const appendEvent = async (event) => {
    if (!handle) handle = await open(filePath, append ? 'a' : 'wx', 0o600);
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
    return filePath;
  };
  appendEvent.close = async () => {
    if (!handle) return;
    await handle.close();
    handle = null;
  };
  appendEvent.path = filePath;
  return appendEvent;
}

export async function inspectExistingM5V2Reconcile({
  adapter,
  definition,
  pipelineId,
  projectId,
  now = () => new Date(),
} = {}) {
  assertInputs({ adapter, definition, pipelineId, projectId });
  const targetDefinition = toV2Definition(definition);
  const blockers = [];
  const [
    pipelineDocument,
    projectDocument,
    routineDocument,
    caseDocument,
    agentDocument,
  ] = await Promise.all([
    adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}`),
    adapter.request('GET', `/api/projects/${encodeURIComponent(projectId)}`),
    adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(adapter.companyId)}/routines`,
    ),
    adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}/cases`),
    adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(adapter.companyId)}/agents`,
    ),
  ]);
  const pipeline = unwrap(pipelineDocument, 'pipeline');
  const project = unwrap(projectDocument, 'project');
  const routines = rows(routineDocument).filter((item) => item.projectId === projectId);
  const agents = rows(agentDocument);
  const cases = rows(caseDocument);

  check(
    blockers,
    pipeline?.id === pipelineId
      && pipeline?.key === targetDefinition.key
      && pipeline?.projectId === projectId,
    'target_identity_mismatch',
    '目标必须是传入 project 下的既有 m5 v2 Pipeline',
  );
  check(
    blockers,
    project?.id === projectId
      && String(project?.description || '').includes(
        `[agent-army:m5:project:${targetDefinition.project.key}]`,
      ),
    'project_identity_mismatch',
    'Project 缺少目标 v2 marker 或 ID 不匹配',
  );

  const goalIds = unique([
    ...(Array.isArray(project?.goalIds) ? project.goalIds : []),
    ...(project?.goalId ? [project.goalId] : []),
  ]);
  check(
    blockers,
    goalIds.length === 1,
    'project_goal_ambiguous',
    `v2 Project 必须且只能绑定一个 Goal，当前为 ${goalIds.length} 个`,
  );
  const goalId = goalIds[0] ?? null;

  const agentBindings = resolveExactAgentBindings({
    agents,
    definition:targetDefinition,
    blockers,
  });
  const governedRoutines = routines.filter((item) => item.status !== 'archived');
  const routineIndex = indexVersionedRoutines({
    routines:governedRoutines,
    namespace:targetDefinition.key,
    blockers,
  });
  const routineIds = Object.fromEntries(
    [...routineIndex.entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([key, matches]) => [key, matches[0].id]),
  );
  const plan = buildBootstrapPlan(targetDefinition, {
    ...agentBindings,
    resourceNamespace:targetDefinition.key,
    projectId,
    goalId,
    routineIds,
  });
  const desiredRoutines = [
    ...plan.resources.routines,
    plan.resources.scheduleRoutine,
  ];
  const desiredKeys = new Set(desiredRoutines.map((item) => item.key));
  const unexpectedKeys = [...routineIndex.keys()].filter((key) => !desiredKeys.has(key));
  check(
    blockers,
    unexpectedKeys.length === 0,
    'unexpected_v2_routine',
    `v2 Project 存在未声明 Routine: ${unexpectedKeys.join(', ')}`,
  );

  const routineDetails = new Map();
  for (const routine of governedRoutines) {
    const detail = await adapter.request(
      'GET',
      `/api/routines/${encodeURIComponent(routine.id)}`,
    );
    routineDetails.set(routine.id, unwrap(detail, 'routine'));
  }

  const desiredByKey = new Map(desiredRoutines.map((item) => [item.key, item]));
  const assetsDesired = desiredByKey.get('m5-assets');
  const visualDesired = desiredByKey.get('m5-visual-analysis');
  const assetsMatches = routineIndex.get('m5-assets') ?? [];
  const visualMatches = routineIndex.get('m5-visual-analysis') ?? [];

  check(
    blockers,
    assetsMatches.length === 1,
    'assets_routine_not_unique',
    `m5-assets 必须唯一，当前为 ${assetsMatches.length} 条`,
  );
  check(
    blockers,
    visualMatches.length <= 1,
    'visual_routine_not_unique',
    `m5-visual-analysis 至多一条，当前为 ${visualMatches.length} 条`,
  );

  const assets = assetsMatches[0]
    ? routineDetails.get(assetsMatches[0].id)
    : null;
  const visual = visualMatches[0]
    ? routineDetails.get(visualMatches[0].id)
    : null;
  const legacyAssetsPayload = assetsDesired
    ? buildLegacyAssetsPayload(assetsDesired.payload)
    : null;
  const assetsState = assets && assetsDesired
    ? routineMatchesDeclaration(assets, assetsDesired.payload)
      ? 'desired'
      : routineMatchesDeclaration(assets, legacyAssetsPayload)
        ? 'legacy'
        : 'unexpected'
    : 'missing';
  check(
    blockers,
    ['desired', 'legacy'].includes(assetsState) && assets?.env == null,
    'assets_unexpected_drift',
    'm5-assets 不是已知旧声明/目标声明或含未声明 env，拒绝覆盖',
  );

  const visualState = visual && visualDesired
    ? routineMatchesDeclaration(visual, visualDesired.payload)
      ? 'desired'
      : 'unexpected'
    : 'missing';
  check(
    blockers,
    ['desired', 'missing'].includes(visualState) && (!visual || visual.env == null),
    'visual_unexpected_drift',
    '既有 m5-visual-analysis 与目标声明不一致或含未声明 env',
  );

  for (const desired of desiredRoutines) {
    if (['m5-assets', 'm5-visual-analysis'].includes(desired.key)) continue;
    const matches = routineIndex.get(desired.key) ?? [];
    if (matches.length !== 1) {
      blockers.push({
        code:'routine_identity_mismatch',
        detail:`${desired.key} 必须唯一，当前为 ${matches.length} 条`,
      });
      continue;
    }
    const detail = routineDetails.get(matches[0].id);
    check(
      blockers,
      routineMatchesDeclaration(detail, desired.payload),
      'unrelated_routine_drift',
      `${desired.key} 与声明不一致；专用对账拒绝顺带修改`,
    );
  }

  const pipelineHeaderMatches = pipelineHeaderMatchesDeclaration(
    pipeline,
    plan.resources.pipeline.payload,
  );
  const stageDrift = plan.resources.pipeline.payload.stages
    .filter((desired) => {
      const actual = pipeline?.stages?.find((item) => item.key === desired.key);
      return !actual || !stageMatchesDeclaration(actual, desired);
    })
    .map((item) => item.key);
  const unexpectedStages = (pipeline?.stages ?? [])
    .filter((actual) =>
      !plan.resources.pipeline.payload.stages.some((item) => item.key === actual.key)
    )
    .map((item) => item.key);
  check(
    blockers,
    pipelineHeaderMatches && stageDrift.length === 0 && unexpectedStages.length === 0,
    'pipeline_declaration_drift',
    `Pipeline header/stage 漂移: missing-or-drift=${stageDrift.join(',') || 'none'}; unexpected=${unexpectedStages.join(',') || 'none'}`,
  );

  const liveTransitions = logicalTransitions(pipeline);
  const desiredTransitions = structuredClone(plan.resources.pipeline.transitions);
  const legacyTransitions = desiredTransitions.map((item) =>
    item.fromStageKey === 'parallel_join_gate'
      && item.toStageKey === 'render'
      && item.label === '五分支汇聚完成'
      ? { ...item, label:'四分支汇聚完成' }
      : item
  );
  const transitionState = transitionSetsEqual(liveTransitions, desiredTransitions)
    ? 'desired'
    : transitionSetsEqual(liveTransitions, legacyTransitions)
      ? 'legacy'
      : 'unexpected';
  check(
    blockers,
    ['desired', 'legacy'].includes(transitionState),
    'transition_unexpected_drift',
    'Pipeline transitions 不是已知四分支旧声明或五分支目标声明',
  );

  assertDraftCampaign({
    blockers,
    cases,
    projectId,
    deploymentKey:targetDefinition.key,
  });
  const daily = routineIndex.get('m5-daily-campaign')?.[0];
  const dailyDetail = daily ? routineDetails.get(daily.id) : null;
  const scheduleTriggers = (dailyDetail?.triggers ?? [])
    .filter((item) => item.kind === 'schedule');
  check(
    blockers,
    (dailyDetail?.triggers ?? []).length === 1
      && scheduleTriggers.length === 1
      && containsDeclared(scheduleTriggers[0], plan.resources.scheduleTrigger)
      && scheduleTriggers[0].enabled === false
      && scheduleTriggers[0].lastFiredAt == null,
    'daily_trigger_not_pristine_off',
    'v2 每日 Trigger 必须唯一、关闭且从未触发',
  );

  if (assets?.id) {
    const runs = rows(await adapter.request(
      'GET',
      `/api/routines/${encodeURIComponent(assets.id)}/runs?limit=1`,
    ));
    check(
      blockers,
      runs.length === 0,
      'assets_has_runs',
      'm5-assets 已有运行记录，拒绝自动改写声明',
    );
  }
  if (visual?.id) {
    const runs = rows(await adapter.request(
      'GET',
      `/api/routines/${encodeURIComponent(visual.id)}/runs?limit=1`,
    ));
    check(
      blockers,
      runs.length === 0,
      'visual_has_runs',
      'm5-visual-analysis 已有运行记录，拒绝对账',
    );
  }

  const diff = {
    createRoutine:visualState === 'missing'
      ? [{
        key:'m5-visual-analysis',
        marker:visualDesired?.marker,
        payload:visualDesired?.payload,
      }]
      : [],
    updateRoutine:assetsState === 'legacy'
      ? [{
        key:'m5-assets',
        id:assets.id,
        fromRevisionId:assets.latestRevisionId ?? null,
        payload:assetsDesired.payload,
      }]
      : [],
    updateTransitions:transitionState === 'legacy',
    transitionCount:desiredTransitions.length,
    unchangedRoutines:desiredRoutines.length
      - (visualState === 'missing' ? 1 : 0)
      - (assetsState === 'legacy' ? 1 : 0),
    unchangedStages:stageDrift.length === 0 && unexpectedStages.length === 0
      ? plan.resources.pipeline.payload.stages.length
      : 0,
  };
  const rollbackSnapshot = buildRollbackSnapshot({
    now,
    adapter,
    pipelineId,
    pipelineKey:targetDefinition.key,
    projectId,
    assets,
    assetsDesired,
    visual,
    visualDesired,
    liveTransitions,
    desiredTransitions,
  });

  return {
    schemaVersion:'agent.army/m5-existing-v2-reconcile-audit/v1',
    mode:'dry-run',
    target:{
      companyId:adapter.companyId,
      pipelineId,
      pipelineKey:targetDefinition.key,
      projectId,
      goalId,
    },
    states:{
      assets:assetsState,
      visualAnalysis:visualState,
      transitions:transitionState,
      campaignGrantStatus:campaignGrantStatus(cases),
      cronEnabled:scheduleTriggers[0]?.enabled ?? null,
    },
    checks:{
      routineCount:governedRoutines.length,
      expectedRoutineCount:desiredRoutines.length,
      stageCount:pipeline?.stages?.length ?? null,
      transitionCount:liveTransitions.length,
    },
    blockers,
    preconditionsPassed:blockers.length === 0,
    diff,
    desired:{
      assetsRoutine:assetsDesired,
      visualRoutine:visualDesired,
      transitions:desiredTransitions,
    },
    rollbackSnapshot,
    writesToLivePaperclip:false,
    confirmation:M5_EXISTING_V2_RECONCILE_CONFIRMATION,
  };
}

export async function applyExistingM5V2Reconcile({
  adapter,
  definition,
  pipelineId,
  projectId,
  confirmation,
  writeRollbackSnapshot,
  appendRecoveryProgress,
  now = () => new Date(),
} = {}) {
  if (confirmation !== M5_EXISTING_V2_RECONCILE_CONFIRMATION) {
    throw new Error('现有 M5 v2 对账缺少精确确认串');
  }
  if (typeof writeRollbackSnapshot !== 'function') {
    throw new Error('live 对账必须先提供回滚快照写入器');
  }
  if (typeof appendRecoveryProgress !== 'function') {
    throw new Error('live 对账必须提供 fsync 进度 journal');
  }
  const audit = await inspectExistingM5V2Reconcile({
    adapter,
    definition,
    pipelineId,
    projectId,
    now,
  });
  if (!audit.preconditionsPassed) {
    throw new Error(
      `现有 M5 v2 对账前置检查失败: ${audit.blockers.map((item) => item.code).join(', ')}`,
    );
  }
  const hasWrites = audit.diff.createRoutine.length > 0
    || audit.diff.updateRoutine.length > 0
    || audit.diff.updateTransitions;
  if (!hasWrites) {
    return { ...audit, mode:'apply', operations:[], alreadyReconciled:true };
  }
  const snapshotLocation = await writeRollbackSnapshot(audit.rollbackSnapshot);
  if (!snapshotLocation) throw new Error('回滚快照未确认落盘，拒绝 live 写入');
  const startedAt = now().toISOString();
  await appendRecoveryProgress({
    schemaVersion:'agent.army/m5-existing-v2-progress/v1',
    type:'apply_started',
    at:startedAt,
    snapshotSha256:audit.rollbackSnapshot.sha256,
    snapshotLocation,
  });
  const operations = [];
  let attemptedStep = null;
  try {
    for (const update of audit.diff.updateRoutine) {
      attemptedStep = 'assets_patch';
      const result = await adapter.reconcileRoutine({ id:update.id }, update.payload);
      if (!result.updated) throw new Error('m5-assets 在写入前发生变化，拒绝继续');
      const operation = {
        method:'PATCH',
        resource:'routine',
        key:update.key,
        id:update.id,
        revisionId:result.resource.latestRevisionId ?? null,
        targetPayloadSha256:audit.rollbackSnapshot.assetsRoutine.targetPayloadSha256,
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }
    for (const create of audit.diff.createRoutine) {
      attemptedStep = 'visual_create';
      const resource = await adapter.create('routine', create.payload);
      const operation = {
        method:'POST',
        resource:'routine',
        key:create.key,
        id:resource.id,
        revisionId:resource.latestRevisionId ?? null,
        targetPayloadSha256:audit.rollbackSnapshot.visualRoutine.targetPayloadSha256,
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }
    if (audit.diff.updateTransitions) {
      attemptedStep = 'transitions_put';
      const currentDocument = await adapter.request(
        'GET',
        `/api/pipelines/${encodeURIComponent(pipelineId)}`,
      );
      const current = unwrap(currentDocument, 'pipeline');
      if (!transitionSetsEqual(
        logicalTransitions(current),
        audit.rollbackSnapshot.pipelineTransitions.oldTransitions,
      )) {
        throw new Error('Pipeline transitions 在写入前发生变化，拒绝覆盖');
      }
      await adapter.setPipelineTransitions(
        pipelineId,
        audit.desired.transitions,
      );
      const operation = {
        method:'PUT',
        resource:'pipeline-transitions',
        id:pipelineId,
        count:audit.desired.transitions.length,
        targetTransitionsSha256:
          audit.rollbackSnapshot.pipelineTransitions.targetTransitionsSha256,
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }

    attemptedStep = 'post_write_verification';
    const verification = await inspectExistingM5V2Reconcile({
      adapter,
      definition,
      pipelineId,
      projectId,
      now,
    });
    if (
      !verification.preconditionsPassed
      || verification.diff.createRoutine.length > 0
      || verification.diff.updateRoutine.length > 0
      || verification.diff.updateTransitions
    ) {
      throw new Error('现有 M5 v2 对账写后回读失败');
    }
    await appendRecoveryProgress({
      schemaVersion:'agent.army/m5-existing-v2-progress/v1',
      type:'apply_completed',
      at:now().toISOString(),
      snapshotSha256:audit.rollbackSnapshot.sha256,
      completedOperations:structuredClone(operations),
    });
    return {
      mode:'apply',
      operations,
      alreadyReconciled:false,
      rollbackSnapshot:audit.rollbackSnapshot,
      verification:{
        preconditionsPassed:true,
        routineCount:verification.checks.routineCount,
        stageCount:verification.checks.stageCount,
        transitionCount:verification.checks.transitionCount,
        cronEnabled:verification.states.cronEnabled,
        campaignGrantStatus:verification.states.campaignGrantStatus,
      },
    };
  } catch (error) {
    const recovery = {
      snapshotSha256:audit.rollbackSnapshot.sha256,
      snapshotLocation,
      attemptedStep,
      completedOperations:structuredClone(operations),
      cause:safeErrorMessage(error),
    };
    try {
      await appendRecoveryProgress({
        schemaVersion:'agent.army/m5-existing-v2-progress/v1',
        type:'recovery_required',
        at:now().toISOString(),
        ...recovery,
      });
    } catch (journalError) {
      recovery.journalError = safeErrorMessage(journalError);
    }
    throw new M5V2RecoveryRequiredError(
      `M5 v2 对账部分失败，需要按快照恢复: ${recovery.cause}`,
      recovery,
    );
  }
}

export async function recoverExistingM5V2Reconcile({
  adapter,
  snapshot,
  confirmation,
  appendRecoveryProgress,
  now = () => new Date(),
} = {}) {
  if (confirmation !== M5_EXISTING_V2_RECOVERY_CONFIRMATION) {
    throw new Error('现有 M5 v2 恢复缺少精确确认串');
  }
  if (!adapter?.request || !adapter?.companyId) {
    throw new Error('现有 M5 v2 恢复需要已限定公司的 Paperclip adapter');
  }
  if (typeof appendRecoveryProgress !== 'function') {
    throw new Error('现有 M5 v2 恢复必须提供 fsync 进度 journal');
  }
  assertRollbackSnapshot(snapshot, adapter.companyId);
  const initial = await inspectRecoveryState({ adapter, snapshot });
  if (!initial.safeToRecover) {
    const error = new Error(
      `M5 v2 恢复遇到未知漂移: ${initial.blockers.map((item) => item.code).join(', ')}`,
    );
    error.code = 'M5_V2_RECOVERY_BLOCKED';
    error.recovery = initial;
    throw error;
  }
  const needsRecovery = Object.values(initial.states).some((state) => state === 'target');
  if (!needsRecovery) {
    return {
      mode:'recover',
      alreadyRecovered:true,
      operations:[],
      states:initial.states,
    };
  }
  await appendRecoveryProgress({
    schemaVersion:'agent.army/m5-existing-v2-progress/v1',
    type:'recovery_started',
    at:now().toISOString(),
    snapshotSha256:snapshot.sha256,
    states:initial.states,
  });

  const operations = [];
  let attemptedStep = null;
  try {
    if (initial.states.transitions === 'target') {
      attemptedStep = 'transitions_restore';
      const currentDocument = await adapter.request(
        'GET',
        `/api/pipelines/${encodeURIComponent(snapshot.pipelineId)}`,
      );
      const current = unwrap(currentDocument, 'pipeline');
      if (
        transitionsHash(logicalTransitions(current))
        !== snapshot.pipelineTransitions.targetTransitionsSha256
      ) {
        throw new Error('恢复前 transitions 已不再是本次 target 状态');
      }
      await adapter.setPipelineTransitions(
        snapshot.pipelineId,
        snapshot.pipelineTransitions.oldTransitions,
      );
      const operation = {
        method:'PUT',
        resource:'pipeline-transitions',
        id:snapshot.pipelineId,
        restoredTransitionsSha256:snapshot.pipelineTransitions.oldTransitionsSha256,
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }

    if (initial.states.visual === 'target') {
      attemptedStep = 'visual_archive';
      const currentDocument = await adapter.request(
        'GET',
        `/api/routines/${encodeURIComponent(initial.visual.id)}`,
      );
      const current = unwrap(currentDocument, 'routine');
      if (
        current.latestRevisionId !== initial.visual.latestRevisionId
        || payloadHash(normalizeRoutinePayload(current))
          !== snapshot.visualRoutine.targetPayloadSha256
      ) {
        throw new Error('恢复前 visual Routine revision 或 payload 已变化');
      }
      const resource = await adapter.request(
        'PATCH',
        `/api/routines/${encodeURIComponent(current.id)}`,
        { status:'archived', baseRevisionId:current.latestRevisionId },
      );
      const operation = {
        method:'PATCH',
        resource:'routine',
        key:'m5-visual-analysis',
        id:current.id,
        revisionId:resource.latestRevisionId ?? null,
        status:'archived',
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }

    if (initial.states.assets === 'target') {
      attemptedStep = 'assets_restore';
      const currentDocument = await adapter.request(
        'GET',
        `/api/routines/${encodeURIComponent(snapshot.assetsRoutine.id)}`,
      );
      const current = unwrap(currentDocument, 'routine');
      if (
        current.latestRevisionId !== initial.assets.latestRevisionId
        || payloadHash(normalizeRoutinePayload(current))
          !== snapshot.assetsRoutine.targetPayloadSha256
      ) {
        throw new Error('恢复前 assets Routine revision 或 payload 已变化');
      }
      const resource = await adapter.request(
        'PATCH',
        `/api/routines/${encodeURIComponent(current.id)}`,
        {
          ...structuredClone(snapshot.assetsRoutine.oldPayload),
          baseRevisionId:current.latestRevisionId,
        },
      );
      const operation = {
        method:'PATCH',
        resource:'routine',
        key:'m5-assets',
        id:current.id,
        revisionId:resource.latestRevisionId ?? null,
        restoredPayloadSha256:snapshot.assetsRoutine.oldPayloadSha256,
      };
      operations.push(operation);
      await appendRecoveryProgress(progressOperation(now, attemptedStep, operation));
    }

    attemptedStep = 'recovery_verification';
    const verification = await inspectRecoveryState({ adapter, snapshot });
    if (
      !verification.safeToRecover
      || Object.values(verification.states).some((state) => state !== 'old')
    ) {
      throw new Error('M5 v2 恢复写后验证失败');
    }
    await appendRecoveryProgress({
      schemaVersion:'agent.army/m5-existing-v2-progress/v1',
      type:'recovery_completed',
      at:now().toISOString(),
      snapshotSha256:snapshot.sha256,
      completedOperations:structuredClone(operations),
    });
    return {
      mode:'recover',
      alreadyRecovered:false,
      operations,
      states:verification.states,
    };
  } catch (error) {
    const recovery = {
      snapshotSha256:snapshot.sha256,
      attemptedStep,
      completedOperations:structuredClone(operations),
      cause:safeErrorMessage(error),
    };
    try {
      await appendRecoveryProgress({
        schemaVersion:'agent.army/m5-existing-v2-progress/v1',
        type:'recovery_still_required',
        at:now().toISOString(),
        ...recovery,
      });
    } catch (journalError) {
      recovery.journalError = safeErrorMessage(journalError);
    }
    throw new M5V2RecoveryRequiredError(
      `M5 v2 恢复未完成: ${recovery.cause}`,
      recovery,
    );
  }
}

async function inspectRecoveryState({ adapter, snapshot }) {
  const [
    pipelineDocument,
    projectDocument,
    routineDocument,
    caseDocument,
  ] = await Promise.all([
    adapter.request('GET', `/api/pipelines/${encodeURIComponent(snapshot.pipelineId)}`),
    adapter.request('GET', `/api/projects/${encodeURIComponent(snapshot.projectId)}`),
    adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(adapter.companyId)}/routines`,
    ),
    adapter.request(
      'GET',
      `/api/pipelines/${encodeURIComponent(snapshot.pipelineId)}/cases`,
    ),
  ]);
  const pipeline = unwrap(pipelineDocument, 'pipeline');
  const project = unwrap(projectDocument, 'project');
  const routines = rows(routineDocument)
    .filter((item) => item.projectId === snapshot.projectId);
  const cases = rows(caseDocument);
  const blockers = [];
  check(
    blockers,
    pipeline?.id === snapshot.pipelineId
      && pipeline?.key === snapshot.pipelineKey
      && pipeline?.projectId === snapshot.projectId
      && project?.id === snapshot.projectId,
    'recovery_target_identity_mismatch',
    '恢复目标 Pipeline/Project identity 不匹配',
  );
  assertDraftCampaign({
    blockers,
    cases,
    projectId:snapshot.projectId,
    deploymentKey:snapshot.pipelineKey,
  });

  const dailyMatches = routines.filter((item) =>
    String(item.description || '').includes(
      `[agent-army:m5:deployment:${snapshot.pipelineKey}:routine:m5-daily-campaign]`,
    )
  );
  const daily = dailyMatches.length === 1
    ? unwrap(await adapter.request(
      'GET',
      `/api/routines/${encodeURIComponent(dailyMatches[0].id)}`,
    ), 'routine')
    : null;
  const scheduleTriggers = (daily?.triggers ?? [])
    .filter((item) => item.kind === 'schedule');
  check(
    blockers,
    (daily?.triggers ?? []).length === 1
      && scheduleTriggers.length === 1
      && scheduleTriggers[0].enabled === false,
    'recovery_daily_trigger_not_off',
    '恢复时每日 Trigger 必须保持唯一且关闭',
  );

  const assetsDocument = await adapter.request(
    'GET',
    `/api/routines/${encodeURIComponent(snapshot.assetsRoutine.id)}`,
  );
  const assets = unwrap(assetsDocument, 'routine');
  const assetsHash = payloadHash(normalizeRoutinePayload(assets));
  const assetsState = assetsHash === snapshot.assetsRoutine.oldPayloadSha256
    ? 'old'
    : assetsHash === snapshot.assetsRoutine.targetPayloadSha256
      ? 'target'
      : 'unexpected';

  const visualMatches = routines.filter((item) =>
    String(item.description || '').includes(snapshot.visualRoutine.marker)
  );
  let visual = null;
  let visualState = 'unexpected';
  if (snapshot.visualRoutine.priorState === 'present') {
    if (
      visualMatches.length === 1
      && visualMatches[0].id === snapshot.visualRoutine.priorId
    ) {
      visual = unwrap(await adapter.request(
        'GET',
        `/api/routines/${encodeURIComponent(visualMatches[0].id)}`,
      ), 'routine');
      visualState = payloadHash(normalizeRoutinePayload(visual))
        === snapshot.visualRoutine.targetPayloadSha256
        ? 'old'
        : 'unexpected';
    }
  } else if (visualMatches.length === 0) {
    visualState = 'old';
  } else if (visualMatches.length === 1) {
    visual = unwrap(await adapter.request(
      'GET',
      `/api/routines/${encodeURIComponent(visualMatches[0].id)}`,
    ), 'routine');
    const visualHash = payloadHash(normalizeRoutinePayload(visual));
    const archivedHash = payloadHash({
      ...structuredClone(snapshot.visualRoutine.targetPayload),
      status:'archived',
    });
    visualState = visualHash === snapshot.visualRoutine.targetPayloadSha256
      ? 'target'
      : visualHash === archivedHash
        ? 'old'
        : 'unexpected';
  }

  const transitionHash = transitionsHash(logicalTransitions(pipeline));
  const transitionState =
    transitionHash === snapshot.pipelineTransitions.oldTransitionsSha256
      ? 'old'
      : transitionHash === snapshot.pipelineTransitions.targetTransitionsSha256
        ? 'target'
        : 'unexpected';
  check(
    blockers,
    assetsState !== 'unexpected',
    'recovery_assets_unexpected_drift',
    'assets 既不是 old 也不是本次 target',
  );
  check(
    blockers,
    visualState !== 'unexpected',
    'recovery_visual_unexpected_drift',
    'visual 既不是 old/archived 也不是本次 target',
  );
  check(
    blockers,
    transitionState !== 'unexpected',
    'recovery_transitions_unexpected_drift',
    'transitions 既不是 old 也不是本次 target',
  );
  return {
    safeToRecover:blockers.length === 0,
    blockers,
    states:{
      transitions:transitionState,
      visual:visualState,
      assets:assetsState,
    },
    assets:{
      id:assets?.id ?? null,
      latestRevisionId:assets?.latestRevisionId ?? null,
    },
    visual:{
      id:visual?.id ?? null,
      latestRevisionId:visual?.latestRevisionId ?? null,
    },
  };
}

function assertInputs({ adapter, definition, pipelineId, projectId }) {
  if (!adapter?.request || !adapter?.companyId) {
    throw new Error('现有 M5 v2 对账需要已限定公司的 Paperclip adapter');
  }
  if (!definition?.key || !pipelineId || !projectId) {
    throw new Error('现有 M5 v2 对账缺少 definition、pipelineId 或 projectId');
  }
}

function toV2Definition(definition) {
  if (definition.key.endsWith('-v2') && definition.project?.key?.endsWith('-v2')) {
    return structuredClone(definition);
  }
  return buildM5V2CloneDefinition(definition);
}

function resolveExactAgentBindings({ agents, definition, blockers }) {
  const agentIds = {};
  for (const owner of listM5RequiredAgentKeys(definition)) {
    const matches = agents.filter((agent) =>
      agent.status !== 'terminated' && agent.metadata?.agentArmyId === owner
    );
    check(
      blockers,
      matches.length === 1,
      'business_agent_binding_mismatch',
      `岗位 ${owner} 必须唯一，当前为 ${matches.length} 个`,
    );
    if (matches.length === 1) agentIds[owner] = matches[0].id;
  }
  const result = { agentIds };
  for (const [role, bindingKey] of Object.entries(SYSTEM_CONTROLLER_BINDINGS)) {
    const matches = agents.filter((agent) =>
      agent.status !== 'terminated' && agent.metadata?.agentArmySystemRole === role
    );
    check(
      blockers,
      matches.length === 1,
      'system_controller_binding_mismatch',
      `系统控制器 ${role} 必须唯一，当前为 ${matches.length} 个`,
    );
    if (matches.length === 1) result[bindingKey] = matches[0].id;
  }
  return result;
}

function indexVersionedRoutines({ routines, namespace, blockers }) {
  const prefix = `[agent-army:m5:deployment:${namespace}:routine:`;
  const index = new Map();
  for (const routine of routines) {
    const descriptions = String(routine.description || '');
    const matches = [...descriptions.matchAll(
      new RegExp(`\\[agent-army:m5:deployment:${escapeRegExp(namespace)}:routine:([^\\]]+)\\]`, 'g'),
    )];
    check(
      blockers,
      matches.length === 1,
      'routine_namespace_marker_mismatch',
      `Routine ${routine.id} 必须且只能含一个 ${prefix}... marker`,
    );
    if (matches.length !== 1) continue;
    const key = matches[0][1];
    const rowsForKey = index.get(key) ?? [];
    rowsForKey.push(routine);
    index.set(key, rowsForKey);
  }
  return index;
}

function assertDraftCampaign({ blockers, cases, projectId, deploymentKey }) {
  const normalized = cases.map((item) => ({
    case:item?.case ?? item,
    stage:item?.stage ?? null,
    activeWork:item?.activeWork ?? item?.case?.activeWork ?? null,
    descendantActiveWorkCount:Number(
      item?.descendantActiveWorkCount ?? item?.case?.descendantActiveWorkCount ?? 0,
    ),
  }));
  const item = normalized[0];
  const record = item?.case;
  check(
    blockers,
    normalized.length === 1
      && !record?.parentCaseId
      && (item?.stage?.key ?? record?.stageKey) === 'draft'
      && record?.fields?.campaignGrant?.status === 'draft'
      && record?.fields?.deploymentKey === deploymentKey
      && record?.fields?.projectId === projectId
      && Number(record?.childCount ?? 0) === 0
      && !item?.activeWork
      && item?.descendantActiveWorkCount === 0
      && !record?.leaseToken
      && !record?.terminalKind,
    'campaign_not_pristine_draft',
    'v2 必须只有一个未批准、未运行、无子项的 draft Campaign Case',
  );
}

function campaignGrantStatus(cases) {
  if (cases.length !== 1) return null;
  const record = cases[0]?.case ?? cases[0];
  return record?.fields?.campaignGrant?.status ?? null;
}

function buildLegacyAssetsPayload(payload) {
  return {
    ...structuredClone(payload),
    title:'M5 / 并行画面分析',
    description:String(payload.description)
      .replace(
        '只处理素材和关键帧并写回 AssetPackage，不输出画面分析结论。',
        '完成素材和视觉证据处理并写回 AssetPackage。',
      ),
  };
}

function logicalTransitions(pipeline) {
  const stageKeyById = new Map(
    (pipeline?.stages ?? []).map((stage) => [stage.id, stage.key]),
  );
  return (pipeline?.transitions ?? []).map((item) => ({
    fromStageKey:item.fromStageKey ?? stageKeyById.get(item.fromStageId) ?? null,
    toStageKey:item.toStageKey ?? stageKeyById.get(item.toStageId) ?? null,
    label:item.label ?? null,
  }));
}

function transitionSetsEqual(left, right) {
  return canonicalTransitions(left) === canonicalTransitions(right);
}

function canonicalTransitions(transitions) {
  const values = transitions.map((item) =>
    `${item.fromStageKey ?? ''}\u0000${item.toStageKey ?? ''}\u0000${item.label ?? ''}`
  );
  if (new Set(values).size !== values.length) return '__duplicate__';
  return JSON.stringify(values.sort());
}

function normalizeTransitions(transitions) {
  return structuredClone(transitions ?? []).map((item) => ({
    fromStageKey:item.fromStageKey ?? null,
    toStageKey:item.toStageKey ?? null,
    label:item.label ?? null,
  }));
}

function transitionsHash(transitions) {
  return createHash('sha256')
    .update(canonicalTransitions(normalizeTransitions(transitions)))
    .digest('hex');
}

function normalizeRoutinePayload(payload) {
  if (!payload) return null;
  return {
    projectId:payload.projectId ?? null,
    folderId:payload.folderId ?? null,
    goalId:payload.goalId ?? null,
    parentIssueId:payload.parentIssueId ?? null,
    title:payload.title,
    description:payload.description ?? null,
    assigneeAgentId:payload.assigneeAgentId ?? null,
    priority:payload.priority ?? 'medium',
    status:payload.status ?? 'active',
    concurrencyPolicy:payload.concurrencyPolicy ?? 'coalesce_if_active',
    catchUpPolicy:payload.catchUpPolicy ?? 'skip_missed',
    variables:(payload.variables ?? []).map((variable) => ({
      name:variable.name,
      label:variable.label ?? null,
      type:variable.type ?? 'text',
      defaultValue:variable.defaultValue ?? null,
      required:Boolean(variable.required),
      options:[...(variable.options ?? [])],
    })),
    env:null,
  };
}

function payloadHash(payload) {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function assertRollbackSnapshot(snapshot, companyId) {
  if (
    snapshot?.schemaVersion !== 'agent.army/m5-existing-v2-rollback/v2'
    || snapshot?.companyId !== companyId
  ) {
    throw new Error('M5 v2 回滚快照版本或 company 不匹配');
  }
  const { sha256, ...body } = snapshot;
  if (payloadHash(body) !== sha256) throw new Error('M5 v2 回滚快照哈希不匹配');
  const hashesMatch = (
    payloadHash(snapshot.assetsRoutine.oldPayload)
      === snapshot.assetsRoutine.oldPayloadSha256
    && payloadHash(snapshot.assetsRoutine.targetPayload)
      === snapshot.assetsRoutine.targetPayloadSha256
    && payloadHash(snapshot.visualRoutine.targetPayload)
      === snapshot.visualRoutine.targetPayloadSha256
    && transitionsHash(snapshot.pipelineTransitions.oldTransitions)
      === snapshot.pipelineTransitions.oldTransitionsSha256
    && transitionsHash(snapshot.pipelineTransitions.targetTransitions)
      === snapshot.pipelineTransitions.targetTransitionsSha256
  );
  if (!hashesMatch) throw new Error('M5 v2 回滚快照子资源哈希不匹配');
}

function progressOperation(now, step, operation) {
  return {
    schemaVersion:'agent.army/m5-existing-v2-progress/v1',
    type:'operation_succeeded',
    at:now().toISOString(),
    step,
    operation:structuredClone(operation),
  };
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'unknown')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function buildRollbackSnapshot({
  now,
  adapter,
  pipelineId,
  pipelineKey,
  projectId,
  assets,
  assetsDesired,
  visual,
  visualDesired,
  liveTransitions,
  desiredTransitions,
}) {
  const oldAssetsPayload = normalizeRoutinePayload(assets);
  const targetAssetsPayload = normalizeRoutinePayload(assetsDesired?.payload);
  const targetVisualPayload = normalizeRoutinePayload(visualDesired?.payload);
  const oldTransitions = normalizeTransitions(liveTransitions);
  const targetTransitions = normalizeTransitions(desiredTransitions);
  const snapshot = {
    schemaVersion:'agent.army/m5-existing-v2-rollback/v2',
    capturedAt:now().toISOString(),
    companyId:adapter.companyId,
    projectId,
    pipelineId,
    pipelineKey,
    assetsRoutine:{
      id:assets?.id ?? null,
      priorRevisionId:assets?.latestRevisionId ?? null,
      oldPayload:oldAssetsPayload,
      oldPayloadSha256:payloadHash(oldAssetsPayload),
      targetPayload:targetAssetsPayload,
      targetPayloadSha256:payloadHash(targetAssetsPayload),
      rollback:assets?.id && assets?.latestRevisionId
        ? {
          method:'PATCH',
          path:`/api/routines/${assets.id}`,
          bodyTemplate:{
            ...structuredClone(oldAssetsPayload),
            baseRevisionId:'{currentTargetRevisionId}',
          },
        }
        : null,
    },
    visualRoutine:{
      priorState:visual ? 'present' : 'absent',
      priorId:visual?.id ?? null,
      priorRevisionId:visual?.latestRevisionId ?? null,
      marker:visualDesired?.marker ?? null,
      targetPayload:targetVisualPayload,
      targetPayloadSha256:payloadHash(targetVisualPayload),
      rollback:visual
        ? null
        : {
          resolveByMarker:visualDesired?.marker ?? null,
          method:'PATCH',
          pathTemplate:'/api/routines/{resolvedRoutineId}',
          bodyTemplate:{
            status:'archived',
            baseRevisionId:'{currentTargetRevisionId}',
          },
        },
    },
    pipelineTransitions:{
      oldTransitions,
      oldTransitionsSha256:transitionsHash(oldTransitions),
      targetTransitions,
      targetTransitionsSha256:transitionsHash(targetTransitions),
      restore:{
        method:'PUT',
        path:`/api/pipelines/${pipelineId}/transitions`,
        body:{
          transitions:structuredClone(oldTransitions),
          enforceTransitions:true,
        },
      },
    },
  };
  return {
    ...snapshot,
    sha256:createHash('sha256').update(stableJson(snapshot)).digest('hex'),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function check(blockers, passed, code, detail) {
  if (!passed) blockers.push({ code, detail });
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function unwrap(payload, key) {
  return payload?.[key] ?? payload;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
