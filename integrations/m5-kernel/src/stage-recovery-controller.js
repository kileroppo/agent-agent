import crypto from 'node:crypto';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  routeDescriptorFingerprint,
  routeExecutionDescriptor,
  validM5RouteExecution,
} from './route-execution.js';

const RECOVERY_SCHEMA = 'agent.army/m5-stage-recovery/v1';
const CONTENT_RECOVERY_SCHEMA = 'agent.army/m5-content-recovery/v1';
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'blocked', 'timed_out', 'timeout']);
const RECOVERY_ACTIONS = new Set(['retry', 'replan', 'blocked']);

export const M5_STAGE_RECOVERY_LIMITS = Object.freeze({
  maxStageRetries:2,
  maxReplansPerContent:3,
});

export class M5StageRecoveryError extends Error {}

export async function getActiveM5PlanRevision({
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

export async function consumeM5SystemPlanRevision({
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

export class M5StageRecoveryController {
  constructor({
    governance,
    maxStageRetries = M5_STAGE_RECOVERY_LIMITS.maxStageRetries,
    maxReplansPerContent = M5_STAGE_RECOVERY_LIMITS.maxReplansPerContent,
    workProductValidator = null,
    now = () => new Date(),
  } = {}) {
    this.governance = governance;
    this.maxStageRetries = positiveLimit(maxStageRetries, '单阶段重试上限');
    this.maxReplansPerContent = positiveLimit(maxReplansPerContent, '内容重规划上限');
    this.workProductValidator = typeof workProductValidator === 'function'
      ? workProductValidator
      : null;
    this.now = now;
  }

  async handleFailure({ assignment, contract, task = null, summary, routeExecution = null } = {}) {
    assertRecoveryInput({ assignment, contract });
    this.assertGovernance();
    for (let conflictAttempt = 0; conflictAttempt < 5; conflictAttempt += 1) {
      const snapshot = await this.snapshot(assignment);
      const stageCandidates = m5StageWorkProductCandidates(snapshot.outputs, contract);
      const existingProducts = healthyM5StageWorkProducts(stageCandidates, contract);
      if (stageCandidates.length > 1) {
        throw new M5StageRecoveryError(
          `M5 ${contract.stageKey} 阶段存在多个 Work Product 候选或未解决漂移，拒绝自动选择。`,
        );
      }
      if (stageCandidates.length === 1 && existingProducts.length !== 1) {
        throw new M5StageRecoveryError(
          `M5 ${contract.stageKey} Work Product 候选结构、Provider 或状态漂移；禁止自动恢复或覆盖。`,
        );
      }
      if (existingProducts.length === 1) {
        if (!this.workProductValidator) {
          throw new M5StageRecoveryError(
            `M5 ${contract.stageKey} 已有 Work Product，但完整漂移校验器不可用，禁止自动恢复。`,
          );
        }
        try {
          await this.workProductValidator({
            contract,
            product:existingProducts[0],
            targetCaseId:assignment.pipelineCaseId,
            projectId:assignment.projectId,
            assignment,
            task,
            paperclipRuns:snapshot.runs,
          });
        } catch (error) {
          throw new M5StageRecoveryError(
            `M5 ${contract.stageKey} Work Product 漂移：${error?.message || '完整校验失败'}；禁止自动恢复或覆盖。`,
          );
        }
        await this.governance.completeM5RecoveredStageIssue(assignment.issueId, {
          runId:assignment.runId,
          comment:recoveryComment({
            action:'verified_work_product',
            contract,
            assignment,
            stageAttempt:0,
            replanCount:0,
            detail:'已验证 Work Product 已存在；重放未再次执行阶段或写入产物。',
          }),
        });
        return {
          action:'verified_work_product',
          replayed:true,
          stageAttempt:0,
          replanCount:0,
          workProductId:existingProducts[0].id || null,
        };
      }

      const state = deriveM5StageRecoveryState({
        assignment,
        contract,
        caseItem:snapshot.caseItem,
        contentCase:snapshot.contentCase,
        issue:snapshot.issue,
        runs:snapshot.runs,
        events:snapshot.events,
      });
      const handled = [...state.history, ...state.contentHistory]
        .find((item) => item.runId === assignment.runId);
      if (handled) {
        await this.applyIssueDecision({
          assignment,
          contract,
          decision:handled,
          replayed:true,
        });
        return { ...handled, replayed:true };
      }

      const decision = planM5StageFailureRecovery({
        state,
        maxStageRetries:this.maxStageRetries,
        maxReplansPerContent:this.maxReplansPerContent,
      });
      const occurredAt = this.now().toISOString();
      const record = {
        runId:assignment.runId,
        issueId:assignment.issueId,
        stageKey:contract.stageKey,
        action:decision.action,
        stageAttempt:decision.stageAttempt,
        replanCount:decision.replanCount,
        occurredAt,
      };
      const recoveryAction = decision.action === 'blocked'
        ? uniqueRecoveryAction({
            assignment,
            contract,
            replanCount:decision.replanCount,
          })
        : null;
      const previousContentRecovery = contentRecoveryValue(
        snapshot.contentCase.fields?.m5ContentRecovery,
      );
      const recordedDecision = {
        ...record,
        caseId:snapshot.caseItem.id,
        ...(decision.action === 'replan' ? {
          planRevision:createPlanRevision({
            assignment,
            contract,
            contentCase:snapshot.contentCase,
            failedCase:snapshot.caseItem,
            replanCount:decision.replanCount,
            summary,
            occurredAt,
            routeExecution:validM5RouteExecution(routeExecution)
              ? routeExecution
              : latestSystemRouteExecution(previousContentRecovery),
          }),
        } : {}),
        ...(recoveryAction ? { recoveryAction } : {}),
      };
      const history = [...state.history, recordedDecision].slice(-32);
      const recovery = {
        schemaVersion:RECOVERY_SCHEMA,
        stageKey:contract.stageKey,
        status:decision.action === 'blocked' ? 'blocked' : 'scheduled',
        stageAttempt:decision.nextStageAttempt,
        replanCount:decision.replanCount,
        lastHandledRunId:assignment.runId,
        lastFailureSummary:safeText(summary, 500),
        updatedAt:occurredAt,
        history,
        recoveryAction,
      };
      const contentHistory = decision.action === 'replan' || decision.action === 'blocked'
        ? [...state.contentHistory, recordedDecision].slice(-128)
        : state.contentHistory;
      const contentFields = {
        ...(snapshot.contentCase.fields || {}),
        m5ContentRecovery:{
          schemaVersion:CONTENT_RECOVERY_SCHEMA,
          replanCount:decision.replanCount,
          lastHandledRunId:assignment.runId,
          updatedAt:occurredAt,
          history:contentHistory,
          activePlanRevision:recordedDecision.planRevision
            || previousContentRecovery?.activePlanRevision
            || null,
          planRevisionConsumptions:[
            ...(previousContentRecovery?.planRevisionConsumptions || []),
          ].slice(-32),
          stageRecoveries:{
            ...(previousContentRecovery?.stageRecoveries || {}),
            [stageRecoveryKey(snapshot.caseItem.id, contract.stageKey)]:recovery,
          },
        },
      };
      try {
        await this.governance.patchPipelineCaseFields(
          snapshot.contentCase.id,
          {
            expectedVersion:snapshot.contentCase.version,
            fields:contentFields,
            runId:assignment.runId,
          },
        );
      } catch (error) {
        if (conflictAttempt < 4 && isVersionConflict(error)) continue;
        throw error;
      }
      await this.applyIssueDecision({
        assignment,
        contract,
        decision:recordedDecision,
        replayed:false,
      });
      return { ...recordedDecision, replayed:false };
    }
    throw new M5StageRecoveryError('M5 阶段恢复状态发生并发漂移，请按当前 Paperclip Case 重放。');
  }

  async snapshot(assignment) {
    const caseValue = await this.governance.getPipelineCase(assignment.pipelineCaseId);
    const caseItem = caseValue?.case ?? caseValue;
    if (!caseItem?.id || !Number.isInteger(Number(caseItem.version))) {
      throw new M5StageRecoveryError('M5 阶段恢复缺少带版本的 Paperclip Case。');
    }
    const contentCase = await resolveM5ContentCase(this.governance, caseItem);
    const [issue, runs, events, contentEvents, outputs] = await Promise.all([
      this.governance.getPaperclipIssue(assignment.issueId),
      this.governance.getPaperclipIssueRuns(assignment.issueId),
      this.governance.getPipelineCaseEvents(assignment.pipelineCaseId),
      contentCase.id === caseItem.id
        ? Promise.resolve([])
        : this.governance.getPipelineCaseEvents(contentCase.id),
      this.governance.getPipelineCaseOutputs(assignment.pipelineCaseId),
    ]);
    return {
      caseItem,
      contentCase,
      issue,
      runs:listItems(runs, 'runs'),
      events:[
        ...listItems(events, 'events'),
        ...listItems(contentEvents, 'events'),
      ],
      outputs,
    };
  }

  async applyIssueDecision({ assignment, contract, decision, replayed }) {
    const detail = decision.action === 'retry'
      ? `安排第 ${decision.stageAttempt} 次阶段尝试后的安全重试。`
      : decision.action === 'replan'
        ? `单阶段安全重试已用尽，安排第 ${decision.replanCount} 次内容重规划。`
        : `阶段重试与 ${decision.replanCount} 次内容重规划均已用尽；${decision.recoveryAction?.instruction || '等待负责人恢复。'}`;
    const comment = recoveryComment({
      action:decision.action,
      contract,
      assignment,
      stageAttempt:decision.stageAttempt,
      replanCount:decision.replanCount,
      detail:`${detail}${replayed ? ' 本次为幂等重放。' : ''}`,
    });
    if (decision.action === 'blocked') {
      await this.governance.blockM5StageIssue(assignment.issueId, {
        runId:assignment.runId,
        comment,
      });
      return;
    }
    await this.governance.reopenM5StageIssue(assignment.issueId, {
      runId:assignment.runId,
      comment,
    });
  }

  assertGovernance() {
    const required = [
      'getPipelineCase',
      'getPaperclipIssue',
      'getPaperclipIssueRuns',
      'getPipelineCaseEvents',
      'getPipelineCaseOutputs',
      'patchPipelineCaseFields',
      'reopenM5StageIssue',
      'blockM5StageIssue',
      'completeM5RecoveredStageIssue',
    ];
    const missing = required.filter((name) => typeof this.governance?.[name] !== 'function');
    if (missing.length) {
      throw new M5StageRecoveryError(`M5 阶段恢复缺少 Paperclip 原生能力：${missing.join('、')}。`);
    }
  }
}

export function deriveM5StageRecoveryState({
  assignment,
  contract,
  caseItem,
  contentCase,
  issue,
  runs,
  events,
} = {}) {
  assertRecoveryInput({ assignment, contract });
  const caseContentRecovery = contentRecoveryValue(
    contentCase?.fields?.m5ContentRecovery || caseItem?.fields?.m5ContentRecovery,
  );
  const rootStageRecovery = recoveryValue(
    caseContentRecovery?.stageRecoveries?.[
      stageRecoveryKey(caseItem?.id, contract.stageKey)
    ],
    contract.stageKey,
  );
  const caseRecovery = rootStageRecovery
    || recoveryValue(caseItem?.fields?.m5StageRecovery, contract.stageKey);
  const issueRecovery = recoveryValue(
    issue?.m5StageRecovery
      || issue?.metadata?.m5StageRecovery
      || issue?.executionPolicy?.m5StageRecovery,
    contract.stageKey,
  );
  const eventRecoveries = listItems(events, 'events')
    .flatMap((event) => recoveryValuesFromEvent(event, contract.stageKey));
  const eventContentRecoveries = listItems(events, 'events')
    .flatMap((event) => contentRecoveryValuesFromEvent(event));
  const source = caseRecovery || issueRecovery || latestRecovery(eventRecoveries) || null;
  const history = uniqueHistory([
    ...(eventRecoveries.flatMap((item) => item.history || [])),
    ...(issueRecovery?.history || []),
    ...(caseRecovery?.history || []),
  ], contract.stageKey);
  const contentHistory = uniqueContentHistory([
    ...(eventContentRecoveries.flatMap((item) => item.history || [])),
    ...(caseContentRecovery?.history || []),
  ]);
  const failedRunIds = new Set(
    listItems(runs, 'runs')
      .filter((run) => FAILED_RUN_STATUSES.has(String(run?.status || run?.state || '').toLowerCase()))
      .map((run) => String(run?.id || run?.runId || '').trim())
      .filter(Boolean),
  );
  const handled = history.some((item) => item.runId === assignment.runId);
  const fallbackAttempt = new Set([...failedRunIds, assignment.runId]).size;
  const stageAttempt = handled
    ? history.find((item) => item.runId === assignment.runId).stageAttempt
    : source
      ? nonNegativeInteger(source.stageAttempt) + 1
      : fallbackAttempt;
  const replanCount = Math.max(
    nonNegativeInteger(caseContentRecovery?.replanCount),
    ...eventContentRecoveries.map((item) => nonNegativeInteger(item.replanCount)),
    ...contentHistory.map((item) => nonNegativeInteger(item.replanCount)),
    nonNegativeInteger(source?.replanCount),
    ...history.map((item) => nonNegativeInteger(item.replanCount)),
  );
  return {
    schemaVersion:RECOVERY_SCHEMA,
    stageKey:contract.stageKey,
    stageAttempt,
    replanCount,
    handled,
    history,
    contentHistory,
    failedRunIds:[...failedRunIds],
  };
}

export function planM5StageFailureRecovery({
  state,
  maxStageRetries = M5_STAGE_RECOVERY_LIMITS.maxStageRetries,
  maxReplansPerContent = M5_STAGE_RECOVERY_LIMITS.maxReplansPerContent,
} = {}) {
  const stageAttempt = Math.max(1, nonNegativeInteger(state?.stageAttempt));
  const replanCount = nonNegativeInteger(state?.replanCount);
  if (stageAttempt <= positiveLimit(maxStageRetries, '单阶段重试上限')) {
    return {
      action:'retry',
      stageAttempt,
      nextStageAttempt:stageAttempt,
      replanCount,
    };
  }
  if (replanCount < positiveLimit(maxReplansPerContent, '内容重规划上限')) {
    return {
      action:'replan',
      stageAttempt,
      nextStageAttempt:0,
      replanCount:replanCount + 1,
    };
  }
  return {
    action:'blocked',
    stageAttempt,
    nextStageAttempt:stageAttempt,
    replanCount,
  };
}

export function healthyM5StageWorkProducts(outputs, contract) {
  const expected = contract?.expectedWorkProduct;
  if (!expected) return [];
  const expectedProvider = {
    ContentVersion:'agent-army.content-autonomy',
    MachineReview:'agent-army.content-autonomy',
    PublishReceipt:'agent-army.publisher-gateway',
    MetricSnapshot:'agent-army.publisher-gateway',
    LearningProposal:'agent-army.m5-retrospective',
  }[expected.type] || 'agent-army.ajun-runtime';
  const candidates = m5StageWorkProductCandidates(outputs, contract);
  const normalized = normalizeStageOutputs(candidates);
  return candidates.filter((_, index) => {
    const item = normalized[index];
    const artifact = item?.artifact;
    const artifactHash = String(item?.artifactHash || '');
    const sourceTaskId = String(item?.sourceTaskId || '').trim();
    const sourceArtifactId = String(item?.sourceArtifactId || '').trim();
    const expectedPayloadValid = expected.type === 'ContentVersion'
      ? validContentVersionWorkProduct(item?.contentVersion, artifact?.contentVersion)
      : expected.type === 'MachineReview'
        ? validMachineReviewWorkProduct(item?.reviewReport, artifact?.reviewReport)
        : true;
    return item?.recordKind === 'work_product'
    && item?.type === 'artifact'
    && item?.provider === expectedProvider
    && item?.sourceTrust == null
    && item?.status === 'active'
    && item?.healthStatus === 'healthy'
    && item?.schemaVersion === expected.schemaVersion
    && item?.kind === expected.type
    && item?.stageKey === contract.stageKey
    && sourceTaskId.length > 0
    && sourceTaskId.length <= 240
    && sourceArtifactId.length > 0
    && sourceArtifactId.length <= 240
    && /^sha256:[0-9a-f]{64}$/i.test(artifactHash)
    && (!item.externalId || item.externalId === artifactHash)
    && artifact
    && typeof artifact === 'object'
    && !Array.isArray(artifact)
    && Object.keys(artifact).length > 0
    && expectedPayloadValid;
  });
}

export function m5StageWorkProductCandidates(outputs, contract) {
  const expected = contract?.expectedWorkProduct;
  if (!expected) return [];
  const source = stageOutputValues(outputs);
  const normalized = normalizeStageOutputs(source);
  return source.filter((_, index) => {
    const item = normalized[index];
    if (item?.recordKind !== 'work_product' || item?.type !== 'artifact') return false;
    return item?.stageKey === contract.stageKey
      || item?.schemaVersion === expected.schemaVersion
      || item?.kind === expected.type;
  });
}

function normalizeStageOutputs(outputs) {
  return stageOutputValues(outputs).map((item) => {
    if (item?.recordKind === 'work_product') return item;
    const metadata = item?.metadata;
    if (item?.kind !== 'work_product' || !metadata || typeof metadata !== 'object') return item;
    const artifact = metadata.artifact?.data || metadata.artifact
      || metadata.contentVersion || metadata.reviewReport || null;
    return {
      id:item.id || null,
      externalId:item.externalId || null,
      recordKind:item.kind,
      type:item.type,
      provider:item.provider,
      sourceTrust:item.sourceTrust ?? null,
      status:item.status,
      healthStatus:item.healthStatus,
      createdByRunId:item.createdByRunId || null,
      schemaVersion:metadata.schemaVersion || null,
      kind:metadata.kind || metadata.artifactKind || null,
      stageKey:metadata.stageKey || null,
      artifact,
      artifactHash:metadata.artifactHash || null,
      sourceTaskId:metadata.sourceTaskId || null,
      sourceArtifactId:metadata.sourceArtifactId || null,
      sourceIssueId:metadata.sourceIssueId || null,
      sourceRunId:metadata.sourceRunId || null,
      pipelineCaseId:metadata.pipelineCaseId || null,
      projectId:metadata.projectId || null,
      contentVersion:metadata.contentVersion || metadata.artifact?.contentVersion
        || (metadata.kind === 'ContentVersion' ? artifact : null),
      reviewReport:metadata.reviewReport || metadata.artifact?.reviewReport
        || (metadata.kind === 'MachineReview' ? artifact : null),
    };
  });
}

function stageOutputValues(outputs) {
  return Array.isArray(outputs)
    ? outputs
    : Array.isArray(outputs?.items) ? outputs.items : [];
}

function validContentVersionWorkProduct(primary, nested) {
  const value = primary || nested;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && String(value.platform || '').trim()
    && String(value.version || value.contentVersion || '').trim()
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.fileHash || value.sha256 || '')),
  );
}

function validMachineReviewWorkProduct(primary, nested) {
  const value = primary || nested;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.passed === true
    && Array.isArray(value.checks)
    && value.checks.length >= 7
    && value.checks.every((check) => check?.passed === true),
  );
}

