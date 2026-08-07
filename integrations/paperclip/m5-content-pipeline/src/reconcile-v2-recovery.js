import {
  assertDraftCampaign,
  check,
  rows,
  unwrap,
} from './reconcile-v2-inspection.js';
import {
  M5_EXISTING_V2_RECOVERY_CONFIRMATION,
  M5V2RecoveryRequiredError,
  assertRollbackSnapshot,
  logicalTransitions,
  normalizeRoutinePayload,
  payloadHash,
  progressOperation,
  safeErrorMessage,
  transitionsHash,
} from './reconcile-v2-journal.js';

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
