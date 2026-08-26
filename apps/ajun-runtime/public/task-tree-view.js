import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { displaySubtaskTitle } from './task-record-presentation.js';
export function renderTaskWorkflowTree(task = {}, options = {}) {
    if (!task || !task.taskId) {
        return '<div class="task-tree-empty"><p>暂无任务协同数据</p></div>';
    }
    const agentNameFn = options.agentName || ((id) => id || '未知员工');
    const breadcrumb = task.workflowBreadcrumb;
    const isWorkflow = Boolean(breadcrumb && (breadcrumb.workflowId || (breadcrumb.siblings && breadcrumb.siblings.length > 0)));
    if (isWorkflow) {
        return renderMultiTaskWorkflowTree(task, breadcrumb, agentNameFn);
    }
    return renderSingleTaskBreakdownTree(task, agentNameFn);
}
export const renderTaskTreeView = renderTaskWorkflowTree;
function renderMultiTaskWorkflowTree(task, breadcrumb, agentNameFn) {
    const workflowId = breadcrumb.workflowId || 'WF-MAIN';
    const workflowLabel = workflowId.slice(0, 10).toUpperCase();
    const parentWorkflow = breadcrumb.parentWorkflowId
        ? breadcrumb.parentWorkflowId.slice(0, 10).toUpperCase()
        : null;
    const currentTaskItem = {
        taskId: task.taskId,
        title: task.input?.title || task.title || '当前任务',
        status: task.status || 'unknown',
        assigneeAgentId: task.assigneeAgentId,
        createdAt: task.createdAt,
        completedAt: task.completedAt || task.updatedAt,
        isCurrent: true,
        artifactRefs: task.artifactRefs || [],
    };
    const siblings = (Array.isArray(breadcrumb.siblings) ? breadcrumb.siblings : []).map((s) => ({
        ...s,
        isCurrent: s.taskId === task.taskId,
    }));
    // Combine and de-duplicate
    const allTasks = siblings.some((s) => s.taskId === task.taskId)
        ? siblings.map((s) => s.taskId === task.taskId ? currentTaskItem : s)
        : [currentTaskItem, ...siblings];
    const tasksTreeHtml = allTasks.map((t, index) => {
        const isCurrent = t.isCurrent;
        const taskRef = String(t.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
        const statusTone = statusToTone(t.status);
        const statusLabel = statusToLabel(t.status);
        const agent = agentNameFn(t.assigneeAgentId);
        const duration = t.createdAt ? formatDuration(t.createdAt, t.completedAt) : '';
        const rawArtifacts = Array.isArray(t.artifactRefs) ? t.artifactRefs : [];
        const artifacts = rawArtifacts.filter((a) => {
            const type = String(a?.type || '');
            const title = String(a?.title || a?.name || '');
            return !/employee_(?:execution_|role_)?report|agent_audit|role_draft/i.test(type)
                && !/员工岗位回报|执行审计|岗位草案/i.test(title);
        });
        const artifactsHtml = artifacts.map((art) => {
            const name = cleanTreeText(art?.title || art?.name || art?.type || '交付产物', 35);
            const url = String(art?.url || art?.downloadUrl || art?.location || art?.path || '').trim();
            const isHttp = /^https?:\/\//i.test(url);
            const isRealFilePath = /^(?:\/|[a-zA-Z]:[/\\]|file:\/\/)/.test(url) && !url.startsWith('runtime://');
            const rawSummary = art?.summary || art?.description || art?.data?.summary || art?.data?.conclusion || (typeof art?.data?.text === 'string' ? art?.data.text : '');
            const summary = typeof rawSummary === 'string' ? rawSummary.slice(0, 300).trim() : '';
            return `<div class="tree-artifact-leaf">
          <div class="tree-art-name">
            <svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-records"></use></svg>
            <span>${escapeHtml(name)}</span>
            <span class="artifact-type-tag">交付产物</span>
          </div>
          <div class="tree-art-actions">
            ${isHttp ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-action">打开查看 ↗</a>` : ''}
            ${isRealFilePath ? `<button type="button" class="text-action" data-copy-path="${escapeHtml(url)}">复制路径</button>` : ''}
            ${!isRealFilePath && summary ? `<button type="button" class="text-action" data-copy-text="${escapeHtml(summary)}">复制内容</button>` : ''}
          </div>
        </div>`;
        }).join('');
        return html `
      <div class="tree-task-node ${isCurrent ? 'is-current-task' : ''} is-${statusTone}">
        <div class="tree-node-step-index">#${index + 1}</div>
        <div class="tree-task-main">
          <div class="tree-task-header">
            ${raw(isCurrent
            ? html `<span class="tree-task-ref is-current" title="当前环节编号">#${taskRef}</span>`
            : html `<button type="button" class="tree-task-ref-btn" data-subtask-preview="${t.taskId}" title="点击编号直接查看该环节详情">#${taskRef} ↗</button>`)}
            <span class="tree-task-title-badge">${raw(displaySubtaskTitle(t, task))}</span>
            <span class="tree-task-agent"><svg width="12" height="12" aria-hidden="true"><use href="#icon-employees"></use></svg> ${agent}</span>
            <span class="tree-task-status status-${statusTone}">${statusLabel}</span>
            ${raw(duration ? html `<span class="tree-task-time">${duration}</span>` : '')}
            ${raw(isCurrent ? '<span class="tree-current-badge">当前环节</span>' : '')}
          </div>
          ${raw(artifactsHtml ? `<div class="tree-task-artifacts">${artifactsHtml}</div>` : '')}
        </div>
      </div>
    `;
    }).join('');
    return html `
    <section class="task-tree-container" aria-label="工作流协同链路">
      <div class="tree-root-header">
        <div class="tree-root-icon">
          <svg aria-hidden="true"><use href="#icon-connections"></use></svg>
        </div>
        <div class="tree-root-info">
          <div class="tree-root-eyebrow">
            ${raw(parentWorkflow ? html `<span>父工作流 #${parentWorkflow}</span><span class="tree-arrow">➔</span>` : '')}
            <span>多 Agent 协作工作流</span>
          </div>
          <h3 class="tree-root-title">#${workflowLabel} · 共 ${allTasks.length} 个协作环节</h3>
          <p class="tree-root-desc">本任务由团队中多位 AI 员工分工配合完成。点击任意环节的<strong>「查看环节详情」</strong>即可在右侧查看该步骤成果与诉求，无需离开当前页面。</p>
        </div>
      </div>
      <div class="tree-branches">
        ${raw(tasksTreeHtml)}
      </div>
    </section>
  `;
}
function renderSingleTaskBreakdownTree(task, agentNameFn) {
    const taskRef = String(task.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    const title = task.input?.title || task.title || '任务全貌';
    const status = task.status || 'unknown';
    const statusTone = statusToTone(status);
    const statusLabel = statusToLabel(status);
    const assignee = agentNameFn(task.assigneeAgentId);
    const duration = task.createdAt ? formatDuration(task.createdAt, task.completedAt || task.updatedAt) : '';
    const input = task.input || {};
    const sourceUrl = input.sourceUrl || (Array.isArray(input.sourceUrls) ? input.sourceUrls[0] : null);
    const sourceTime = formatFullDateTime(task.createdAt);
    const cost = task.costAttribution || {};
    const tokens = (cost.inputTokens || cost.outputTokens)
        ? `输入 ${cost.inputTokens} / 输出 ${cost.outputTokens} Tokens`
        : '';
    const rawArtifacts = Array.isArray(task.artifactRefs) ? task.artifactRefs : [];
    const artifacts = rawArtifacts.filter((a) => a?.type !== 'employee_execution_report');
    const acceptance = task.acceptanceTarget || {};
    const decision = acceptance.decision;
    return html `
    <section class="task-tree-container" aria-label="任务解构树">
      <div class="tree-root-header">
        <div class="tree-root-icon is-${statusTone}">
          <svg aria-hidden="true"><use href="#icon-target"></use></svg>
        </div>
        <div>
          <div class="tree-root-eyebrow">
            <span class="tree-task-ref">#${taskRef}</span>
            <span>${assignee}</span>
            <span class="tree-task-status status-${statusTone}">${statusLabel}</span>
          </div>
          <h3 class="tree-root-title">${cleanTreeText(title, 60)}</h3>
        </div>
      </div>

      <div class="tree-branches single-task-breakdown">
        <!-- Branch 1: Origin -->
        <div class="tree-task-node is-completed">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-message"></use></svg> 源头与输入</div>
          <div class="tree-task-main">
            <p class="tree-node-text"><strong>时间：</strong>${sourceTime}</p>
            ${raw(sourceUrl ? html `<p class="tree-node-text"><strong>源链接：</strong><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${cleanTreeText(sourceUrl, 50)}</a></p>` : '')}
            ${raw(input.description ? html `<p class="tree-node-text"><strong>原始诉求：</strong>${cleanTreeText(input.description, 100)}</p>` : '')}
          </div>
        </div>

        <!-- Branch 2: Execution -->
        <div class="tree-task-node is-${statusTone}">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-spark"></use></svg> 过程与开销</div>
          <div class="tree-task-main">
            <p class="tree-node-text"><strong>责任员工：</strong>${assignee} (${task.taskType || '通用'})</p>
            ${raw(duration ? html `<p class="tree-node-text"><strong>执行耗时：</strong>${duration}</p>` : '')}
            ${raw(tokens ? html `<p class="tree-node-text"><strong>吞吐量：</strong>${tokens}</p>` : '')}
          </div>
        </div>

        <!-- Branch 3: Deliverables -->
        <div class="tree-task-node ${artifacts.length ? 'is-completed' : 'is-muted'}">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-records"></use></svg> 产物交付 (${artifacts.length})</div>
          <div class="tree-task-main">
            ${raw(artifacts.length ? artifacts.map((a) => `
              <div class="tree-artifact-leaf">
                <svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-check"></use></svg>
                <span>${escapeHtml(cleanTreeText(a.title || a.name || a.type || '交付文件', 40))}</span>
              </div>
            `).join('') : '<p class="tree-node-empty">暂无产物生成</p>')}
          </div>
        </div>

        <!-- Branch 4: Acceptance -->
        <div class="tree-task-node ${decision === 'accepted' ? 'is-success' : 'is-attention'}">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-shield"></use></svg> 业务验收闭环</div>
          <div class="tree-task-main">
            <p class="tree-node-text"><strong>状态：</strong>${decision === 'accepted' ? '已确认有用 (满意闭环)' : (decision === 'revision_required' ? '已标记需改进' : '待人工验收')}</p>
          </div>
        </div>
      </div>
    </section>
  `;
}
function statusToTone(status) {
    if (['succeeded'].includes(status))
        return 'success';
    if (['failed', 'error'].includes(status))
        return 'danger';
    if (['running', 'queued', 'waiting_worker'].includes(status))
        return 'active';
    if (['needs_input', 'waiting_approval', 'pending_approval', 'waiting_test', 'paused'].includes(status))
        return 'warning';
    return 'muted';
}
function statusToLabel(status) {
    const map = {
        succeeded: '已完成',
        failed: '未完成',
        running: '处理中',
        queued: '排队中',
        waiting_approval: '等待确认',
        pending_approval: '等待确认',
        waiting_test: '待验证',
        needs_input: '等待补充',
        paused: '已暂停',
        cancelled: '已关闭',
    };
    return map[status] || status || '更新中';
}
function cleanTreeText(value, limit) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
