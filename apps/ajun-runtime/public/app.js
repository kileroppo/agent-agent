import { markSyncStarted, replaceChildrenPreservingDisclosureState, setTextIfChanged } from './disclosure-state.js';
import { createConsoleNavigation } from './console-navigation.js';
import { createAccessViews } from './app-access-views.js';
import { bindConsoleInteractions } from './app-interactions.js';
import { createBoomMonitorConsole } from './boom-monitor-console.js';
import { createBillingLedgerWorkbench } from './billing-ledger-workbench.js';
import { startBrowserHotReload } from './hot-reload-client.js';
import { createTaskRecordWorkbench } from './task-record-workbench.js';
import { createStepFunModelPolicyConsole } from './stepfun-model-policy-console.js';
import { createRuntimeReleaseConsole } from './runtime-release-console.js';
import { canRefreshConsole } from './refresh-scheduler.js';
import { statusLabel, taskTypeLabel as presentTaskTypeLabel } from './console-labels.js';
import { createBillingUsageCache } from './billing-usage-cache.js';
import { formatNumber, formatCompactNumber, formatUsd, formatDate, providerLabel } from './format-utils.js';
import { initNightMode } from './night-mode.js';
import { injectContextNavigation } from './context-nav-injection.js';
import { createEmployeeView } from './employee-view.js';
import { createOverviewView } from './overview-view.js';
import { createBillingView } from './billing-view.js';
// 1. Initialize night mode & inject context navigation
initNightMode();
injectContextNavigation();
// 2. Query DOM Elements
const capabilityList = document.querySelector('#capability-list');
const agentList = document.querySelector('#agent-list');
const recentTaskList = document.querySelector('#recent-task-list');
const overviewStats = document.querySelector('#overview-stats');
const chainDiagnosis = document.querySelector('#chain-diagnosis');
const overviewSummary = document.querySelector('#overview-summary');
const billingSummary = document.querySelector('#billing-summary');
const billingStats = document.querySelector('#billing-stats');
const billingCostHealth = document.querySelector('#billing-cost-health');
const billingAttribution = document.querySelector('#billing-attribution');
const billingProfileList = document.querySelector('#billing-profile-list');
const billingDateFilter = document.querySelector('#billing-date-filter');
const billingDateFrom = document.querySelector('#billing-date-from');
const billingDateTo = document.querySelector('#billing-date-to');
const billingDateMessage = document.querySelector('#billing-date-message');
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
const syncBadge = document.querySelector('.sync-badge');
const syncStatus = document.querySelector('#sync-status');
const syncIndicator = document.querySelector('#sync-indicator');
const employeeConnections = document.querySelector('#employee-connections');
const employeeConnectionList = document.querySelector('#employee-connection-list');
const modelPolicyRoot = document.querySelector('#hermes-model-management');
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
const contextLinks = [...document.querySelectorAll('[data-context-page]')];
const ownerOnlyElements = [...document.querySelectorAll('[data-owner-only]')];
const accessStepPanels = [...document.querySelectorAll('[data-access-step-panel]')];
const accessStepIndicators = [...document.querySelectorAll('[data-access-step-indicator]')];
const accessStepNext2 = document.querySelector('#access-step-next-2');
const accessStepNext3 = document.querySelector('#access-step-next-3');
const accessStepBack1 = document.querySelector('#access-step-back-1');
const accessStepBack2 = document.querySelector('#access-step-back-2');
// 3. Configuration & Constants
const directEmployeeTaskTypes = [
    'media.transcribe-and-refine',
    'report.public-material',
    'research.intel-report',
    'office.briefing-package',
    'office.presentation-package'
];
const ownerOnlyModules = new Set(['connections', 'campaigns', 'billing', 'release', 'boom-monitor', 'tools']);
function taskIdFromPath(pathname) {
    return pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}
