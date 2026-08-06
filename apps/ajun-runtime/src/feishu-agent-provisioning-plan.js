/**
 * Produces a safe, owner-reviewable draft for Feishu's official one-click app
 * creation flow. It never calls Feishu and never contains credentials.
 */
export class FeishuAgentProvisioningPlanner {
  plan(agent, { collaborationGroup = false, existingApp = false } = {}) {
    validateAgent(agent);
    if (agent.status !== 'active') {
      throw new FeishuAgentProvisioningPlanError('岗位尚未上岗，不能创建飞书智能体应用。');
    }

    const capabilities = ['私聊接收工作', '原聊天回复结果', '审批卡片按钮'];
    const events = ['im.message.receive_v1', 'card.action.trigger'];
    if (collaborationGroup) {
      capabilities.push('协作群内被 @ 后接力处理');
      events.push('im.message.group_at_msg.include_bot');
    }

    return {
      kind: 'feishu_agent_app_draft',
      agent: { agentId: agent.agentId, name: agent.name, role: agent.role },
      status: 'owner_review_required',
      nextAction: existingApp ? '准备更新已有飞书应用，等待负责人扫码确认。' : '准备创建独立飞书应用，等待负责人扫码确认。',
      externalActionTaken: false,
      requestedCapabilities: capabilities,
      requiredEvents: events,
      registerApp: feishuRegisterAppOptions(agent, { collaborationGroup }),
      requiredPermissions: collaborationGroup
        ? ['读取机器人在协作群中被 @ 的消息', '读取协作群内机器人基础信息']
        : ['读取用户发给机器人的消息'],
      callback: 'card.action.trigger',
      safety: [
        '只按这名员工的真实工作范围申请最小权限。',
        '不包含应用凭据、用户标识或聊天内容。',
        '扫码确认前不会创建或更新外部飞书应用。',
        '创建后仍须通过一条真实工作验收，才可对用户开放。'
      ]
    };
  }
}

export class FeishuAgentProvisioningPlanError extends Error {}

function validateAgent(agent) {
  if (!agent || typeof agent !== 'object' || !String(agent.agentId || '').trim() || !String(agent.name || '').trim()) {
    throw new FeishuAgentProvisioningPlanError('员工资料不完整，不能准备飞书应用草案。');
  }
}

export function feishuRegisterAppOptions(agent, { collaborationGroup = false } = {}) {
  const events = ['im.message.receive_v1'];
  const scopes = ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'];
  if (collaborationGroup) {
    events.push('im.message.group_at_msg:readonly');
    scopes.push('im:message.group_at_msg:readonly');
  }
  return {
    createOnly:true,
    appPreset:{ name:agent.name, desc:agent.role },
    addons:{
      preset:false,
      scopes:{ tenant:scopes },
      events:{ items:{ tenant:events } },
      callbacks:{ items:['card.action.trigger'] }
    }
  };
}