function latestRecovery(items) {
  const values = Array.isArray(items) ? items : [];
  return values.reduce((latest, candidate) => {
    if (!latest) return candidate;
    const candidateAt = Date.parse(
      candidate?.updatedAt
      || candidate?.history?.at(-1)?.occurredAt
      || 0,
    );
    const latestAt = Date.parse(
      latest?.updatedAt
      || latest?.history?.at(-1)?.occurredAt
      || 0,
    );
    if (Number.isFinite(candidateAt) && Number.isFinite(latestAt)) {
      return candidateAt > latestAt ? candidate : latest;
    }
    if (Number.isFinite(candidateAt)) return candidate;
    return latest;
  }, null);
}

function uniqueRecoveryAction({ assignment, contract, replanCount }) {
  return {
    id:`m5-recover:${assignment.pipelineCaseId}:${contract.stageKey}:r${replanCount}`,
    action:'owner_restore_current_stage',
    instruction:`负责人核对 ${contract.stageKey} 最近一次失败证据后，仅恢复当前 Case 的该阶段。`,
  };
}

function recoveryComment({
  action,
  contract,
  assignment,
  stageAttempt,
  replanCount,
  detail,
}) {
  return [
    `[agent-army:m5:stage-recovery action=${action} stage=${contract.stageKey} stageAttempt=${stageAttempt} replanCount=${replanCount} run=${assignment.runId}]`,
    detail,
  ].join('\n');
}

