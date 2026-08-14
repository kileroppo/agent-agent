import {
  createM5RouteExecution,
  validM5RouteExecution,
} from '@agent-army/m5-kernel/route-execution';

import { ValidationError } from './task-validation-error.ts';
export {
  m5PipelineCaseChainIds,
  m5PlanRevisionExecutionContext,
  m5RelatedTaskContext,
  paperclipCaseContextFields,
  trustedRoleToolScope,
} from './paperclip-assignment-context.js';

export function assertM5PlanRevisionConsumed({
  expected,
  actual,
  runId,
  allowUnchangedFailure = false,
  input,
} = {}) {
  if (!expected) return null;
  const revisionId = String(expected.revisionId || '').trim();
  const consumedRevisionId = String(input?.consumedRevisionId || '').trim();
  if (!revisionId || consumedRevisionId !== revisionId) {
    throw new ValidationError('当前 M5 Run 必须精确回报已消费的 PlanRevision ID。');
  }
  if (
    !validM5RouteExecution(actual)
    || actual.runId !== runId
    || actual.consumedRevisionId !== revisionId
    || actual.stageKey !== expected.nextRoute?.stageKey
  ) {
    throw new ValidationError('当前 M5 Run 没有执行器生成的 PlanRevision 消费回执。');
  }
  if (
    !allowUnchangedFailure
    && (actual.routeChanged !== true || actual.changedDimensions.length === 0)
  ) {
    throw new ValidationError(
      '执行器确认本次输入、工具和策略均未变化；拒绝把同一路线写成已恢复。',
    );
  }
  return {
    schemaVersion:'agent.army/m5-plan-revision-receipt/v1',
    consumedRevisionId,
    routeChanged:actual.routeChanged === true,
    changedDimensions:[...actual.changedDimensions],
    routeFingerprint:actual.routeFingerprint,
    routeSummary:actual.routeSummary,
    stageKey:expected.nextRoute?.stageKey || null,
    recordedAt:new Date().toISOString(),
  };
}

export function prepareM5ExecutorTask({ task, assignment, contract } = {}) {
  if (!contract || contract.executionMode !== 'hermes') {
    return { task, recovery:null, routeExecution:null };
  }
  const recovery = task?.input?.context?.m5Recovery || null;
  const strategy = recovery?.nextRoute?.kind
    || `default:${contract.executionTool?.id || 'hermes_executor'}`;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const routeExecution = createM5RouteExecution({
    runId:assignment.runId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds:[contract.executionTool?.id || 'hermes_executor'],
    inputs:m5BusinessExecutionInput(task?.input),
  });
  if (!recovery) return { task, recovery:null, routeExecution };
  return {
    recovery,
    routeExecution,
    task:{
      ...task,
      input:{
        ...(task.input || {}),
        context:{
          ...(task.input?.context || {}),
          m5AlternativeRoute:{
            revisionId:recovery.revisionId,
            strategy,
            instruction:recovery.nextRoute?.instruction || '',
            preserveVerifiedWorkProducts:
              recovery.nextRoute?.preserveVerifiedWorkProducts === true,
          },
        },
      },
    },
  };
}

export function assertM5ExecutorRouteReceipt({
  task,
  contract,
  result,
  allowUnchanged = false,
} = {}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  if (!recovery && !validM5RouteExecution(result)) return null;
  if (
    !validM5RouteExecution(result)
    || result.runId !== task?.execution?.paperclipRunId
    || result.stageKey !== contract?.stageKey
  ) {
    throw new ValidationError('M5 阶段执行器缺少与当前 Run、阶段一致的真实路线回执。');
  }
  if (recovery) {
    if (result.consumedRevisionId !== recovery.revisionId) {
      throw new ValidationError('M5 阶段执行器消费的 PlanRevision 与当前指派不一致。');
    }
    if (!allowUnchanged && (result.routeChanged !== true || result.changedDimensions.length === 0)) {
      throw new ValidationError('M5 阶段执行器没有真实改变输入、工具或策略。');
    }
  }
  return result;
}

export function m5BusinessExecutionInput(input) {
  if (!input || typeof input !== 'object') return {};
  const context = input.context && typeof input.context === 'object'
    ? Object.fromEntries(
        Object.entries(input.context)
          .filter(([key]) => !['m5Recovery', 'm5AlternativeRoute'].includes(key)),
      )
    : {};
  return {
    ...input,
    context,
  };
}
