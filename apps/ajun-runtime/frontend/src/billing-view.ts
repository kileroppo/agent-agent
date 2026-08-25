import { html } from './html.js';
import { formatNumber, formatCompactNumber, formatUsd, formatDate } from './format-utils.js';

export function createBillingView({ elements, api, billingUsageCache, billingLedgerWorkbench, agentName, overviewView }: any): any {
    const { billingSummary, billingStats, billingCostHealth, billingAttribution, billingProfileList, billingDateFilter, billingDateFrom, billingDateTo, billingDateMessage } = elements;
    const { syncBadge } = elements;

    function isAlertDismissed(key: string): boolean {
        try {
            return localStorage.getItem(`ajun_dismiss_billing_${key}`) === 'true';
        } catch {
            return false;
        }
    }

    function dismissAlert(key: string): void {
        try {
            localStorage.setItem(`ajun_dismiss_billing_${key}`, 'true');
        } catch {}
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
            billingStats.replaceChildren(overviewView.statCard('可核金额', '未知', '等待用量库恢复', 'cost', true), overviewView.statCard('模型请求', '未知', '暂时无法读取', 'clock'), overviewView.statCard('Token', '未知', '暂时无法读取', 'records'));
            renderBillingCostHealth(null);
            billingAttribution.hidden = false;
            billingAttribution.innerHTML = '<div><strong>账本暂不可用</strong><span>任务记录仍保留，但暂时无法核对全部模型消耗。</span></div>';
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
        billingStats.replaceChildren(overviewView.statCard('可核金额', knownCostCount ? formatUsd(cost.knownUsd) : '未知', costNote, 'cost'), overviewView.statCard('模型请求', formatNumber(totals.apiCalls), `${formatNumber(totals.sessionCount)} 个会话`, 'clock'), overviewView.statCard('Token', formatCompactNumber(tokens.total), `输入、输出与缓存合计 ${formatNumber(tokens.total)}`, 'records'));
        renderBillingCostHealth(billing.health);
        const taskEntries: any = Number(billing.attribution?.taskEntryCount ?? billing.attribution?.attributedEntryCount ?? 0);
        const agentSessions: any = Number(billing.attribution?.agentSessionEntryCount || 0);
        const systemEntries: any = Number(billing.attribution?.systemEntryCount || 0);
        const unattributed: any = Number(billing.attribution?.unattributedEntryCount || 0);
        const providerReconciliation: any = billing.providerReconciliation || { status: 'not_configured' };
        const providerCoverageMissing: any = providerReconciliation.status !== 'matched';
        const healthAlerts: any[] = Array.isArray(billing.health?.alerts) ? billing.health.alerts : [];
        const healthHasProviderNotice = healthAlerts.some((a: any): any => a.code === 'provider_total_not_reconciled' || a.code === 'provider_usage_gap');
        const duplicateProviderNotice = !isAlertDismissed('cost-health') && healthHasProviderNotice && providerCoverageMissing && unattributed === 0;
        const shouldShowAttribution = !isAlertDismissed('attribution') && (unattributed > 0 || (providerCoverageMissing && !duplicateProviderNotice));
        billingAttribution.hidden = !shouldShowAttribution;
        billingAttribution.classList.toggle('attention', unattributed > 0 || providerCoverageMissing);
        if (shouldShowAttribution) {
            billingAttribution.innerHTML = providerReconciliation.status === 'gap'
                ? `<div><strong>发现 ${formatNumber(providerReconciliation.untrackedApiCalls)} 次账外调用</strong><span>Provider 总账比本系统多 ${formatNumber(providerReconciliation.untrackedTokens)} Token；这些调用尚未归属到任务或岗位。</span></div><div class="billing-alert-actions"><a class="secondary-action" href="https://platform.stepfun.com/" target="_blank" rel="noreferrer">打开 StepFun 后台核对</a><button type="button" class="billing-alert-dismiss" aria-label="关闭提示" title="关闭">×</button></div>`
                : providerCoverageMissing
                    ? '<div><strong>这里只是受管岗位的局部账本</strong><span>尚未接入 StepFun 全账号总量；这里显示 0 次，也不能说明账号今天没有调用。</span></div><div class="billing-alert-actions"><a class="secondary-action" href="https://platform.stepfun.com/" target="_blank" rel="noreferrer">打开 StepFun 后台核对</a><button type="button" class="billing-alert-dismiss" aria-label="关闭提示" title="关闭">×</button></div>'
                    : unattributed
                ? `<div><strong>${unattributed} 条消费仍未识别来源</strong><span>${taskEntries} 条关联业务任务，${agentSessions} 条属于独立 Agent 会话，${systemEntries} 条属于系统调用。</span></div><div class="billing-alert-actions"><button type="button" class="secondary-action">只看未识别</button><button type="button" class="billing-alert-dismiss" aria-label="关闭提示" title="关闭">×</button></div>`
                : '';
            billingAttribution.querySelector('.billing-alert-dismiss')?.addEventListener('click', (): any => {
                dismissAlert('attribution');
                billingAttribution.hidden = true;
            });
            billingAttribution.querySelector('button.secondary-action')?.addEventListener('click', (): any => focusBillingLedger({ view: 'unattributed' }));
        }
        const profiles: any = Array.isArray(billing.profiles) ? billing.profiles : [];
        billingProfileList.replaceChildren(...(profiles.length ? profiles.map(billingProfileRow) : [billingEmpty('当前范围没有岗位模型用量。')]));
        billingLedgerWorkbench.setEntries(Array.isArray(billing.entries) ? billing.entries : []);
    }
    function renderBillingCostHealth(health: any): any {
        billingCostHealth.className = 'billing-cost-health';
        const alerts: any[] = Array.isArray(health?.alerts) ? health.alerts : [];
        if ((health?.status === 'healthy' && alerts.length === 0) || isAlertDismissed('cost-health')) {
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
        const dismissBtn: any = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'billing-alert-dismiss';
        dismissBtn.setAttribute('aria-label', '关闭提示');
        dismissBtn.setAttribute('title', '关闭');
        dismissBtn.textContent = '×';
        dismissBtn.addEventListener('click', (): any => {
            dismissAlert('cost-health');
            billingCostHealth.hidden = true;
        });
        actions.append(dismissBtn);
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

    // Bind date controls on creation
    bindBillingDateControls();

    return {
        loadBilling,
        renderBilling,
    };
}
