import { ProposalValidationError } from './agent-proposal-service.js';
import { presentTaskCard } from './task-card-presentation.js';
import { presentTask, shortTaskRef } from './task-presentation.js';

export function createFeishuApprovalResolver({ proposals, tasks }) {
  if (!proposals || !tasks) throw new TypeError('proposals 和 tasks 必填。');
  return async function resolveFeishuApproval({
    approvalId,
    action,
    governanceMode,
    chatRef,
    requesterRef,
  }) {
    const decisionBy = String(requesterRef || 'feishu-approver');
    const safeChatRef = String(chatRef || '');
    if (governanceMode === 'proposal') {
      const proposal = await proposals.get(approvalId);
      if (!proposal.sourceChatRef || proposal.sourceChatRef !== safeChatRef) {
        throw new ProposalValidationError('该草案只能在发起它的飞书会话中决定。');
      }
      return {
        proposal:action === 'approve'
          ? await proposals.approveForTest(approvalId, decisionBy)
          : await proposals.reject(approvalId, decisionBy),
      };
    }
    const options = {
      decisionBy,
      decisionReason:'由飞书审批卡确认。',
      chatRef:safeChatRef,
    };
    if (governanceMode === 'paperclip') {
      return { task:await tasks.resolvePaperclipApproval(approvalId, action, options) };
    }
    return {
      task:action === 'approve'
        ? await tasks.approveApproval(approvalId, options)
        : await tasks.rejectApproval(approvalId, options),
    };
  };
}

export function presentCommanderReply(payload, detailBaseUrl, taskCardContext = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const task = payload.task || payload.mission || null;
  if (!task?.taskId) return payload;
  const presentation = presentTask(task, { detailBaseUrl });
  const reply = composeTaskReply(payload.reply, task.taskId, presentation);
  return {
    ...payload,
    reply,
    presentation,
    taskCard:presentTaskCard(task, taskCardContext),
  };
}

export function presentTaskStatus(notification, task, taskCardContext = {}) {
  if (!task?.taskId) return notification;
  const { projectionTruth = null, ...publicNotification } = notification || {};
  const projectedTask = notification?.status
    ? {
        ...task,
        status:notification.status,
        ...(projectionTruth ? {
          updatedAt:latestCardTruthTimestamp(task.updatedAt, projectionTruth.updatedAt),
          presentationRevision:[
            task.presentationRevision ?? task.revision ?? '0',
            projectionTruth.taskId,
            projectionTruth.revision ?? '0',
            projectionTruth.status,
            notification.status,
          ].map((value) => String(value || '')).join(':'),
        } : {}),
      }
    : task;
  return {
    ...publicNotification,
    taskCard:presentTaskCard(projectedTask, taskCardContext),
  };
}

function latestCardTruthTimestamp(...values) {
  const timestamps = values
    .map((value) => String(value || '').trim())
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .map((value) => new Date(value).toISOString())
    .sort();
  return timestamps.at(-1) || null;
}

export async function resolveTaskCardAction(input, { store, tasks, resolveApproval }) {
  const taskId = requiredCardField(input?.taskId, '任务卡动作缺少任务编号。');
  const action = requiredCardField(input?.action, '任务卡动作缺少操作。');
  if (!['approve', 'reject', 'pause', 'resume'].includes(action)) {
    throw new ProposalValidationError('任务卡动作不受支持。');
  }
  const chatRef = requiredCardField(input?.chatRef, '任务卡动作缺少原飞书会话。');
  const task = await findTask(store, taskId);
  if (!task || task.source?.channel !== 'feishu' || String(task.source?.chatRef || '') !== chatRef) {
    throw new ProposalValidationError('只能在创建该任务的原飞书会话操作任务卡。');
  }
  const context = await taskCardContextFor({ store, tasks }, task);
  const current = presentTaskCard(task, context);
  if (String(input?.sourceRevision || '') !== current.sourceRevision
    || String(input?.contentHash || '') !== current.contentHash) {
    throw new ProposalValidationError('任务卡已更新，请按最新状态操作。');
  }

  if (action === 'pause' || action === 'resume') {
    if (!current.actions.some((item) => item.action === action)) {
      throw new ProposalValidationError('当前任务状态不允许这项操作。');
    }
    await (action === 'pause' ? tasks.requestPause(taskId) : tasks.requestResume(taskId));
  } else {
    const approvalId = requiredCardField(input?.approvalId, '审批动作缺少审批编号。');
    const cardAction = current.actions.find((item) => item.action === action && item.approvalId === approvalId);
    if (!cardAction) throw new ProposalValidationError('这项审批已经变化或不属于当前任务。');
    await resolveApproval({
      approvalId,
      action,
      governanceMode:cardAction.governanceMode || requiredCardField(input?.governanceMode, '审批动作缺少治理方式。'),
      chatRef,
      requesterRef:String(input?.requesterRef || 'feishu-approver'),
    });
  }

  const latestTask = await findTask(store, taskId);
  const latestContext = await taskCardContextFor({ store, tasks }, latestTask);
  return { handled:true, taskCard:presentTaskCard(latestTask, latestContext) };
}

function composeTaskReply(value, taskId, presentation) {
  const link = presentation.detailUrl
    ? `[查看任务 ${shortTaskRef(taskId)}](${presentation.detailUrl})`
    : `任务 ${shortTaskRef(taskId)}`;
  const nextAction = String(presentation.nextAction || '').trim();
  let reply = String(value || '').trim() || String(presentation.summary || '').trim();

  if (reply.includes(taskId)) reply = reply.replaceAll(taskId, link);

  const hasTaskReference = reply.includes(presentation.detailUrl || '\0')
    || reply.includes(shortTaskRef(taskId));
  const hasExplicitNextAction = /(?:^|\n)(?:下一步|你现在要做)\s*[：:]/m.test(reply);
  const alreadyStatesNextAction = nextAction && normalizeReplyText(reply).includes(normalizeReplyText(nextAction));
  const footer = [];
  if (nextAction && !hasExplicitNextAction && !alreadyStatesNextAction) footer.push(`下一步：${nextAction}`);
  if (!hasTaskReference) footer.push(link);
  return footer.length ? `${reply}\n\n${footer.join('\n')}` : reply;
}

function normalizeReplyText(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[。；;，,！!？?]/g, '');
}

async function taskCardContextFor({ store, tasks }, task) {
  const [approvals, recoveryView] = await Promise.all([
    store.listApprovals(),
    tasks.recoveryView(task),
  ]);
  return { approvals, recoveryView };
}

async function findTask(store, taskId) {
  if (typeof store.getTask === 'function') return store.getTask(taskId);
  return (await store.list()).find((item) => item.taskId === taskId) || null;
}

function requiredCardField(value, message) {
  const text = String(value || '').trim();
  if (!text) throw new ProposalValidationError(message);
  return text;
}
