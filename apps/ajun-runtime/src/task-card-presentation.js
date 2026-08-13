import crypto from 'node:crypto';
import { presentTask } from './task-presentation.js';
import { sanitizeFailureText } from './technical-failure-classifier.ts';
import { DEFAULT_TASK_DEFINITION_REGISTRY } from './task-definition-registry.js';
import { isTaskCardTerminalStatus } from './task-status-policy.js';

export const TASK_CARD_SCHEMA_VERSION = 'agent.army/task-card/v1';
const TASK_CARD_RENDER_REVISION = 'card-ux4';

const ACTION_LABELS = Object.freeze({
  approve:'批准',
  reject:'拒绝',
  pause:'暂停任务',
  resume:'继续任务',
});
const ALLOWED_ACTIONS = new Set(Object.keys(ACTION_LABELS));
const TERMINAL_STATES = new Set(['rejected']);

/**
 * Build the public, deterministic task-card projection. This function is pure:
 * callers provide approval and recovery views instead of granting it store access.
 */
export function presentTaskCard(task = {}, {
  approvals = [],
  recoveryView = null,
  owner = null,
  agentId = null,
  profileId = null,
  chatId = null,
  taskCardPolicy = null,
} = {}) {
  const relevantApprovals = taskApprovals(task, approvals);
  const pendingApproval = relevantApprovals.find((approval) => approval?.status === 'pending') || null;
  const presentation = presentTask(task, { approvals:relevantApprovals, recoveryView });
  const taskCardCopy = publicTaskCardCopy(task, presentation);
  const state = cardState(task, { pendingApproval, recoveryView });
  const updatedAt = latestTimestamp(task, relevantApprovals, recoveryView);
  const projection = {
    schemaVersion:TASK_CARD_SCHEMA_VERSION,
    taskId:safeIdentifier(task.taskId) || null,
    agentId:cardAgentId(task, agentId),
    profileId:cardProfileId(task, profileId),
    chatId:cardChatId(task, chatId),
    taskCardPolicy:cardPolicy(taskCardPolicy || task?.source?.taskCardPolicy),
    taskKind:safeIdentifier(task?.input?.taskType || task?.taskType) || null,
    taskRef:presentation.taskRef,
    title:publicText(task.input?.title || task.title, 160) || '未命名任务',
    state,
    tone:cardTone(state, presentation.tone),
    summary:taskCardCopy.summary,
    owner:ownerLabel(owner, task),
    nextAction:taskCardCopy.nextAction,
    details:taskDetails(task),
    primaryLink:deliveryLink(task),
    actions:cardActions({ task, pendingApproval, recoveryView, state }),
    sourceRevision:sourceRevision(task, relevantApprovals, recoveryView, updatedAt),
    terminal:TERMINAL_STATES.has(state) || isTaskCardTerminalStatus(state),
    updatedAt,
  };
  return {
    ...projection,
    contentHash:hashProjection(projection),
  };
}

function taskDetails(task) {
  const taskType = safeIdentifier(task?.input?.taskType || task?.taskType);
  return {
    taskType:DEFAULT_TASK_DEFINITION_REGISTRY.taskLabel(taskType) || '军团任务',
    createdAt:validTimestamp(task?.createdAt) || null,
  };
}

function cardAgentId(task, value) {
  return safeIdentifier(value || task?.source?.targetAgentId) || null;
}

function cardProfileId(task, value) {
  return safeIdentifier(value || task?.source?.profileId) || null;
}

function cardChatId(task, value) {
  return safeIdentifier(value || task?.source?.chatRef) || null;
}

function cardPolicy(value) {
  const policy = safeIdentifier(value);
  return ['disabled', 'routed-task', 'durable-task', 'incident-only'].includes(policy) ? policy : null;
}

