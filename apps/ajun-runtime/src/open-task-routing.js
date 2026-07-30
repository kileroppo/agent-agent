import { createHash } from 'node:crypto';
import { assertNoSensitiveData } from './goal-spec.js';
import { INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT } from './m5-routine-execution-contract.js';
import { createM5ObservationDecision } from './m5-route-execution.js';

export const OPEN_TASK_DELEGATES = Object.freeze({
  'army.goal-program':'army.route-task',
  'media.open-production':'media.transcribe-and-refine',
  'research.open-investigation':'research.intel-report',
  'office.deliverable-program':'office.briefing-package',
  'operations.incident-response':'operations.health-review',
  'governance.capability-design':'governance.agent-proposal',
  'governance.assurance-review':'governance.approval-review',
  'governance.architecture-experiment':'governance.architecture-review',
  'operations.engineering-resolution':'operations.technical-repair',
  'content.analysis-program':'content.video-benchmark-analysis',
  'content.creation-program':'content.video-script-package'
});
const CONTROLLED_SOURCE_MATERIAL = Symbol.for(
  'agent.army.openResearch.controlledSourceMaterial',
);

export function supportsOpenTask(task, agent) {
  return Boolean(
    task
    && agent?.openTaskPolicy
    && OPEN_TASK_DELEGATES[task.taskType]
    && agent.acceptedTaskTypes?.includes(task.taskType)
  );
}

export function routeOpenTaskForExecutor(task, agent) {
  if (!supportsOpenTask(task, agent)) return task;
  return {
    ...task,
    taskType:OPEN_TASK_DELEGATES[task.taskType],
    input:{
      ...(task.input || {}),
      context:{
        ...(task.input?.context || {}),
        openTaskType:task.taskType,
        delegatedTaskType:OPEN_TASK_DELEGATES[task.taskType],
        controlPlane:'paperclip',
        capabilityPolicy:'agent-manifest'
      }
    }
  };
}

export function inspectOpenTaskManifestCapabilities(task, agent) {
  if (!supportsOpenTask(task, agent)) {
    return { allowed:true, requested:[], missing:[] };
  }
  assertNoSensitiveData(task.input?.goalSpec || {}, 'goalSpec');
  const requested = [...new Set(
    [
      ...(Array.isArray(task.input?.goalSpec?.capabilityRequests)
        ? task.input.goalSpec.capabilityRequests.map((item) => item?.capabilityId)
        : []),
      ...(Array.isArray(task.input?.goalSpec?.requestedPermissions)
        ? task.input.goalSpec.requestedPermissions
        : [])
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 12)
  )];
  const manifestCapabilities = new Set([
    ...(Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : []),
    ...(Array.isArray(agent?.runtimeCapabilities?.mcpTools) ? agent.runtimeCapabilities.mcpTools : []),
    ...(Array.isArray(agent?.runtimeCapabilities?.skills) ? agent.runtimeCapabilities.skills : [])
  ].map((item) => String(item || '').trim()).filter(Boolean));
  const missing = requested.filter((capabilityId) => !manifestCapabilities.has(capabilityId));
  return {
    allowed:missing.length === 0,
    requested,
    missing
  };
}

