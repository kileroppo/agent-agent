import {
  markSyncStarted,
  replaceChildrenPreservingDisclosureState,
  setTextIfChanged,
} from './disclosure-state.js';
import { createConsoleNavigation } from './console-navigation.js';
import { createAccessViews } from './app-access-views.js';
import { bindConsoleInteractions } from './app-interactions.js';
import { createBoomMonitorConsole } from './boom-monitor-console.js';

const capabilityList = document.querySelector('#capability-list');
const agentList = document.querySelector('#agent-list');
const taskList = document.querySelector('#task-list');
const recentTaskList = document.querySelector('#recent-task-list');
const overviewStats = document.querySelector('#overview-stats');
const overviewSummary = document.querySelector('#overview-summary');
const taskCount = document.querySelector('#task-count');
const taskSearch = document.querySelector('#task-search');
const taskLoadMore = document.querySelector('#task-load-more');
const focusPanel = document.querySelector('#focus-panel');
const capabilitySummary = document.querySelector('#capability-summary');
const accessGate = document.querySelector('#access-gate');
const accessForm = document.querySelector('#access-form');
const accessKey = document.querySelector('#access-key');
const collaboratorName = document.querySelector('#collaborator-name');
const accessMessage = document.querySelector('#access-message');
const shareInfo = document.querySelector('#share-info');
const rotateShareKey = document.querySelector('#rotate-share-key');
const shareMessage = document.querySelector('#share-message');
const syncStatus = document.querySelector('#sync-status');
const syncIndicator = document.querySelector('#sync-indicator');
const employeeConnections = document.querySelector('#employee-connections');
const employeeConnectionList = document.querySelector('#employee-connection-list');
const accessConnections = document.querySelector('#access-connections');
const aiControl = document.querySelector('#ai-control');
const aiServiceList = document.querySelector('#ai-service-list');
const aiControlMessage = document.querySelector('#ai-control-message');
const aiRoutingList = document.querySelector('#ai-routing-list');
const refreshAiControl = document.querySelector('#refresh-ai-control');
const accessConnectionList = document.querySelector('#access-connection-list');
const accessConnectionMessage = document.querySelector('#access-connection-message');
const contentAccessSummary = document.querySelector('#content-access-summary');
const accessLoginDisclosure = document.querySelector('#access-login-disclosure');
const accessLoginForm = document.querySelector('#access-login-form');
const accessLoginProvider = document.querySelector('#access-login-provider');
const accessLoginAlias = document.querySelector('#access-login-alias');
const accessLoginAccount = document.querySelector('#access-login-account');
const accessLoginMessage = document.querySelector('#access-login-message');
const openPlatformLogin = document.querySelector('#open-platform-login');
const refreshLoginAccounts = document.querySelector('#refresh-login-accounts');
const saveAccessConnection = document.querySelector('#save-access-connection');
const cancelAccessReauthorize = document.querySelector('#cancel-access-reauthorize');
const campaignList = document.querySelector('#campaign-list');
const campaignMessage = document.querySelector('#campaign-message');
const moduleLinks = [...document.querySelectorAll('[data-module]')];
const modulePages = [...document.querySelectorAll('[data-module-page]')];
const ownerOnlyElements = [...document.querySelectorAll('[data-owner-only]')];
const taskFilterButtons = [...document.querySelectorAll('[data-task-filter]')];
const accessStepPanels = [...document.querySelectorAll('[data-access-step-panel]')];
const accessStepIndicators = [...document.querySelectorAll('[data-access-step-indicator]')];
const accessStepNext2 = document.querySelector('#access-step-next-2');
const accessStepNext3 = document.querySelector('#access-step-next-3');
const accessStepBack1 = document.querySelector('#access-step-back-1');
const accessStepBack2 = document.querySelector('#access-step-back-2');

