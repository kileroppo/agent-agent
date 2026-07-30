import { getM5RoutineExecutionContract } from './m5-routine-execution-contract.js';
import {
  consumeM5SystemPlanRevision,
  M5StageRecoveryController,
} from './m5-stage-recovery-controller.js';

const UUID_PATTERN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const RECOVERABLE_SYSTEM_FAILURE = Symbol('m5RecoverableSystemFailure');

export function markM5SystemControllerFailure(error) {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, RECOVERABLE_SYSTEM_FAILURE, {
      value:true,
      enumerable:false,
      configurable:true,
    });
  }
  return error;
}

export function isRecoverableM5SystemControllerFailure(error) {
  return error?.[RECOVERABLE_SYSTEM_FAILURE] === true;
}

export async function consumeM5SystemControllerPlanRevision({
  governance,
  pipelineCaseId,
  runId,
  routineKey,
  systemRole,
} = {}) {
  const contract = getM5RoutineExecutionContract(routineKey);
  if (
    !contract
    || contract.executionMode !== 'system_controller'
    || contract.systemController !== systemRole
  ) {
    throw new M5SystemControllerRecoveryError('系统控制器消费重规划的执行契约不匹配。');
  }
  return consumeM5SystemPlanRevision({
    governance,
    pipelineCaseId,
    stageKey:contract.stageKey,
    runId,
    routeSummary:'系统控制器已放弃失败运行的派生输入，并重新从当前 Paperclip Case、Issue 与可信 Work Product 推导本次确定性执行参数。',
  });
}

export async function recoverM5SystemControllerFailure({
  governance,
  issueId,
  runId,
  agentId,
  routineKey,
  systemRole,
  error,
} = {}) {
  const contract = getM5RoutineExecutionContract(routineKey);
  if (
    !contract
    || contract.executionMode !== 'system_controller'
    || contract.systemController !== systemRole
  ) {
    throw new M5SystemControllerRecoveryError('系统控制器恢复契约不匹配。');
  }
  if (typeof governance?.verifySystemAssignment !== 'function') {
    throw new M5SystemControllerRecoveryError('系统控制器恢复缺少 Paperclip 身份核验。');
  }
  const verified = await governance.verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId:agentId,
    systemRole,
  });
  const issue = verified?.issue;
  if (!issue || !['in_progress', 'in_review'].includes(issue.status)) {
    throw new M5SystemControllerRecoveryError('只有当前可执行的系统 Routine 才能进入恢复循环。');
  }
  if (!String(issue.description || '').includes(`[agent-army:m5:routine:${routineKey}]`)) {
    throw new M5SystemControllerRecoveryError('系统控制器恢复拒绝不匹配的 Routine。');
  }
  const pipelineCaseId = String(issue.description || '').match(
    new RegExp(`当前 Case 为 (${UUID_PATTERN.source})`, 'i'),
  )?.[1] || '';
  if (!pipelineCaseId) {
    throw new M5SystemControllerRecoveryError('系统控制器恢复缺少固定 Case 绑定。');
  }
  if (typeof governance.assertCaseIssueLink === 'function') {
    await governance.assertCaseIssueLink(pipelineCaseId, issueId);
  }
  const controller = new M5StageRecoveryController({ governance });
  const recovery = await controller.handleFailure({
    assignment:{
      issueId,
      runId,
      pipelineCaseId,
    },
    contract,
    summary:safeSystemFailureSummary(error),
  });
  return {
    accepted:true,
    issueId,
    status:recovery.action === 'blocked' ? 'blocked' : 'recovery_scheduled',
    recovery,
  };
}

function safeSystemFailureSummary(error) {
  const code = String(error?.code || error?.name || 'system_controller_error')
    .replace(/[^a-z0-9_.-]/gi, '_')
    .slice(0, 120);
  const message = String(error?.message || '系统控制器执行失败。')
    .replace(/(?:\/Users|\/home)\/[^\s"'`]+/g, '[local-path]')
    .replace(/\b(?:sk|key|token|secret)[-_][a-z0-9._-]{8,}\b/gi, '[credential]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return `${code}: ${message}`;
}

export class M5SystemControllerRecoveryError extends Error {}
