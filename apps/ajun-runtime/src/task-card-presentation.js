import crypto from 'node:crypto';
import { presentTask } from './task-presentation.js';
import { sanitizeFailureText } from './technical-failure-classifier.js';

export const TASK_CARD_SCHEMA_VERSION = 'agent.army/task-card/v1';

const ACTION_LABELS = Object.freeze({
  approve:'批准',
  reject:'拒绝',
  pause:'暂停任务',
  resume:'继续任务',
});
const ALLOWED_ACTIONS = new Set(Object.keys(ACTION_LABELS));
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);

/**
 * Build the public, deterministic task-card projection. This function is pure:
 * callers provide approval and recovery views instead of granting it store access.
 */
export function presentTaskCard(task = {}, { approvals = [], recoveryView = null, owner = null } = {}) {
  const relevantApprovals = taskApprovals(task, approvals);
  const pendingApproval = relevantApprovals.find((approval) => approval?.status === 'pending') || null;
  const presentation = presentTask(task, { approvals:relevantApprovals, recoveryView });
  const state = cardState(task, { pendingApproval, recoveryView });
  const updatedAt = latestTimestamp(task, relevantApprovals, recoveryView);
  const projection = {
    schemaVersion:TASK_CARD_SCHEMA_VERSION,
    taskId:safeIdentifier(task.taskId) || null,
    taskRef:presentation.taskRef,
    title:publicText(task.input?.title || task.title, 160) || '未命名任务',
    state,
    tone:cardTone(state, presentation.tone),
    summary:publicText(presentation.summary, 800) || '任务状态已更新。',
    owner:ownerLabel(owner, task),
    nextAction:publicText(presentation.nextAction, 800) || '等待新的进度；无需重复提交。',
    actions:cardActions({ task, pendingApproval, recoveryView, state }),
    sourceRevision:sourceRevision(task, relevantApprovals, recoveryView, updatedAt),
    terminal:TERMINAL_STATES.has(state),
    updatedAt,
  };
  return {
    ...projection,
    contentHash:hashProjection(projection),
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
      actions.push(actionView('approve', { approvalId, governanceMode }));
      actions.push(actionView('reject', { approvalId, governanceMode }));
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
  if (TERMINAL_STATES.has(state)) return [];
  return actions.filter((item) => ALLOWED_ACTIONS.has(item.action)).slice(0, 4);
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