const taskLabels = {
  'army.intake': '先让 A君判断下一步',
  'army.route-task': '任务路由',
  'army.cross-agent-mission': 'A君：多人任务统筹',
  'media.transcribe-and-refine': '小D：转录并整理素材',
  'report.public-material': '小R：公开网页摘要',
  'research.github-search': '小R：公开 GitHub 检索',
  'research.intel-report': '小R：公开资料研究',
  'office.briefing-package': '办公执行助理：汇报包',
  'office.presentation-package': '小办：演示文稿',
  'office.knowledge-summary': '小办：知识归档',
  'content.video-benchmark-analysis': '小拆：视频内容拆解',
  'content.performance-review': '小拆：内容表现复盘',
  'content.platform-draft': '小创：平台内容草稿',
  'content.video-script-package': '小创：可拍视频脚本',
  'operations.health-review': '运维官：本机健康检查',
  'governance.approval-review': '审核官：范围与风险审查',
  'governance.architecture-review': '架构师：能力评估'
};

const statusLabels = {
  active: '可用',
  ready: '可用',
  local: '本机可用',
  waiting: '等待连接',
  blocked: '尚未配置',
  not_configured: '未接线',
  not_ready: '未就绪',
  pending_authorization: '待授权',
  verified: '已验证',
  connected: '已连接',
  external: 'Hermes 已接管',
  connecting: '连接中',
  disabled: '未启用',
  expiring: '即将到期',
  expired: '已到期',
  revoked: '已撤销',
  error: '需检查',
  unavailable: '暂不可用',
  partial: '部分完成',
  planned: '待准备',
  draft: '草案中',
  pending_approval: '等待审核',
  waiting_approval: '等待确认',
  waiting_worker: '等待 Mac',
  waiting_test: '待测试',
  queued: '等待开始',
  running: '处理中',
  pausing: '正在暂停',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '未完成',
  needs_input: '等待补充',
  cancelled: '已关闭',
  rejected: '已拒绝',
  stopped: '已停止'
};

const directEmployeeTaskTypes = [
  'media.transcribe-and-refine',
  'report.public-material',
  'research.intel-report',
  'office.briefing-package',
  'office.presentation-package'
];
const completedTaskStatuses = new Set(['succeeded', 'cancelled', 'rejected']);
const attentionTaskStatuses = new Set([
  'failed',
  'needs_input',
  'pending_approval',
  'waiting_approval',
  'waiting_test',
  'paused',
  'blocked',
  'error'
]);
const ownerOnlyModules = new Set(['connections', 'campaigns', 'boom-monitor']);
let boomMonitor;

function taskIdFromPath(pathname) {
  return pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}

const state = {
  overview:undefined,
  selectedTaskRevealed:false,
  shareKey:sessionStorage.getItem('ajun-share-key') || '',
  requesterName:sessionStorage.getItem('ajun-requester-name') || '',
  localOwner:false,
  loading:false,
  currentTaskFilter:'',
  taskSearchQuery:'',
  visibleTaskCount:24,
  accessLoginOptions:{ providers:[], accounts:[] },
  reauthorizeConnectionId:'',
};

const selectedTaskId = taskIdFromPath(location.pathname);
const moduleNavigation = createConsoleNavigation({
  selectedTaskId,
  getHash:() => location.hash,
  activate:activateModule,
});

state.currentTaskFilter = selectedTaskId ? 'all' : 'attention';

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.shareKey) headers.set('x-ajun-share-key', state.shareKey);
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail || payload.error || '请求失败。');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setSyncStatus(message, state) {
  syncStatus.textContent = message;
  syncIndicator.className = `sync-indicator ${state}`;
}

