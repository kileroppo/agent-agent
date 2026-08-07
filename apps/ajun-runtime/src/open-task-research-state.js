import { createHash } from 'node:crypto';
import { INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT } from '@agent-army/m5-kernel/routine-execution-contract';

const CONTROLLED_SOURCE_MATERIAL = Symbol.for(
  'agent.army.openResearch.controlledSourceMaterial',
);

function recoverIntelResearchOpenTaskState({
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

function validTimestampText(value) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function validHashText(value) {
  const text = String(value || '').trim();
  return /^sha256:[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
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

export const openTaskResearchState = Object.freeze({
  recover:recoverIntelResearchOpenTaskState,
  sources:Object.freeze({
    addVerified:addVerifiedSourceObservation,
    publicUrl:publicResearchUrl,
    validTimestamp:validTimestampText,
    validHash:validHashText,
  }),
  report:Object.freeze({
    verifyArtifact:verifiedResearchReportArtifact,
    workProduct:openResearchReportWorkProduct,
    completedObservation:completedReportObservation,
    completedResult:completedOpenResearchResult,
  }),
  progress:Object.freeze({
    requiredInteger:requiredProgressInteger,
    requiredBudgetInteger,
    canonicalBudget:canonicalOpenResearchBudget,
    assertToolBudget:assertOpenResearchToolBudget,
  }),
  healthyCompletion:healthyOpenResearchWorkProduct,
});
