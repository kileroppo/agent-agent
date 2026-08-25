import { html } from './html.js';
export function createEmployeeView({ directEmployeeTaskTypes, presentTaskTypeLabel, getAgents }) {
    function isDirectEmployee(agent) {
        return agent.acceptedTaskTypes?.some((type) => directEmployeeTaskTypes.includes(type));
    }
    function isPrimaryEmployee(agent) {
        return agent.agentId === 'ajun' || isDirectEmployee(agent) || agent.capabilityTruth?.overall === 'human_accepted';
    }
    function agentGroupTitle(title, detail) {
        const node = document.createElement('div');
        node.className = 'agent-group-title';
        node.innerHTML = html `<strong>${title}</strong><span>${detail}</span>`;
        return node;
    }
    function agentCard(agent, support) {
        const node = document.createElement('article');
        node.className = `agent${support ? ' support-agent' : ''}`;
        const types = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · ');
        const summaryTypes = agent.acceptedTaskTypes.slice(0, 2).map(taskTypeLabel).join(' · ') || '职责待核对';
        const independent = independentRuntimeLabel(agent);
        const truth = capabilityTruthLabel(agent.capabilityTruth);
        node.innerHTML = html `
    <details class="agent-disclosure" data-disclosure-key="agent:${agent.agentId}">
      <summary>
        <span class="agent-avatar">${agent.name.slice(0, 1)}</span>
        <span class="agent-summary-copy">
          <strong>${agent.name}</strong>
          <small>${summaryTypes}</small>
        </span>
        <span class="status ${agent.status}">${truth}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="agent-body">
        <p>${agent.role}</p>
        <p>${types}</p>
        <p>${independent}</p>
      </div>
    </details>`;
        return node;
    }
    function backgroundEmployeeDisclosure(agents) {
        const node = document.createElement('details');
        node.className = 'background-employees-disclosure';
        node.dataset.disclosureKey = 'employees:background';
        const title = agents.some((agent) => agent.capabilityTruth?.overall !== 'human_accepted')
            ? '后台岗位与待人工验收'
            : '后台岗位';
        node.innerHTML = html `<summary><span><strong>${title}</strong><small>${agents.length} 位，不是日常派活入口</small></span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="agent-grid background-agent-grid"></div>`;
        node.querySelector('.background-agent-grid')?.replaceChildren(...agents.map((agent) => agentCard(agent, true)));
        return node;
    }
    function capabilityTruthLabel(value) {
        return { human_accepted: '已验收', verified: '已验证', live: '在线待验证', configured: '已配置', declared: '仅登记', not_declared: '未接入' }[value?.overall] || '待核对';
    }
    function independentRuntimeLabel(agent) {
        const state = agent.independentRuntime?.state;
        if (state === 'model_pending')
            return '岗位已定义，正在配置独立大脑';
        if (state === 'model_transport_pending')
            return '独立身份已建立，模型授权和真实调用待完成';
        const channel = agent.feishuChannel;
        if (channel?.status === 'external' && channel?.verified === true)
            return '独立 Hermes 员工已完成真实任务与连续追问';
        if (channel?.status === 'external')
            return '独立 Hermes 飞书入口已接管，待真实消息验证';
        if (channel?.verified === true)
            return '独立飞书入口已完成真实任务收发';
        if (channel?.status === 'connected')
            return '独立飞书入口已连接，待真实消息验证';
        if (channel?.status === 'connecting')
            return '独立飞书入口正在连接';
        if (channel?.status === 'failed')
            return `独立飞书入口未连接：${channel.message}`;
        if (channel?.status === 'disabled')
            return `独立飞书入口未启用：${channel.message}`;
        return {
            ready: '已独立接通',
            channel_pending: '模型调用已验证，飞书入口待接通',
            waiting_verification: '独立入口待真实验证',
            not_created: '独立身份尚未创建',
            missing_profile: '独立身份资料缺失',
            invalid_reference: '独立身份资料无效',
            not_declared: '目前由 A君统一代管'
        }[state] || (agent.source === 'approved-proposal' ? '通过限定试用，由 A君统一代管' : '状态待核对');
    }
    function taskTypeLabel(type) {
        return presentTaskTypeLabel(type, getAgents());
    }
    return {
        isDirectEmployee,
        isPrimaryEmployee,
        agentGroupTitle,
        agentCard,
        backgroundEmployeeDisclosure,
        capabilityTruthLabel,
        independentRuntimeLabel,
        taskTypeLabel,
    };
}
