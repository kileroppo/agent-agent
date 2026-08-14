import { privateReadGrantStatus, revokePrivateReadGrant } from './private-read-grant.js';
import { ValidationError } from './task-validation-error.ts';

export class TaskApprovalLifecycle {
  constructor({ store, governance = null } = {}) {
    this.store = store;
    this.governance = governance;
  }

  async revokePrivateReadGrant(approvalId, { revokedBy = 'A君', chatRef = '' } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval || approval.action !== 'wechat-private-chat-read') throw new ValidationError('找不到这条微信临时授权。');
    if (!approval.privateReadGrant) throw new ValidationError('这条审批尚未生成可撤销的微信临时授权。');
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) throw new ValidationError('找不到关联任务。');
    validateApprovalChat(task, chatRef);
    if (approval.privateReadGrant.revokedAt) return withGrantStatus(approval);
    const updated = await this.store.updateApproval(approvalId, {
      privateReadGrant:{
        ...revokePrivateReadGrant(approval.privateReadGrant),
        revokedBy:String(revokedBy || 'A君').slice(0, 120),
      },
    });
    return withGrantStatus(updated);
  }

  async expirePending({ now = Date.now() } = {}) {
    const approvals = await this.store.listApprovals();
    const expired = [];
    for (const approval of approvals) {
      if (!isExpiredApproval(approval, now)) continue;
      const result = await this.expire(approval.approvalId, { now });
      if (result.expired) expired.push(result);
    }
    return expired;
  }

  async expire(approvalId, { now = Date.now() } = {}) {
    const approval = (await this.store.listApprovals()).find((item) => item.approvalId === approvalId);
    if (!approval || !isExpiredApproval(approval, now)) return { approval, task:null, expired:false };
    const decidedAt = new Date(now).toISOString();
    const expiredApproval = await this.store.updateApproval(approvalId, {
      status:'expired', decisionBy:'A君', decisionReason:'审批已过期，未执行任务。', decidedAt,
    });
    const task = (await this.store.list()).find((item) => item.taskId === approval.taskId);
    if (!task) return { approval:expiredApproval, task:null, expired:true };
    if (approval.holdTask === false) {
      const updated = await this.store.updateTask(task.taskId, {
        execution:{
          ...(task.execution || {}),
          control:{ ...(task.execution?.control || {}), action:approval.action, status:'expired', approvalId, decidedAt },
        },
      });
      return { approval:expiredApproval, task:updated, expired:true };
    }
    if (task.status !== 'waiting_approval') return { approval:expiredApproval, task, expired:true };
    let closed = await this.store.updateTask(task.taskId, {
      status:'cancelled',
      currentStage:'approval_expired',
      error:{
        code:'approval_expired',
        message:'审批已过期，任务已关闭且未执行。',
        userMessage:'这项确认已过期，任务没有执行，已自动关闭。',
        category:'manual',
        stage:'approval',
        occurredAt:decidedAt,
      },
    });
    if (this.governance && closed.governance?.paperclipIssueId) {
      try {
        closed = await this.store.updateTask(closed.taskId, { governance:await this.governance.update(closed) });
      } catch {
        // 本机已如实关闭，Paperclip 恢复后会由既有补同步链路继续处理。
      }
    }
    return { approval:expiredApproval, task:closed, expired:true };
  }
}

function withGrantStatus(approval) {
  return { ...approval, privateReadGrantStatus:privateReadGrantStatus(approval.privateReadGrant) };
}

function validateApprovalChat(task, chatRef) {
  const expected = String(task.source?.chatRef || '').trim();
  const actual = String(chatRef || '').trim();
  if (actual && expected && actual !== expected) throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}

function isExpiredApproval(approval, now = Date.now()) {
  const validUntil = Date.parse(approval?.validUntil || '');
  return approval?.status === 'pending' && Number.isFinite(validUntil) && validUntil <= now;
}