async function load({ background = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  markSyncStarted(syncIndicator, { background });
  try {
    state.overview = await api('/api/overview');
    accessGate.hidden = true;
    document.body.classList.remove('access-required');
    await accessViews.renderLocalShare();
    render();
    updateOwnerNavigation();
    moduleNavigation.initialize();
    setSyncStatus(`已同步 · ${new Date().toLocaleTimeString()}`, 'synced');
    document.body.classList.remove('is-loading');
  } catch (error) {
    if (error.status === 401) {
      accessGate.hidden = false;
      accessMessage.textContent = error.message;
      document.body.classList.add('access-required');
      setSyncStatus('等待共享口令', 'waiting');
      return;
    }
    setSyncStatus('同步暂不可用', 'error');
    throw error;
  } finally {
    state.loading = false;
  }
}

function updateOwnerNavigation() {
  for (const element of ownerOnlyElements) element.hidden = !state.localOwner;
  if (!state.localOwner && ownerOnlyModules.has(location.hash.slice(1))) activateModule('overview', { replaceHash: true });
}

function activateModule(name, { replaceHash = false } = {}) {
  const requested = modulePages.some((page) => page.dataset.modulePage === name) ? name : 'overview';
  const selected = ownerOnlyModules.has(requested) && !state.localOwner ? 'overview' : requested;
  for (const link of moduleLinks) {
    const active = link.dataset.module === selected;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const page of modulePages) {
    const active = page.dataset.modulePage === selected;
    page.classList.toggle('is-active', active);
    page.setAttribute('aria-hidden', String(!active));
  }
  document.title = `${moduleTitle(selected)} · A君运行台`;
  if (selected === 'boom-monitor') boomMonitor?.activate();
  if (replaceHash && location.hash !== `#${selected}`) history.replaceState(null, '', `#${selected}`);
}

function moduleTitle(name) {
  return ({ overview: '总览', employees: '员工', connections: '账号与接入', campaigns:'发布活动', 'boom-monitor':'爆款雷达', records: '任务记录' })[name] || '总览';
}


function render() {
  renderFocus(state.overview.taskFocus);
  renderOverviewStats();
  capabilityList.replaceChildren(...state.overview.capabilities.map((item) => capabilityCard(item)));
  const readyCapabilities = state.overview.capabilities.filter((item) => ['ready', 'active', 'connected', 'verified'].includes(item.status)).length;
  const limitedCapabilities = state.overview.capabilities.length - readyCapabilities;
  capabilitySummary.textContent = `${readyCapabilities} 项已就绪${limitedCapabilities ? ` · ${limitedCapabilities} 项受限或待准备` : ''}`;
  const directEmployees = state.overview.alwaysOnAgents?.length ? state.overview.alwaysOnAgents : state.overview.agents.filter(isDirectEmployee);
  const supportEmployees = state.overview.onDemandAgents?.length ? state.overview.onDemandAgents : state.overview.agents.filter((agent) => !isDirectEmployee(agent));
  replaceChildrenPreservingDisclosureState(agentList, [
    agentGroupTitle('常驻员工', '保持飞书入口或后台巡检常驻'),
    ...directEmployees.map((agent) => agentCard(agent, false)),
    agentGroupTitle('后台按需能力', '不常驻飞书入口，由 A君或 Paperclip 按任务唤醒'),
    ...supportEmployees.map((agent) => agentCard(agent, true))
  ]);
  renderTaskLists();
}

function renderOverviewStats() {
  const focus = state.overview.taskFocus || {};
  const active = Number.isFinite(focus.inProgress) ? focus.inProgress : 0;
  const ownerActionable = Number.isFinite(focus.ownerActionable) ? focus.ownerActionable : (focus.next ? 1 : 0);
  const readyAgents = state.overview.agents.filter((agent) => ['active', 'ready', 'external', 'connected', 'verified'].includes(agent.status)).length;
  overviewSummary.textContent = ownerActionable
    ? `${ownerActionable} 件事需要你决定。`
    : active
      ? `${active} 项工作正在推进，你暂时不用处理。`
      : '当前没有必须处理的事。';
  const cards = [
    statCard('需要你', ownerActionable, ownerActionable ? '打开上方下一步处理' : '目前无需决定', 'target', ownerActionable > 0),
    statCard('正在处理', active, active ? '系统会继续推进' : '没有执行中的工作', 'clock'),
    statCard('可用员工', `${readyAgents}/${state.overview.agents.length}`, '正式岗位，不含系统控制器', 'employees')
  ];
  overviewStats.replaceChildren(...cards);
}

function statCard(label, value, note, icon, attention = false) {
  const node = document.createElement('article');
  node.className = `stat-card${attention ? ' attention' : ''}`;
  node.innerHTML = `<div class="stat-card-head"><span>${escapeHtml(label)}</span><span class="stat-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span></div><strong class="stat-value">${escapeHtml(value)}</strong><span class="stat-note">${escapeHtml(note)}</span>`;
  return node;
}

function renderTaskLists() {
  const tasks = state.overview.tasks || [];
  const normalizedQuery = state.taskSearchQuery.toLocaleLowerCase('zh-CN');
  const filtered = tasks.filter((task) =>
    selectedTaskId
      ? task.taskId === selectedTaskId
      : state.currentTaskFilter === 'all' || taskStatusGroup(task.status) === state.currentTaskFilter
  ).filter((task) => !normalizedQuery || [
    task.input?.title,
    task.taskId,
    agentName(task.assigneeAgentId),
    taskTypeLabel(task.taskType),
    statusLabel(task.status)
  ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(normalizedQuery)));
  const shown = selectedTaskId ? filtered : filtered.slice(0, state.visibleTaskCount);
  taskCount.textContent = filtered.length > shown.length ? `显示 ${shown.length}/${filtered.length} 条` : `${filtered.length} 条`;
  const taskNodes = !filtered.length
    ? [...document.querySelector('#empty').content.cloneNode(true).childNodes]
    : shown.map(taskCard);
  replaceChildrenPreservingDisclosureState(taskList, taskNodes);
  if (filtered.length && selectedTaskId && !state.selectedTaskRevealed) {
    state.selectedTaskRevealed = true;
    requestAnimationFrame(() => taskList.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.scrollIntoView({ block:'center' }));
  }
  taskLoadMore.hidden = Boolean(selectedTaskId) || shown.length >= filtered.length;
  if (!taskLoadMore.hidden) taskLoadMore.textContent = `再显示 ${Math.min(24, filtered.length - shown.length)} 条`;
  updateTaskFilterCounts(tasks);
  renderRecentTasks(tasks.filter(isRecentOwnerTask).slice(0, 3));
}

function updateTaskFilterCounts(tasks) {
  const labels = { attention:'待复盘', active:'进行中', completed:'已结束', all:'全部' };
  for (const button of taskFilterButtons) {
    const filter = button.dataset.taskFilter;
    const count = filter === 'all' ? tasks.length : tasks.filter((task) => taskStatusGroup(task.status) === filter).length;
    const active = filter === state.currentTaskFilter;
    button.textContent = `${labels[filter]} ${count}`;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderRecentTasks(tasks) {
  recentTaskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = '暂无记录';
    recentTaskList.append(empty);
    return;
  }
  recentTaskList.append(...tasks.map((task) => {
    const item = document.createElement('div');
    item.className = 'recent-task';
    const attention = taskStatusGroup(task.status) === 'attention';
    item.innerHTML = `<span class="recent-task-dot${attention ? ' attention' : ''}"></span><span class="recent-task-title">${escapeHtml(task.input.title)}</span><span class="recent-task-status">${escapeHtml(statusLabel(task.status))}</span>`;
    return item;
  }));
}

function isRoutineNoise(task) {
  if (task?.taskType !== 'operations.health-review' || task?.source?.channel !== 'paperclip') return false;
  const title = String(task.input?.title || '').trim();
  const description = String(task.input?.description || '').trim();
  return title === 'A君定时本机巡检' || description.startsWith('agent-army:operations-health-v1');
}

function isRecentOwnerTask(task) {
  if (isRoutineNoise(task)) return false;
  const channels = [task?.source?.channel, task?.source?.originChannel].map((value) => String(value || '').trim());
  return channels.some((channel) => ['feishu', 'local-ui', 'hermes-native'].includes(channel));
}

function taskCard(task) {
  const node = document.createElement('article');
  node.className = 'task';
  node.dataset.taskId = task.taskId;
  const approval = state.overview.approvals.find((item) => task.approvalRefs?.includes(item.approvalId));
  const pendingApproval = approval?.status === 'pending' ? approval : null;
  const artifacts = task.artifactRefs || [];
  const report = artifacts.find((item) => item.type === 'health_report')?.data;
  const intake = artifacts.find((item) => item.type === 'task_intake_record')?.data;
  const review = artifacts.find((item) => item.type === 'review_report')?.data;
  const architecture = artifacts.find((item) => item.type === 'architecture_review')?.data;
  const xiaodResult = artifacts.find((item) => item.type === 'xiaod_media_delivery');
  const publicReport = artifacts.find((item) => item.type === 'public_web_report')?.data;
  const recovery = recoveryState(task);
  const approvalResult = pendingApproval
    ? `<p class="result degraded">待你确认：${escapeHtml(pendingApproval.reason)}<br><small>本次范围：${escapeHtml(pendingApproval.requestedScope?.title || task.input.title)} · ${escapeHtml(taskTypeLabel(pendingApproval.requestedScope?.taskType || task.taskType))}</small></p>`
    : '';
  const result = approvalResult || (
    recovery ? `<p class="result ${recovery.tone}">${escapeHtml(recovery.detail)}</p>`
      : task.error?.userMessage ? `<p class="result degraded">需要处理：${escapeHtml(task.error.userMessage)}</p>`
        : report ? `<p class="result ${escapeHtml(report.overall)}">健康检查：${escapeHtml(report.overall === 'healthy' ? '正常' : '需要关注')} · ${escapeHtml(report.components.map((item) => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、'))}</p>`
          : intake ? `<p class="result healthy">下一步建议：${escapeHtml(intake.nextAction)}</p>`
            : review ? `<p class="result ${review.scopeStated ? 'healthy' : 'degraded'}">审核结论：${escapeHtml(review.nextAction)}</p>`
              : architecture ? `<p class="result healthy">能力评估：已启用 ${architecture.currentCapabilities.length} 个岗位 · ${escapeHtml(architecture.nextAction)}</p>`
                : publicReport ? `<p class="result healthy">网页摘要：${escapeHtml(publicReport.summary)}</p>`
                  : xiaodResult ? `<p class="result ${xiaodResult.validation?.qualityPassed ? 'healthy' : 'degraded'}">小D交付已生成 · ${xiaodResult.validation?.qualityPassed ? '质量检查通过' : '建议人工校对'}</p>`
                    : ''
  );
  const shownStatus = recovery || { label: statusLabel(task.status), className: task.status };
  const presentation = task.presentation || {
    taskRef:`#${String(task.taskId || '').replaceAll('-', '').slice(0, 8).toUpperCase()}`,
    summary:`${task.input.title}：${statusLabel(task.status)}`,
    nextAction:task.error?.userMessage || '等待新的进度。',
    detailPath:`/tasks/${encodeURIComponent(task.taskId)}`,
    technical:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage, errorCode:task.error?.code }
  };
  node.innerHTML = `
    <details class="task-disclosure" data-disclosure-key="task:${escapeHtml(task.taskId)}"${selectedTaskId === task.taskId ? ' open' : ''}>
      <summary>
        <div class="task-summary-main">
          <span class="status ${escapeHtml(shownStatus.className)}">${escapeHtml(shownStatus.label)}</span>
          <div class="task-summary-copy">
            <h3>${escapeHtml(task.input.title)}</h3>
            <p>${escapeHtml(taskTypeLabel(task.taskType))}</p>
          </div>
        </div>
        <span class="task-owner">${escapeHtml(agentName(task.assigneeAgentId))}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="task-body">
        <div class="task-body-copy">
          <p class="task-human-summary">${escapeHtml(presentation.summary)}</p>
          <p class="task-next-action"><strong>下一步</strong>${escapeHtml(presentation.nextAction)}</p>
          ${result}
          <div class="task-actions">
            <a class="task-detail-link" href="${escapeHtml(presentation.detailPath)}">查看任务 ${escapeHtml(presentation.taskRef)}</a>
            <button class="task-copy-id" type="button">复制完整编号</button>
          </div>
          <details class="task-technical" data-disclosure-key="task-technical:${escapeHtml(task.taskId)}">
            <summary>技术详情</summary>
            <dl>
              <div><dt>完整编号</dt><dd>${escapeHtml(presentation.technical.taskId || task.taskId)}</dd></div>
              <div><dt>原始状态</dt><dd>${escapeHtml(presentation.technical.status || task.status)}</dd></div>
              <div><dt>当前阶段</dt><dd>${escapeHtml(presentation.technical.currentStage || '未记录')}</dd></div>
              ${presentation.technical.errorCode ? `<div><dt>错误代码</dt><dd>${escapeHtml(presentation.technical.errorCode)}</dd></div>` : ''}
              <div><dt>路由说明</dt><dd>${escapeHtml(task.routing?.reason || '未记录')}</dd></div>
            </dl>
          </details>
        </div>
        <div class="task-meta">
          <strong>${escapeHtml(agentName(task.assigneeAgentId))}</strong>
          <span>${escapeHtml(taskTypeLabel(task.taskType))}</span>
          <span>提交人：${escapeHtml(requesterLabel(task))}</span>
          ${task.parentTaskId ? '<span>来自 A君建议</span>' : ''}
          ${pendingApproval ? '<span class="approval">请在飞书原会话处理</span>' : ''}
        </div>
      </div>
    </details>`;
  node.querySelector('.task-copy-id')?.addEventListener('click', async () => {
    const button = node.querySelector('.task-copy-id');
    try {
      await navigator.clipboard.writeText(task.taskId);
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败，请展开技术详情';
    }
    setTimeout(() => { button.textContent = '复制完整编号'; }, 1600);
  });
  return node;
}

function taskStatusGroup(status) {
  if (completedTaskStatuses.has(status)) return 'completed';
  if (attentionTaskStatuses.has(status)) return 'attention';
  return 'active';
}

function renderFocus(focus) {
  focusPanel.classList.remove('skeleton-panel');
  if (!focus?.total) {
    focusPanel.innerHTML = '<div class="focus-copy"><p class="focus-state is-clear">无需处理</p><h3>还没有任务记录</h3><p>请在飞书交办，A君会在这里同步下一步。</p></div><div class="focus-guard"><span>对外发布关闭</span><span>不会静默执行</span></div>';
    return;
  }
  const current = focus.next;
  const focusTask = state.overview.tasks.find((task) => task.taskId === current?.taskId);
  const recovery = focusTask ? recoveryState(focusTask) : null;
  const ownerStatuses = new Set(['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test', 'succeeded']);
  const needsOwner = Boolean(current && ownerStatuses.has(current.status));
  const title = current ? escapeHtml(current.title) : '现在没有必须处理的事';
  const action = recovery
    ? escapeHtml(recovery.detail)
    : current
      ? escapeHtml(current.action)
      : '历史失败和待验证记录都留在“记录”中，不会自动重试或对外发布。';
  const reason = current?.status === 'succeeded'
    ? '这是建议，不会自动创建后续任务。'
    : needsOwner
      ? '这件事需要你的输入或确认，系统不会替你决定。'
      : current
        ? '系统正在推进，你可以查看进度，不需要一直盯着。'
        : '当前没有任务在执行，也没有等待你的审批。';
  const primaryAction = current
    ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}">${current.status === 'succeeded' ? '查看这条建议' : needsOwner ? '查看并处理' : '查看进度'}</a>`
    : '<a class="focus-primary-action secondary" href="#records">打开任务记录</a>';
  const governanceReady = state.overview.capabilities.some((item) => item.id === 'governance' && item.status === 'ready');
  const externalWriteReady = state.overview.capabilities.some((item) => item.id === 'external-execution' && item.status === 'ready');
  const costText = usageCostText(state.overview.usage);
  focusPanel.innerHTML = `
    <div class="focus-copy">
      <p class="focus-state ${needsOwner ? 'needs-owner' : current ? 'is-running' : 'is-clear'}">${needsOwner ? '需要你决定' : current ? '系统正在处理' : '无需处理'}</p>
      <h3>${title}</h3>
      <p class="focus-action-copy">${action}</p>
      <p class="focus-reason">${escapeHtml(reason)}</p>
      <div class="focus-actions">${primaryAction}</div>
    </div>
    <div class="focus-guard">
      <span>${governanceReady ? 'Paperclip 已连接' : '治理连接待恢复'}</span>
      <span>${externalWriteReady ? '对外写入按审批开放' : '对外发布关闭'}</span>
      <span>${focus.inProgress ? `${focus.inProgress} 项正在推进` : '没有执行中任务'}</span>
      <span>${escapeHtml(costText)}</span>
    </div>`;
}