function deliveryLink(task) {
  const delivery = (Array.isArray(task?.artifactRefs) ? task.artifactRefs : [])
    .find((artifact) => artifact?.type === 'xiaod_media_delivery');
  const value = String(delivery?.data?.larkUrl || '').trim();
  if (!value || delivery?.data?.larkPermissionGranted !== true) return null;
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn');
    if (url.protocol !== 'https:' || !trustedHost || !url.pathname.startsWith('/docx/')) return null;
    return { label:'打开交付文档', url:url.toString() };
  } catch {
    return null;
  }
}

function publicTaskCardCopy(task, presentation) {
  if (task?.error?.code === 'xiaod_delivery_pending') {
    const title = publicText(task.input?.title || task.title, 160) || '当前视频任务';
    return {
      summary:`${title}：视频处理结果已保存，但报告发送到飞书失败。`,
      nextAction:'这不是你的操作问题；请联系系统管理员检查小D的飞书应用连接。修复后，在本会话回复“继续飞书交付”。',
    };
  }
  return {
    summary:publicText(presentation.summary, 800) || '任务状态已更新。',
    nextAction:publicText(presentation.nextAction, 800) || '等待新的进度；无需重复提交。',
  };
}

// A semantic alias for callers that use "project" terminology.
export const projectTaskCard = presentTaskCard;

function taskApprovals(task, approvals) {
  if (!Array.isArray(approvals)) return [];
  const taskId = safeIdentifier(task?.taskId);
  const refs = new Set((Array.isArray(task?.approvalRefs) ? task.approvalRefs : [])
    .map(safeIdentifier)
    .filter(Boolean));
  return approvals.filter((approval) => {
    const approvalId = safeIdentifier(approval?.approvalId);
    return (approvalId && refs.has(approvalId))
      || (taskId && safeIdentifier(approval?.taskId) === taskId);
  }).sort((left, right) => approvalSortKey(right).localeCompare(approvalSortKey(left)));
}

function cardState(task, { pendingApproval, recoveryView }) {
  if (pendingApproval) return 'waiting_approval';
  const taskStatus = normalizedState(task?.status);
  const recoveryState = normalizedState(recoveryView?.state || recoveryView?.status);
  if (['recovery_pending', 'technical_repair'].includes(recoveryState)) return recoveryState;
  if (taskStatus === 'pending_approval') return 'waiting_approval';
  return taskStatus || 'unknown';
}

function cardTone(state, fallback) {
  if (state === 'succeeded') return 'success';
  if (state === 'failed') return 'danger';
  if (['cancelled', 'rejected'].includes(state)) return 'muted';
  if (['pausing', 'paused', 'waiting_approval', 'needs_input', 'waiting_test', 'recovery_pending', 'technical_repair'].includes(state)) return 'attention';
  return ['active', 'attention', 'success', 'danger', 'muted'].includes(fallback) ? fallback : 'active';
}

function cardActions({ task, pendingApproval, recoveryView, state }) {
  const actions = [];
  if (pendingApproval) {
    const approvalId = safeIdentifier(pendingApproval.approvalId);
    const governanceMode = safeIdentifier(pendingApproval.governanceMode);
    if (approvalId) {
      const labels = approvalActionLabels(pendingApproval.action);
      actions.push(actionView('approve', { approvalId, governanceMode, label:labels.approve }));
      actions.push(actionView('reject', { approvalId, governanceMode, label:labels.reject }));
    }
  }

  for (const candidate of Array.isArray(recoveryView?.actions) ? recoveryView.actions : []) {
    const action = normalizeAction(candidate?.action || candidate?.actionKey || candidate?.taskControlAction);
    if (!action || actions.some((item) => item.action === action)) continue;
    actions.push(actionView(action, {
      approvalId:safeIdentifier(candidate?.approvalId),
      governanceMode:safeIdentifier(candidate?.governanceMode),
      label:publicText(candidate?.label, 80),
    }));
  }

  // The existing task-control contract supports pause/resume only for a live
  // 小D job. Expose those controls from the same eligibility facts instead of
  // advertising an action that the authoritative service would reject.
  if (!pendingApproval && task?.execution?.executor === 'xiaod' && task.execution?.xiaodJobId) {
    if (['queued', 'running', 'pausing'].includes(state) && !actions.some((item) => item.action === 'pause')) actions.push(actionView('pause'));
    if (state === 'paused' && !actions.some((item) => item.action === 'resume')) actions.push(actionView('resume'));
  }

  // A paused task can expose resume only when the supplied recovery view explicitly
  // authorizes it. Terminal tasks never retain stale controls.
  if (TERMINAL_STATES.has(state) || isTaskCardTerminalStatus(state)) return [];
  return actions.filter((item) => ALLOWED_ACTIONS.has(item.action)).slice(0, 4);
}

