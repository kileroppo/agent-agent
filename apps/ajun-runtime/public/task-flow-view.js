import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
export function renderTaskFlowPipeline(task = {}, options = {}) {
    if (!task || !task.taskId) {
        return '<div class="task-flow-empty"><p>暂无任务流程数据</p></div>';
    }
    const agentNameFn = options.agentName || ((id) => id || '未知员工');
    const presentation = task.presentation || {};
    const status = task.status || 'unknown';
    const isCompleted = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(status);
    const isSucceeded = status === 'succeeded';
    const isFailed = ['failed', 'error'].includes(status);
    const isActionNeeded = ['needs_input', 'waiting_approval', 'pending_approval', 'waiting_test', 'paused', 'blocked'].includes(status);
    const isRunning = ['running', 'queued', 'waiting_worker', 'pausing'].includes(status);
    // 1. Origin Node
    const input = task.input || {};
    const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
    const originChannel = task.paperclipIssue ? 'Paperclip' : (input.channel || (sourceUrl ? '外部链接' : '飞书'));
    const originTime = formatFullDateTime(task.createdAt);
    const originSummary = sourceUrl
        ? cleanFlowText(sourceUrl.replace(/^https?:\/\/(www\.)?/, ''), 28)
        : cleanFlowText(input.description || input.title || '用户指令', 28);
    // 2. Assignee / Routing Node
    const assignee = agentNameFn(task.assigneeAgentId);
    const taskTypeLabel = cleanFlowText(task.taskType || '通用任务', 20);
    // 3. Execution & Cost Node
    const cost = task.costAttribution || {};
    const duration = task.createdAt
        ? formatDuration(task.createdAt, task.completedAt || (isCompleted ? task.updatedAt : null))
        : '';
    const tokenInfo = (cost.inputTokens || cost.outputTokens)
        ? `${Math.round((cost.inputTokens + cost.outputTokens) / 100) / 10}k Tokens`
        : '';
    const costSummary = [duration, tokenInfo].filter(Boolean).join(' · ') || (isRunning ? '正在执行' : '已就绪');
    // 4. Deliverables Node
    const artifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const artifactCount = artifacts.length;
    const artifactSummary = artifactCount > 0
        ? (artifacts[0]?.title || artifacts[0]?.name || artifacts[0]?.type || `${artifactCount} 项产物`).replace(/_/g, ' ')
        : (isSucceeded ? '产物已归档' : (isRunning ? '等待生成' : '无产物'));
    // 5. Acceptance Node
    const acceptance = task.acceptanceTarget || {};
    const decision = acceptance.decision;
    const acceptanceLabel = decision === 'accepted'
        ? '已采纳 (有用)'
        : decision === 'revision_required'
            ? '已标记需改进'
            : (isSucceeded ? '待验收' : (isFailed ? '未完成' : '流转中'));
    const acceptanceTone = decision === 'accepted' ? 'success' : (decision === 'revision_required' ? 'warning' : (isSucceeded ? 'attention' : 'muted'));
    const nodes = [
        {
            key: 'origin',
            stepNum: 1,
            badge: originChannel,
            title: '源头诉求',
            desc: originSummary || '任务输入',
            meta: originTime ? `创建于 ${originTime.slice(5, 16)}` : '已登记',
            icon: originChannel === 'Paperclip' ? 'shield' : 'message',
            status: 'completed',
            active: options.activeNode === 'origin',
        },
        {
            key: 'routing',
            stepNum: 2,
            badge: assignee,
            title: '指派执行',
            desc: taskTypeLabel,
            meta: isRunning ? '处理中' : '已指派',
            icon: 'employees',
            status: isRunning ? 'active' : 'completed',
            active: options.activeNode === 'routing',
        },
        {
            key: 'execution',
            stepNum: 3,
            badge: duration ? `${duration}` : (isRunning ? '执行中' : '就绪'),
            title: '过程开销',
            desc: costSummary,
            meta: isFailed ? '执行中断' : (isRunning ? '计算中' : '执行完成'),
            icon: isFailed ? 'alert' : 'spark',
            status: isFailed ? 'danger' : (isRunning ? 'active' : 'completed'),
            active: options.activeNode === 'execution',
        },
        {
            key: 'deliverables',
            stepNum: 4,
            badge: `${artifactCount} 产物`,
            title: '交付成果',
            desc: cleanFlowText(artifactSummary, 26),
            meta: isSucceeded ? '已就绪' : (isRunning ? '生成中' : '待交付'),
            icon: 'target',
            status: artifactCount > 0 ? 'completed' : (isSucceeded ? 'completed' : (isRunning ? 'active' : 'muted')),
            active: options.activeNode === 'deliverables',
        },
        {
            key: 'acceptance',
            stepNum: 5,
            badge: acceptanceLabel,
            title: '业务验收',
            desc: decision ? (decision === 'accepted' ? '满意闭环' : '需改进') : (isSucceeded ? '请确认结果' : '等待完成'),
            meta: decision ? '已归档' : (isSucceeded ? '待确认' : '未到环节'),
            icon: decision === 'accepted' ? 'check' : (isSucceeded ? 'clock' : 'shield'),
            status: acceptanceTone,
            active: options.activeNode === 'acceptance',
        },
    ];
    const nodesHtml = nodes.map((node, index) => {
        const isLast = index === nodes.length - 1;
        const nodeStatusClass = `is-${node.status}`;
        const activeClass = node.active ? 'is-selected' : '';
        return html `
      <div class="flow-step ${nodeStatusClass} ${activeClass}" data-flow-node="${node.key}" tabindex="0" role="button" aria-label="${node.title}">
        <div class="flow-node-header">
          <span class="flow-node-badge">${node.badge}</span>
          <span class="flow-node-num">#${node.stepNum}</span>
        </div>
        <div class="flow-node-body">
          <div class="flow-node-icon-wrapper">
            <svg class="flow-node-icon" aria-hidden="true"><use href="#icon-${node.icon}"></use></svg>
          </div>
          <div class="flow-node-content">
            <strong class="flow-node-title">${node.title}</strong>
            <p class="flow-node-desc" title="${escapeHtml(node.desc)}">${node.desc}</p>
            <span class="flow-node-meta">${node.meta}</span>
          </div>
        </div>
      </div>
      ${raw(!isLast ? `<div class="flow-connector ${nodeStatusClass}"><svg viewBox="0 0 24 24" class="flow-arrow" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` : '')}
    `;
    }).join('');
    return html `
    <section class="task-flow-container" aria-label="任务全链路流程图">
      <div class="task-flow-pipeline">
        ${raw(nodesHtml)}
      </div>
      <div class="task-flow-tips">
        <span>💡 点击上方节点可联动聚焦对应阶段事实</span>
      </div>
    </section>
  `;
}
function cleanFlowText(value, limit) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
