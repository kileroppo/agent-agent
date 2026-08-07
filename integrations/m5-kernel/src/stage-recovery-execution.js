import { validM5RouteExecution } from './route-execution.js';
import { stageRecoveryState } from './stage-recovery-state.js';
import { stageRecoveryPlanRevision } from './stage-recovery-plan-revision.js';

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
    comment:recoveryComment,
    uniqueAction:uniqueRecoveryAction,
  },
  input:{
    assert:assertRecoveryInput,
    positiveLimit,
    safeText,
  },
  content:{ resolve:resolveM5ContentCase },
  collections:{ listItems },
  conflict:isVersionConflict,
} = stageRecoveryState;
const {
  create:createPlanRevision,
  latestSystemExecution:latestSystemRouteExecution,
} = stageRecoveryPlanRevision;

class M5StageRecoveryController {
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


export const stageRecoveryExecution = Object.freeze({
  Controller:M5StageRecoveryController,
});