export function decideIntelResearchOpenTask({
  task,
  agent,
  observation,
  progress = {},
  budget = {},
  now = () => new Date(),
} = {}) {
  const contract = INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT;
  if (
    task?.taskType !== contract.taskType
    || agent?.agentId !== contract.agentId
    || !supportsOpenTask(task, agent)
  ) {
    throw new Error('当前任务不是小R受控开放研究任务。');
  }
  assertNoSensitiveData(observation || {}, 'observation');
  const runId = String(observation?.runId || '').trim();
  const issueId = String(observation?.issueId || '').trim();
  const observationId = String(observation?.observationId || '').trim();
  if (
    observation?.schemaVersion !== 'agent.army/tool-observation/v1'
    || !runId
    || !issueId
    || !observationId
  ) {
    throw new Error('小R开放研究决策缺少真实 Paperclip Observation、Run 或 Issue。');
  }
  const remainingUnits = requiredBudgetInteger(budget.remainingUnits, 'remainingUnits');
  const estimatedNextStepUnits = requiredBudgetInteger(
    budget.estimatedNextStepUnits,
    'estimatedNextStepUnits',
    { positive:true },
  );
  const normalizedProgress = {
    stepsUsed:requiredProgressInteger(progress.stepsUsed, 'stepsUsed'),
    safeRetriesUsed:requiredProgressInteger(progress.safeRetriesUsed, 'safeRetriesUsed'),
    replansUsed:requiredProgressInteger(progress.replansUsed, 'replansUsed'),
  };
  let action = 'switch_adapter';
  let selectedToolId = {
    pdf_detected:'content.public.pdf.read',
    dynamic_page_required:'content.public.dynamic.read',
    github_repository_detected:'github.public.read',
  }[observation.classification];
  if (
    !selectedToolId
    && observation?.outcome === 'succeeded'
    && observation?.classification === 'source_verified'
    && observation?.result?.acceptanceSatisfied === false
  ) {
    action = 'continue';
    selectedToolId = String(observation?.result?.nextToolId || '').trim();
  }
  const completedWorkProduct = healthyOpenResearchWorkProduct(
    observation?.result?.workProduct,
    { runId },
  );
  if (
    !selectedToolId
    && observation?.outcome === 'succeeded'
    && observation?.classification === 'goal_satisfied'
    && observation?.provenance === 'trusted_report_executor'
    && observation?.toolId === 'controlled.intel-research-report'
    && observation?.result?.acceptanceSatisfied === true
    && completedWorkProduct
  ) {
    action = 'complete';
  }
  if (
    !selectedToolId
    && observation?.outcome === 'failed'
    && observation?.error?.retryable === true
    && normalizedProgress.safeRetriesUsed < contract.maxSafeRetries
    && normalizedProgress.stepsUsed < contract.maxSteps
    && remainingUnits >= estimatedNextStepUnits
  ) {
    action = 'safe_retry';
    selectedToolId = String(observation.toolId || '').trim();
  }
  let limitReason = null;
  if (selectedToolId && normalizedProgress.stepsUsed >= contract.maxSteps) {
    limitReason = 'step_limit_exhausted';
  } else if (selectedToolId && remainingUnits < estimatedNextStepUnits) {
    limitReason = 'budget_insufficient';
  }
  if (limitReason) {
    action = 'request_replan';
    selectedToolId = null;
  }
  let replanAllowed = normalizedProgress.replansUsed < contract.maxReplans;
  if (
    !selectedToolId
    && observation?.outcome === 'failed'
  ) {
    action = 'request_replan';
  }
  if (!selectedToolId && !['request_replan', 'complete'].includes(action)) {
    throw new Error('当前 Observation 尚无受控研究路线。');
  }
  const manifestTools = new Set(
    (Array.isArray(agent.toolAllowlist) ? agent.toolAllowlist : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (
    selectedToolId
    && (!contract.toolIds.includes(selectedToolId) || !manifestTools.has(selectedToolId))
  ) {
    throw new Error(`小R Manifest 未授权 ${selectedToolId}。`);
  }
  const consumesToolStep = Boolean(selectedToolId);
  const consumesReplan = action === 'request_replan' && replanAllowed;
  const successCondition = selectedToolId
    ? contract.successConditions[selectedToolId]
    : contract.controlSuccessConditions[action];
  const routeDecision = createM5ObservationDecision({
    runId,
    issueId,
    observation,
    action,
    selectedToolId,
    successCondition,
    budget:{
      stepsRemaining:Math.max(
        0,
        contract.maxSteps - normalizedProgress.stepsUsed - (consumesToolStep ? 1 : 0),
      ),
      safeRetriesRemaining:Math.max(
        0,
        contract.maxSafeRetries
          - normalizedProgress.safeRetriesUsed
          - (action === 'safe_retry' ? 1 : 0),
      ),
      replansRemaining:Math.max(
        0,
        contract.maxReplans - normalizedProgress.replansUsed - (consumesReplan ? 1 : 0),
      ),
      remainingUnitsAfterDecision:Math.max(
        0,
        remainingUnits - (consumesToolStep ? estimatedNextStepUnits : 0),
      ),
    },
    now,
  });
  return {
    ...routeDecision,
    schemaVersion:'agent.army/intel-research-open-task-decision/v1',
    taskId:String(task.taskId || '').trim() || null,
    replanAllowed,
    limitReason,
    executionStatus:action === 'complete'
      ? 'complete'
      : action === 'request_replan' && !replanAllowed
        ? 'blocked'
        : 'ready',
    budget:{
      ...routeDecision.budget,
      remainingUnits,
      estimatedNextStepUnits,
    },
    progress:normalizedProgress,
    paperclipWrites:[
      {
        kind:'append_run_observation',
        runId,
        issueId,
        sourceObservationId:observationId,
        recordedAt:now().toISOString(),
      },
      ...(action === 'request_replan' && replanAllowed ? [{
        kind:'request_plan_revision',
        runId,
        issueId,
        sourceObservationId:observationId,
      }] : []),
      ...(action === 'request_replan' && !replanAllowed ? [{
        kind:'block_issue',
        runId,
        issueId,
        sourceObservationId:observationId,
        reason:'replan_limit_exhausted',
      }] : []),
      ...(action === 'complete' ? [{
        kind:'create_work_product',
        runId,
        issueId,
        sourceObservationId:observationId,
        ...completedWorkProduct,
      }] : []),
    ],
  };
}

export async function executeIntelResearchOpenTaskStep({
  task,
  agent,
  assignment,
  executionPolicy,
  paperclipWorkProducts,
  roleToolContext,
  reportExecutor,
  writeStepWorkProduct,
  readWorkProducts,
  now = () => new Date(),
} = {}) {
  const issueId = String(assignment?.issueId || '').trim();
  const runId = String(assignment?.runId || '').trim();
  if (
    task?.taskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType
    || agent?.agentId !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.agentId
    || !issueId
    || !runId
  ) {
    throw new Error('当前 Paperclip assignment 不是小R开放研究任务。');
  }
  if (typeof roleToolContext?.execute !== 'function') {
    throw new Error('小R开放研究缺少经岗位 Manifest 编译的工具执行上下文。');
  }
  if (typeof writeStepWorkProduct !== 'function') {
    throw new Error('小R开放研究缺少 Paperclip Observation Work Product 写回能力。');
  }
  if (typeof readWorkProducts !== 'function') {
    throw new Error('小R开放研究缺少 Paperclip Work Product 回读能力。');
  }

  const priorState = recoverIntelResearchOpenTaskState({
    workProducts:paperclipWorkProducts,
    issueId,
    runId,
  });
  if (priorState?.completedReport) {
    return completedOpenResearchResult({
      report:priorState.completedReport,
      issueId,
      runId,
      progress:priorState.progress,
      budget:priorState.budget,
      now,
      reusedReport:true,
    });
  }
  if (task?.execution?.openResearch && !priorState) {
    throw new Error(
      'Paperclip 缺少小R开放研究 Work Product；拒绝把本地投影当成任务真相。',
    );
  }
  let progress = priorState?.progress || {
    stepsUsed:0,
    safeRetriesUsed:0,
    replansUsed:0,
  };
  let budget = priorState?.budget || canonicalOpenResearchBudget(executionPolicy);
  let observation = priorState?.lastObservation || null;
  const sourceObservations = [...(priorState?.sourceObservations || [])];
  const sourceCheckpointPersisted = sourceObservations.length >= 2;
  let initialToolId = null;

  if (!observation) {
    assertOpenResearchToolBudget(progress, budget);
    initialToolId = initialResearchTool(task);
    assertManifestResearchTool(initialToolId, agent);
    observation = await executeObservedResearchTool({
      task,
      assignment,
      roleToolContext,
      toolId:initialToolId,
      stepNumber:progress.stepsUsed + 1,
      now,
    });
    progress = {
      ...progress,
      stepsUsed:progress.stepsUsed + 1,
    };
    budget = {
      ...budget,
      remainingUnits:budget.remainingUnits - budget.estimatedNextStepUnits,
    };
    addVerifiedSourceObservation(sourceObservations, observation, {
      issueId,
      runId,
    });
  }

  const canGenerateRecoveredReport = sourceCheckpointPersisted
    && progress.stepsUsed < INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps
    && budget.remainingUnits >= budget.estimatedNextStepUnits;
  let decision = canGenerateRecoveredReport
    ? priorState?.lastDecision
    : decideIntelResearchOpenTask({
        task,
        agent,
        observation,
        progress,
        budget,
        now,
      });
  if (canGenerateRecoveredReport && !decision?.decisionId) {
    throw new Error('Paperclip 来源检查点缺少小R受控决策。');
  }
  let nextObservation = null;
  if (!canGenerateRecoveredReport && decision.selectedToolId) {
    nextObservation = await executeObservedResearchTool({
      task,
      assignment,
      roleToolContext,
      toolId:decision.selectedToolId,
      stepNumber:progress.stepsUsed + 1,
      priorObservation:observation,
      now,
    });
    progress = {
      stepsUsed:progress.stepsUsed + 1,
      safeRetriesUsed:progress.safeRetriesUsed + (decision.action === 'safe_retry' ? 1 : 0),
      replansUsed:progress.replansUsed,
    };
    budget = {
      ...budget,
      remainingUnits:decision.budget.remainingUnitsAfterDecision,
    };
    addVerifiedSourceObservation(sourceObservations, nextObservation, {
      issueId,
      runId,
    });
  } else if (
    !canGenerateRecoveredReport
    && decision.action === 'request_replan'
    && decision.replanAllowed
  ) {
    progress = {
      ...progress,
      replansUsed:progress.replansUsed + 1,
    };
  }

  let completedReport = null;
  if (
    sourceObservations.length >= 2
    && decision.action !== 'request_replan'
    && progress.stepsUsed < INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps
    && budget.remainingUnits >= budget.estimatedNextStepUnits
  ) {
    if (!sourceCheckpointPersisted) {
      const sourceCheckpoint = openResearchStepWorkProduct({
        task,
        assignment,
        initialToolId,
        observation,
        decision,
        nextObservation,
        progress,
        budget,
        now,
      });
      const writtenCheckpoint = await writeStepWorkProduct(sourceCheckpoint);
      if (!String(writtenCheckpoint?.id || '').trim()) {
        throw new Error('Paperclip 未返回小R来源 Observation Work Product ID。');
      }
    }
    if (typeof reportExecutor?.synthesizeVerifiedReport !== 'function') {
      throw new Error('小R受控研究报告执行器不可用。');
    }
    const artifact = await reportExecutor.synthesizeVerifiedReport({
      task,
      issueId,
      runId,
      sourceObservations,
    });
    const verifiedArtifact = verifiedResearchReportArtifact({
      artifact,
      task,
      issueId,
      runId,
      sourceObservations,
    });
    progress = {
      ...progress,
      stepsUsed:progress.stepsUsed + 1,
    };
    budget = {
      ...budget,
      remainingUnits:budget.remainingUnits - budget.estimatedNextStepUnits,
    };
    const reportProduct = openResearchReportWorkProduct({
      task,
      assignment,
      artifact:verifiedArtifact,
      sourceObservations,
      progress,
      budget,
      now,
    });
    const writtenReport = await writeStepWorkProduct(reportProduct);
    if (!String(writtenReport?.id || '').trim()) {
      throw new Error('Paperclip 未返回小R ResearchReport Work Product ID。');
    }
    const refreshed = recoverIntelResearchOpenTaskState({
      workProducts:await readWorkProducts(),
      issueId,
      runId,
    });
    if (!refreshed?.completedReport) {
      throw new Error('小R ResearchReport 写回后无法从当前 Run 回读健康 Work Product。');
    }
    completedReport = refreshed.completedReport;
    const completionObservation = completedReportObservation({
      assignment,
      report:completedReport,
      stepNumber:progress.stepsUsed,
      now,
    });
    decision = decideIntelResearchOpenTask({
      task,
      agent,
      observation:completionObservation,
      progress,
      budget,
      now,
    });
    nextObservation = completionObservation;
  }

  const product = openResearchStepWorkProduct({
    task,
    assignment,
    initialToolId,
    observation,
    decision,
    nextObservation,
    progress,
    budget,
    now,
  });
  const written = await writeStepWorkProduct(product);
  const workProductId = String(written?.id || '').trim();
  if (!workProductId) {
    throw new Error('Paperclip 未返回小R Observation Work Product ID。');
  }

  const terminalObservation = nextObservation || observation;
  const executionStatus = completedReport && decision.action === 'complete'
    ? 'succeeded'
    : decision.action === 'request_replan'
      ? 'waiting_test'
      : 'running';
  return {
    status:executionStatus,
    currentStage:decision.action === 'complete'
      ? 'open_research_complete'
      : decision.action === 'request_replan'
        ? 'open_research_replan_required'
        : 'open_research_observation_ready',
    artifactRefs:completedReport ? [completedReport.artifact] : [],
    execution:{
      openResearch:{
        schemaVersion:'agent.army/open-research-runtime-state/v1',
        issueId,
        runId,
        lastObservation:terminalObservation,
        lastDecision:decision,
        progress,
        budget,
        lastWorkProductId:workProductId,
        projectionSource:'paperclip_work_product',
        updatedAt:now().toISOString(),
      },
    },
    openResearch:{
      observation,
      decision,
      nextObservation,
      workProductId,
      ...(completedReport ? {
        reportWorkProductId:completedReport.id,
        sourceObservationIds:completedReport.sourceObservationIds,
        reusedReport:false,
      } : {}),
    },
    ...(executionStatus === 'waiting_test' ? {
      error:{
        code:decision.replanAllowed
          ? 'open_research_replan_required'
          : 'open_research_replan_limit_exhausted',
        message:decision.replanAllowed
          ? '小R已根据真实 Observation 请求 Paperclip 重规划。'
          : '小R已耗尽三次重规划上限，任务保持阻塞。',
        userMessage:'开放研究没有继续扩大工具调用；请查看当前 Observation 和恢复动作。',
        category:'governance',
        stage:'open_research_observation_loop',
        retryable:false,
        occurredAt:now().toISOString(),
      },
    } : {}),
  };
}

export function recoverIntelResearchOpenTaskState({
  workProducts,
  issueId,
  runId,
} = {}) {
  const safeIssueId = String(issueId || '').trim();
  const safeRunId = String(runId || '').trim();
  const items = Array.isArray(workProducts)
    ? workProducts
    : Array.isArray(workProducts?.items)
      ? workProducts.items
      : [];
  const sourceObservations = uniqueVerifiedSourceObservations(
    items.flatMap((item) => {
      if (
        item?.type !== 'OpenResearchStep'
        || item?.schemaVersion !== 'agent.army/open-research-step/v1'
        || item?.metadata?.issueId !== safeIssueId
        || item?.metadata?.runId !== safeRunId
      ) return [];
      return [item.metadata.observation, item.metadata.nextObservation];
    }),
    { issueId:safeIssueId, runId:safeRunId },
  );
  const completedReports = items
    .map((item) => healthyResearchReportWorkProduct(item, {
      issueId:safeIssueId,
      runId:safeRunId,
      sourceObservations,
    }))
    .filter(Boolean);
  if (completedReports.length > 1) {
    const checksums = new Set(completedReports.map((item) => item.artifact.checksum));
    if (checksums.size > 1) {
      throw new Error('Paperclip 当前 Run 存在多个不同 ResearchReport，拒绝自动选择。');
    }
  }
  const candidates = items.flatMap((item) => {
    const metadata = item?.metadata;
    const observation = metadata?.nextObservation || metadata?.observation;
    if (
      item?.type !== 'OpenResearchStep'
      || item?.schemaVersion !== 'agent.army/open-research-step/v1'
      || metadata?.issueId !== safeIssueId
      || metadata?.runId !== safeRunId
      || observation?.issueId !== safeIssueId
      || observation?.runId !== safeRunId
      || observation?.provenance !== 'trusted_role_tool_adapter'
      || !metadata?.decision?.decisionId
    ) return [];
    const progress = {
      stepsUsed:requiredProgressInteger(metadata.progress?.stepsUsed, 'stepsUsed'),
      safeRetriesUsed:requiredProgressInteger(
        metadata.progress?.safeRetriesUsed,
        'safeRetriesUsed',
      ),
      replansUsed:requiredProgressInteger(metadata.progress?.replansUsed, 'replansUsed'),
    };
    return [{
      id:String(item.id || '').trim() || null,
      decisionId:String(metadata.decision.decisionId),
      lastDecision:metadata.decision,
      lastObservation:observation,
      progress,
      budget:canonicalOpenResearchBudget(metadata.budget),
      recordedAt:String(metadata.recordedAt || ''),
    }];
  }).sort((left, right) =>
    right.progress.stepsUsed - left.progress.stepsUsed
    || Date.parse(right.recordedAt || 0) - Date.parse(left.recordedAt || 0)
  );
  if (!candidates.length && !completedReports.length) return null;
  if (!candidates.length) {
    return {
      lastObservation:null,
      lastDecision:null,
      sourceObservations,
      progress:completedReports[0].progress,
      budget:completedReports[0].budget,
      workProductId:completedReports[0].id,
      completedReport:completedReports[0],
    };
  }
  const latest = candidates[0];
  const drift = candidates.find((candidate) =>
    candidate !== latest
    && candidate.progress.stepsUsed === latest.progress.stepsUsed
    && candidate.decisionId !== latest.decisionId
  );
  if (drift) {
    throw new Error('Paperclip 存在多个同进度开放研究 Work Product，拒绝自动选择。');
  }
  return {
    lastObservation:latest.lastObservation,
    lastDecision:latest.lastDecision,
    sourceObservations,
    progress:latest.progress,
    budget:latest.budget,
    workProductId:latest.id,
    completedReport:completedReports[0] || null,
  };
}

function addVerifiedSourceObservation(observations, observation, expectedScope) {
  const verified = verifiedSourceObservation(observation, expectedScope);
  if (!verified) return;
  const key = `${verified.result.sourceEvidence.url}|${verified.result.sourceEvidence.contentHash}`;
  const index = observations.findIndex((item) =>
    `${item.result.sourceEvidence.url}|${item.result.sourceEvidence.contentHash}` === key
  );
  if (index < 0) observations.push(verified);
}

function uniqueVerifiedSourceObservations(observations, expectedScope) {
  const result = [];
  for (const observation of observations) {
    addVerifiedSourceObservation(result, observation, expectedScope);
  }
  return result;
}

function verifiedSourceObservation(observation, { issueId, runId } = {}) {
  const evidence = observation?.result?.sourceEvidence;
  const expectedIssueId = String(issueId || '').trim();
  const expectedRunId = String(runId || '').trim();
  if (
    observation?.schemaVersion !== 'agent.army/tool-observation/v1'
    || !expectedIssueId
    || !expectedRunId
    || observation?.issueId !== expectedIssueId
    || observation?.runId !== expectedRunId
    || observation?.outcome !== 'succeeded'
    || observation?.classification !== 'source_verified'
    || observation?.provenance !== 'trusted_role_tool_adapter'
    || !String(observation?.observationId || '').trim()
    || !publicResearchUrl(evidence?.url)
    || !validTimestampText(evidence?.fetchedAt)
    || !validHashText(evidence?.contentHash)
    || !String(evidence?.sourceId || '').trim()
    || !String(evidence?.evidenceFragment?.fragmentId || '').trim()
    || !String(evidence?.evidenceFragment?.text || '').trim()
  ) return null;
  return observation;
}

function verifiedResearchReportArtifact({
  artifact,
  task,
  issueId,
  runId,
  sourceObservations,
} = {}) {
  const validation = artifact?.validation || {};
  const verifiedObservations = uniqueVerifiedSourceObservations(sourceObservations, {
    issueId,
    runId,
  });
  const sourceIds = verifiedObservations.map((item) => item.observationId);
  const expectedChecksum = `sha256:${createHash('sha256')
    .update(JSON.stringify(artifact?.data || null))
    .digest('hex')}`;
  if (
    artifact?.type !== 'intel_research_report'
    || String(artifact?.taskId || '') !== String(task?.taskId || '')
    || !String(artifact?.artifactId || '').trim()
    || !/^runtime:\/\/[^/]+\/intel-research-report$/.test(String(artifact?.location || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(artifact?.checksum || ''))
    || artifact.checksum.toLowerCase() !== expectedChecksum
    || artifact?.data?.schemaVersion !== 'agent.army/intel-research-report/v1'
    || artifact?.data?.runId !== runId
    || !reportDataMatchesSourceObservations(artifact.data, verifiedObservations)
    || validation.exists !== true
    || validation.readable !== true
    || validation.nonEmpty !== true
    || validation.publicReadOnly !== true
    || validation.minimumSourcesMet !== true
    || validation.claimEvidenceBound !== true
    || validation.currentRun !== true
    || Number(validation.sourceCount) < 2
    || sourceIds.length < 2
  ) {
    throw new Error('小R受控执行器没有生成可核验的当前 Run 研究报告产物。');
  }
  return structuredClone(artifact);
}

function reportDataMatchesSourceObservations(report, observations) {
  const reportedObservationIds = Array.isArray(report?.sourceObservationIds)
    ? [...new Set(report.sourceObservationIds.map(String).filter(Boolean))]
    : [];
  const expectedObservationIds = observations.map((item) => item.observationId);
  if (
    reportedObservationIds.length !== expectedObservationIds.length
    || !expectedObservationIds.every((id) => reportedObservationIds.includes(id))
  ) return false;
  const expectedSources = new Map(observations.map((observation) => {
    const evidence = observation.result.sourceEvidence;
    const controlledSummary = String(
      observation?.[CONTROLLED_SOURCE_MATERIAL]?.summary || '',
    ).trim();
    return [String(evidence.sourceId), {
      url:publicResearchUrl(evidence.url),
      contentHash:normalizeContentHash(evidence.contentHash),
      fragmentId:String(evidence.evidenceFragment.fragmentId),
      fragmentText:controlledSummary || null,
    }];
  }));
  const reportSources = Array.isArray(report?.sources) ? report.sources : [];
  if (reportSources.length !== expectedSources.size) return false;
  for (const source of reportSources) {
    const expected = expectedSources.get(String(source?.sourceId || ''));
    const fragments = Array.isArray(source?.evidenceFragments)
      ? source.evidenceFragments
      : [];
    if (
      !expected
      || publicResearchUrl(source?.url || source?.source) !== expected.url
      || normalizeContentHash(source?.contentHash) !== expected.contentHash
      || !fragments.some((fragment) =>
        String(fragment?.fragmentId || '') === expected.fragmentId
        && String(fragment?.text || '').trim()
        && (
          expected.fragmentText == null
          || String(fragment?.text || '') === expected.fragmentText
        )
      )
    ) return false;
  }
  const claims = Array.isArray(report?.claims) ? report.claims : [];
  return claims.length > 0 && claims.every((claim) => {
    const sourceIds = Array.isArray(claim?.sourceIds)
      ? [...new Set(claim.sourceIds.map(String).filter(Boolean))]
      : [];
    const fragments = Array.isArray(claim?.evidenceFragments)
      ? claim.evidenceFragments
      : [];
    return Boolean(String(claim?.text || '').trim())
      && sourceIds.length > 0
      && sourceIds.every((sourceId) => {
        const expected = expectedSources.get(sourceId);
        const source = reportSources.find((item) =>
          String(item?.sourceId || '') === sourceId
        );
        const reportFragment = source?.evidenceFragments?.find((fragment) =>
          String(fragment?.fragmentId || '') === expected?.fragmentId
        );
        return expected && fragments.some((fragment) =>
          String(fragment?.sourceId || '') === sourceId
          && String(fragment?.fragmentId || '') === expected.fragmentId
          && String(fragment?.text || '') === String(reportFragment?.text || '')
        );
      });
  });
}

function normalizeContentHash(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function openResearchReportWorkProduct({
  task,
  assignment,
  artifact,
  sourceObservations,
  progress,
  budget,
  now,
} = {}) {
  const sourceObservationIds = uniqueVerifiedSourceObservations(sourceObservations, {
    issueId:assignment.issueId,
    runId:assignment.runId,
  })
    .map((item) => item.observationId);
  const idempotencyHash = createHash('sha256')
    .update(JSON.stringify({
      issueId:assignment.issueId,
      runId:assignment.runId,
      sourceObservationIds,
      checksum:artifact.checksum,
    }))
    .digest('hex');
  return {
    type:'ResearchReport',
    schemaVersion:'agent.army/intel-research-report/v1',
    title:artifact.title,
    status:'active',
    healthStatus:'healthy',
    idempotencyKey:`open-research-report:${idempotencyHash}`,
    metadata:{
      taskId:String(task?.taskId || '').trim(),
      issueId:assignment.issueId,
      runId:assignment.runId,
      artifactRef:artifact.location,
      artifact,
      report:artifact.data,
      sourceObservationIds,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        publicReadOnly:true,
        sourceCount:sourceObservationIds.length,
        minimumSourcesMet:sourceObservationIds.length >= 2,
        claimEvidenceBound:artifact.validation.claimEvidenceBound === true,
        currentRun:artifact.data.runId === assignment.runId,
      },
      progress,
      budget,
      recordedAt:now().toISOString(),
    },
  };
}

function healthyResearchReportWorkProduct(value, {
  issueId,
  runId,
  sourceObservations,
} = {}) {
  const metadata = value?.metadata;
  const artifact = metadata?.artifact;
  const validation = metadata?.validation || {};
  const sourceObservationIds = Array.isArray(metadata?.sourceObservationIds)
    ? [...new Set(metadata.sourceObservationIds.map(String).filter(Boolean))]
    : [];
  const verifiedObservations = uniqueVerifiedSourceObservations(sourceObservations, {
    issueId,
    runId,
  });
  const expectedObservationIds = verifiedObservations.map((item) => item.observationId);
  const expectedChecksum = `sha256:${createHash('sha256')
    .update(JSON.stringify(artifact?.data || null))
    .digest('hex')}`;
  if (
    value?.type !== 'ResearchReport'
    || value?.schemaVersion !== 'agent.army/intel-research-report/v1'
    || value?.healthStatus !== 'healthy'
    || metadata?.issueId !== issueId
    || metadata?.runId !== runId
    || metadata?.artifactRef !== artifact?.location
    || artifact?.type !== 'intel_research_report'
    || artifact?.data?.schemaVersion !== 'agent.army/intel-research-report/v1'
    || artifact?.data?.runId !== runId
    || !/^runtime:\/\/[^/]+\/intel-research-report$/.test(String(artifact?.location || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(artifact?.checksum || ''))
    || artifact.checksum.toLowerCase() !== expectedChecksum
    || !reportDataMatchesSourceObservations(artifact.data, verifiedObservations)
    || artifact?.validation?.exists !== true
    || artifact?.validation?.readable !== true
    || artifact?.validation?.nonEmpty !== true
    || artifact?.validation?.claimEvidenceBound !== true
    || validation.exists !== true
    || validation.readable !== true
    || validation.nonEmpty !== true
    || validation.claimEvidenceBound !== true
    || validation.currentRun !== true
    || sourceObservationIds.length < 2
    || sourceObservationIds.length !== expectedObservationIds.length
    || !expectedObservationIds.every((id) => sourceObservationIds.includes(id))
  ) return null;
  return {
    id:String(value.id || '').trim() || null,
    artifact:structuredClone(artifact),
    artifactRef:artifact.location,
    sourceObservationIds,
    progress:normalizedRecoveredProgress(metadata.progress),
    budget:canonicalOpenResearchBudget(metadata.budget),
  };
}

function normalizedRecoveredProgress(value) {
  return {
    stepsUsed:requiredProgressInteger(value?.stepsUsed, 'stepsUsed'),
    safeRetriesUsed:requiredProgressInteger(value?.safeRetriesUsed, 'safeRetriesUsed'),
    replansUsed:requiredProgressInteger(value?.replansUsed, 'replansUsed'),
  };
}

function completedReportObservation({
  assignment,
  report,
  stepNumber,
  now,
} = {}) {
  return {
    schemaVersion:'agent.army/tool-observation/v1',
    observationId:`${assignment.runId}:open-research:report:${stepNumber}`,
    issueId:assignment.issueId,
    runId:assignment.runId,
    toolId:'controlled.intel-research-report',
    outcome:'succeeded',
    classification:'goal_satisfied',
    provenance:'trusted_report_executor',
    result:{
      acceptanceSatisfied:true,
      evidenceSourceCount:report.sourceObservationIds.length,
      workProduct:{
        type:'ResearchReport',
        schemaVersion:'agent.army/intel-research-report/v1',
        runId:assignment.runId,
        artifactRef:report.artifactRef,
        sourceObservationIds:report.sourceObservationIds,
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          claimEvidenceBound:true,
        },
      },
    },
    recordedAt:now().toISOString(),
  };
}

function completedOpenResearchResult({
  report,
  issueId,
  runId,
  progress,
  budget,
  now,
  reusedReport,
} = {}) {
  return {
    status:'succeeded',
    currentStage:'open_research_complete',
    artifactRefs:[report.artifact],
    execution:{
      openResearch:{
        schemaVersion:'agent.army/open-research-runtime-state/v1',
        issueId,
        runId,
        lastObservation:null,
        lastDecision:null,
        progress,
        budget,
        lastWorkProductId:report.id,
        projectionSource:'paperclip_work_product',
        updatedAt:now().toISOString(),
      },
    },
    openResearch:{
      decision:{
        action:'complete',
        executionStatus:'complete',
        selectedToolId:null,
      },
      reportWorkProductId:report.id,
      sourceObservationIds:report.sourceObservationIds,
      reusedReport:reusedReport === true,
    },
  };
}

function requiredProgressInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`小R开放研究进度 ${label} 缺失或无效。`);
  }
  return normalized;
}

