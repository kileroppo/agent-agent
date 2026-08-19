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
import { createRuntimeReleaseConsole } from './runtime-release-console.js';
import { canRefreshConsole } from './refresh-scheduler.js';
import { statusLabel, taskTypeLabel as presentTaskTypeLabel } from './console-labels.js';
import { createBillingUsageCache } from './billing-usage-cache.js';
import { businessDebtPresentation, capabilityPresentation, capabilitySummaryText, countCapabilityTiers, isOwnerActionFocus, managerFirstEmployees, reliabilityPresentation } from './overview-presentation.js';
import { html, raw, escapeHtml } from './html.js';
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
const billingDateFilter: any = document.querySelector('#billing-date-filter');
const billingDateFrom: any = document.querySelector('#billing-date-from');
const billingDateTo: any = document.querySelector('#billing-date-to');
const billingDateMessage: any = document.querySelector('#billing-date-message');
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
const directEmployeeTaskTypes: any = [
    'media.transcribe-and-refine',
    'report.public-material',
    'research.intel-report',
    'office.briefing-package',
    'office.presentation-package'
];
const ownerOnlyModules: any = new Set(['connections', 'campaigns', 'billing', 'release', 'boom-monitor', 'tools']);
let boomMonitor: any;
let recordWorkbench: any;
let runtimeReleaseConsole: any;
const billingLedgerWorkbench: any = createBillingLedgerWorkbench({ agentName, formatDate, formatNumber, formatUsd });
const billingUsageCache: any = createBillingUsageCache({ load: (): any => api('/api/usage') });
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
        if (background && !canRefreshConsole({
            page: document,
            accessGate,
            forms: [accessForm, accessLoginForm],
        }))
            return;
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
            : ['employees', 'connections', 'billing', 'release'].includes(selected)
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
    if (selected === 'campaigns')
        accessViews?.renderContentCampaigns().catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (selected === 'billing')
        loadBilling().catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (selected === 'release')
        runtimeReleaseConsole?.activate();
    else
        runtimeReleaseConsole?.deactivate();
    recordWorkbench?.setActive(selected === 'records').catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (replaceHash && location.hash !== '#now')
        history.replaceState(null, '', '#now');
}
function moduleTitle(name: any): any {
    return ({ overview: '现在', employees: '员工', connections: '账号与接入', campaigns: '发布活动', billing: 'AI 成本账本', release: '版本管理', 'boom-monitor': '爆款雷达', records: '运行记录' } as Record<string, string>)[name] || '现在';
}
function render(): any {
    renderFocus(state.overview.taskFocus);
    renderOverviewStats();
    capabilityList.replaceChildren(...state.overview.capabilities.map((item: any): any => capabilityCard(item)));
    const capabilityTiers: any = countCapabilityTiers(state.overview.capabilities);
    capabilitySummary.textContent = capabilitySummaryText(capabilityTiers);
    const employees: any = managerFirstEmployees(state.overview.manager, state.overview.agents);
    const directEmployees: any = employees.filter(isPrimaryEmployee);
    const supportEmployees: any = employees.filter((agent: any): any => !isPrimaryEmployee(agent));
    replaceChildrenPreservingDisclosureState(agentList, [
        agentGroupTitle('业务结果入口', '日常派活去飞书；这里查看状态、验收和恢复'),
        ...directEmployees.map((agent: any): any => agentCard(agent, false)),
        ...(supportEmployees.length ? [backgroundEmployeeDisclosure(supportEmployees)] : [])
    ]);
    renderRecentTasks(state.overview.recentTasks || []);
}
async function loadBilling({ force = false }: any = {}): Promise<any> {
    try {
        renderBilling(await billingUsageCache.read({ force }));
    }
    catch (error: any) {
        const cached: any = billingUsageCache.peek();
        renderBilling(cached || { status: 'unavailable' });
        if (cached && billingDateMessage)
            billingDateMessage.textContent = '刷新失败，仍显示上次成功读取的账本。';
        throw error;
    }
}
function renderBilling(billing: any): any {
    if (!billingSummary || !billingStats || !billingCostHealth || !billingAttribution || !billingProfileList)
        return;
    if (!billing || billing.status === 'unavailable') {
        billingSummary.textContent = 'Hermes 用量库暂时不可读；缺失数据不会显示成 0。';
        billingStats.replaceChildren(statCard('可核金额', '未知', '等待用量库恢复', 'cost', true), statCard('模型请求', '未知', '暂时无法读取', 'clock'), statCard('Token', '未知', '暂时无法读取', 'records'));
        renderBillingCostHealth(null);
        billingAttribution.hidden = false;
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
    syncBillingDateInputs(billing.period);
    billingSummary.textContent = `${periodStart} 起 · ${billing.status === 'partial' ? '部分岗位暂不可读' : '正式岗位 Hermes 用量'}，不等于 StepFun 全账号账单`;
    billingStats.replaceChildren(statCard('可核金额', knownCostCount ? formatUsd(cost.knownUsd) : '未知', costNote, 'cost'), statCard('模型请求', formatNumber(totals.apiCalls), `${formatNumber(totals.sessionCount)} 个会话`, 'clock'), statCard('Token', formatCompactNumber(tokens.total), `输入、输出与缓存合计 ${formatNumber(tokens.total)}`, 'records'));
    renderBillingCostHealth(billing.health);
    const taskEntries: any = Number(billing.attribution?.taskEntryCount ?? billing.attribution?.attributedEntryCount ?? 0);
    const agentSessions: any = Number(billing.attribution?.agentSessionEntryCount || 0);
    const systemEntries: any = Number(billing.attribution?.systemEntryCount || 0);
    const unattributed: any = Number(billing.attribution?.unattributedEntryCount || 0);
    const providerReconciliation: any = billing.providerReconciliation || { status: 'not_configured' };
    const providerCoverageMissing: any = providerReconciliation.status !== 'matched';
    billingAttribution.hidden = unattributed === 0 && !providerCoverageMissing;
    billingAttribution.classList.toggle('attention', unattributed > 0 || providerCoverageMissing);
    billingAttribution.innerHTML = providerReconciliation.status === 'gap'
        ? `<div><strong>发现 ${formatNumber(providerReconciliation.untrackedApiCalls)} 次账外调用</strong><span>Provider 总账比本系统多 ${formatNumber(providerReconciliation.untrackedTokens)} Token；这些调用尚未归属到任务或岗位。</span></div><a class="secondary-action" href="https://platform.stepfun.com/" target="_blank" rel="noreferrer">打开 StepFun 后台核对</a>`
        : providerCoverageMissing
            ? '<div><strong>这里只是受管岗位的局部账本</strong><span>尚未接入 StepFun 全账号总量；这里显示 0 次，也不能说明账号今天没有调用。</span></div><a class="secondary-action" href="https://platform.stepfun.com/" target="_blank" rel="noreferrer">打开 StepFun 后台核对</a>'
            : unattributed
        ? `<div><strong>${unattributed} 条消费仍未识别来源</strong><span>${taskEntries} 条关联业务任务，${agentSessions} 条属于独立 Agent 会话，${systemEntries} 条属于系统调用。</span></div><button type="button" class="secondary-action">只看未识别</button>`
        : '';
    billingAttribution.querySelector('button')?.addEventListener('click', (): any => focusBillingLedger({ view: 'unattributed' }));
    const profiles: any = Array.isArray(billing.profiles) ? billing.profiles : [];
    billingProfileList.replaceChildren(...(profiles.length ? profiles.map(billingProfileRow) : [billingEmpty('当前范围没有岗位模型用量。')]));
    billingLedgerWorkbench.setEntries(Array.isArray(billing.entries) ? billing.entries : []);
}
function renderBillingCostHealth(health: any): any {
    billingCostHealth.className = 'billing-cost-health';
    const alerts: any[] = Array.isArray(health?.alerts) ? health.alerts : [];
    if (health?.status === 'healthy' && alerts.length === 0) {
        billingCostHealth.hidden = true;
        billingCostHealth.replaceChildren();
        return;
    }
    billingCostHealth.hidden = false;
    const copy: any = document.createElement('div');
    const title: any = document.createElement('strong');
    const detail: any = document.createElement('span');
    const actions: any = document.createElement('div');
    actions.className = 'billing-alert-actions';
    if (!health) {
        billingCostHealth.classList.add('unavailable');
        title.textContent = '成本健康状态未知';
        detail.textContent = '账本恢复后再判断缓存命中、调用量、推理占比和费用覆盖。';
    }
    else {
        const status: any = ['warning', 'attention', 'healthy'].includes(health.status) ? health.status : 'attention';
        billingCostHealth.classList.add(status);
        const highCalls: any = alerts.find((alert: any): any => alert.code === 'high_api_calls');
        const unknownCost: any = alerts.find((alert: any): any => alert.code === 'cost_unknown');
        const providerGap: any = alerts.find((alert: any): any => alert.code === 'provider_usage_gap');
        const providerMissing: any = alerts.find((alert: any): any => alert.code === 'provider_total_not_reconciled');
        title.textContent = highCalls ? `当前范围调用较多（${formatNumber(highCalls.value)} 次）`
            : providerGap ? `发现 ${formatNumber(providerGap.value)} 次账外调用`
                : providerMissing ? '尚未核对 StepFun 全账号总量'
            : unknownCost ? `${formatNumber(unknownCost.value)} 条费用待核对`
                : status === 'warning' ? '成本数据有异常' : '成本数据待核对';
        detail.textContent = health.operatorMessage || '成本健康数据不完整，暂不下结论。';
        if (highCalls)
            actions.append(alertAction('看高频岗位', (): any => document.querySelector('#billing-profile-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
        if (unknownCost)
            actions.append(alertAction('看费用未知', (): any => focusBillingLedger({ view: 'unknown_cost' })));
        if (providerGap || providerMissing)
            actions.append(alertLink('打开 StepFun 后台', 'https://platform.stepfun.com/'));
    }
    copy.append(title, detail);
    billingCostHealth.replaceChildren(copy, actions);
}
function billingProfileRow(profile: any): any {
    const node: any = document.createElement('article');
    node.className = 'billing-profile-row';
    const knownCostCount: any = Number(profile.cost?.actualEntryCount || 0) + Number(profile.cost?.estimatedEntryCount || 0);
    node.innerHTML = html`<div><strong>${agentName(profile.agentId)}</strong><span>${formatNumber(profile.apiCalls)} 次请求 · ${formatCompactNumber(profile.tokens?.total)} Token · ${formatNumber(profile.sessionCount)} 个会话</span></div><div class="billing-profile-actions"><b>${knownCostCount ? formatUsd(profile.cost?.knownUsd) : '金额未知'}</b><button type="button" class="text-action">看流水</button></div>`;
    node.querySelector('button')?.addEventListener('click', (): any => focusBillingLedger({ agentId: profile.agentId }));
    return node;
}
function alertAction(label: any, action: any): any {
    const button: any = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-action';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
}
function alertLink(label: any, href: any): any {
    const link: any = document.createElement('a');
    link.className = 'secondary-action';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = label;
    return link;
}
function focusBillingLedger({ view = 'all', agentId = '' }: any = {}): any {
    billingLedgerWorkbench.setView(view);
    billingLedgerWorkbench.setAgent(agentId);
    document.querySelector('#billing-ledger-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function syncBillingDateInputs(period: any): any {
    if (!billingDateFrom || !billingDateTo || !period?.since)
        return;
    billingDateFrom.value = localDateValue(new Date(period.since));
    const until: any = period.until ? new Date(period.until) : new Date();
    if (until.getHours() === 0 && until.getMinutes() === 0 && until.getSeconds() === 0 && until.getMilliseconds() === 0)
        until.setMilliseconds(-1);
    billingDateTo.value = localDateValue(until);
}
async function loadBillingDateRange(): Promise<any> {
    const since: any = localDayStart(billingDateFrom?.value);
    const selectedUntil: any = localDayStart(billingDateTo?.value);
    if (!since || !selectedUntil || selectedUntil < since) {
        billingDateMessage.textContent = '请选择有效的起止日期。';
        return;
    }
    const until: any = new Date(selectedUntil);
    until.setDate(until.getDate() + 1);
    billingDateMessage.textContent = '正在查询…';
    try {
        const usage: any = await api(`/api/usage?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`);
        billingUsageCache.replace(usage.billing);
        renderBilling(usage.billing);
        billingDateMessage.textContent = '已更新';
    }
    catch (error: any) {
        billingDateMessage.textContent = error.message || '查询失败。';
    }
}
function localDayStart(value: any): any {
    const match: any = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match)
        return null;
    const date: any = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
}
function localDateValue(value: any): any {
    const date: any = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function bindBillingDateControls(): any {
    billingDateFilter?.addEventListener('submit', (event: any): any => {
        event.preventDefault();
        loadBillingDateRange();
    });
    for (const button of document.querySelectorAll('[data-billing-range-days]')) {
        button.addEventListener('click', (): any => {
            const days: any = Math.max(1, Number((button as HTMLElement).dataset.billingRangeDays || 1));
            const to: any = new Date();
            const from: any = new Date(to.getFullYear(), to.getMonth(), to.getDate());
            from.setDate(from.getDate() - days + 1);
            billingDateFrom.value = localDateValue(from);
            billingDateTo.value = localDateValue(to);
            loadBillingDateRange();
        });
    }
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
    const health: any = state.overview.health || {};
    const active: any = Number.isFinite(focus.inProgress) ? focus.inProgress : 0;
    const ownerActionable: any = Number.isFinite(focus.ownerActionable) ? focus.ownerActionable : (focus.next ? 1 : 0);
    const reliability: any = reliabilityPresentation(health, recordCategoryHref);
    const debt: any = businessDebtPresentation(health.businessDebt, focus, recordCategoryHref);
    overviewSummary.textContent = ownerActionable
        ? `${ownerActionable} 件事需要你决定。`
        : active
            ? `${active} 项工作正在推进；你暂时不需操作，仍请留意下方风险与质量债。`
            : '负责人当前没有待办；系统风险与业务质量债仍需分别核对。';
    const cards: any = [
        statCard('运行中', active, active ? '系统正在推进的业务工作' : '当前没有执行中的业务工作', 'clock', false, recordCategoryHref('business_active')),
        statCard('系统可靠性', reliability.value, reliability.note, reliability.icon, reliability.attention, reliability.href),
        statCard('业务质量债', debt.value, debt.note, debt.icon, debt.attention, debt.href),
    ];
    overviewStats.replaceChildren(...cards);
}
function recordCategoryHref(category: any): any {
    const params: any = new URLSearchParams({ recordView: 'all', recordCategory: category, recordTime: 'all' });
    return `/?${params}#records`;
}
function statCard(label: any, value: any, note: any, icon: any, attention: any = false, href: any = ''): any {
    const node: any = document.createElement(href ? 'a' : 'article');
    node.className = `stat-card${attention ? ' attention' : ''}${href ? ' is-link' : ''}`;
    if (href) {
        node.href = href;
        node.setAttribute('aria-label', `${label} ${value}，${note}`);
    }
    node.innerHTML = html`<div class="stat-card-head"><span>${label}</span><span class="stat-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span></div><strong class="stat-value">${value}</strong><span class="stat-note">${note}</span>`;
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
        item.innerHTML = html`<span class="recent-task-dot${raw(attention ? ' attention' : '')}"></span><span class="recent-task-title">${task.input.title}</span><span class="recent-task-status">${statusLabel(task.status)}</span>`;
        return item;
    }));
}
function renderFocus(focus: any): any {
    focusPanel.classList.remove('skeleton-panel');
    if (!focus?.total) {
        focusPanel.innerHTML = '<div class="focus-copy"><p class="focus-state is-clear">负责人暂不需处理</p><h3>还没有任务记录</h3><p>请在飞书交办，A君会在这里同步下一步；这不表示系统风险已排除。</p></div><div class="focus-guard"><span>对外发布关闭</span><span>不会静默执行</span></div>';
        return;
    }
    const current: any = focus.next;
    const needsOwner: any = isOwnerActionFocus(focus, current);
    const title: any = current ? current.title : '没有新的负责人动作';
    const action: any = current
        ? current.action
        : '历史失败和待验证记录都留在“记录”中，不会自动重试或对外发布。';
    const reason: any = current?.status === 'succeeded'
        ? '这是建议，不会自动创建后续任务。'
        : needsOwner
            ? '这件事需要你的输入或确认，系统不会替你决定。'
            : current
                ? '系统正在推进，你可以查看进度，不需要一直盯着。'
                : '当前没有任务等待你的操作；系统可靠性和质量债请看下方独立状态。';
    const primaryAction: any = current
        ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}">${current.status === 'succeeded' ? '查看这条建议' : needsOwner ? '查看并处理' : '查看进度'}</a>`
        : '<a class="focus-primary-action secondary" href="#records">打开任务记录</a>';
    const governanceReady: any = state.overview.capabilities.some((item: any): any => item.id === 'governance' && item.status === 'ready');
    const externalWriteReady: any = state.overview.capabilities.some((item: any): any => item.id === 'external-execution' && item.status === 'ready');
    const costText: any = usageCostText(state.overview.usage);
    focusPanel.innerHTML = html`
    <div class="focus-copy">
      <p class="focus-state ${raw(needsOwner ? 'needs-owner' : current ? 'is-running' : 'is-clear')}">${needsOwner ? '需要你决定' : current ? '系统正在处理' : '负责人暂不需处理'}</p>
      <h3>${title}</h3>
      <p class="focus-action-copy">${action}</p>
      <p class="focus-reason">${reason}</p>
      <div class="focus-actions">${raw(primaryAction)}</div>
    </div>
    <div class="focus-guard">
      <span>${governanceReady ? 'Paperclip 已连接' : '治理连接待恢复'}</span>
      <span>${externalWriteReady ? '对外写入按审批开放' : '对外发布关闭'}</span>
      <span>${focus.inProgress ? `${focus.inProgress} 项正在推进` : '没有执行中任务'}</span>
      <span>${costText}</span>
    </div>`;
}
function usageCostText(usage: any): any {
    const totals: any = usage?.cost?.totals || [];
    if (!usage?.cost?.reportedTaskCount || !totals.length)
        return '今日费用未上报';
    return `今日已上报费用 ${totals.map((item: any): any => `${item.amount} ${item.currency}`).join(' · ')}`;
}
function isDirectEmployee(agent: any): any {
    return agent.acceptedTaskTypes?.some((type: any): any => directEmployeeTaskTypes.includes(type));
}
function isPrimaryEmployee(agent: any): any {
    return agent.agentId === 'ajun' || isDirectEmployee(agent) || agent.capabilityTruth?.overall === 'human_accepted';
}
function agentGroupTitle(title: any, detail: any): any {
    const node: any = document.createElement('div');
    node.className = 'agent-group-title';
    node.innerHTML = html`<strong>${title}</strong><span>${detail}</span>`;
    return node;
}
function agentCard(agent: any, support: any): any {
    const node: any = document.createElement('article');
    node.className = `agent${support ? ' support-agent' : ''}`;
    const types: any = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · ');
    const summaryTypes: any = agent.acceptedTaskTypes.slice(0, 2).map(taskTypeLabel).join(' · ') || '职责待核对';
    const independent: any = independentRuntimeLabel(agent);
    const truth: any = capabilityTruthLabel(agent.capabilityTruth);
    node.innerHTML = html`
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
function backgroundEmployeeDisclosure(agents: any): any {
    const node: any = document.createElement('details');
    node.className = 'background-employees-disclosure';
    node.dataset.disclosureKey = 'employees:background';
    const title: any = agents.some((agent: any): any => agent.capabilityTruth?.overall !== 'human_accepted')
        ? '后台岗位与待人工验收'
        : '后台岗位';
    node.innerHTML = html`<summary><span><strong>${title}</strong><small>${agents.length} 位，不是日常派活入口</small></span><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="agent-grid background-agent-grid"></div>`;
    node.querySelector('.background-agent-grid')?.replaceChildren(...agents.map((agent: any): any => agentCard(agent, true)));
    return node;
}
function capabilityCard(item: any): any {
    const node: any = document.createElement('article');
    const truth: any = capabilityPresentation(item);
    node.className = `capability-card capability-${truth.level}`;
    node.innerHTML = html`<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><span class="capability-truth ${truth.level}">${truth.label}</span><h3>${item.name}</h3><p title="${item.detail}">${item.detail}</p><small>${truth.note}</small>`;
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
    return presentTaskTypeLabel(type, state.overview?.agents || []);
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
    statusLabel,
    formatDate,
    providerLabel,
    agentName,
    replaceChildrenPreservingDisclosureState,
    setTextIfChanged,
    modelPolicyConsole:createStepFunModelPolicyConsole({ root:modelPolicyRoot, api }),
});
recordWorkbench = createTaskRecordWorkbench({
    api,
    getAgents: (): any => state.overview?.agents || [],
    taskTypeLabel,
    agentName,
    initialTaskId: state.selectedTaskId,
});
boomMonitor = createBoomMonitorConsole({
    root: document.querySelector('#module-boom-monitor'),
    api,
    formatDate,
});
runtimeReleaseConsole = createRuntimeReleaseConsole({
    root:document.querySelector('#module-release'),
    api,
});
bindBillingDateControls();
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
