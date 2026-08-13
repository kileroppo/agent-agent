import { ProposalValidationError } from './agent-proposal-service.js';
import { presentTaskCard } from './task-card-presentation.js';

export {
  presentCommanderReply,
  presentTaskStatus,
} from './contracts/agent-army-adapter-projection.js';

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

export async function resolveTaskCardAction(input, { store, tasks, resolveApproval }) {
  const taskId = requiredCardField(input?.taskId, '任务卡动作缺少任务编号。');
  const action = requiredCardField(input?.action, '任务卡动作缺少操作。');
  if (!['approve', 'reject', 'pause', 'resume'].includes(action)) {
    throw new ProposalValidationError('任务卡动作不受支持。');
  }
  const chatRef = requiredCardField(input?.chatId || input?.chatRef, '任务卡动作缺少原飞书会话。');
  const task = await findTask(store, taskId);
  const cardIdentity = assertTaskCardOwnership(task, { ...input, chatRef });
  const context = await taskCardContextFor({ store, tasks }, task);
  const current = presentTaskCard(task, { ...context, ...cardIdentity });
  const projectionChanged = String(input?.sourceRevision || '') !== current.sourceRevision
    || String(input?.contentHash || '') !== current.contentHash;

  if (action === 'pause' || action === 'resume') {
    if (!current.actions.some((item) => item.action === action)) {
      return refreshedTaskCard(current, projectionChanged ? 'stale_projection' : 'action_unavailable');
    }
    // Progress polling can advance the projection between rendering and a human
    // click. Pause/resume remains safe when the authoritative latest card still
    // exposes the same operation, so do not turn that normal race into an error.
    await (action === 'pause' ? tasks.requestPause(taskId) : tasks.requestResume(taskId));
  } else {
    if (projectionChanged) return refreshedTaskCard(current, 'stale_projection');
    const approvalId = requiredCardField(input?.approvalId, '审批动作缺少审批编号。');
    const cardAction = current.actions.find((item) => item.action === action && item.approvalId === approvalId);
    if (!cardAction) return refreshedTaskCard(current, 'action_unavailable');
    await resolveApproval({
      approvalId,
      action,
      governanceMode:cardAction.governanceMode || requiredCardField(input?.governanceMode, '审批动作缺少治理方式。'),
      chatRef,
      requesterRef:String(input?.requesterRef || 'feishu-approver'),
    });
  }

  const latestTask = await findTask(store, taskId);
  assertTaskCardOwnership(latestTask, { ...input, chatRef });
  const latestContext = await taskCardContextFor({ store, tasks }, latestTask);
  return {
    handled:true,
    actionApplied:true,
    message:action === 'pause' ? '已进入暂停确认。'
      : action === 'resume' ? '已进入继续确认。'
        : '操作已处理。',
    taskCard:presentTaskCard(latestTask, { ...latestContext, ...cardIdentity }),
  };
}

/**
 * Bind a card read/action to the Feishu chat and Hermes identity that created
 * the task. Old A君 tasks predate explicit identity fields, so only A君/default
 * callers may use that narrow compatibility path. Other agents must have an
 * explicit source binding; assigneeAgentId alone never grants card ownership.
 */
export function assertTaskCardOwnership(task, input = {}) {
  if (!task || task.source?.channel !== 'feishu') {
    throw new ProposalValidationError('只能读取或操作由飞书创建的任务卡。');
  }
  const chatId = requiredCardField(input.chatId || input.chatRef, '任务卡缺少原飞书会话。');
  const expectedChatId = String(task.source?.chatRef || '').trim();
  if (!expectedChatId || expectedChatId !== chatId) {
    throw new ProposalValidationError('只能在创建该任务的原飞书会话读取或操作任务卡。');
  }

  const requestedAgentId = optionalCardField(input.agentId);
  const requestedProfileId = optionalCardField(input.profileId);
  const expectedAgentId = optionalCardField(task.source?.targetAgentId);
  const expectedProfileId = optionalCardField(task.source?.profileId);
  const ajunCompatibility = (!expectedAgentId || expectedAgentId === 'ajun')
    && (!expectedProfileId || expectedProfileId === 'ajun');

  if (expectedAgentId) {
    if ((!requestedAgentId && !ajunCompatibility) || (requestedAgentId && requestedAgentId !== expectedAgentId)) {
      throw new ProposalValidationError('任务卡与当前 Agent 身份不匹配。');
    }
  } else if (requestedAgentId && requestedAgentId !== 'ajun') {
    throw new ProposalValidationError('旧任务卡只允许 A君兼容读取。');
  }

  if (expectedProfileId) {
    if ((!requestedProfileId && !ajunCompatibility) || (requestedProfileId && requestedProfileId !== expectedProfileId)) {
      throw new ProposalValidationError('任务卡与当前 Hermes Profile 不匹配。');
    }
  } else if (requestedProfileId && requestedProfileId !== 'ajun') {
    throw new ProposalValidationError('旧任务卡只允许 A君 Profile 兼容读取。');
  }

  return {
    agentId:expectedAgentId || requestedAgentId || null,
    profileId:expectedProfileId || requestedProfileId || null,
    // Preserve the visible shape of pre-identity A君 cards so their hash does
    // not become stale solely because the server gained ownership validation.
    chatId:expectedAgentId || expectedProfileId || requestedAgentId || requestedProfileId
      ? expectedChatId
      : null,
  };
}

function refreshedTaskCard(taskCard, reason) {
  return {
    handled:true,
    actionApplied:false,
    reason,
    message:reason === 'stale_projection'
      ? '任务刚刚有新进展，已为你刷新到最新状态。'
      : '任务已经进入下一阶段，原操作不再适用。',
    taskCard,
  };
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

function optionalCardField(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
}