function recoveryValue(value, stageKey) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== RECOVERY_SCHEMA
    || value.stageKey !== stageKey
  ) return null;
  return {
    ...value,
    stageAttempt:nonNegativeInteger(value.stageAttempt),
    replanCount:nonNegativeInteger(value.replanCount),
    history:uniqueHistory(value.history, stageKey),
  };
}

function recoveryValuesFromEvent(event, stageKey) {
  const found = [];
  const queue = [event];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const direct = recoveryValue(value, stageKey);
    if (direct) found.push(direct);
    const nested = recoveryValue(value.m5StageRecovery, stageKey);
    if (nested) found.push(nested);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return found;
}

function contentRecoveryValue(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== CONTENT_RECOVERY_SCHEMA
  ) return null;
  return {
    ...value,
    replanCount:nonNegativeInteger(value.replanCount),
    history:uniqueContentHistory(value.history),
    stageRecoveries:Object.fromEntries(
      Object.entries(
        value.stageRecoveries
        && typeof value.stageRecoveries === 'object'
        && !Array.isArray(value.stageRecoveries)
          ? value.stageRecoveries
          : {},
      ).flatMap(([key, recovery]) => {
        const stageKey = String(recovery?.stageKey || '').trim();
        const normalized = recoveryValue(recovery, stageKey);
        return validStageRecoveryKey(key, stageKey) && normalized
          ? [[key, normalized]]
          : [];
      }),
    ),
    activePlanRevision:validPlanRevision(value.activePlanRevision)
      ? value.activePlanRevision
      : null,
    planRevisionConsumptions:(Array.isArray(value.planRevisionConsumptions)
      ? value.planRevisionConsumptions
      : [])
      .filter(validPlanRevisionConsumption)
      .slice(-32),
  };
}

