import { canRefreshConsole, startRefreshScheduler } from './refresh-scheduler.js';
import { bindRefreshProtectedForms } from './refresh-scheduler.js';
import { bindAccessGateInteractions } from './interactions/access-gate-interactions.js';
import { bindAiControlInteractions } from './interactions/ai-control-interactions.js';
import { bindEmployeeInteractions } from './interactions/employee-interactions.js';
import { bindAccessConnectionInteractions } from './interactions/access-connection-interactions.js';
import { bindCampaignInteractions } from './interactions/campaign-interactions.js';

export function bindConsoleInteractions({ elements, state, api, load, setSyncStatus, moduleNavigation, accessViews, }: any): any {
    const { accessForm, accessLoginForm, accessGate, }: any = elements;
    bindAccessGateInteractions({ elements, state, api, load });
    bindAiControlInteractions({ elements, api, accessViews });
    bindEmployeeInteractions({ elements, api, accessViews, load });
    bindAccessConnectionInteractions({ elements, state, api, accessViews });
    bindCampaignInteractions({ elements, api, accessViews, load });
    window.addEventListener('hashchange', moduleNavigation.locationChanged);
    bindRefreshProtectedForms({ page: document });
    startRefreshScheduler({
        refresh: load,
        canRefresh: (): any => canRefreshConsole({
            page: document,
            accessGate,
            forms: [accessForm, accessLoginForm],
        }),
        intervalMs: 15000,
        onDegraded: (failures: any): any => {
            const syncBadge: any = document.querySelector('.sync-badge');
            const syncIndicator: any = document.querySelector('#sync-indicator');
            const syncStatus: any = document.querySelector('#sync-status');
            syncBadge?.classList.add('is-degraded');
            if (syncIndicator) syncIndicator.className = 'sync-indicator error';
            if (syncStatus) syncStatus.textContent = '连接不稳定';
        },
        onRecovered: (): any => {
            const syncBadge: any = document.querySelector('.sync-badge');
            syncBadge?.classList.remove('is-degraded');
        },
    });
    accessViews.setAccessStep(1);
    load().catch((error: any): any => {
        setSyncStatus(error.message, 'error');
    });
}
