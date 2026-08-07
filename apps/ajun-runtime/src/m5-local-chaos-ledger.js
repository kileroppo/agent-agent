import { LOCAL_CHAOS_FIXTURE } from './m5-local-chaos-fixtures.js';

export function buildM5LocalChaosLedger({
  definition,
  declaredTransitions,
  campaignCase,
  dayCase,
  platformCase,
  caseJourney,
  requestChangesTo,
  parallel,
  recovery,
  paperclipControl,
  costRecorder,
  budgetErrorCode,
  connectorCallsBeforeResume,
  pausedCampaign,
  resumeWithoutGrantErrorCode,
  connectorCallsBeforeGrantResume,
  resumedCampaign,
  publishResult,
  controllerReplay,
  gatewayReplay,
  douyin,
  metrics,
  clock,
}) {
  const declaredSuccessStages = definition.stages
    .filter((stage) => stage.kind !== 'cancelled' && stage.key !== 'learning')
    .map((stage) => stage.key);
  const traversedStages = new Set(caseJourney.map((item) => item.toStage));
  const assertions = [
    assertion('definition_16_stages', definition.stages.length === 16),
    assertion(
      'success_path_to_done',
      declaredSuccessStages.every((stage) => traversedStages.has(stage))
        && caseJourney.at(-1)?.toStage === 'done'
        && caseJourney.slice(1).every((item) => item.declaredTransition === true),
    ),
    assertion(
      'cancelled_is_alternative_only',
      definition.stages.some((stage) => stage.key === 'cancelled' && stage.kind === 'cancelled')
        && !traversedStages.has('cancelled'),
    ),
    assertion(
      'parallel_max_4',
      parallel.declaredMaxConcurrency === 4
        && parallel.observedMaxConcurrency === 4
        && parallel.observedMaxConcurrency <= 4
        && parallel.barrierEvidence.every((item) =>
          item.arrived === item.waveSize
          && item.completedBeforeRelease === 0,
        ),
    ),
    assertion(
      'single_safe_retry_and_restart_resume',
      recovery.safeRetryCount === 1
        && recovery.reusedVerifiedWorkProduct
        && recovery.workProductCountBeforeRestart === recovery.workProductCountAfterRestart,
    ),
    assertion(
      'single_request_changes',
      caseJourney.filter((item) => item.reason === 'request_changes').length === 1,
    ),
    assertion(
      'single_budget_hard_stop',
      budgetErrorCode === 'publisher_budget_exceeded'
        && paperclipControl.pauseCalls.length === 1
        && connectorCallsBeforeResume === 0
        && pausedCampaign.fields.campaignGrant.status === 'paused'
        && pausedCampaign.fields.dailyCronEnabled === false
        && resumeWithoutGrantErrorCode === 'campaign_not_active'
        && connectorCallsBeforeGrantResume === 0
        && resumedCampaign.fields.campaignGrant.status === 'active'
        && resumedCampaign.fields.dailyCronEnabled === true,
    ),
    assertion(
      'fake_publish_idempotent',
      publishResult.receipt.receiptId === gatewayReplay.receipt.receiptId
        && gatewayReplay.replayed === true
        && controllerReplay.replayed === true
        && douyin.publishCalls.length === 1,
    ),
    assertion(
      'three_metric_snapshots',
      metrics.snapshots.length === 3
        && metrics.connectorCalls === 3
        && metrics.duplicateCollections === 0,
    ),
  ];

  const ledger = {
    schemaVersion:'agent.army/m5-local-chaos-acceptance/v1',
    mode:'local_fake_only',
    externalEffects:false,
    paidCalls:0,
    generatedAt:clock().toISOString(),
    scope:{
      campaignCaseId:campaignCase.id,
      dayCaseId:dayCase.id,
      platformCaseId:platformCase.id,
      scheduledDate:LOCAL_CHAOS_FIXTURE.scheduledDate,
      platform:'douyin',
      contentVersionId:'content-v1',
    },
    definition:{
      declaredStageCount:definition.stages.length,
      stageKeys:definition.stages.map((stage) => stage.key),
      successfulPath:declaredSuccessStages,
      successTerminal:'done',
      alternativeTerminal:'cancelled',
      declaredTransitionCount:declaredTransitions.length,
      allJourneyEdgesDeclared:caseJourney.slice(1).every(
        (item) => item.declaredTransition === true,
      ),
    },
    caseJourney,
    parallel,
    recovery,
    review:{
      requestChanges:{
        fromStage:'machine_review',
        toStage:requestChangesTo,
        count:caseJourney.filter((item) => item.reason === 'request_changes').length,
      },
      finalApprovalPassed:true,
    },
    budget:{
      hardStopCount:paperclipControl.pauseCalls.length,
      errorCode:budgetErrorCode,
      connectorCallsBeforeResume,
      grantStatusAfterStop:pausedCampaign.fields.campaignGrant.status,
      cronEnabledAfterStop:pausedCampaign.fields.dailyCronEnabled,
      resumeWithoutGrantErrorCode,
      connectorCallsBeforeGrantResume,
      grantStatusAfterResume:resumedCampaign.fields.campaignGrant.status,
      cronEnabledAfterResume:resumedCampaign.fields.dailyCronEnabled,
      resumed:paperclipControl.resumeCount === 1 && costRecorder.resumeCount === 1,
    },
    publisher:{
      connectorMode:'fake',
      receiptId:publishResult.receipt.receiptId,
      externalContentId:publishResult.receipt.externalContentId,
      connectorCalls:douyin.publishCalls.length,
      controllerReplay:controllerReplay.replayed === true,
      replayed:gatewayReplay.replayed === true,
      sameReceipt:publishResult.receipt.receiptId === gatewayReplay.receipt.receiptId,
    },
    metrics,
    assertions,
    passed:assertions.every((item) => item.passed),
  };
  const security = inspectM5LocalLedgerSafety(ledger);
  if (!security.passed) {
    throw new Error(`M5 本地 chaos ledger 安全审计失败：${security.violations.join('；')}`);
  }
  return { ...ledger, security };
}

export function inspectM5LocalLedgerSafety(value) {
  const violations = [];
  let checkedNodes = 0;
  const sensitiveKey = /(?:^|[_-])(?:authorization|cookie|token|secret|password|api[_-]?key)(?:$|[_-])/i;
  const credentialValue = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,})/i;
  const absolutePath = /(?:^|[\s"'=:])\/(?:Users|home|private|tmp|var|opt|etc)(?:\/|$)|(?:^|[\s"'=:])[a-z]:\\(?:Users|Windows|Program Files)(?:\\|$)/i;
  const visit = (item, path) => {
    checkedNodes += 1;
    if (typeof item === 'string') {
      if (credentialValue.test(item)) violations.push(`${path}:credential_value`);
      if (absolutePath.test(item)) violations.push(`${path}:absolute_path`);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = `${path}.${key}`;
      if (sensitiveKey.test(key)) violations.push(`${childPath}:credential_field`);
      visit(child, childPath);
    }
  };
  visit(value, '$');
  return {
    passed:violations.length === 0,
    checkedNodes,
    credentialFields:violations.filter((item) => item.endsWith(':credential_field')).length,
    credentialValues:violations.filter((item) => item.endsWith(':credential_value')).length,
    absolutePaths:violations.filter((item) => item.endsWith(':absolute_path')).length,
    violations,
  };
}

function assertion(id, passed) {
  return { id, passed:passed === true };
}