function usageCostText(usage) {
  const totals = usage?.cost?.totals || [];
  if (!usage?.cost?.reportedTaskCount || !totals.length) return '今日费用未上报';
  return `今日已上报费用 ${totals.map((item) => `${item.amount} ${item.currency}`).join(' · ')}`;
}

function isDirectEmployee(agent) {
  return agent.acceptedTaskTypes.some((type) => directEmployeeTaskTypes.includes(type));
}

function agentGroupTitle(title, detail) {
  const node = document.createElement('div');
  node.className = 'agent-group-title';
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  return node;
}

function agentCard(agent, support) {
  const node = document.createElement('article');
  node.className = `agent${support ? ' support-agent' : ''}`;
  const types = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · ');
  const summaryTypes = agent.acceptedTaskTypes.slice(0, 2).map(taskTypeLabel).join(' · ') || '职责待核对';
  const independent = independentRuntimeLabel(agent);
  node.innerHTML = `
    <details class="agent-disclosure" data-disclosure-key="agent:${escapeHtml(agent.agentId)}">
      <summary>
        <span class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</span>
        <span class="agent-summary-copy">
          <strong>${escapeHtml(agent.name)}</strong>
          <small>${escapeHtml(summaryTypes)}</small>
        </span>
        <span class="status ${escapeHtml(agent.status)}">${escapeHtml(statusLabel(agent.status))}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="agent-body">
        <p>${escapeHtml(agent.role)}</p>
        <p>${escapeHtml(types)}</p>
        <p>${escapeHtml(independent)}</p>
      </div>
    </details>`;
  return node;
}