function stageRecoveryKey(caseId, stageKey) {
  const normalizedCaseId = String(caseId || '').trim();
  const normalizedStageKey = String(stageKey || '').trim();
  if (
    !/^[0-9a-f-]{36}$/i.test(normalizedCaseId)
    || !/^[a-z][a-z0-9_]{0,63}$/.test(normalizedStageKey)
  ) {
    throw new M5StageRecoveryError('M5 阶段恢复范围缺少有效 Case 或 stage key。');
  }
  return `${normalizedCaseId}:${normalizedStageKey}`;
}

function validStageRecoveryKey(value, stageKey) {
  return new RegExp(`^[0-9a-f-]{36}:${escapeRegex(stageKey)}$`, 'i').test(String(value || ''));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contentRecoveryValuesFromEvent(event) {
  const found = [];
  const queue = [event];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const direct = contentRecoveryValue(value);
    if (direct) found.push(direct);
    const nested = contentRecoveryValue(value.m5ContentRecovery);
    if (nested) found.push(nested);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return found;
}

function uniqueHistory(items, stageKey) {
  const byRun = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const runId = String(item?.runId || '').trim();
    const action = String(item?.action || '').trim();
    if (
      !runId
      || !RECOVERY_ACTIONS.has(action)
      || (item.stageKey && item.stageKey !== stageKey)
    ) continue;
    byRun.set(runId, {
      runId,
      caseId:String(item.caseId || '').trim() || null,
      issueId:String(item.issueId || '').trim() || null,
      stageKey,
      action,
      stageAttempt:Math.max(1, nonNegativeInteger(item.stageAttempt)),
      replanCount:nonNegativeInteger(item.replanCount),
      occurredAt:String(item.occurredAt || '').trim() || null,
      ...(validPlanRevision(item.planRevision) ? { planRevision:item.planRevision } : {}),
      ...(item.recoveryAction ? { recoveryAction:item.recoveryAction } : {}),
    });
  }
  return [...byRun.values()];
}

