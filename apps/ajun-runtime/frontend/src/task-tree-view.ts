import { html, raw, escapeHtml } from './html.js';
import { formatFullDateTime, formatDuration } from './format-utils.js';
import { displaySubtaskTitle } from './task-record-presentation.js';

export interface TaskTreeOptions {
  agentName?: (id: string) => string;
}

export function renderTaskWorkflowTree(task: any = {}, options: TaskTreeOptions = {}): string {
  if (!task || !task.taskId) {
    return '<div class="task-tree-empty"><p>暂无任务协同数据</p></div>';
  }

  const agentNameFn = options.agentName || ((id: string) => id || '未知员工');
  const breadcrumb = task.workflowBreadcrumb;
  const isWorkflow = Boolean(breadcrumb && (breadcrumb.workflowId || (breadcrumb.siblings && breadcrumb.siblings.length > 0)));

  if (isWorkflow) {
    return renderMultiTaskWorkflowTree(task, breadcrumb, agentNameFn);
  }

  return renderSingleTaskBreakdownTree(task, agentNameFn);
}
export const renderTaskTreeView = renderTaskWorkflowTree;

function renderMultiTaskWorkflowTree(task: any, breadcrumb: any, agentNameFn: (id: string) => string): string {
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

  const siblings = (Array.isArray(breadcrumb.siblings) ? breadcrumb.siblings : []).map((s: any) => ({
    ...s,
    isCurrent: s.taskId === task.taskId,
  }));

  // Combine and de-duplicate
  const allTasks = siblings.some((s: any) => s.taskId === task.taskId)
    ? siblings.map((s: any) => s.taskId === task.taskId ? currentTaskItem : s)
    : [currentTaskItem, ...siblings];

  const tasksTreeHtml = allTasks.map((t: any, index: number) => {
    const isCurrent = t.isCurrent;
    const taskRef = String(t.taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    const statusTone = statusToTone(t.status);
    const statusLabel = statusToLabel(t.status);
    const agent = agentNameFn(t.assigneeAgentId);
    const duration = t.createdAt ? formatDuration(t.createdAt, t.completedAt) : '';

    const rawArtifacts = Array.isArray(t.artifactRefs) ? t.artifactRefs : [];
    const artifacts = rawArtifacts.filter((a: any) => a?.type !== 'employee_execution_report');
    const artifactsHtml = artifacts.map((art: any) => {
      const name = cleanTreeText(art?.title || art?.name || art?.type || '交付产物', 35);
      const url = art?.url || art?.downloadUrl || art?.location || art?.path || '';
      return `<div class="tree-artifact-leaf">
          <div class="tree-art-name">
            <svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-records"></use></svg>
            <span>${escapeHtml(name)}</span>
            <span class="artifact-type-tag">交付产物</span>
          </div>
          ${url ? `<button type="button" class="text-action" data-copy-path="${escapeHtml(url)}">复制路径</button>` : ''}
        </div>`;
    }).join('');

    return html`
      <div class="tree-task-node ${isCurrent ? 'is-current-task' : ''} is-${statusTone}">
        <div class="tree-node-step-index">#${index + 1}</div>
        <div class="tree-task-main">
          <div class="tree-task-header">
            <span class="tree-task-ref">#${taskRef}</span>
            <span class="tree-task-agent"><svg width="12" height="12" aria-hidden="true"><use href="#icon-employees"></use></svg> ${agent}</span>
            <span class="tree-task-status status-${statusTone}">${statusLabel}</span>
            ${raw(duration ? html`<span class="tree-task-time">${duration}</span>` : '')}
            <div class="tree-node-actions">
              ${raw(isCurrent 
                ? '<span class="tree-current-badge">当前环节</span>' 
                : `<button type="button" class="subtask-preview-btn" data-subtask-preview="${t.taskId}"><svg width="12" height="12" aria-hidden="true"><use href="#icon-records"></use></svg> 查看环节详情</button>`
              )}
            </div>
          </div>
          <div class="tree-task-title">${raw(displaySubtaskTitle(t, task))}</div>
          ${raw(artifactsHtml ? `<div class="tree-task-artifacts">${artifactsHtml}</div>` : '')}
        </div>
      </div>
    `;
  }).join('');

  return html`
    <section class="task-tree-container" aria-label="工作流协同链路">
      <div class="tree-root-header">
        <div class="tree-root-icon">
          <svg aria-hidden="true"><use href="#icon-connections"></use></svg>
        </div>
        <div class="tree-root-info">
          <div class="tree-root-eyebrow">
            ${raw(parentWorkflow ? html`<span>父工作流 #${parentWorkflow}</span><span class="tree-arrow">➔</span>` : '')}
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

function renderSingleTaskBreakdownTree(task: any, agentNameFn: (id: string) => string): string {
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
  const artifacts = rawArtifacts.filter((a: any) => a?.type !== 'employee_execution_report');
  const acceptance = task.acceptanceTarget || {};
  const decision = acceptance.decision;

  return html`
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
            ${raw(sourceUrl ? html`<p class="tree-node-text"><strong>源链接：</strong><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${cleanTreeText(sourceUrl, 50)}</a></p>` : '')}
            ${raw(input.description ? html`<p class="tree-node-text"><strong>原始诉求：</strong>${cleanTreeText(input.description, 100)}</p>` : '')}
          </div>
        </div>

        <!-- Branch 2: Execution -->
        <div class="tree-task-node is-${statusTone}">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-spark"></use></svg> 过程与开销</div>
          <div class="tree-task-main">
            <p class="tree-node-text"><strong>责任员工：</strong>${assignee} (${task.taskType || '通用'})</p>
            ${raw(duration ? html`<p class="tree-node-text"><strong>执行耗时：</strong>${duration}</p>` : '')}
            ${raw(tokens ? html`<p class="tree-node-text"><strong>吞吐量：</strong>${tokens}</p>` : '')}
          </div>
        </div>

        <!-- Branch 3: Deliverables -->
        <div class="tree-task-node ${artifacts.length ? 'is-completed' : 'is-muted'}">
          <div class="tree-branch-tag"><svg class="tree-leaf-icon" aria-hidden="true"><use href="#icon-records"></use></svg> 产物交付 (${artifacts.length})</div>
          <div class="tree-task-main">
            ${raw(artifacts.length ? artifacts.map((a: any) => `
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

function statusToTone(status: string): string {
  if (['succeeded'].includes(status)) return 'success';
  if (['failed', 'error'].includes(status)) return 'danger';
  if (['running', 'queued', 'waiting_worker'].includes(status)) return 'active';
  if (['needs_input', 'waiting_approval', 'pending_approval', 'waiting_test', 'paused'].includes(status)) return 'warning';
  return 'muted';
}

function statusToLabel(status: string): string {
  const map: Record<string, string> = {
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

function cleanTreeText(value: any, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