function approvalActionLabels(action) {
  if (action === 'pause-task') return { approve:'确认暂停', reject:'保持运行' };
  if (action === 'resume-task') return { approve:'确认继续', reject:'保持暂停' };
  return { approve:ACTION_LABELS.approve, reject:ACTION_LABELS.reject };
}

function actionView(action, { approvalId = '', governanceMode = '', label = '' } = {}) {
  return {
    action,
    label:label || ACTION_LABELS[action],
    approvalId:approvalId || null,
    governanceMode:governanceMode || null,
  };
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return ALLOWED_ACTIONS.has(action) ? action : '';
}

function ownerLabel(owner, task) {
  const value = typeof owner === 'string'
    ? owner
    : owner?.label || owner?.name || owner?.agentId
      || task?.owner?.label || task?.owner?.name || task?.owner
      || task?.assigneeAgentName || task?.assigneeAgentId;
  return publicText(value, 120) || null;
}

function latestTimestamp(task, approvals, recoveryView) {
  const timestamps = [
    task?.updatedAt,
    task?.execution?.updatedAt,
    task?.workflow?.updatedAt,
    task?.governance?.updatedAt,
    recoveryView?.updatedAt,
    recoveryView?.verification?.updatedAt,
    ...approvals.flatMap((approval) => [approval?.updatedAt, approval?.decidedAt, approval?.createdAt]),
  ].map(validTimestamp).filter(Boolean).sort();
  return timestamps.at(-1) || null;
}

function sourceRevision(task, approvals, recoveryView, updatedAt) {
  const explicit = [
    TASK_CARD_RENDER_REVISION,
    task?.presentationRevision,
    task?.revision,
    task?.workflow?.revision,
    recoveryView?.presentationRevision,
    recoveryView?.revision,
    ...approvals.map((approval) => approval?.revision),
  ].map(normalizedRevision).filter(Boolean);
  if (updatedAt) return `${updatedAt}:${explicit.join('.') || '0'}`;
  const legacyTruth = {
    taskStatus:normalizedState(task?.status),
    approvalStates:approvals.map((approval) => ({
      approvalId:safeIdentifier(approval?.approvalId),
      status:normalizedState(approval?.status),
    })).sort((a, b) => String(a.approvalId).localeCompare(String(b.approvalId))),
    recoveryState:normalizedState(recoveryView?.state || recoveryView?.status),
    revisions:explicit,
  };
  return `legacy:${crypto.createHash('sha256').update(stableJson(legacyTruth)).digest('hex').slice(0, 16)}`;
}

function hashProjection(projection) {
  const { sourceRevision:_, updatedAt:__, ...visibleContent } = projection;
  return crypto.createHash('sha256').update(stableJson(visibleContent)).digest('hex');
}

function approvalSortKey(approval) {
  const timestamp = validTimestamp(approval?.updatedAt || approval?.decidedAt || approval?.createdAt);
  return `${timestamp}:${safeIdentifier(approval?.approvalId)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedState(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 80);
}

function normalizedRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return safeIdentifier(value);
}

function safeIdentifier(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function publicText(value, limit) {
  return sanitizeFailureText(value).slice(0, limit);
}

function validTimestamp(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}