async function resolveM5ContentCase(governance, initialCase) {
  const campaignId = String(initialCase?.fields?.campaignId || '').trim();
  const scheduledDate = String(initialCase?.fields?.scheduledDate || '').trim();
  if (
    !campaignId
    || campaignId.includes(':')
    || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)
  ) {
    throw new M5StageRecoveryError(
      'M5 内容恢复必须从当前 Case 的 campaignId 和 scheduledDate 解析日期内容根。',
    );
  }
  const expectedCaseKey = `${campaignId}:${scheduledDate}`;
  let current = initialCase;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current?.id || visited.has(current.id)) break;
    visited.add(current.id);
    if (
      current.caseKey === expectedCaseKey
      && current.fields?.campaignId === campaignId
      && current.fields?.scheduledDate === scheduledDate
      && !current.fields?.platform
      && !current.fields?.workBranch
      && !current.fields?.parallelJoin
      && Number.isInteger(Number(current.version))
    ) {
      return current;
    }
    const parentCaseId = String(current.parentCaseId || '').trim();
    if (!parentCaseId) break;
    const parentValue = await governance.getPipelineCase(parentCaseId);
    current = parentValue?.case ?? parentValue;
  }
  throw new M5StageRecoveryError(
    `M5 当前 Case 无法回溯到日期内容根 ${expectedCaseKey}，拒绝使用分支级计数冒充整条内容计数。`,
  );
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

