import { classifyTechnicalFailure } from './technical-failure-classifier.js';

export function view(task, { audience = 'local-owner', relatedTasks = [] } = {}) {
  const coordination = task?.recovery?.coordination || null;
  const verificationTaskId = coordination?.retryTaskId || coordination?.technicalTaskId || coordination?.operatorTaskId || null;
  const verification = coordination ? {
    state:String(coordination.status || 'pending'),
    taskId:verificationTaskId || task.taskId,
    detailPath:`/tasks/${encodeURIComponent(verificationTaskId || task.taskId)}`,
  } : null;
  if (audience !== 'local-owner' || coordination) return { actions:[], verification };
  const actions = [];
  if (task?.status === 'failed') {
    if (confirmedTranscriptOnlyEligible(task, relatedTasks)) actions.push(action(
      'use_confirmed_transcript_only', '仅用确认稿继续', 'primary',
      '将关闭视觉分析，只使用已核验确认稿创建原 Paperclip 任务的子任务；不会重新抓取素材或调用视觉 Provider。',
    ));
    if (locallyOwnedFailure(task) && recoverableFailure(task)) actions.push(action(
      'request_safe_recovery', '请求安全恢复', actions.length ? 'secondary' : 'primary',
      '系统会先核验故障类型、重试上限和组织归属；不满足安全条件时只会升级受控处理，不会强行重跑。',
    ));
    if (paperclipDiagnosisEligible(task)) actions.push(action(
      'request_read_only_diagnosis', '只读诊断', 'secondary',
      '只在原 Paperclip Issue 下创建诊断子任务；不修改代码、不重跑任务、不扩权。',
    ));
  }
  if (visionCapabilityRecoveryEligible(task)) actions.push(action(
    'retry_visual_analysis_after_recovery', '恢复识图后重跑', actions.length ? 'secondary' : 'primary',
    '只有本机主人点击后才会先核验 vision.analyze 已配置、健康且通过端到端验证；余额或额度错误还必须有晚于本次失败的新端到端验证。能力未恢复时不创建任务、不消耗重跑次数。恢复后仅创建一次保留原视觉模式的子任务，子任务会调用识图能力，可能产生一次 Provider 费用。',
  ));
  return { actions, verification };
}

export function visionCapabilityRecoveryEligible(task) {
  return task?.taskType === 'content.video-benchmark-analysis'
    && ['failed', 'needs_input', 'waiting_test'].includes(String(task?.status || ''))
    && ['auto', 'required'].includes(task?.input?.visualMode)
    && Number(task?.recovery?.attempt || 0) < 1
    && Boolean(paperclipIssueIdFor(task))
    && visionCapabilityFailure(task)
    && !recoveryEvents(task).some((event) => event.actionKey === 'retry_visual_analysis_after_recovery');
}

export function confirmedTranscriptOnlyEligible(task, tasks) {
  return task?.taskType === 'content.video-benchmark-analysis'
    && task?.execution?.owner === 'paperclip-hermes'
    && Boolean(String(task?.governance?.paperclipIssueId || '').trim())
    && ['auto', 'required'].includes(task?.input?.visualMode)
    && Boolean(confirmedTranscriptFor(task, tasks));
}

export function confirmedTranscriptFor(task, tasks) {
  const sourceTaskIds = new Set(uniqueStrings(task?.input?.context?.sourceTaskIds || []));
  for (const candidate of Array.isArray(tasks) ? tasks : []) {
    if (candidate.taskId !== task?.taskId && !sourceTaskIds.has(candidate.taskId)) continue;
    const artifact = (candidate.artifactRefs || []).find((item) => validConfirmedTranscript(
      item,
      { legacyAttested:legacyConfirmedTranscriptTask(candidate) },
    ));
    if (artifact) return { taskId:candidate.taskId, artifact };
  }
  const own = (task?.artifactRefs || []).find((item) => validConfirmedTranscript(
    item,
    { legacyAttested:legacyConfirmedTranscriptTask(task) },
  ));
  return own ? { taskId:task.taskId, artifact:own } : null;
}

export function recoveryEvents(task) {
  return Array.isArray(task?.recovery?.events) ? [...task.recovery.events] : [];
}

export function requestAttempt(task) {
  return Number(task?.recovery?.attempt || 0) + 1;
}

export function duplicateRecovery(task, input, attempt) {
  const events = recoveryEvents(task);
  const duplicate = events.find((event) => event.requestId === input.requestId)
    || events.find((event) => event.actionKey === input.actionKey && Number(event.attempt) === attempt);
  if (duplicate) return duplicate;
  const coordination = task?.recovery?.coordination;
  return coordination?.actionKey === input.actionKey && Number(coordination.attempt) === attempt ? coordination : null;
}

