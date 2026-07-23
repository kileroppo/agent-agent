const MAX_REMEMBERED_EVENTS = 1000;

/**
 * The thin boundary used by Feishu's official Channel SDK.
 *
 * The SDK owns connection, event de-duplication at the platform edge and
 * rendering; this bridge only turns its normalised message/card input into
 * the existing A君 task and approval truth.  It does not connect to Feishu,
 * create applications or retain credentials.
 */
export class FeishuChannelBridge {
  constructor({ commander, resolveApproval } = {}) {
    if (!commander?.handle) throw new FeishuChannelBridgeError('飞书收发入口缺少总管处理器。');
    if (typeof resolveApproval !== 'function') throw new FeishuChannelBridgeError('飞书收发入口缺少审批处理器。');
    this.commander = commander;
    this.resolveApproval = resolveApproval;
    this.replies = new Map();
  }

  async handleMessage(input) {
    const event = messageEvent(input);
    if (event.chatType === 'group' && !event.mentioned) {
      return { handled:false, reason:'群内未提及机器人，不创建任务。' };
    }
    const existing = this.replies.get(event.eventRef);
    if (existing) return { ...existing, deduplicated:true };

    const result = await this.commander.handle({
      text:event.text,
      sourceEventRef:event.eventRef,
      requesterRef:event.requesterRef,
      chatRef:event.chatRef,
      targetAgentId:event.targetAgentId || undefined
    });
    const response = { handled:true, deduplicated:false, eventRef:event.eventRef, result };
    this.remember(event.eventRef, response);
    return response;
  }

  async handleCardAction(input) {
    const action = cardAction(input);
    const result = await this.resolveApproval(action);
    return { handled:true, action, result };
  }

  remember(eventRef, response) {
    this.replies.set(eventRef, response);
    if (this.replies.size <= MAX_REMEMBERED_EVENTS) return;
    this.replies.delete(this.replies.keys().next().value);
  }
}

export class FeishuChannelBridgeError extends Error {}

function messageEvent(input) {
  const eventRef = required(input?.eventRef, '飞书消息缺少稳定事件编号，未创建任务。');
  const text = required(input?.text, '飞书消息正文不能为空。');
  const chatType = input?.chatType === 'group' ? 'group' : input?.chatType === 'p2p' ? 'p2p' : null;
  if (!chatType) throw new FeishuChannelBridgeError('飞书消息缺少可识别的聊天类型，未创建任务。');
  return {
    eventRef,
    text,
    chatType,
    mentioned: input?.mentioned === true,
    chatRef: optional(input?.chatRef),
    requesterRef: optional(input?.requesterRef),
    targetAgentId: optional(input?.targetAgentId)
  };
}

function cardAction(input) {
  const action = required(input?.action, '飞书卡片缺少决定，未执行任何动作。');
  if (!['approve', 'reject'].includes(action)) throw new FeishuChannelBridgeError('飞书卡片决定不受支持，未执行任何动作。');
  const governanceMode = required(input?.governanceMode, '飞书卡片缺少治理方式，未执行任何动作。');
  if (!['local', 'paperclip', 'proposal'].includes(governanceMode)) throw new FeishuChannelBridgeError('飞书卡片治理方式不受支持，未执行任何动作。');
  return {
    action,
    governanceMode,
    approvalId:required(input?.approvalId, '飞书卡片缺少审批编号，未执行任何动作。'),
    chatRef:optional(input?.chatRef),
    requesterRef:optional(input?.requesterRef) || 'feishu-approver'
  };
}

function required(value, message) {
  const text = optional(value);
  if (!text) throw new FeishuChannelBridgeError(message);
  return text;
}

function optional(value) { return String(value || '').trim(); }