function validPlanRevision(value) {
  return value?.schemaVersion === 'agent.army/m5-plan-revision/v1'
    && /^m5-plan-revision:[0-9a-f-]{36}:r[1-9]\d*$/i.test(String(value.revisionId || ''))
    && /^[0-9a-f-]{36}$/i.test(String(value.contentCaseId || ''))
    && /^[0-9a-f-]{36}$/i.test(String(value.failedCaseId || ''))
    && Number.isInteger(Number(value.revision))
    && Number(value.revision) > 0
    && ['same_stage_rebuild_inputs', 'system_controller_rederive_case_state']
      .includes(value.nextRoute?.kind)
    && value.nextRoute?.preserveVerifiedWorkProducts === true
    && Boolean(String(value.nextRoute?.stageKey || '').trim())
    && routeExecutionDescriptor(value.rejectedRoute?.execution)
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.rejectedRoute?.routeFingerprint || ''))
    && routeDescriptorFingerprint(value.rejectedRoute.execution)
      === value.rejectedRoute.routeFingerprint
    && /^sha256:[0-9a-f]{64}$/i.test(String(value.failureObservation?.summaryHash || ''));
}

function validPlanRevisionConsumption(value) {
  return value?.schemaVersion === 'agent.army/m5-plan-revision-consumption/v1'
    && /^m5-plan-revision:[0-9a-f-]{36}:r[1-9]\d*$/i.test(String(value.revisionId || ''))
    && Boolean(String(value.runId || '').trim())
    && /^[a-z][a-z0-9_]{0,63}$/.test(String(value.stageKey || ''))
    && value.routeKind === 'system_controller_rederive_case_state'
    && value.routeChanged === true
    && validM5RouteExecution(value.routeExecution)
    && String(value.routeSummary || '').trim().length >= 12
    && Number.isFinite(Date.parse(String(value.consumedAt || '')));
}

