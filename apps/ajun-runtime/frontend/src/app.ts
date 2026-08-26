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
const capabilityList: any = document.querySelector('#capability-list');
const agentList: any = document.querySelector('#agent-list');
const recentTaskList: any = document.querySelector('#recent-task-list');
const overviewStats: any = document.querySelector('#overview-stats');
const chainDiagnosis: any = document.querySelector('#chain-diagnosis');
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

// 3. Configuration & Constants
const directEmployeeTaskTypes: any = [
    'media.transcribe-and-refine',
    'report.public-material',
    'research.intel-report',
    'office.briefing-package',
    'office.presentation-package'
];
const ownerOnlyModules: any = new Set(['connections', 'campaigns', 'billing', 'release', 'boom-monitor', 'tools']);

function taskIdFromPath(pathname: any): any {
    return pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}

// 4. Application State
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

function agentName(agentId: any): any {
    return state.overview?.agents.find((agent: any): any => agent.agentId === agentId)?.name || '等待分配';
}

// 5. Views and Workbenches Initialization
const employeeView: any = createEmployeeView({
    directEmployeeTaskTypes,
    presentTaskTypeLabel,
    getAgents: (): any => state.overview?.agents || [],
});

function taskTypeLabel(type: any): any {
    return employeeView.taskTypeLabel(type);
}

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

function setSyncStatus(message: any, syncState: any): any {
    const quiet: any = syncState === 'synced';
    syncStatus.textContent = quiet ? '已同步' : message;
    syncIndicator.className = `sync-indicator ${syncState}`;
    syncBadge?.classList.toggle('is-quiet', quiet);
}

const overviewView: any = createOverviewView({
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

const billingLedgerWorkbench: any = createBillingLedgerWorkbench({ agentName, formatDate, formatNumber, formatUsd });
const billingUsageCache: any = createBillingUsageCache({ load: (): any => api('/api/usage') });

const billingView: any = createBillingView({
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

let boomMonitor: any;
let recordWorkbench: any;
let runtimeReleaseConsole: any;

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
        ? 'release'
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
        billingView.loadBilling().catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (selected === 'release')
        runtimeReleaseConsole?.activate();
    else
        runtimeReleaseConsole?.deactivate();
    recordWorkbench?.setActive(selected === 'records').catch((error: any): any => setSyncStatus(error.message, 'error'));
    if (replaceHash && location.hash !== '#now')
        history.replaceState(null, '', '#now');
}

function moduleTitle(name: any): any {
    return ({
        overview: '总览',
        employees: '员工编队',
        connections: '账号接入',
        campaigns: '发布活动',
        billing: 'AI 成本账本',
        release: '版本管理',
        'boom-monitor': '爆款雷达',
        records: '任务记录'
    } as Record<string, string>)[name] || '总览';
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
    modelPolicyConsole: createStepFunModelPolicyConsole({ root: modelPolicyRoot, api }),
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