function requiredBudgetInteger(value, label, { positive = false } = {}) {
  const normalized = Number(value);
  if (
    !Number.isInteger(normalized)
    || normalized < 0
    || (positive && normalized === 0)
  ) {
    throw new Error(`小R开放研究预算 ${label} 缺失或无效。`);
  }
  return normalized;
}

function canonicalOpenResearchBudget(value) {
  return {
    remainingUnits:requiredBudgetInteger(value?.remainingUnits, 'remainingUnits'),
    estimatedNextStepUnits:requiredBudgetInteger(
      value?.estimatedNextStepUnits,
      'estimatedNextStepUnits',
      { positive:true },
    ),
  };
}

function assertOpenResearchToolBudget(progress, budget) {
  if (progress.stepsUsed >= INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps) {
    throw new Error('小R开放研究步骤预算已耗尽。');
  }
  if (budget.remainingUnits < budget.estimatedNextStepUnits) {
    throw new Error('小R开放研究费用预算不足。');
  }
}

function initialResearchTool(task) {
  const sourceUrl = openResearchSourceUrl(task);
  if (!sourceUrl) return 'content.public.search';
  if (/\.pdf(?:$|[?#])/i.test(sourceUrl)) return 'content.public.pdf.read';
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(sourceUrl)) return 'github.public.read';
  return 'content.public.fetch';
}

function assertManifestResearchTool(toolId, agent) {
  const contract = INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT;
  const manifestTools = new Set(
    (Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (!contract.toolIds.includes(toolId) || !manifestTools.has(toolId)) {
    throw new Error(`小R Manifest 未授权 ${toolId}。`);
  }
}

async function executeObservedResearchTool({
  task,
  assignment,
  roleToolContext,
  toolId,
  stepNumber,
  priorObservation = null,
  now,
} = {}) {
  const sourceUrl = researchToolSourceUrl({ task, toolId, priorObservation });
  const request = researchToolRequest({ task, toolId, sourceUrl });
  let output = null;
  let failure = null;
  try {
    output = await roleToolContext.execute(request);
  } catch (error) {
    failure = error;
  }
  return trustedAdapterObservation({
    assignment,
    toolId,
    stepNumber,
    sourceUrl,
    output,
    failure,
    task,
    now,
  });
}

function researchToolRequest({ task, toolId, sourceUrl } = {}) {
  if (toolId === 'content.public.search') {
    return {
      toolId,
      externalSideEffect:'network-read',
      url:'https://html.duckduckgo.com/html/',
      input:{
        query:String(
          task?.input?.topic
          || task?.input?.title
          || task?.input?.goalSpec?.objective
          || '',
        ).trim().slice(0, 300),
        limit:3,
      },
    };
  }
  const safeUrl = publicResearchUrl(sourceUrl);
  if (!safeUrl) throw new Error('小R开放研究缺少可核验的公开来源 URL。');
  return {
    toolId,
    externalSideEffect:'network-read',
    url:safeUrl,
    input:{
      sourceUrl:safeUrl,
      ...(toolId.startsWith('github.') ? { operation:'read' } : {}),
    },
  };
}

function researchToolSourceUrl({ task, toolId, priorObservation } = {}) {
  if (toolId === 'content.public.search' || toolId === 'github.public.search') return null;
  const observed = publicResearchUrl(priorObservation?.result?.sourceUrl);
  if (
    observed
    && priorObservation?.classification === 'source_verified'
    && !['content.public.search', 'github.public.search'].includes(priorObservation?.toolId)
  ) {
    const urls = openResearchSourceUrls(task);
    const currentIndex = urls.indexOf(observed);
    if (currentIndex >= 0 && urls[currentIndex + 1]) return urls[currentIndex + 1];
  }
  return observed || openResearchSourceUrl(task);
}

function openResearchSourceUrl(task) {
  return openResearchSourceUrls(task)[0] || null;
}

function openResearchSourceUrls(task) {
  const candidates = [
    ...(Array.isArray(task?.input?.sourceUrls) ? task.input.sourceUrls : []),
    task?.input?.sourceUrl,
  ];
  return [...new Set(candidates.map(publicResearchUrl).filter(Boolean))];
}

function publicResearchUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || /^(?:localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(
      parsed.hostname,
    )
  ) return null;
  return parsed.toString();
}

function trustedAdapterObservation({
  assignment,
  toolId,
  stepNumber,
  sourceUrl,
  output,
  failure,
  task,
  now,
} = {}) {
  const errorCode = String(failure?.code || '').trim().toLowerCase();
  const errorText = String(failure?.message || '').toLowerCase();
  const contentType = String(output?.contentType || output?.mimeType || '').toLowerCase();
  const discoveredUrl = Array.isArray(output?.results)
    ? output.results.map((item) => publicResearchUrl(item?.url)).find(Boolean)
    : null;
  const actualSourceUrl = publicResearchUrl(
    output?.sourceRef || output?.url || discoveredUrl || sourceUrl,
  );
  const fetchedAt = validTimestampText(output?.fetchedAt || output?.searchedAt);
  const contentHash = validHashText(output?.contentHash);
  let outcome = failure ? 'failed' : 'succeeded';
  let classification = 'source_verified';
  let error = null;
  if (
    toolId === 'content.public.fetch'
    && (
      contentType.includes('application/pdf')
      || errorCode.includes('pdf')
      || errorText.includes('pdf')
    )
  ) {
    outcome = 'failed';
    classification = 'pdf_detected';
    error = { code:'content_type_pdf', retryable:false };
  } else if (
    toolId === 'content.public.fetch'
    && (
      output?.requiresDynamic === true
      || errorCode.includes('dynamic')
      || errorText.includes('javascript')
    )
  ) {
    outcome = 'failed';
    classification = 'dynamic_page_required';
    error = { code:'client_render_required', retryable:false };
  } else if (failure) {
    classification = 'transport_unavailable';
    error = {
      code:String(failure?.code || 'adapter_failed').slice(0, 120),
      retryable:failure?.retryable === true,
    };
  }
  const observation = {
    schemaVersion:'agent.army/tool-observation/v1',
    observationId:`${assignment.runId}:open-research:${stepNumber}`,
    issueId:assignment.issueId,
    runId:assignment.runId,
    toolId,
    outcome,
    classification,
    provenance:'trusted_role_tool_adapter',
    result:{
      sourceUrl:actualSourceUrl,
      contentType:contentType || null,
      fetchedAt,
      contentHash,
      evidenceSourceCount:outcome === 'succeeded' ? 1 : 0,
      acceptanceSatisfied:false,
      nextToolId:deterministicNextResearchTool({ task, toolId, actualSourceUrl }),
      ...(
        outcome === 'succeeded'
        && !['content.public.search', 'github.public.search'].includes(toolId)
        && actualSourceUrl
        && fetchedAt
        && contentHash
          ? {
              sourceEvidence:trustedSourceEvidence({
                toolId,
                actualSourceUrl,
                fetchedAt,
                contentHash,
                title:output?.title,
              }),
            }
          : {}
      ),
    },
    ...(error ? { error } : {}),
    recordedAt:now().toISOString(),
  };
  const sourceSummary = controlledSourceSummary(output?.text || output?.summary);
  if (observation.result.sourceEvidence && sourceSummary) {
    Object.defineProperty(observation, CONTROLLED_SOURCE_MATERIAL, {
      value:Object.freeze({ summary:sourceSummary }),
      enumerable:false,
      configurable:false,
      writable:false,
    });
  }
  return observation;
}

function trustedSourceEvidence({
  toolId,
  actualSourceUrl,
  fetchedAt,
  contentHash,
  title,
} = {}) {
  const sourceId = `source-${createHash('sha256')
    .update(`${actualSourceUrl}|${contentHash}`)
    .digest('hex')
    .slice(0, 16)}`;
  const safeTitle = String(title || '未提供标题的公开来源')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const fragmentId = `${sourceId}-provenance`;
  return {
    sourceId,
    title:safeTitle,
    url:actualSourceUrl,
    fetchedAt,
    contentHash,
    kind:toolId === 'content.public.pdf.read'
      ? 'public_pdf'
      : toolId === 'content.public.dynamic.read'
        ? 'public_dynamic_web'
        : toolId.startsWith('github.')
          ? 'github_public'
          : 'public_web',
    evidenceFragment:{
      fragmentId,
      text:`受控适配器已读取公开来源《${safeTitle}》，抓取时间 ${fetchedAt}，正文校验值 ${contentHash}。`,
    },
  };
}

function controlledSourceSummary(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (
    /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|[?&](?:token|api[_-]?key|secret|password)=)/i.test(compact)
    || /(?:^|[\s"'=:])\/(?:Users|home|private|tmp|var|opt|etc)(?:\/|$)/i.test(compact)
  ) return null;
  return (compact.split(/(?<=[。！？.!?])\s*/).find(Boolean) || compact).slice(0, 900);
}

function deterministicNextResearchTool({ task, toolId, actualSourceUrl } = {}) {
  const urls = [
    ...(Array.isArray(task?.input?.sourceUrls) ? task.input.sourceUrls : []),
    task?.input?.sourceUrl,
  ].map(publicResearchUrl).filter(Boolean);
  const currentIndex = urls.indexOf(actualSourceUrl);
  const nextUrl = currentIndex >= 0 ? urls[currentIndex + 1] : null;
  if (nextUrl) {
    if (/\.pdf(?:$|[?#])/i.test(nextUrl)) return 'content.public.pdf.read';
    if (/^https?:\/\/(?:www\.)?github\.com\//i.test(nextUrl)) return 'github.public.read';
    return 'content.public.fetch';
  }
  if (toolId === 'content.public.search') return 'content.public.fetch';
  return 'content.public.search';
}

function validTimestampText(value) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function validHashText(value) {
  const text = String(value || '').trim();
  return /^sha256:[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
}

function openResearchStepWorkProduct({
  task,
  assignment,
  initialToolId,
  observation,
  decision,
  nextObservation,
  progress,
  budget,
  now,
} = {}) {
  return {
    type:'OpenResearchStep',
    schemaVersion:'agent.army/open-research-step/v1',
    title:`小R开放研究步骤 ${progress.stepsUsed}`,
    idempotencyKey:`open-research-step:${decision.decisionId}`,
    metadata:{
      taskId:String(task?.taskId || '').trim() || null,
      issueId:assignment.issueId,
      runId:assignment.runId,
      initialToolId,
      observation,
      decision,
      nextObservation,
      progress,
      budget,
      recordedAt:now().toISOString(),
    },
  };
}

function healthyOpenResearchWorkProduct(value, { runId } = {}) {
  const type = String(value?.type || '').trim();
  const schemaVersion = String(value?.schemaVersion || '').trim();
  const artifactRef = String(value?.artifactRef || '').trim();
  const sourceObservationIds = Array.isArray(value?.sourceObservationIds)
    ? [...new Set(value.sourceObservationIds.map(String).filter(Boolean))]
    : [];
  const validation = value?.validation || {};
  if (
    type !== 'ResearchReport'
    || schemaVersion !== 'agent.army/intel-research-report/v1'
    || value?.runId !== runId
    || !artifactRef
    || sourceObservationIds.length < 2
    || validation.exists !== true
    || validation.readable !== true
    || validation.nonEmpty !== true
    || validation.claimEvidenceBound !== true
  ) return null;
  return {
    type,
    schemaVersion,
    artifactRef,
    runId,
    sourceObservationIds,
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      claimEvidenceBound:true,
    },
  };
}