function uniqueContentHistory(items) {
  const byRun = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const runId = String(item?.runId || '').trim();
    const stageKey = String(item?.stageKey || '').trim();
    const action = String(item?.action || '').trim();
    if (!runId || !stageKey || !RECOVERY_ACTIONS.has(action)) continue;
    byRun.set(runId, {
      runId,
      issueId:String(item.issueId || '').trim() || null,
      stageKey,
      action,
      stageAttempt:Math.max(1, nonNegativeInteger(item.stageAttempt)),
      replanCount:nonNegativeInteger(item.replanCount),
      occurredAt:String(item.occurredAt || '').trim() || null,
      ...(item.recoveryAction ? { recoveryAction:item.recoveryAction } : {}),
    });
  }
  return [...byRun.values()];
}

function assertRecoveryInput({ assignment, contract }) {
  if (
    !assignment?.issueId
    || !assignment?.runId
    || !assignment?.pipelineCaseId
    || !contract?.stageKey
    || !['hermes', 'system_controller'].includes(contract.executionMode)
  ) {
    throw new M5StageRecoveryError('M5 阶段恢复缺少可信 Issue、Run、Case 或阶段契约。');
  }
}

function listItems(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : Array.isArray(value?.items) ? value.items : [];
}

function positiveLimit(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 100) {
    throw new M5StageRecoveryError(`${label}无效。`);
  }
  return normalized;
}

function nonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function safeText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isVersionConflict(error) {
  return error?.status === 409 || /版本冲突|version conflict|409/i.test(String(error?.message || ''));
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
