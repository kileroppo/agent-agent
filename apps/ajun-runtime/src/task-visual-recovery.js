import { paperclipIssueIdFor, uniqueStrings } from './task-recovery-policy.js';

const BILLING_FAILURE_CODES = new Set([
  'provider_http_402',
  'provider_balance_insufficient',
  'provider_quota_exhausted',
]);

export async function visionCapabilityReadiness(capabilityStatus, { failureCode = '', failureAt = '' } = {}) {
  let status = null;
  try {
    status = typeof capabilityStatus === 'function'
      ? await capabilityStatus()
      : capabilityStatus;
  } catch {
    status = null;
  }
  const row = (Array.isArray(status?.capabilities) ? status.capabilities : [])
    .find((item) => item?.capability === 'vision.analyze');
  const capability = {
    capability:'vision.analyze',
    configured:row?.configured === true,
    healthy:row?.healthy === true,
    e2eVerified:row?.e2eVerified === true,
  };
  const baseReady = capability.configured && capability.healthy && capability.e2eVerified;
  if (!BILLING_FAILURE_CODES.has(String(failureCode || '').toLowerCase())) {
    return { ...capability, ready:baseReady };
  }
  const verifiedAt = String(row?.verifiedAt || '').trim() || null;
  const failureTime = Date.parse(String(failureAt || ''));
  const verifiedTime = Date.parse(verifiedAt || '');
  const billingRecoveryVerified = Number.isFinite(failureTime)
    && Number.isFinite(verifiedTime)
    && verifiedTime > failureTime;
  return {
    ...capability,
    verifiedAt,
    requiresBillingRecovery:true,
    billingRecoveryVerified,
    ready:baseReady && billingRecoveryVerified,
  };
}

export async function retryVisualAnalysis({
  task,
  requestId,
  requestedBy,
  createTask,
  record,
  clock,
  errorFactory,
}) {
  if (typeof createTask !== 'function') {
    throw errorFactory('视觉恢复重跑入口暂不可用，未创建子任务。', 'task_recovery_unavailable', 503);
  }
  const paperclipIssueId = paperclipIssueIdFor(task);
  if (!paperclipIssueId) {
    throw errorFactory('原 Paperclip 任务关联不存在，未创建无审计关联的重跑。', 'paperclip_parent_issue_required', 503);
  }
  const attempt = Number(task.recovery?.attempt || 0) + 1;
  const rootTaskId = task.recovery?.rootTaskId || task.taskId;
  const sourceTaskIds = uniqueStrings(task.input?.context?.sourceTaskIds || []);
  const retryTask = await createTask({
    title:`${task.input?.title || '视频内容拆解'}（恢复识图后重跑）`,
    description:'本机主人明确点击，且 vision.analyze 已配置、健康并通过端到端验证后，使用原视觉模式进行一次受控重跑。',
    taskType:'content.video-benchmark-analysis',
    agentId:task.assigneeAgentId,
    requester:{ kind:'local-owner', ref:requestedBy.ref },
    source:{ channel:'internal-recovery', parentChannel:task.source?.channel || null, chatRef:task.source?.chatRef || null },
    parentTaskId:task.taskId,
    sourceUrl:task.input?.sourceUrl,
    sourceUrls:task.input?.sourceUrls,
    reviewPolicy:task.input?.reviewPolicy,
    evidenceMode:task.input?.evidenceMode,
    analysisIntent:task.input?.analysisIntent,
    depth:task.input?.depth,
    focus:task.input?.focus,
    visualMode:task.input?.visualMode,
    context:{
      ...(task.input?.context || {}),
      sourceTaskIds,
      parentPaperclipIssueId:paperclipIssueId,
      recoveryFromTaskId:task.taskId,
    },
    idempotencyKey:`recovery-vision-capability:${task.taskId}`,
    recovery:{
      rootTaskId,
      attempt,
      triggeredByTaskId:task.taskId,
      mode:'vision_capability_restored',
      requestId,
    },
  });
  await record(task.taskId, {
    status:'retrying',
    actionKey:'retry_visual_analysis_after_recovery',
    requestId,
    requestedBy,
    retryTaskId:retryTask.taskId,
    attempt,
    reason:`已在 vision.analyze 能力恢复后创建一次 visualMode=${task.input?.visualMode} 的受控子任务。`,
  }, {
    event:'child_created',
    actionKey:'retry_visual_analysis_after_recovery',
    requestId,
    attempt,
    actor:requestedBy,
    taskId:retryTask.taskId,
    occurredAt:clock().toISOString(),
  });
  return { retryTask };
}
