import { markSyncStarted, replaceChildrenPreservingDisclosureState, setTextIfChanged, } from './disclosure-state.js';
import { createConsoleNavigation } from './console-navigation.js';
import { createAccessViews } from './app-access-views.js';
import { bindConsoleInteractions } from './app-interactions.js';
import { createBoomMonitorConsole } from './boom-monitor-console.js';
import { createBillingLedgerWorkbench } from './billing-ledger-workbench.js';
import { startBrowserHotReload } from './hot-reload-client.js';
import { taskStatusGroup } from './task-record-filter.js';
import { createTaskRecordWorkbench } from './task-record-workbench.js';
import { createStepFunModelPolicyConsole } from './stepfun-model-policy-console.js';
const capabilityList: any = document.querySelector('#capability-list');
const agentList: any = document.querySelector('#agent-list');
const recentTaskList: any = document.querySelector('#recent-task-list');
const overviewStats: any = document.querySelector('#overview-stats');
const overviewSummary: any = document.querySelector('#overview-summary');
const billingSummary: any = document.querySelector('#billing-summary');
const billingStats: any = document.querySelector('#billing-stats');
const billingCostHealth: any = document.querySelector('#billing-cost-health');
const billingAttribution: any = document.querySelector('#billing-attribution');
const billingProfileList: any = document.querySelector('#billing-profile-list');
const focusPanel: any = document.querySelector('#focus-panel');
const capabilitySummary: any = document.querySelector('#capability-summary');
const accessGate: any = document.querySelector('#access-gate');
const accessForm: any = document.querySelector('#access-form');
const accessKey: any = document.querySelector('#access-key');
const collaboratorName: any = document.querySelector('#collaborator-name');
const accessMessage: any = document.querySelector('#access-message');
const shareInfo: any = document.querySelector('#share-info');
const rotateShareKey: any = document.querySelector('#rotate-share-key');
const shareMessage: any = document.querySelector('#share-message');
const syncBadge: any = document.querySelector('.sync-badge');
const syncStatus: any = document.querySelector('#sync-status');
const syncIndicator: any = document.querySelector('#sync-indicator');
const employeeConnections: any = document.querySelector('#employee-connections');
const employeeConnectionList: any = document.querySelector('#employee-connection-list');
const modelPolicyRoot: any = document.querySelector('#hermes-model-management');
const accessConnections: any = document.querySelector('#access-connections');
const aiControl: any = document.querySelector('#ai-control');
const aiServiceList: any = document.querySelector('#ai-service-list');
const aiControlMessage: any = document.querySelector('#ai-control-message');
const aiRoutingList: any = document.querySelector('#ai-routing-list');
const refreshAiControl: any = document.querySelector('#refresh-ai-control');
const accessConnectionList: any = document.querySelector('#access-connection-list');
const accessConnectionMessage: any = document.querySelector('#access-connection-message');
const contentAccessSummary: any = document.querySelector('#content-access-summary');
const accessLoginDisclosure: any = document.querySelector('#access-login-disclosure');
const accessLoginForm: any = document.querySelector('#access-login-form');
const accessLoginProvider: any = document.querySelector('#access-login-provider');
const accessLoginAlias: any = document.querySelector('#access-login-alias');
const accessLoginAccount: any = document.querySelector('#access-login-account');
const accessLoginMessage: any = document.querySelector('#access-login-message');
const openPlatformLogin: any = document.querySelector('#open-platform-login');
const refreshLoginAccounts: any = document.querySelector('#refresh-login-accounts');
const saveAccessConnection: any = document.querySelector('#save-access-connection');
const cancelAccessReauthorize: any = document.querySelector('#cancel-access-reauthorize');
const campaignList: any = document.querySelector('#campaign-list');
const campaignMessage: any = document.querySelector('#campaign-message');
const moduleLinks: any = [...document.querySelectorAll('[data-module]')];
const modulePages: any = [...document.querySelectorAll('[data-module-page]')];
const contextLinks: any = [...document.querySelectorAll('[data-context-page]')];
const ownerOnlyElements: any = [...document.querySelectorAll('[data-owner-only]')];
const accessStepPanels: any = [...document.querySelectorAll('[data-access-step-panel]')];
const accessStepIndicators: any = [...document.querySelectorAll('[data-access-step-indicator]')];
const accessStepNext2: any = document.querySelector('#access-step-next-2');
const accessStepNext3: any = document.querySelector('#access-step-next-3');
const accessStepBack1: any = document.querySelector('#access-step-back-1');
const accessStepBack2: any = document.querySelector('#access-step-back-2');
const taskLabels: any = {
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
const statusLabels: any = {
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
const directEmployeeTaskTypes: any = [
    'media.transcribe-and-refine',
    'report.public-material',
    'research.intel-report',
    'office.briefing-package',
    'office.presentation-package'
];
const ownerOnlyModules: any = new Set(['connections', 'campaigns', 'billing', 'boom-monitor', 'tools']);
let boomMonitor: any;
let recordWorkbench: any;
const billingLedgerWorkbench: any = createBillingLedgerWorkbench({ agentName, formatDate, formatNumber, formatUsd, escapeHtml });
function taskIdFromPath(pathname: any): any {
    return pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}
const state: any = {
    overview: undefined,
    selectedTaskId: taskIdFromPath(location.pathname),
    selectedTaskRevealed: false,
    shareKey: sessionStorage.getItem('ajun-share-key') || '',
    requesterName: sessionStorage.getItem('ajun-requester-name') || '',
    localOwner: false,
    loading: false,
    accessLoginOptions: { providers: [], accounts: [] },
    reauthorizeConnectionId: '',
};
const moduleNavigation: any = createConsoleNavigation({
    getHash: (): any => location.hash,
    getPathname: (): any => location.pathname,
    replaceLocation: (value: any): any => history.replaceState(null, '', value),
    activate: activateModule,
});
async function api(url: any, options: any = {}): Promise<any> {
    const headers: any = new Headers(options.headers || {});
    if (state.shareKey)
        headers.set('x-ajun-share-key', state.shareKey);
    const response: any = await fetch(url, { ...options, headers });
    const payload: any = await response.json();
    if (!response.ok) {
        const error: any = new Error(payload.detail || payload.error || '请求失败。');
        error.status = response.status;
        throw error;
    }
    return payload;
}
function setSyncStatus(message: any, state: any): any {
    const quiet: any = state === 'synced';
    syncStatus.textContent = quiet ? '已同步' : message;
    syncIndicator.className = `sync-indicator ${state}`;
    syncBadge?.classList.toggle('is-quiet', quiet);
}
async function load({ background = false }: any = {}): Promise<any> {
    if (state.loading)
        return;
    state.loading = true;
    markSyncStarted(syncIndicator, { background });
    try {
        state.overview = await api('/api/console-overview');
        accessGate.hidden = true;
        document.body.classList.remove('access-required');
        await accessViews.renderLocalShare();
        render();
        recordWorkbench?.updateFilterOptions();
        updateOwnerNavigation();
        moduleNavigation.initialize();
        if (background)
            await recordWorkbench?.refresh({ background: true });
        setSyncStatus(`已同步 · ${new Date().toLocaleTimeString()}`, 'synced');
        document.body.classList.remove('is-loading');
    }
    catch (error: any) {
        if (error.status === 401) {
            accessGate.hidden = false;
            accessMessage.textContent = error.message;
            document.body.classList.add('access-required');
            setSyncStatus('等待共享口令', 'waiting');
            return;
        }
        setSyncStatus('同步暂不可用', 'error');
        throw error;
    }
    finally {
        state.loading = false;
    }
}
function updateOwnerNavigation(): any {
    for (const element of ownerOnlyElements)
        element.hidden = !state.localOwner;
    if (!state.localOwner && ownerOnlyModules.has(location.hash.slice(1)))
        activateModule('overview', { navigationGroup: 'overview', replaceHash: true });
}
function activateModule(name: any, { navigationGroup = '', replaceHash = false }: any = {}): any {
    const virtualPage: any = name === 'system'
        ? state.localOwner ? 'connections' : 'employees'
        : name === 'tools' ? 'boom-monitor' : name;
    const requested: any = modulePages.some((page: any): any => page.dataset.modulePage === virtualPage) ? virtualPage : 'overview';
    const selected: any = ownerOnlyModules.has(requested) && !state.localOwner ? 'overview' : requested;
    const selectedGroup: any = selected === 'overview'
        ? 'overview'
        : selected === 'records'
            ? 'records'
            : ['employees', 'connections', 'billing'].includes(selected)
                ? 'system'
                : ['campaigns', 'boom-monitor'].includes(selected)
                    ? 'tools'
                    : navigationGroup || 'overview';
    for (const link of moduleLinks) {
        const active: any = link.dataset.module === selectedGroup;
        link.classList.toggle('is-active', active);
        if (active)
            link.setAttribute('aria-current', 'page');
        else
            link.removeAttribute('aria-current');
    }
    for (const page of modulePages) {
        const active: any = page.dataset.modulePage === selected;
        page.classList.toggle('is-active', active);
        page.setAttribute('aria-hidden', String(!active));
    }
    for (const link of contextLinks) {
        const active: any = link.dataset.contextPage === selected;
        link.classList.toggle('is-active', active);
        if (active)
            link.setAttribute('aria-current', 'page');
        else
            link.removeAttribute('aria-current');
    }
    document.title = `${moduleTitle(selected)} · A君运行台`;
    if (selected === 'boom-monitor')
        boomMonitor?.activate();
    recordWorkbench?.setActive(selected === 'records').catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (replaceHash && location.hash !== '#now')
        history.replaceState(null, '', '#now');
}
function moduleTitle(name: any): any {
    return ({ overview: '现在', employees: '员工', connections: '账号与接入', campaigns: '发布活动', billing: 'AI 成本账本', 'boom-monitor': '爆款雷达', records: '运行记录' } as Record<string, string>)[name] || '现在';
}
function render(): any {
    renderFocus(state.overview.taskFocus);
    renderOverviewStats();
    capabilityList.replaceChildren(...state.overview.capabilities.map((item: any): any => capabilityCard(item)));
    const readyCapabilities: any = state.overview.capabilities.filter((item: any): any => ['verified', 'human_accepted'].includes(item.truth?.overall)).length;
    const limitedCapabilities: any = state.overview.capabilities.length - readyCapabilities;
    capabilitySummary.textContent = `${readyCapabilities} 项有真实任务证据${limitedCapabilities ? ` · ${limitedCapabilities} 项待验证或受限` : ''}`;
    const directEmployees: any = state.overview.alwaysOnAgents?.length ? state.overview.alwaysOnAgents : state.overview.agents.filter(isDirectEmployee);
    const supportEmployees: any = state.overview.onDemandAgents?.length ? state.overview.onDemandAgents : state.overview.agents.filter((agent: any): any => !isDirectEmployee(agent));
    replaceChildrenPreservingDisclosureState(agentList, [
        agentGroupTitle('常驻员工', '保持飞书入口或后台巡检常驻'),
        ...directEmployees.map((agent: any): any => agentCard(agent, false)),
        agentGroupTitle('后台按需能力', '不常驻飞书入口，由 A君或 Paperclip 按任务唤醒'),
        ...supportEmployees.map((agent: any): any => agentCard(agent, true))
    ]);
    renderBilling();
    renderRecentTasks(state.overview.recentTasks || []);
}
function renderBilling(): any {
    if (!billingSummary || !billingStats || !billingCostHealth || !billingAttribution || !billingProfileList)
        return;
    const billing: any = state.overview.billing;
    if (!billing || billing.status === 'unavailable') {
        billingSummary.textContent = 'Hermes 用量库暂时不可读；缺失数据不会显示成 0。';
        billingStats.replaceChildren(statCard('可核金额', '未知', '等待用量库恢复', 'cost', true), statCard('模型请求', '未知', '暂时无法读取', 'clock'), statCard('Token', '未知', '暂时无法读取', 'records'));
        renderBillingCostHealth(null);
        billingAttribution.innerHTML = '<strong>账本暂不可用</strong><span>任务记录仍保留，但暂时无法核对全部模型消耗。</span>';
        billingProfileList.replaceChildren(billingEmpty('暂时无法读取岗位用量。'));
        billingLedgerWorkbench.setUnavailable();
        return;
    }
    const totals: any = billing.totals || {};
    const cost: any = totals.cost || {};
    const tokens: any = totals.tokens || {};
    const knownCostCount: any = Number(cost.actualEntryCount || 0) + Number(cost.estimatedEntryCount || 0);
    const periodStart: any = billing.period?.since ? formatDate(billing.period.since) : '最近七天';
    const costNote: any = Number(cost.actualEntryCount || 0)
        ? `含 ${cost.actualEntryCount} 条实际费用，其余为估算`
        : Number(cost.estimatedEntryCount || 0)
            ? '当前全部为 Hermes 估算，不是 Provider 最终账单'
            : 'Provider 未返回可核金额';
    billingSummary.textContent = `${periodStart} 至今 · ${billing.status === 'partial' ? '部分岗位暂不可读' : '已读取正式岗位 Hermes 用量'}`;
    billingStats.replaceChildren(statCard('可核金额', knownCostCount ? formatUsd(cost.knownUsd) : '未知', costNote, 'cost'), statCard('模型请求', formatNumber(totals.apiCalls), `${formatNumber(totals.sessionCount)} 个会话`, 'clock'), statCard('Token', formatCompactNumber(tokens.total), `输入、输出与缓存合计 ${formatNumber(tokens.total)}`, 'records'));
    renderBillingCostHealth(billing.health);
    const taskEntries: any = Number(billing.attribution?.taskEntryCount ?? billing.attribution?.attributedEntryCount ?? 0);
    const agentSessions: any = Number(billing.attribution?.agentSessionEntryCount || 0);
    const systemEntries: any = Number(billing.attribution?.systemEntryCount || 0);
    const unattributed: any = Number(billing.attribution?.unattributedEntryCount || 0);
    billingAttribution.classList.toggle('attention', unattributed > 0);
    billingAttribution.innerHTML = `<strong>${unattributed ? `${unattributed} 条消费仍未识别来源` : '账本来源均已识别'}</strong><span>${taskEntries} 条精确关联业务任务，${agentSessions} 条属于独立 Agent 会话，${systemEntries} 条属于系统调用；识别到 Agent 会话不等同于具体业务任务。</span>`;
    const profiles: any = Array.isArray(billing.profiles) ? billing.profiles : [];
    billingProfileList.replaceChildren(...(profiles.length ? profiles.map(billingProfileRow) : [billingEmpty('最近七天没有岗位模型用量。')]));
    billingLedgerWorkbench.setEntries(Array.isArray(billing.entries) ? billing.entries : []);
}
function renderBillingCostHealth(health: any): any {
    billingCostHealth.className = 'billing-cost-health';
    const title: any = document.createElement('strong');
    const detail: any = document.createElement('span');
    if (!health) {
        billingCostHealth.classList.add('unavailable');
        title.textContent = '成本健康状态未知';
        detail.textContent = '账本恢复后再判断缓存命中、调用量、推理占比和费用覆盖。';
    }
    else {
        const status: any = ['warning', 'attention', 'healthy'].includes(health.status) ? health.status : 'attention';
        billingCostHealth.classList.add(status);
        title.textContent = status === 'healthy' ? '成本健康正常' : status === 'warning' ? '成本需要处理' : '成本需要关注';
        detail.textContent = health.operatorMessage || '成本健康数据不完整，暂不下结论。';
    }
    billingCostHealth.replaceChildren(title, detail);
}
function billingProfileRow(profile: any): any {
    const node: any = document.createElement('article');
    node.className = 'billing-profile-row';
    const knownCostCount: any = Number(profile.cost?.actualEntryCount || 0) + Number(profile.cost?.estimatedEntryCount || 0);
    node.innerHTML = `<div><strong>${escapeHtml(agentName(profile.agentId))}</strong><span>${formatNumber(profile.apiCalls)} 次请求 · ${formatCompactNumber(profile.tokens?.total)} Token · ${formatNumber(profile.sessionCount)} 个会话</span></div><b>${knownCostCount ? formatUsd(profile.cost?.knownUsd) : '金额未知'}</b>`;
    return node;
}
function billingEmpty(message: any): any {
    const node: any = document.createElement('p');
    node.className = 'billing-empty';
    node.textContent = message;
    return node;
}
function formatNumber(value: any): any {
    return Number(value || 0).toLocaleString('zh-CN');
}
function formatCompactNumber(value: any): any {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
}
function formatUsd(value: any): any {
    const number: any = Number(value || 0);
    return `$${number.toFixed(number >= 0.01 ? 2 : 4)}`;
}
function renderOverviewStats(): any {
    const focus: any = state.overview.taskFocus || {};
    const active: any = Number.isFinite(focus.inProgress) ? focus.inProgress : 0;
    const ownerActionable: any = Number.isFinite(focus.ownerActionable) ? focus.ownerActionable : (focus.next ? 1 : 0);
    const verificationBacklog: any = Number.isFinite(focus.verificationBacklog) ? focus.verificationBacklog : 0;
    const unresolvedFailures: any = Number.isFinite(focus.unresolvedFailures) ? focus.unresolvedFailures : 0;
    const historicalArchived: any = Number.isFinite(focus.historicalArchived) ? focus.historicalArchived : 0;
    const validatedByLaterEvidence: any = Number.isFinite(focus.validatedByLaterEvidence) ? focus.validatedByLaterEvidence : 0;
    const unavailableAgents: any = state.overview.agents.filter((agent: any): any => ['not_declared', 'declared', 'unknown'].includes(agent.capabilityTruth?.overall)).length;
    overviewSummary.textContent = ownerActionable
        ? `${ownerActionable} 件事需要你决定。`
        : active
            ? `${active} 项工作正在推进，你暂时不用处理。`
            : '当前没有必须处理的事。';
    const cards: any = [
        statCard('待处理', ownerActionable, ownerActionable ? '打开上方事项处理' : '目前无需决定', 'target', ownerActionable > 0),
        statCard('运行中', active, active ? '系统会继续推进' : '当前没有执行中的工作', 'clock'),
        ...(verificationBacklog ? [statCard('待复验', verificationBacklog, '需要按业务优先级重新跑验收', 'records', true)] : []),
        ...(unresolvedFailures ? [statCard('仍失败', unresolvedFailures, '保留错误证据，不会自动重试', 'alert', true)] : []),
        ...(validatedByLaterEvidence ? [statCard('已有新证据', validatedByLaterEvidence, '同岗位同能力的后续成功产物已通过校验', 'target')] : []),
        ...(historicalArchived ? [statCard('历史归档', historicalArchived, '包含取消、验收样例和已被成功结果替代的记录', 'records')] : []),
        ...(unavailableAgents ? [statCard('接入异常', unavailableAgents, '前往系统页检查员工与连接', 'alert', true)] : []),
    ];
    overviewStats.replaceChildren(...cards);
}
function statCard(label: any, value: any, note: any, icon: any, attention: any = false): any {
    const node: any = document.createElement('article');
    node.className = `stat-card${attention ? ' attention' : ''}`;
    node.innerHTML = `<div class="stat-card-head"><span>${escapeHtml(label)}</span><span class="stat-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span></div><strong class="stat-value">${escapeHtml(value)}</strong><span class="stat-note">${escapeHtml(note)}</span>`;
    return node;
}
function renderRecentTasks(tasks: any): any {
    recentTaskList.replaceChildren();
    if (!tasks.length) {
        const empty: any = document.createElement('p');
        empty.className = 'subtle';
        empty.textContent = '暂无记录';
        recentTaskList.append(empty);
        return;
    }
    recentTaskList.append(...tasks.map((task: any): any => {
        const item: any = document.createElement('a');
        item.className = 'recent-task';
        item.href = `/tasks/${encodeURIComponent(task.taskId)}`;
        const attention: any = taskStatusGroup(task.status) === 'attention';
        item.innerHTML = `<span class="recent-task-dot${attention ? ' attention' : ''}"></span><span class="recent-task-title">${escapeHtml(task.input.title)}</span><span class="recent-task-status">${escapeHtml(statusLabel(task.status))}</span>`;
        return item;
    }));
}
function renderFocus(focus: any): any {
    focusPanel.classList.remove('skeleton-panel');
    if (!focus?.total) {
        focusPanel.innerHTML = '<div class="focus-copy"><p class="focus-state is-clear">无需处理</p><h3>还没有任务记录</h3><p>请在飞书交办，A君会在这里同步下一步。</p></div><div class="focus-guard"><span>对外发布关闭</span><span>不会静默执行</span></div>';
        return;
    }
    const current: any = focus.next;
    const ownerStatuses: any = new Set(['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test', 'succeeded']);
    const needsOwner: any = Boolean(current && ownerStatuses.has(current.status));
    const title: any = current ? escapeHtml(current.title) : '现在没有必须处理的事';
    const action: any = current
        ? escapeHtml(current.action)
        : '历史失败和待验证记录都留在“记录”中，不会自动重试或对外发布。';
    const reason: any = current?.status === 'succeeded'
        ? '这是建议，不会自动创建后续任务。'
        : needsOwner
            ? '这件事需要你的输入或确认，系统不会替你决定。'
            : current
                ? '系统正在推进，你可以查看进度，不需要一直盯着。'
                : '当前没有任务在执行，也没有等待你的审批。';
    const primaryAction: any = current
        ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}">${current.status === 'succeeded' ? '查看这条建议' : needsOwner ? '查看并处理' : '查看进度'}</a>`
        : '<a class="focus-primary-action secondary" href="#records">打开任务记录</a>';
    const governanceReady: any = state.overview.capabilities.some((item: any): any => item.id === 'governance' && item.status === 'ready');
    const externalWriteReady: any = state.overview.capabilities.some((item: any): any => item.id === 'external-execution' && item.status === 'ready');
    const costText: any = usageCostText(state.overview.usage);
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
function usageCostText(usage: any): any {
    const totals: any = usage?.cost?.totals || [];
    if (!usage?.cost?.reportedTaskCount || !totals.length)
        return '今日费用未上报';
    return `今日已上报费用 ${totals.map((item: any): any => `${item.amount} ${item.currency}`).join(' · ')}`;
}
function isDirectEmployee(agent: any): any {
    return agent.acceptedTaskTypes.some((type: any): any => directEmployeeTaskTypes.includes(type));
}
function agentGroupTitle(title: any, detail: any): any {
    const node: any = document.createElement('div');
    node.className = 'agent-group-title';
    node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
    return node;
}
function agentCard(agent: any, support: any): any {
    const node: any = document.createElement('article');
    node.className = `agent${support ? ' support-agent' : ''}`;
    const types: any = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · ');
    const summaryTypes: any = agent.acceptedTaskTypes.slice(0, 2).map(taskTypeLabel).join(' · ') || '职责待核对';
    const independent: any = independentRuntimeLabel(agent);
    const truth: any = capabilityTruthLabel(agent.capabilityTruth);
    node.innerHTML = `
    <details class="agent-disclosure" data-disclosure-key="agent:${escapeHtml(agent.agentId)}">
      <summary>
        <span class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</span>
        <span class="agent-summary-copy">
          <strong>${escapeHtml(agent.name)}</strong>
          <small>${escapeHtml(summaryTypes)}</small>
        </span>
        <span class="status ${escapeHtml(agent.status)}">${escapeHtml(truth)}</span>
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
function capabilityCard(item: any): any {
    const node: any = document.createElement('article');
    node.className = 'capability-card';
    node.innerHTML = `<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><h3>${escapeHtml(item.name)}</h3><p title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</p>`;
    return node;
}
function capabilityTruthLabel(value: any): any {
    return ({ human_accepted: '已验收', verified: '已验证', live: '在线待验证', configured: '已配置', declared: '仅登记', not_declared: '未接入' } as Record<string, string>)[value?.overall] || '待核对';
}
function independentRuntimeLabel(agent: any): any {
    const state: any = agent.independentRuntime?.state;
    if (state === 'model_pending')
        return '岗位已定义，正在配置独立大脑';
    if (state === 'model_transport_pending')
        return '独立身份已建立，模型授权和真实调用待完成';
    const channel: any = agent.feishuChannel;
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
    return ({
        ready: '已独立接通',
        channel_pending: '模型调用已验证，飞书入口待接通',
        waiting_verification: '独立入口待真实验证',
        not_created: '独立身份尚未创建',
        missing_profile: '独立身份资料缺失',
        invalid_reference: '独立身份资料无效',
        not_declared: '目前由 A君统一代管'
    } as Record<string, string>)[state] || (agent.source === 'approved-proposal' ? '通过限定试用，由 A君统一代管' : '状态待核对');
}
function taskTypeLabel(type: any): any {
    const agent: any = state.overview?.agents.find((item: any): any => item.acceptedTaskTypes.includes(type));
    const suffix: any = agent?.status === 'draft' ? '（准备中）' : '';
    return `${taskLabels[type] || agent?.name || '待分配工作'}${suffix}`;
}
function statusLabel(status: any): any {
    return statusLabels[String(status || '')] || '状态待确认';
}
function formatDate(value: any): any {
    const date: any = new Date(value);
    return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString();
}
function agentName(agentId: any): any {
    return state.overview?.agents.find((agent: any): any => agent.agentId === agentId)?.name || '等待分配';
}
function providerLabel(provider: any): any {
    return ({
        xhs: '小红书',
        dy: '抖音',
        bili: '哔哩哔哩',
        ks: '快手',
        youtube: 'YouTube'
    } as Record<string, string>)[provider] || provider || '未知平台';
}
function escapeHtml(value: any): any {
    return String(value).replace(/[&<>"']/g, (char: any): any => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    } as Record<string, string>)[char]);
}
const elements: any = {
    capabilityList, agentList, recentTaskList, overviewStats, overviewSummary,
    focusPanel, capabilitySummary, accessGate,
    accessForm, accessKey, collaboratorName, accessMessage, shareInfo, rotateShareKey,
    shareMessage, syncStatus, syncIndicator, employeeConnections, employeeConnectionList,
    accessConnections, aiControl, aiServiceList, aiControlMessage, aiRoutingList,
    refreshAiControl, accessConnectionList, accessConnectionMessage, contentAccessSummary,
    accessLoginDisclosure, accessLoginForm, accessLoginProvider, accessLoginAlias,
    accessLoginAccount, accessLoginMessage, openPlatformLogin, refreshLoginAccounts,
    saveAccessConnection, cancelAccessReauthorize, campaignList, campaignMessage,
    moduleLinks, modulePages, ownerOnlyElements, accessStepPanels,
    accessStepIndicators, accessStepNext2, accessStepNext3, accessStepBack1, accessStepBack2,
};
const accessViews: any = createAccessViews({
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
    modelPolicyConsole:createStepFunModelPolicyConsole({ root:modelPolicyRoot, api, escapeHtml }),
});
recordWorkbench = createTaskRecordWorkbench({
    api,
    getAgents: (): any => state.overview?.agents || [],
    taskTypeLabel,
    agentName,
    escapeHtml,
    initialTaskId: state.selectedTaskId,
});
boomMonitor = createBoomMonitorConsole({
    root: document.querySelector('#module-boom-monitor'),
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
});
startBrowserHotReload();
