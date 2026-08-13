import { stageRecoveryState } from './stage-recovery-state.js';
import { M5StageRecoveryLedger } from './stage-recovery-ledger.js';

const {
  limits:M5_STAGE_RECOVERY_LIMITS,
  Error:M5StageRecoveryError,
  records:{ comment:recoveryComment },
  input:{
    assert:assertRecoveryInput,
    positiveLimit,
  },
  content:{ resolve:resolveM5ContentCase },
  collections:{ listItems },
} = stageRecoveryState;

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

  async handleFailure(input = {}) {
    const { assignment, contract } = input;
    assertRecoveryInput({ assignment, contract });
    this.assertGovernance();
    const decision = await new M5StageRecoveryLedger({
      governance:this.governance,
      maxStageRetries:this.maxStageRetries,
      maxReplansPerContent:this.maxReplansPerContent,
      workProductValidator:this.workProductValidator,
      now:this.now,
      snapshotLoader:(assignment) => this.snapshot(assignment),
    }).recordFailure(input);
    if (decision.action === 'verified_work_product') {
      await this.governance.completeM5RecoveredStageIssue(assignment.issueId, {
        runId:assignment.runId,
        comment:recoveryComment({
          action:decision.action,
          contract,
          assignment,
          stageAttempt:0,
          replanCount:0,
          detail:'已验证 Work Product 已存在；重放未再次执行阶段或写入产物。',
        }),
      });
      return decision;
    }
    await this.applyIssueDecision({
      assignment,
      contract,
      decision,
      replayed:decision.replayed,
    });
    return decision;
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