export function existingResult(task, event) {
  const coordination = task.recovery?.coordination || {};
  return {
    status:'existing', taskId:task.taskId, actionKey:event.actionKey,
    operatorTaskId:coordination.operatorTaskId || null,
    retryTaskId:coordination.retryTaskId || null,
    technicalTaskId:coordination.technicalTaskId || null,
    recovery:view(task, { audience:'local-owner' }),
  };
}

export function ineligibleResult(task, actionKey, recoveryView) {
  return {
    status:actionKey === 'request_safe_recovery' && task.execution?.owner === 'paperclip-hermes' ? 'requires_external' : 'not_eligible',
    taskId:task.taskId, actionKey, recovery:recoveryView,
  };
}

export async function taskById(store, taskId) {
  if (typeof store?.getTask === 'function') return store.getTask(taskId);
  return (await store.list()).find((item) => item.taskId === taskId) || null;
}

export async function recoveryRelatedTasks(store, task) {
  if (!mayNeedConfirmedTranscriptChain(task)) return [task];
  const sourceTaskIds = uniqueStrings(task.input?.context?.sourceTaskIds || []);
  if (!sourceTaskIds.length || typeof store?.getTask !== 'function') {
    if (typeof store?.list !== 'function') return [task];
    const sourceSet = new Set(sourceTaskIds);
    return [task, ...(await store.list()).filter((item) => sourceSet.has(item.taskId))];
  }
  const related = await Promise.all(sourceTaskIds.map((taskId) => store.getTask(taskId)));
  return [task, ...related.filter(Boolean)];
}

export function safeText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function failureClassification(task) {
  return classifyTechnicalFailure({ error:task?.error, taskType:task?.taskType, sourceUrl:task?.input?.sourceUrl });
}

export function paperclipIssueIdFor(task) {
  return String(task?.governance?.paperclipIssueId || task?.execution?.paperclipIssueId
    || task?.input?.context?.parentPaperclipIssueId || '').trim();
}

function action(actionKey, label, emphasis, confirmation) { return { actionKey, label, emphasis, confirmation }; }
function locallyOwnedFailure(task) {
  const owner = String(task?.execution?.owner || '').trim();
  return !owner || owner.startsWith('ajun-') || owner === 'local-evidence-fallback';
}
function recoverableFailure(task) {
  return Number(task?.recovery?.attempt || 0) < 1
    && !recoveryEvents(task).some((event) => event.actionKey === 'request_safe_recovery')
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task?.taskType);
}
function paperclipDiagnosisEligible(task) {
  return task?.execution?.owner === 'paperclip-hermes'
    && Boolean(String(task?.governance?.paperclipIssueId || '').trim())
    && !['operations.failure-recovery', 'operations.technical-repair'].includes(task?.taskType);
}
function visionCapabilityFailure(task) {
  const code = String(task?.error?.code || task?.currentStage || '').trim().toLowerCase();
  if (/^(?:controlled_(?:provider_)?vision_|m5_provider_vision_)/.test(code)) return true;
  if (!['content_growth_input', 'vision', 'vision.analyze', 'visual_analysis'].includes(String(task?.error?.stage || '').trim().toLowerCase())) {
    return false;
  }
  return [
    'local_ai_gateway_unavailable',
    'local_ai_failed',
    'provider_http_402',
    'provider_balance_insufficient',
    'provider_quota_exhausted',
  ].includes(code);
}
function validConfirmedTranscript(artifact, { legacyAttested = false } = {}) {
  const mode = String(artifact?.data?.confirmationMode || '');
  return artifact?.type === 'confirmed_transcript'
    && artifact.validation?.exists === true && artifact.validation?.readable === true
    && artifact.validation?.nonEmpty === true
    && (['automatic', 'human'].includes(mode) || legacyAttested);
}
function legacyConfirmedTranscriptTask(task) {
  return task?.status === 'succeeded'
    && task?.taskType === 'media.transcribe-and-refine'
    && (task.artifactRefs || []).some((artifact) => artifact?.type === 'automatic_transcript_attestation'
      && artifact.validation?.exists === true
      && artifact.validation?.readable === true
      && artifact.validation?.nonEmpty === true);
}
function mayNeedConfirmedTranscriptChain(task) {
  return task?.status === 'failed' && task?.taskType === 'content.video-benchmark-analysis'
    && task?.execution?.owner === 'paperclip-hermes'
    && Boolean(String(task?.governance?.paperclipIssueId || '').trim())
    && ['auto', 'required'].includes(task?.input?.visualMode)
    && !(task?.artifactRefs || []).some(validConfirmedTranscript);
}
