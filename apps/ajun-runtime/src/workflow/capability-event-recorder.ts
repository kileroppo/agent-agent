import type { ExecutionReceipt } from './capability-execution.ts';

type EventStore = Readonly<{
  appendTaskRunEvent(input: Readonly<Record<string, unknown>>): unknown;
}>;

export function createCapabilityEventRecorder(eventStore: EventStore) {
  if (!eventStore || typeof eventStore.appendTaskRunEvent !== 'function') {
    throw new TypeError('能力事件记录器需要 appendTaskRunEvent。');
  }
  return async (receipt: ExecutionReceipt) => {
    const baseTime = Date.parse(receipt.startedAt);
    const common = {
      taskId:receipt.taskId,
      workflowId:receipt.workflowId,
      stepId:receipt.stepId,
      agentId:receipt.agentId,
      capabilityId:receipt.capabilityId,
      policyDecisionId:receipt.policyDecisionId,
      receiptId:receipt.receiptId,
      inputHash:receipt.inputHash,
      outputHash:receipt.outputHash,
      costAmount:receipt.costUsd,
      costCurrency:'USD',
    };
    eventStore.appendTaskRunEvent({
      ...common,
      eventType:'capability_policy_decided',
      routeId:receipt.routeAttempts[0]?.routeId || receipt.routeId,
      status:'allowed',
      startedAt:receipt.startedAt,
    });
    let eventOrdinal = 1;
    for (let index = 0; index < receipt.routeAttempts.length; index += 1) {
      const attempt = receipt.routeAttempts[index];
      for (const failureCode of attempt.failureCodes || (attempt.failureCode ? [attempt.failureCode] : [])) {
        eventStore.appendTaskRunEvent({
          ...common,
          eventType:'capability_route_failed',
          routeId:attempt.routeId,
          attempt:attempt.attempts,
          status:attempt.outcome,
          startedAt:new Date(baseTime + eventOrdinal).toISOString(),
          errorCode:failureCode,
          safeSummary:`路线 ${attempt.routeId} 失败（${failureCode}），排查凭证 ${receipt.receiptId}。`,
        });
        eventOrdinal += 1;
      }
      const current = receipt.routeAttempts[index + 1];
      if (!current) continue;
      eventStore.appendTaskRunEvent({
        ...common,
        eventType:'route_fallback_started',
        routeId:current.routeId,
        attempt:index + 2,
        status:'fallback',
        startedAt:new Date(baseTime + eventOrdinal).toISOString(),
        errorCode:attempt.failureCode,
        safeSummary:`${attempt.routeId} 因 ${attempt.failureCode || '能力失败'} 切换到 ${current.routeId}，排查凭证 ${receipt.receiptId}。`,
      });
      eventOrdinal += 1;
    }
    eventStore.appendTaskRunEvent({
      ...common,
      eventType:receipt.outcome === 'success'
        ? 'capability_call_succeeded'
        : receipt.outcome === 'ambiguous'
          ? 'capability_result_ambiguous'
          : 'capability_call_failed',
      routeId:receipt.routeId,
      provider:receipt.provider,
      model:receipt.model,
      attempt:receipt.totalAttempts,
      status:receipt.outcome,
      startedAt:new Date(Math.max(Date.parse(receipt.completedAt), baseTime + eventOrdinal)).toISOString(),
      errorCode:receipt.failureCode,
      safeSummary:receipt.outcome === 'success'
        ? `能力调用完成，排查凭证 ${receipt.receiptId}。`
        : `能力调用${receipt.outcome === 'ambiguous' ? '结果待确认' : '失败'}（${receipt.failureCode || '未知失败'}），排查凭证 ${receipt.receiptId}。`,
    });
  };
}