// 4. Application State
const state = {
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
function agentName(agentId) {
    return state.overview?.agents.find((agent) => agent.agentId === agentId)?.name || '等待分配';
}
// 5. Views and Workbenches Initialization
const employeeView = createEmployeeView({
    directEmployeeTaskTypes,
    presentTaskTypeLabel,
    getAgents: () => state.overview?.agents || [],
});
function taskTypeLabel(type) {
    return employeeView.taskTypeLabel(type);
}
const moduleNavigation = createConsoleNavigation({
    getHash: () => location.hash,
    getPathname: () => location.pathname,
    replaceLocation: (value) => history.replaceState(null, '', value),
    activate: activateModule,
});
async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.shareKey)
        headers.set('x-ajun-share-key', state.shareKey);
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json();
    if (!response.ok) {
        const error = new Error(payload.detail || payload.error || '请求失败。');
        error.status = response.status;
        throw error;
    }
    return payload;
}
function setSyncStatus(message, syncState) {
    const quiet = syncState === 'synced';
    syncStatus.textContent = quiet ? '已同步' : message;
    syncIndicator.className = `sync-indicator ${syncState}`;
    syncBadge?.classList.toggle('is-quiet', quiet);
}
const overviewView = createOverviewView({
    elements: {
        capabilityList,
        agentList,
        recentTaskList,
        overviewStats,
        overviewSummary,
        chainDiagnosis,
        focusPanel,
        capabilitySummary,
        replaceChildrenPreservingDisclosureState,
    },
    state,
    api,
    employeeView,
    formatDate,
});
const billingLedgerWorkbench = createBillingLedgerWorkbench({ agentName, formatDate, formatNumber, formatUsd });
const billingUsageCache = createBillingUsageCache({ load: () => api('/api/usage') });
const billingView = createBillingView({
    elements: {
        billingSummary,
        billingStats,
        billingCostHealth,
        billingAttribution,
        billingProfileList,
        billingDateFilter,
        billingDateFrom,
        billingDateTo,
        billingDateMessage,
        syncBadge,
    },
    api,
    billingUsageCache,
    billingLedgerWorkbench,
    agentName,
    overviewView,
});
let boomMonitor;
let recordWorkbench;
let runtimeReleaseConsole;
async function load({ background = false } = {}) {
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
        await accessViews.renderTaskSubmitForm();
        overviewView.render();
        recordWorkbench?.updateFilterOptions();
        updateOwnerNavigation();
        moduleNavigation.initialize();
        if (background)
            await recordWorkbench?.refresh({ background: true });
        setSyncStatus(`已同步 · ${new Date().toLocaleTimeString()}`, 'synced');
        document.body.classList.remove('is-loading');
    }
    catch (error) {
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
function updateOwnerNavigation() {
    for (const element of ownerOnlyElements)
        element.hidden = !state.localOwner;
    if (!state.localOwner && ownerOnlyModules.has(location.hash.slice(1)))
        activateModule('overview', { navigationGroup: 'overview', replaceHash: true });
}
function activateModule(name, { navigationGroup = '', replaceHash = false } = {}) {
    const virtualPage = name === 'system'
        ? state.localOwner ? 'connections' : 'employees'
        : name === 'tools' ? 'boom-monitor' : name;
    const requested = modulePages.some((page) => page.dataset.modulePage === virtualPage) ? virtualPage : 'overview';
    const selected = ownerOnlyModules.has(requested) && !state.localOwner ? 'overview' : requested;
    const selectedGroup = selected === 'overview'
        ? 'overview'
        : selected === 'records'
            ? 'records'
            : ['employees', 'connections', 'billing', 'release'].includes(selected)
                ? 'system'
                : ['campaigns', 'boom-monitor'].includes(selected)
                    ? 'tools'
                    : navigationGroup || 'overview';
    for (const link of moduleLinks) {
        const active = link.dataset.module === selectedGroup;
        link.classList.toggle('is-active', active);
        if (active)
            link.setAttribute('aria-current', 'page');
        else
            link.removeAttribute('aria-current');
    }
    for (const page of modulePages) {
        const active = page.dataset.modulePage === selected;
        page.classList.toggle('is-active', active);
        page.setAttribute('aria-hidden', String(!active));
    }
    for (const link of contextLinks) {
        const active = link.dataset.contextPage === selected;
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
        accessViews?.renderContentCampaigns().catch((error) => setSyncStatus(error.message, 'error'));
    if (selected === 'billing')
        billingView.loadBilling().catch((error) => setSyncStatus(error.message, 'error'));
    if (selected === 'release')
        runtimeReleaseConsole?.activate();
    else
        runtimeReleaseConsole?.deactivate();
    recordWorkbench?.setActive(selected === 'records').catch((error) => setSyncStatus(error.message, 'error'));
    if (replaceHash && location.hash !== '#now')
        history.replaceState(null, '', '#now');
}
function moduleTitle(name) {
    return { overview: '现在', employees: '员工', connections: '账号与接入', campaigns: '发布活动', billing: 'AI 成本账本', release: '版本管理', 'boom-monitor': '爆款雷达', records: '运行记录' }[name] || '现在';
}
const elements = {
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
const accessViews = createAccessViews({
    elements,
    state,
    api,
    statusLabel,
    formatDate,
    providerLabel,
    agentName,
    replaceChildrenPreservingDisclosureState,
    setTextIfChanged,
    modelPolicyConsole: createStepFunModelPolicyConsole({ root: modelPolicyRoot, api }),
});
recordWorkbench = createTaskRecordWorkbench({
    api,
    getAgents: () => state.overview?.agents || [],
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
    root: document.querySelector('#module-release'),
    api,
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