function capabilityCard(item) {
  const node = document.createElement('article');
  node.className = 'capability-card';
  node.innerHTML = `<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><h3>${escapeHtml(item.name)}</h3><p title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</p>`;
  return node;
}

function independentRuntimeLabel(agent) {
  const state = agent.independentRuntime?.state;
  if (state === 'model_pending') return '岗位已定义，正在配置独立大脑';
  if (state === 'model_transport_pending') return '独立身份已建立，模型授权和真实调用待完成';
  const channel = agent.feishuChannel;
  if (channel?.status === 'external' && channel?.verified === true) return '独立 Hermes 员工已完成真实任务与连续追问';
  if (channel?.status === 'external') return '独立 Hermes 飞书入口已接管，待真实消息验证';
  if (channel?.verified === true) return '独立飞书入口已完成真实任务收发';
  if (channel?.status === 'connected') return '独立飞书入口已连接，待真实消息验证';
  if (channel?.status === 'connecting') return '独立飞书入口正在连接';
  if (channel?.status === 'failed') return `独立飞书入口未连接：${channel.message}`;
  if (channel?.status === 'disabled') return `独立飞书入口未启用：${channel.message}`;
  return ({
    ready: '已独立接通',
    channel_pending: '模型调用已验证，飞书入口待接通',
    waiting_verification: '独立入口待真实验证',
    not_created: '独立身份尚未创建',
    missing_profile: '独立身份资料缺失',
    invalid_reference: '独立身份资料无效',
    not_declared: '目前由 A君统一代管'
  })[state] || (agent.source === 'approved-proposal' ? '通过限定试用，由 A君统一代管' : '状态待核对');
}

