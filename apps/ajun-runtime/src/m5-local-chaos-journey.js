import {
  getM5RoutineExecutionContract,
} from '@agent-army/m5-kernel/routine-execution-contract';
import { PaperclipMetricMonitorHandler } from './paperclip-metric-monitor.js';
import { M5StageRecoveryController } from './m5-stage-recovery-controller.js';
import {
  LOCAL_CHAOS_FIXTURE,
  addWorkProduct,
  buildM5LocalChaosRenderWorkProductFixture,
  validateLocalChaosRenderWorkProduct,
  workProducts,
} from './m5-local-chaos-fixtures.js';

const HOUR_MS = 3_600_000;

export async function exerciseSafeRetryAndRestart({
  adapter,
  governance,
  platformCaseId,
}) {
  const fixture = LOCAL_CHAOS_FIXTURE;
  const contract = getM5RoutineExecutionContract('m5-render');
  governance.addIssue({
    id:fixture.recoveryIssueId,
    caseId:platformCaseId,
    status:'in_progress',
    assigneeAgentId:fixture.creatorAgentId,
    description:'本地 chaos render 恢复任务。',
  });
  governance.startRun({
    issueId:fixture.recoveryIssueId,
    runId:fixture.recoveryRunId,
    agentId:fixture.creatorAgentId,
    status:'failed',
  });
  const assignment = {
    issueId:fixture.recoveryIssueId,
    runId:fixture.recoveryRunId,
    pipelineCaseId:platformCaseId,
    projectId:fixture.projectId,
    routineKey:'m5-render',
    agentId:'content-creator',
  };
  const firstController = new M5StageRecoveryController({
    governance,
    workProductValidator:validateLocalChaosRenderWorkProduct,
    now:() => new Date(fixture.publishedAt),
  });
  const first = await firstController.handleFailure({
    assignment,
    contract,
    summary:'本地 chaos：首次 render 校验失败。',
  });
  addWorkProduct(
    adapter,
    platformCaseId,
    buildM5LocalChaosRenderWorkProductFixture(contract, platformCaseId),
  );
  const beforeRestart = workProducts(adapter, platformCaseId)
    .filter((item) => item.metadata?.kind === contract.expectedWorkProduct.type).length;

  governance.setIssueStatus(fixture.recoveryIssueId, 'in_progress');
  governance.startRun({
    issueId:fixture.recoveryIssueId,
    runId:fixture.recoveryRestartRunId,
    agentId:fixture.creatorAgentId,
    status:'failed',
  });
  const restartedController = new M5StageRecoveryController({
    governance,
    workProductValidator:validateLocalChaosRenderWorkProduct,
    now:() => new Date(fixture.publishedAt),
  });
  const resumed = await restartedController.handleFailure({
    assignment:{ ...assignment, runId:fixture.recoveryRestartRunId },
    contract,
    summary:'本地 chaos：进程重启后从 Paperclip 检查点恢复。',
  });
  const afterRestart = workProducts(adapter, platformCaseId)
    .filter((item) => item.metadata?.kind === contract.expectedWorkProduct.type).length;
  return {
    safeRetryCount:first.action === 'retry' ? 1 : 0,
    retryAction:first.action,
    restartCount:1,
    restartAction:resumed.action,
    reusedVerifiedWorkProduct:resumed.action === 'verified_work_product' && resumed.replayed === true,
    workProductCountBeforeRestart:beforeRestart,
    workProductCountAfterRestart:afterRestart,
  };
}

export async function exerciseMetricCheckpoints({
  governance,
  publisher,
  connector,
  platformCaseId,
  setTime,
  clock,
}) {
  const fixture = LOCAL_CHAOS_FIXTURE;
  const checkpoints = [
    { label:'2h', offsetMs:2 * HOUR_MS, runId:fixture.metricRunIds[0] },
    { label:'24h', offsetMs:24 * HOUR_MS, runId:fixture.metricRunIds[1] },
    { label:'72h', offsetMs:72 * HOUR_MS, runId:fixture.metricRunIds[3] },
  ];
  let handler = null;
  for (const [index, checkpoint] of checkpoints.entries()) {
    setTime(new Date(Date.parse(fixture.publishedAt) + checkpoint.offsetMs));
    governance.startRun({
      issueId:fixture.metricIssueId,
      runId:checkpoint.runId,
      agentId:fixture.metricAgentId,
      status:'running',
    });
    if (index === 0 || index === 1) {
      handler = new PaperclipMetricMonitorHandler({ governance, publisher, now:clock });
    }
    await handler.handle({
      runId:checkpoint.runId,
      agentId:fixture.metricAgentId,
      context:{ taskId:fixture.metricIssueId },
    });
    if (checkpoint.label === '24h') {
      governance.startRun({
        issueId:fixture.metricIssueId,
        runId:fixture.metricRunIds[2],
        agentId:fixture.metricAgentId,
        status:'running',
      });
      await handler.handle({
        runId:fixture.metricRunIds[2],
        agentId:fixture.metricAgentId,
        context:{ taskId:fixture.metricIssueId },
      });
    }
  }
  const snapshots = workProducts(governance.adapter, platformCaseId)
    .filter((item) => item.metadata?.schemaVersion === 'agent.army/metric-snapshot/v1')
    .map((item) => ({
      checkpoint:item.metadata.checkpoint,
      snapshotId:item.metadata.snapshot.snapshotId,
      collectedAt:item.metadata.snapshot.collectedAt,
      metrics:structuredClone(item.metadata.snapshot.metrics),
    }));
  return {
    snapshots,
    connectorCalls:connector.metricCalls.length,
    restartCount:1,
    duplicateCollections:connector.metricCalls.length - snapshots.length,
  };
}

