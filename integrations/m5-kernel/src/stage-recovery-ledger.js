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
  schemas:{
    stage:RECOVERY_SCHEMA,
    content:CONTENT_RECOVERY_SCHEMA,
  },
  limits:M5_STAGE_RECOVERY_LIMITS,
  Error:M5StageRecoveryError,
  derive:deriveM5StageRecoveryState,
  plan:planM5StageFailureRecovery,
  workProducts:{
    healthy:healthyM5StageWorkProducts,
    candidates:m5StageWorkProductCandidates,
  },
  records:{
    contentValue:contentRecoveryValue,
    key:stageRecoveryKey,
    uniqueAction:uniqueRecoveryAction,
  },
  revision:{ valid:validPlanRevision },
  input:{
    assert:assertRecoveryInput,
    positiveLimit,
    safeText,
  },
  content:{ resolve:resolveM5ContentCase },
  collections:{ listItems },
  conflict:isVersionConflict,
} = stageRecoveryState;

export class M5StageRecoveryLedger {
  #governance;
  #maxStageRetries;
  #maxReplansPerContent;
  #workProductValidator;
  #now;
  #snapshotLoader;

  constructor({
    governance,
    maxStageRetries = M5_STAGE_RECOVERY_LIMITS.maxStageRetries,
    maxReplansPerContent = M5_STAGE_RECOVERY_LIMITS.maxReplansPerContent,
    workProductValidator = null,
    now = () => new Date(),
    snapshotLoader = null,
  } = {}) {
    this.#governance = governance;
    this.#maxStageRetries = positiveLimit(maxStageRetries, '单阶段重试上限');
    this.#maxReplansPerContent = positiveLimit(maxReplansPerContent, '内容重规划上限');
    this.#workProductValidator = typeof workProductValidator === 'function'
      ? workProductValidator
      : null;
    this.#now = now;
    this.#snapshotLoader = typeof snapshotLoader === 'function' ? snapshotLoader : null;
  }