function taskTypeLabel(type) {
  const agent = state.overview?.agents.find((item) => item.acceptedTaskTypes.includes(type));
  const suffix = agent?.status === 'draft' ? '（准备中）' : '';
  return `${taskLabels[type] || agent?.name || '待分配工作'}${suffix}`;
}

function statusLabel(status) {
  return statusLabels[String(status || '')] || '状态待确认';
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString();
}

function recoveryState(task) {
  if (task.status !== 'failed') return null;
  const children = state.overview?.tasks?.filter((item) => item.parentTaskId === task.taskId) || [];
  const latest = (items) => [...items].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0];
  const technical = latest(children.filter((item) => item.taskType === 'operations.technical-repair'));
  if (technical?.status === 'waiting_test') return { label: '待测试', className: 'waiting_test', tone: 'degraded', active: false, detail: '技术专家已保留当前结果，但这轮检查还需要后续验证；其他工作会继续推进。' };
  if (technical?.status === 'succeeded') return { label: '修复已核对', className: 'succeeded', tone: 'healthy', active: false, detail: '技术专家已经完成本轮修复和检查；A君正在保留最终记录。' };
  if (technical?.status === 'failed') return { label: '修复未完成', className: 'failed', tone: 'degraded', active: false, detail: '技术专家本轮没有修复成功，当前记录已保留，不会假装完成。' };
  if (technical && ['queued', 'running'].includes(technical.status)) return { label: '技术专家处理中', className: 'running', tone: 'healthy', active: true, detail: '技术专家正在处理这件事，A君会继续跟进最终结果；你不用重复提交。' };
  const retry = latest(children.filter((item) => item.taskType === task.taskType && item.recovery?.rootTaskId === task.taskId));
  if (retry && ['queued', 'running'].includes(retry.status)) return { label: '正在自动重试', className: 'running', tone: 'healthy', active: true, detail: '运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  const coordination = task.recovery?.coordination?.status;
  if (coordination === 'pending') return { label: '系统正在接手', className: 'running', tone: 'healthy', active: true, detail: '任务遇到问题，运维官正在判断安全的恢复办法。' };
  if (coordination === 'retrying') return { label: '正在自动重试', className: 'running', tone: 'healthy', active: true, detail: '运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  if (coordination === 'escalated') return { label: '技术专家处理中', className: 'running', tone: 'healthy', active: true, detail: '这件事已经交给技术专家，A君会继续跟进最终结果。' };
  return null;
}

function agentName(agentId) {
  return state.overview?.agents.find((agent) => agent.agentId === agentId)?.name || '等待分配';
}

function providerLabel(provider) {
  return ({
    xhs:'小红书',
    dy:'抖音',
    bili:'哔哩哔哩',
    ks:'快手',
    youtube:'YouTube'
  })[provider] || provider || '未知平台';
}

function requesterLabel(task) {
  const requester = task?.requester || {};
  if (/^ou_[a-zA-Z0-9]+$/.test(String(requester.ref || ''))) return '飞书老板';
  if (requester.kind === 'local-owner') return '老板';
  if (requester.kind === 'feishu-user') return '飞书老板';
  if (requester.kind === 'local-system') return 'A君';
  if (requester.kind === 'lan-collaborator') return requester.ref || '局域网同事';
  return '内部协作';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}


const elements = {
  capabilityList, agentList, taskList, recentTaskList, overviewStats, overviewSummary,
  taskCount, taskSearch, taskLoadMore, focusPanel, capabilitySummary, accessGate,
  accessForm, accessKey, collaboratorName, accessMessage, shareInfo, rotateShareKey,
  shareMessage, syncStatus, syncIndicator, employeeConnections, employeeConnectionList,
  accessConnections, aiControl, aiServiceList, aiControlMessage, aiRoutingList,
  refreshAiControl, accessConnectionList, accessConnectionMessage, contentAccessSummary,
  accessLoginDisclosure, accessLoginForm, accessLoginProvider, accessLoginAlias,
  accessLoginAccount, accessLoginMessage, openPlatformLogin, refreshLoginAccounts,
  saveAccessConnection, cancelAccessReauthorize, campaignList, campaignMessage,
  moduleLinks, modulePages, ownerOnlyElements, taskFilterButtons, accessStepPanels,
  accessStepIndicators, accessStepNext2, accessStepNext3, accessStepBack1, accessStepBack2,
};

const accessViews = createAccessViews({
  elements,
  state,
  api,
  escapeHtml,
  statusLabel,
  formatDate,
  providerLabel,
  agentName,
  replaceChildrenPreservingDisclosureState,
  setTextIfChanged,
});

boomMonitor = createBoomMonitorConsole({
  root:document.querySelector('#module-boom-monitor'),
  api,
  escapeHtml,
  formatDate,
});

bindConsoleInteractions({
  elements,
  state,
  api,
  load,
  setSyncStatus,
  moduleNavigation,
  accessViews,
  renderTaskLists,
});