export async function executeParallelFixture(adapter, parallelCases) {
  let active = 0;
  let observedMaxConcurrency = 0;
  const waves = [];
  const barrierEvidence = [];
  const maxConcurrency = parallelCases.maxConcurrency;
  for (let index = 0; index < parallelCases.branches.length; index += maxConcurrency) {
    const wave = parallelCases.branches.slice(index, index + maxConcurrency);
    waves.push(wave.length);
    let completed = 0;
    const barrier = createArrivalBarrier(wave.length, () => completed);
    await Promise.all(wave.map(async (branch) => {
      active += 1;
      observedMaxConcurrency = Math.max(observedMaxConcurrency, active);
      try {
        await barrier.wait();
        const current = await adapter.getCase(branch.id);
        await adapter.patchCaseFields(branch.id, current.version, {
          ...current.fields,
          verifiedWorkProduct:{
            kind:current.fields.workBranch.requiredWorkProduct,
            verified:true,
          },
        });
        await transitionUntracked(adapter, branch.id, 'done');
        completed += 1;
      } finally {
        active -= 1;
      }
    }));
    barrierEvidence.push(barrier.evidence());
  }
  await transitionUntracked(adapter, parallelCases.join.id, 'done');
  return {
    branchCount:parallelCases.branches.length,
    declaredMaxConcurrency:maxConcurrency,
    observedMaxConcurrency,
    waves,
    barrierEvidence,
    allBranchesVerified:parallelCases.branches.every((branch) => {
      const stored = adapter.state.cases.find((item) => item.id === branch.id);
      return stored?.stageKey === 'done'
        && stored.fields?.verifiedWorkProduct?.verified === true;
    }),
  };
}

function createArrivalBarrier(expected, completedCount) {
  let arrived = 0;
  let completedBeforeRelease = null;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived === expected) {
        completedBeforeRelease = completedCount();
        release();
      }
      await released;
    },
    evidence() {
      return { waveSize:expected, arrived, completedBeforeRelease };
    },
  };
}

export function createJourneyMover(adapter, caseId, journey, declaredTransitions) {
  return async (toStage, reason) => {
    const current = await adapter.getCase(caseId);
    const fromStage = current.stageKey;
    const edge = await transitionByDeclaredPlan(
      adapter,
      caseId,
      toStage,
      declaredTransitions,
      reason,
    );
    journey.push({
      sequence:journey.length + 1,
      caseId,
      fromStage,
      toStage,
      reason,
      declaredTransition:true,
      declarationLabel:edge.label,
    });
  };
}

export async function transitionByDeclaredPlan(
  adapter,
  caseId,
  toStageKey,
  expectedTransitions,
  reason = null,
) {
  const current = await adapter.getCase(caseId);
  if (!current) throw new Error(`M5 本地 chaos Case 不存在：${caseId}`);
  const pipeline = adapter.state.pipelines.find((item) => item.id === current.pipelineId);
  if (!pipeline?.enforceTransitions) {
    throw new Error('M5 本地 chaos Pipeline 未启用 enforceTransitions。');
  }
  assertTransitionTablesEqual(pipeline.transitions, expectedTransitions);
  const edge = assertM5DeclaredTransition(
    pipeline.transitions,
    current.stageKey,
    toStageKey,
  );
  await adapter.transitionCase(caseId, {
    expectedVersion:current.version,
    toStageKey,
    reason,
  });
  return edge;
}

async function transitionUntracked(adapter, caseId, toStageKey) {
  const current = await adapter.getCase(caseId);
  return adapter.transitionCase(caseId, {
    expectedVersion:current.version,
    toStageKey,
    force:true,
  });
}

export function assertM5DeclaredTransition(transitions, fromStageKey, toStageKey) {
  if (!Array.isArray(transitions)) {
    throw new Error('M5 正式 Pipeline transition 表缺失。');
  }
  const edge = transitions.find((item) =>
    item?.fromStageKey === fromStageKey
    && item?.toStageKey === toStageKey,
  );
  if (!edge) {
    throw new Error(
      `M5 正式 Pipeline 未声明 transition：${fromStageKey}->${toStageKey}。`,
    );
  }
  return structuredClone(edge);
}

function assertTransitionTablesEqual(actual, expected) {
  const canonical = (items) => JSON.stringify((items || []).map((item) => ({
    fromStageKey:item.fromStageKey,
    toStageKey:item.toStageKey,
    label:item.label,
  })));
  if (canonical(actual) !== canonical(expected)) {
    throw new Error('M5 本地 chaos Pipeline transition 表与正式 Bootstrap plan 不一致。');
  }
}
