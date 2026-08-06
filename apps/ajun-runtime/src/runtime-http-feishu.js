import { ProposalValidationError } from './agent-proposal-service.js';
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

export function presentCommanderReply(payload, detailBaseUrl) {
  if (!payload || typeof payload !== 'object') return payload;
  const task = payload.task || payload.mission || null;
  if (!task?.taskId) return payload;
  const presentation = presentTask(task, { detailBaseUrl });
  const link = presentation.detailUrl
    ? `[查看任务 ${shortTaskRef(task.taskId)}](${presentation.detailUrl})`
    : `任务 ${shortTaskRef(task.taskId)}`;
  let reply = String(payload.reply || '').trim();
  if (reply.includes(task.taskId)) reply = reply.replaceAll(task.taskId, link);
  else if (reply && !reply.includes(presentation.detailUrl || '\0')) reply = `${reply}\n\n${link}`;
  return { ...payload, reply, presentation };
}