  async recordFailure({ assignment, contract, task = null, summary, routeExecution = null } = {}) {
    assertRecoveryInput({ assignment, contract });
    this.#assertFailureGovernance();
    for (let conflictAttempt = 0; conflictAttempt < 5; conflictAttempt += 1) {
      const snapshot = await this.#loadFailureSnapshot(assignment);
      const existingProduct = await this.#resolveExistingProduct({
        assignment,
        contract,
        task,
        snapshot,
      });
      if (existingProduct) {
        return {
          action:'verified_work_product',
          replayed:true,
          stageAttempt:0,
          replanCount:0,
          workProductId:existingProduct.id || null,
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
      if (handled) return { ...handled, replayed:true };

      const recordedDecision = this.#createFailureDecision({
        assignment,
        contract,
        snapshot,
        state,
        summary,
        routeExecution,
      });
      try {
        await this.#governance.patchPipelineCaseFields(
          snapshot.contentCase.id,
          {
            expectedVersion:snapshot.contentCase.version,
            fields:this.#failureFields({
              assignment,
              contract,
              snapshot,
              state,
              recordedDecision,
              summary,
            }),
            runId:assignment.runId,
          },
        );
        return { ...withoutInternalDecisionFields(recordedDecision), replayed:false };
      } catch (error) {
        if (conflictAttempt < 4 && isVersionConflict(error)) continue;
        throw error;
      }
    }
    throw new M5StageRecoveryError('M5 阶段恢复状态发生并发漂移，请按当前 Paperclip Case 重放。');
  }

  async getActivePlanRevision({
    pipelineCaseId,
    stageKey,
    pipelineCase = null,
  } = {}) {
    if (
      typeof this.#governance?.getPipelineCase !== 'function'
      || !validCaseId(pipelineCaseId)
      || !validStageKey(stageKey)
    ) return null;
    const currentValue = pipelineCase || await this.#governance.getPipelineCase(pipelineCaseId);
    const currentCase = currentValue?.case ?? currentValue;
    if (currentCase?.id !== pipelineCaseId) return null;
    if (!hasContentRootFields(currentCase)) {
      if (currentCase.fields?.m5ContentRecovery) {
        throw new M5StageRecoveryError('含恢复状态的 M5 Case 缺少可核验的内容根字段。');
      }
      return null;
    }
    const contentCase = await resolveM5ContentCase(this.#governance, currentCase);
    return activeRevisionFor({
      recovery:contentRecoveryValue(contentCase?.fields?.m5ContentRecovery),
      pipelineCaseId,
      stageKey,
    });
  }

  async consumeSystemPlanRevision({
    pipelineCaseId,
    stageKey,
    runId,
    routeSummary,
  } = {}) {
    if (
      typeof this.#governance?.getPipelineCase !== 'function'
      || !validCaseId(pipelineCaseId)
      || !validStageKey(stageKey)
      || !String(runId || '').trim()
      || String(routeSummary || '').trim().length < 12
    ) {
      throw new M5StageRecoveryError('系统控制器消费重规划缺少可信 Case、Run、阶段或路线说明。');
    }
    for (let conflictAttempt = 0; conflictAttempt < 5; conflictAttempt += 1) {
      const caseValue = await this.#governance.getPipelineCase(pipelineCaseId);
      const caseItem = caseValue?.case ?? caseValue;
      if (caseItem?.id !== pipelineCaseId) {
        throw new M5StageRecoveryError('系统控制器消费重规划时无法核验当前 Case。');
      }
      if (!hasContentRootFields(caseItem)) {
        if (caseItem.fields?.m5ContentRecovery) {
          throw new M5StageRecoveryError('含恢复状态的系统控制器 Case 缺少可核验的内容根字段。');
        }
        return null;
      }
      const contentCase = await resolveM5ContentCase(this.#governance, caseItem);
      const recovery = contentRecoveryValue(contentCase?.fields?.m5ContentRecovery);
      const revision = activeRevisionFor({ recovery, pipelineCaseId, stageKey });
      if (!revision) return null;
      if (revision.nextRoute.kind !== 'system_controller_rederive_case_state') {
        throw new M5StageRecoveryError('系统控制器拒绝消费 Hermes 重规划路线。');
      }
      const existing = recovery.planRevisionConsumptions.find((item) =>
        item.revisionId === revision.revisionId && item.runId === runId
      );
      if (existing) return structuredClone(existing);

      const receipt = this.#createPlanRevisionReceipt({
        caseItem,
        contentCase,
        recovery,
        revision,
        stageKey,
        runId,
        routeSummary,
      });
      if (typeof this.#governance.patchPipelineCaseFields !== 'function') {
        throw new M5StageRecoveryError('系统控制器缺少持久化重规划消费回执的 Paperclip 适配。');
      }
      try {
        await this.#governance.patchPipelineCaseFields(contentCase.id, {
          expectedVersion:contentCase.version,
          fields:{
            ...(contentCase.fields || {}),
            m5ContentRecovery:{
              ...recovery,
              updatedAt:receipt.consumedAt,
              planRevisionConsumptions:[
                ...recovery.planRevisionConsumptions,
                receipt,
              ].slice(-32),
            },
          },
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

  async #loadFailureSnapshot(assignment) {
    if (this.#snapshotLoader) return this.#snapshotLoader(assignment);
    const caseValue = await this.#governance.getPipelineCase(assignment.pipelineCaseId);
    const caseItem = caseValue?.case ?? caseValue;
    if (!caseItem?.id || !Number.isInteger(Number(caseItem.version))) {
      throw new M5StageRecoveryError('M5 阶段恢复缺少带版本的 Paperclip Case。');
    }
    const contentCase = await resolveM5ContentCase(this.#governance, caseItem);
    const [issue, runs, events, contentEvents, outputs] = await Promise.all([
      this.#governance.getPaperclipIssue(assignment.issueId),
      this.#governance.getPaperclipIssueRuns(assignment.issueId),
      this.#governance.getPipelineCaseEvents(assignment.pipelineCaseId),
      contentCase.id === caseItem.id
        ? Promise.resolve([])
        : this.#governance.getPipelineCaseEvents(contentCase.id),
      this.#governance.getPipelineCaseOutputs(assignment.pipelineCaseId),
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

  async #resolveExistingProduct({ assignment, contract, task, snapshot }) {
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
    if (existingProducts.length === 0) return null;
    if (!this.#workProductValidator) {
      throw new M5StageRecoveryError(
        `M5 ${contract.stageKey} 已有 Work Product，但完整漂移校验器不可用，禁止自动恢复。`,
      );
    }
    try {
      await this.#workProductValidator({
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
    return existingProducts[0];
  }

  #createFailureDecision({
    assignment,
    contract,
    snapshot,
    state,
    summary,
    routeExecution,
  }) {
    const decision = planM5StageFailureRecovery({
      state,
      maxStageRetries:this.#maxStageRetries,
      maxReplansPerContent:this.#maxReplansPerContent,
    });
    const occurredAt = this.#now().toISOString();
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
    return {
      runId:assignment.runId,
      issueId:assignment.issueId,
      caseId:snapshot.caseItem.id,
      stageKey:contract.stageKey,
      action:decision.action,
      stageAttempt:decision.stageAttempt,
      nextStageAttempt:decision.nextStageAttempt,
      replanCount:decision.replanCount,
      occurredAt,
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
  }

  #failureFields({
    assignment,
    contract,
    snapshot,
    state,
    recordedDecision,
    summary,
  }) {
    const previousContentRecovery = contentRecoveryValue(
      snapshot.contentCase.fields?.m5ContentRecovery,
    );
    const persistedDecision = withoutInternalDecisionFields(recordedDecision);
    const recovery = {
      schemaVersion:RECOVERY_SCHEMA,
      stageKey:contract.stageKey,
      status:recordedDecision.action === 'blocked' ? 'blocked' : 'scheduled',
      stageAttempt:recordedDecision.nextStageAttempt,
      replanCount:recordedDecision.replanCount,
      lastHandledRunId:assignment.runId,
      lastFailureSummary:safeText(summary, 500),
      updatedAt:recordedDecision.occurredAt,
      history:[...state.history, persistedDecision].slice(-32),
      recoveryAction:recordedDecision.recoveryAction || null,
    };
    const contentHistory = recordedDecision.action === 'replan'
      || recordedDecision.action === 'blocked'
      ? [...state.contentHistory, persistedDecision].slice(-128)
      : state.contentHistory;
    return {
      ...(snapshot.contentCase.fields || {}),
      m5ContentRecovery:{
        schemaVersion:CONTENT_RECOVERY_SCHEMA,
        replanCount:recordedDecision.replanCount,
        lastHandledRunId:assignment.runId,
        updatedAt:recordedDecision.occurredAt,
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
  }

  #createPlanRevisionReceipt({
    caseItem,
    contentCase,
    recovery,
    revision,
    stageKey,
    runId,
    routeSummary,
  }) {
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
      now:this.#now,
    });
    assertChangedM5RecoveryRoute(routeExecution, revision);
    return {
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
      consumedAt:this.#now().toISOString(),
    };
  }

  #assertFailureGovernance() {
    const required = [
      'getPipelineCase',
      'getPaperclipIssue',
      'getPaperclipIssueRuns',
      'getPipelineCaseEvents',
      'getPipelineCaseOutputs',
      'patchPipelineCaseFields',
    ];
    const missing = required.filter((name) => typeof this.#governance?.[name] !== 'function');
    if (missing.length) {
      throw new M5StageRecoveryError(`M5 阶段恢复缺少 Paperclip 原生能力：${missing.join('、')}。`);
    }
  }
}

function activeRevisionFor({ recovery, pipelineCaseId, stageKey }) {
  const revision = recovery?.activePlanRevision;
  if (
    !validPlanRevision(revision)
    || revision.failedCaseId !== pipelineCaseId
    || revision.nextRoute?.stageKey !== stageKey
  ) return null;
  return structuredClone(revision);
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

function withoutInternalDecisionFields(decision) {
  const { nextStageAttempt:_, ...persisted } = decision;
  return persisted;
}

function hasContentRootFields(caseItem) {
  return Boolean(
    String(caseItem?.fields?.campaignId || '').trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(String(caseItem?.fields?.scheduledDate || '')),
  );
}

function validCaseId(value) {
  return /^[0-9a-f-]{36}$/i.test(String(value || ''));
}

function validStageKey(value) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(String(value || ''));
}

export const stageRecoveryLedger = Object.freeze({
  Ledger:M5StageRecoveryLedger,
});
