import crypto from 'node:crypto';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  routeDescriptorFingerprint,
  routeExecutionDescriptor,
  validM5RouteExecution,
} from './route-execution.js';
import { stageRecoveryState } from './stage-recovery-state.js';

const {
  Error:M5StageRecoveryError,
  records:{ contentValue:contentRecoveryValue },
  revision:{ valid:validPlanRevision },
  input:{ safeText },
  content:{ resolve:resolveM5ContentCase },
  conflict:isVersionConflict,
} = stageRecoveryState;

async function getActiveM5PlanRevision({
  governance,
  pipelineCaseId,
  stageKey,
  pipelineCase = null,
} = {}) {
  if (
    !governance
    || typeof governance.getPipelineCase !== 'function'
    || !/^[0-9a-f-]{36}$/i.test(String(pipelineCaseId || ''))
    || !/^[a-z][a-z0-9_]{0,63}$/.test(String(stageKey || ''))
  ) return null;
  const currentValue = pipelineCase || await governance.getPipelineCase(pipelineCaseId);
  const currentCase = currentValue?.case ?? currentValue;
  if (currentCase?.id !== pipelineCaseId) return null;
  if (
    !String(currentCase.fields?.campaignId || '').trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(currentCase.fields?.scheduledDate || ''))
  ) {
    if (currentCase.fields?.m5ContentRecovery) {
      throw new M5StageRecoveryError('含恢复状态的 M5 Case 缺少可核验的内容根字段。');
    }
    return null;
  }
  const contentCase = await resolveM5ContentCase(governance, currentCase);
  const recovery = contentRecoveryValue(contentCase?.fields?.m5ContentRecovery);
  const revision = recovery?.activePlanRevision;
  if (
    !validPlanRevision(revision)
    || revision.failedCaseId !== currentCase.id
    || revision.nextRoute?.stageKey !== stageKey
  ) return null;
  return structuredClone(revision);
}

async function consumeM5SystemPlanRevision({
  governance,
  pipelineCaseId,
  stageKey,
  runId,
  routeSummary,
  now = () => new Date(),
} = {}) {
  if (
    !governance
    || typeof governance.getPipelineCase !== 'function'
    || !/^[0-9a-f-]{36}$/i.test(String(pipelineCaseId || ''))
    || !/^[a-z][a-z0-9_]{0,63}$/.test(String(stageKey || ''))
    || !String(runId || '').trim()
    || String(routeSummary || '').trim().length < 12
  ) {
    throw new M5StageRecoveryError('系统控制器消费重规划缺少可信 Case、Run、阶段或路线说明。');
  }
  for (let conflictAttempt = 0; conflictAttempt < 5; conflictAttempt += 1) {
    const caseValue = await governance.getPipelineCase(pipelineCaseId);
    const caseItem = caseValue?.case ?? caseValue;
    if (caseItem?.id !== pipelineCaseId) {
      throw new M5StageRecoveryError('系统控制器消费重规划时无法核验当前 Case。');
    }
    if (
      !String(caseItem.fields?.campaignId || '').trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(caseItem.fields?.scheduledDate || ''))
    ) {
      if (caseItem.fields?.m5ContentRecovery) {
        throw new M5StageRecoveryError('含恢复状态的系统控制器 Case 缺少可核验的内容根字段。');
      }
      return null;
    }
    const contentCase = await resolveM5ContentCase(governance, caseItem);
    const recovery = contentRecoveryValue(contentCase?.fields?.m5ContentRecovery);
    const revision = recovery?.activePlanRevision;
    if (
      !validPlanRevision(revision)
      || revision.failedCaseId !== pipelineCaseId
      || revision.nextRoute?.stageKey !== stageKey
    ) return null;
    if (revision.nextRoute.kind !== 'system_controller_rederive_case_state') {
      throw new M5StageRecoveryError('系统控制器拒绝消费 Hermes 重规划路线。');
    }
    const existing = recovery.planRevisionConsumptions.find((item) =>
      item.revisionId === revision.revisionId && item.runId === runId
    );
    if (existing) return structuredClone(existing);
    const previousExecution = [...recovery.planRevisionConsumptions]
      .reverse()
      .find((item) => item.revisionId === revision.revisionId)?.routeExecution || null;
    const routeExecution = createM5RouteExecution({
      runId,
      stageKey,
      recovery:revision,
      previousExecution,
      strategy:revision.nextRoute.kind,
      toolIds:[`agent-army.m5-system:${stageKey}`],
      inputs:systemControllerRouteInputs(caseItem, contentCase),
      now,
    });
    assertChangedM5RecoveryRoute(routeExecution, revision);
    const receipt = {
      schemaVersion:'agent.army/m5-plan-revision-consumption/v1',
      revisionId:revision.revisionId,
      runId:String(runId).trim(),
      stageKey,
      routeKind:revision.nextRoute.kind,
      routeChanged:routeExecution.routeChanged,
      routeExecution,
      routeSummary:[
        String(routeSummary).trim(),
        routeExecution.routeSummary,
      ].join(' ').slice(0, 500),
      consumedAt:now().toISOString(),
    };
    if (typeof governance.patchPipelineCaseFields !== 'function') {
      throw new M5StageRecoveryError('系统控制器缺少持久化重规划消费回执的 Paperclip 适配。');
    }
    const fields = {
      ...(contentCase.fields || {}),
      m5ContentRecovery:{
        ...recovery,
        updatedAt:receipt.consumedAt,
        planRevisionConsumptions:[
          ...recovery.planRevisionConsumptions,
          receipt,
        ].slice(-32),
      },
    };
    try {
      await governance.patchPipelineCaseFields(contentCase.id, {
        expectedVersion:contentCase.version,
        fields,
        runId,
      });
      return structuredClone(receipt);
    } catch (error) {
      if (conflictAttempt < 4 && isVersionConflict(error)) continue;
      throw error;
    }
  }
  throw new M5StageRecoveryError('系统控制器消费重规划时发生持续版本冲突。');
}

