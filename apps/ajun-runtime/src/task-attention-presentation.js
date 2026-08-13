import { sanitizeFailureText } from './technical-failure-classifier.ts';

const ATTENTION_SCHEMA_VERSION = 'agent.army/task-attention-presentation/v1';
const EMPLOYEE_REPORT_TYPE = 'employee_role_report';
const REPORTED_FAILURE_BOILERPLATE = '员工已如实回报任务失败，请查看结果摘要和剩余风险。';

const PRESENTATION = Object.freeze({
  failed:{
    headline:'本轮未完成',
    impact:'本轮任务没有完成；已有产物和审计记录仍会保留。',
  },
  needs_input:{
    headline:'需要补充信息',
    impact:'补充继续所需的信息前，任务不会继续执行。',
  },
  waiting_test:{
    headline:'等待验证',
    impact:'当前结果尚未通过完整验证，不能视为已经完成。',
  },
  waiting_approval:{
    headline:'等待确认',
    impact:'确认完成前，任务不会继续执行受控步骤。',
  },
  paused:{
    headline:'任务已暂停',
    impact:'确认继续前，任务不会开始新的处理步骤。',
  },
});

export function presentTaskAttention(task = {}, { pendingApproval = false, recoveryView = null } = {}) {
  const kind = attentionKind(task, pendingApproval);
  if (!kind) return null;

  const report = ['failed', 'waiting_test'].includes(kind) ? currentEmployeeReport(task) : null;
  const reportData = report?.data || {};
  const userMessage = failureText(task.error?.userMessage, 800);
  const reportSummary = failureText(reportData.summary, 800);
  const cause = reportSummary
    || safeFailureMessage(kind, userMessage)
    || fallbackCause(kind);
  const nextAction = failureText(reportData.nextAction, 800)
    || safeNextAction(kind, userMessage, Boolean(reportSummary), task.error?.retryable);
  const actions = recoveryActions(recoveryView?.actions);
  const verification = recoveryVerification(recoveryView?.verification);

  return {
    schemaVersion:ATTENTION_SCHEMA_VERSION,
    kind,
    headline:PRESENTATION[kind].headline,
    cause,
    impact:PRESENTATION[kind].impact,
    evidence:failureText(reportData.evidence, 800) || null,
    remainingRisks:failureText(reportData.remainingRisks, 800) || null,
    nextAction,
    actions,
    verification,
    technical:{
      code:cleanText(task.error?.code, 120) || null,
      stage:cleanText(task.error?.stage || task.currentStage, 120) || null,
      retryable:typeof task.error?.retryable === 'boolean' ? task.error.retryable : null,
      occurredAt:validIso(task.error?.occurredAt || task.execution?.finishedAt || task.updatedAt),
    },
  };
}

export function currentEmployeeReport(task = {}) {
  const reports = (Array.isArray(task.artifactRefs) ? task.artifactRefs : [])
    .filter((artifact) => artifact?.type === EMPLOYEE_REPORT_TYPE);
  if (!reports.length) return null;
  const reversed = [...reports].reverse();
  const currentRunId = currentPaperclipRunId(task);
  if (!currentRunId) return reversed.find((artifact) => failureText(artifact?.data?.summary, 800)) || null;
  return reversed.find((artifact) =>
    cleanText(artifact?.data?.paperclipRunId || artifact?.paperclipRunId, 240) === currentRunId
  ) || reversed.find((artifact) =>
    !cleanText(artifact?.data?.paperclipRunId || artifact?.paperclipRunId, 240)
    && failureText(artifact?.data?.summary, 800)
  ) || reversed.find((artifact) => failureText(artifact?.data?.summary, 800)) || null;
}

function attentionKind(task, pendingApproval) {
  if (pendingApproval || ['pending_approval', 'waiting_approval'].includes(task?.status)) return 'waiting_approval';
  return Object.hasOwn(PRESENTATION, task?.status) ? task.status : null;
}

function currentPaperclipRunId(task) {
  return [
    task?.governance?.completionSync?.runId,
    task?.execution?.m5Recovery?.runId,
    task?.execution?.paperclipRunId,
    task?.governance?.paperclipRunId,
    task?.input?.context?.paperclipRunId,
  ].map((value) => cleanText(value, 240)).find(Boolean) || '';
}

function safeFailureMessage(kind, userMessage) {
  if (!userMessage || userMessage === REPORTED_FAILURE_BOILERPLATE) return '';
  return ['failed', 'needs_input', 'waiting_test'].includes(kind) ? userMessage : '';
}

function safeNextAction(kind, userMessage, hasReportSummary, retryable) {
  if (kind !== 'failed' && userMessage) return userMessage;
  if (kind === 'failed' && userMessage && !hasReportSummary && userMessage !== REPORTED_FAILURE_BOILERPLATE) {
    return retryAction(retryable);
  }
  if (kind === 'failed') return retryAction(retryable);
  return ({
    needs_input:'请补充任务继续所需的信息。',
    waiting_test:'请查看已有结果和验证缺口，再决定是否采用。',
    waiting_approval:'请核对范围并完成确认。',
    paused:'如需继续，请确认恢复任务。',
  })[kind] || '请查看任务详情。';
}

function retryAction(retryable) {
  if (retryable === true) return '请先确认相关依赖已经恢复，再决定是否重新尝试。';
  if (retryable === false) return '当前不应原样重试；请根据失败原因补充信息或调整范围。';
  return '请根据失败原因决定补充信息、调整范围或暂不处理。';
}

function fallbackCause(kind) {
  return ({
    failed:'任务本轮没有完成，未留下更具体的用户可见原因。',
    needs_input:'任务缺少继续所需的信息。',
    waiting_test:'本轮自动验证尚未完成。',
    waiting_approval:'任务正在等待确认。',
    paused:'任务已经暂停。',
  })[kind];
}

function validIso(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function cleanText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function failureText(value, limit) {
  return sanitizeFailureText(value).slice(0, limit);
}

function recoveryActions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((action) => {
    if (!action || typeof action !== 'object') return [];
    const actionKey = cleanText(action.actionKey, 120);
    if (!actionKey) return [];
    return [{
      actionKey,
      label:failureText(action.label, 160),
      emphasis:cleanText(action.emphasis, 40) || null,
      confirmation:failureText(action.confirmation, 800) || null,
    }];
  }).slice(0, 3);
}

function recoveryVerification(value) {
  if (!value || typeof value !== 'object') return null;
  const state = cleanText(value.state, 80);
  const taskId = cleanText(value.taskId, 120);
  const detailPath = cleanText(value.detailPath, 500);
  if (!state && !taskId && !detailPath) return null;
  return {
    state:state || null,
    taskId:taskId || null,
    detailPath:detailPath || null,
  };
}