function createPlanRevision({
  assignment,
  contract,
  contentCase,
  failedCase,
  replanCount,
  summary,
  occurredAt,
  routeExecution,
}) {
  const observation = safeText(summary, 500);
  const rejectedExecution = routeExecutionDescriptor(routeExecution)
    || defaultRejectedRouteExecution({ contract, contentCase, failedCase });
  return {
    schemaVersion:'agent.army/m5-plan-revision/v1',
    revisionId:`m5-plan-revision:${contentCase.id}:r${replanCount}`,
    contentCaseId:contentCase.id,
    revision:replanCount,
    failedCaseId:assignment.pipelineCaseId,
    failureObservation:{
      issueId:assignment.issueId,
      runId:assignment.runId,
      stageKey:contract.stageKey,
      summary:observation,
      summaryHash:`sha256:${crypto.createHash('sha256').update(observation).digest('hex')}`,
    },
    rejectedRoute:{
      kind:'retry_same_inputs',
      reason:'单阶段两次安全重试已经用尽。',
      execution:rejectedExecution,
      routeFingerprint:routeDescriptorFingerprint(rejectedExecution),
    },
    nextRoute:{
      kind:contract.executionMode === 'system_controller'
        ? 'system_controller_rederive_case_state'
        : 'same_stage_rebuild_inputs',
      stageKey:contract.stageKey,
      preserveVerifiedWorkProducts:true,
      instruction:'读取失败 Observation，保留已验证产物，在现有岗位工具白名单内重建输入或选择替代参数；禁止扩大权限。',
    },
    createdAt:occurredAt,
  };
}

function latestSystemRouteExecution(contentRecovery) {
  return [...(contentRecovery?.planRevisionConsumptions || [])]
    .reverse()
    .map((item) => item?.routeExecution)
    .find(validM5RouteExecution) || null;
}

function defaultRejectedRouteExecution({ contract, contentCase, failedCase }) {
  return routeExecutionDescriptor(createM5RouteExecution({
    runId:'m5-default-route-baseline',
    stageKey:contract.stageKey,
    strategy:'default_system_route',
    toolIds:[`agent-army.m5-system:${contract.stageKey}`],
    inputs:systemControllerRouteInputs(failedCase, contentCase),
  }));
}

function systemControllerRouteInputs(targetCase, contentCase) {
  return {
    targetCase:systemControllerCaseInput(targetCase),
    contentCase:systemControllerCaseInput(contentCase),
  };
}

function systemControllerCaseInput(caseItem) {
  const fields = caseItem?.fields && typeof caseItem.fields === 'object'
    ? Object.fromEntries(
        Object.entries(caseItem.fields)
          .filter(([key]) => key !== 'm5ContentRecovery')
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    : {};
  return {
    caseId:String(caseItem?.id || ''),
    caseKey:String(caseItem?.caseKey || ''),
    stageKey:String(caseItem?.stageKey || ''),
    fields,
  };
}

export const stageRecoveryPlanRevision = Object.freeze({
  active:getActiveM5PlanRevision,
  consume:consumeM5SystemPlanRevision,
  create:createPlanRevision,
  latestSystemExecution:latestSystemRouteExecution,
});
