import { BILLING_PAGE_SIZE, filterBillingEntries } from './billing-entry-filter.js';

const VIEW_LABELS: Record<string, string> = {
    all: '全部',
    task: '任务',
    agent_session: 'Agent 会话',
    system: '系统',
    unattributed: '未识别',
};

export function createBillingLedgerWorkbench({ agentName, formatDate, formatNumber, formatUsd, escapeHtml }: any): any {
    const elements: any = {
        root: document.querySelector('#billing-workbench'),
        list: document.querySelector('#billing-entry-list'),
        detail: document.querySelector('#billing-entry-detail'),
        count: document.querySelector('#billing-entry-count'),
        context: document.querySelector('#billing-list-context'),
        search: document.querySelector('#billing-search'),
        agentFilter: document.querySelector('#billing-agent-filter'),
        loadMore: document.querySelector('#billing-load-more'),
        viewButtons: [...document.querySelectorAll('[data-billing-view]')],
    };
    const state: any = {
        entries: [], query: '', agentId: '', view: 'all', visible: BILLING_PAGE_SIZE,
        selectedRef: '', detailOpen: false,
    };

    elements.list.addEventListener('click', (event: any): any => {
        const row: any = event.target.closest('[data-billing-entry-ref]');
        if (!row)
            return;
        state.selectedRef = row.dataset.billingEntryRef;
        state.detailOpen = true;
        render();
    });
    elements.loadMore.addEventListener('click', (): any => {
        state.visible += BILLING_PAGE_SIZE;
        render();
    });
    for (const button of elements.viewButtons) {
        button.addEventListener('click', (): any => reset({ view: button.dataset.billingView }));
    }
    elements.search.addEventListener('input', (): any => reset({ query: elements.search.value }));
    elements.agentFilter.addEventListener('change', (): any => reset({ agentId: elements.agentFilter.value }));

    function reset(next: any): any {
        Object.assign(state, next, { visible: BILLING_PAGE_SIZE, selectedRef: '', detailOpen: false });
        render();
    }

    function setEntries(entries: any): any {
        state.entries = Array.isArray(entries) ? entries : [];
        render();
    }

    function setUnavailable(): any {
        state.entries = [];
        state.selectedRef = '';
        state.detailOpen = false;
        elements.list.replaceChildren(empty('暂时没有可展示的消费流水。'));
        elements.count.textContent = '读取失败';
        elements.context.textContent = '请稍后重试';
        elements.loadMore.hidden = true;
        renderDetail(null);
    }

    function render(): any {
        const filtered: any = filterBillingEntries(state.entries, state);
        const visible: any = filtered.slice(0, state.visible);
        if (!visible.some((entry: any): any => entry.ledgerRef === state.selectedRef))
            state.selectedRef = visible[0]?.ledgerRef || '';
        const selected: any = visible.find((entry: any): any => entry.ledgerRef === state.selectedRef) || null;
        elements.list.replaceChildren(...(visible.length
            ? visible.map((entry: any): any => entryRow(entry, entry === selected))
            : [empty('没有匹配的消费流水。')]));
        elements.count.textContent = `${filtered.length} 条流水`;
        elements.context.textContent = visible.length < filtered.length ? `已显示 ${visible.length} 条` : '按时间排列';
        elements.loadMore.hidden = visible.length >= filtered.length;
        elements.loadMore.textContent = `继续加载（已显示 ${visible.length}/${filtered.length}）`;
        renderTabs();
        renderAgentFilter();
        renderDetail(selected);
        elements.root.classList.toggle('is-detail-open', Boolean(state.detailOpen && selected));
    }

    function renderTabs(): any {
        const counts: any = Object.fromEntries(['task', 'agent_session', 'system', 'unattributed'].map((status: any): any => [
            status, state.entries.filter((entry: any): any => attributionStatus(entry) === status).length,
        ]));
        counts.all = state.entries.length;
        for (const button of elements.viewButtons) {
            const active: any = button.dataset.billingView === state.view;
            button.textContent = `${VIEW_LABELS[button.dataset.billingView]} ${counts[button.dataset.billingView]}`;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
    }

    function renderAgentFilter(): any {
        const ids: any = [...new Set(state.entries.map((entry: any): any => entry.agentId).filter(Boolean))];
        elements.agentFilter.replaceChildren(option('', '全部员工'), ...ids.map((id: any): any => option(id, agentName(id))));
        elements.agentFilter.value = ids.includes(state.agentId) ? state.agentId : '';
    }

    function entryRow(entry: any, selected: any): any {
        const node: any = document.createElement('button');
        const status: any = attributionStatus(entry);
        node.type = 'button';
        node.className = `billing-entry-row ${status}${selected ? ' is-selected' : ''}`;
        node.dataset.billingEntryRef = entry.ledgerRef;
        node.setAttribute('role', 'option');
        node.setAttribute('aria-selected', String(selected));
        node.innerHTML = `<span class="billing-entry-main"><span>${escapeHtml(formatDate(entry.occurredAt))}</span><strong>${escapeHtml(agentName(entry.agentId))} · ${escapeHtml(entry.model || '未知模型')}</strong><small>${formatNumber(entry.apiCalls)} 次请求 · ${formatNumber(tokenTotal(entry))} Token</small><span class="billing-attribution-label ${status}">${escapeHtml(attributionLabel(status))}</span></span><b>${escapeHtml(costLabel(entry))}</b>`;
        return node;
    }

    function renderDetail(entry: any): any {
        if (!entry) {
            elements.detail.innerHTML = '<div class="record-detail-empty"><svg aria-hidden="true"><use href="#icon-cost"></use></svg><p>选择一条流水查看用量和归属</p></div>';
            return;
        }
        const status: any = attributionStatus(entry);
        const tokens: any = entry.tokens || {};
        const attribution: any = entry.attribution || {};
        const source: any = status === 'task'
            ? `<a class="billing-task-link" href="/tasks/${encodeURIComponent(attribution.taskId)}">${escapeHtml(attribution.taskRef || '任务')} · ${escapeHtml(attribution.taskTitle || '未命名任务')}</a>`
            : `<p>${escapeHtml(attributionDescription(status))}</p>`;
        elements.detail.innerHTML = `
          <button class="record-detail-back" type="button">← 返回流水</button>
          <header class="record-detail-header">
            <div class="record-detail-kicker"><span class="record-row-status ${status === 'unattributed' ? 'attention' : 'success'}">${escapeHtml(attributionLabel(status))}</span><span>${escapeHtml(formatDate(entry.occurredAt))}</span></div>
            <h2>${escapeHtml(agentName(entry.agentId))} · ${escapeHtml(entry.model || '未知模型')}</h2>
            <div class="record-detail-meta"><span>${escapeHtml(entry.provider || 'Provider 未记录')}</span><span>${escapeHtml(entry.usageClass || 'main')}</span></div>
          </header>
          <div class="record-decision"><span>本条费用</span><strong>${escapeHtml(costLabel(entry))}</strong></div>
          <section class="record-detail-section"><h3>本次用量</h3><dl class="billing-detail-metrics">
            ${metric('请求', `${formatNumber(entry.apiCalls)} 次`)}${metric('输入', `${formatNumber(tokens.input)} Token`)}${metric('输出', `${formatNumber(tokens.output)} Token`)}${metric('缓存', `${formatNumber(Number(tokens.cacheRead || 0) + Number(tokens.cacheWrite || 0))} Token`)}${metric('推理', `${formatNumber(tokens.reasoning)} Token`)}${metric('合计', `${formatNumber(tokenTotal(entry))} Token`)}
          </dl></section>
          <section class="record-detail-section"><h3>归属</h3>${source}</section>
          <details class="record-technical"><summary>查看技术记录</summary><dl>
            ${technical('会话', entry.sessionId)}${technical('账本编号', entry.ledgerRef)}${technical('费用来源', entry.cost?.source || '未记录')}
          </dl></details>`;
        elements.detail.querySelector('.record-detail-back')?.addEventListener('click', (): any => {
            state.detailOpen = false;
            elements.root.classList.remove('is-detail-open');
        });
    }

    function metric(label: any, value: any): any {
        return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
    }
    function technical(label: any, value: any): any {
        return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '未记录')}</dd></div>`;
    }
    function costLabel(entry: any): any {
        return entry.cost?.status === 'actual' ? `${formatUsd(entry.cost.amountUsd)} 实际`
            : entry.cost?.status === 'estimated' ? `${formatUsd(entry.cost.amountUsd)} 估算`
                : entry.cost?.status === 'included' ? '套餐内' : '金额未知';
    }
    function tokenTotal(entry: any): any {
        const tokens: any = entry.tokens || {};
        return Number(tokens.input || 0) + Number(tokens.output || 0) + Number(tokens.cacheRead || 0) + Number(tokens.cacheWrite || 0) + Number(tokens.reasoning || 0);
    }
    function attributionStatus(entry: any): any {
        return ['task', 'agent_session', 'system'].includes(entry.attribution?.status) ? entry.attribution.status : 'unattributed';
    }
    function attributionLabel(status: any): any {
        return ({ task: '业务任务', agent_session: '独立 Agent 会话', system: '系统调用', unattributed: '未识别来源' } as Record<string, string>)[status];
    }
    function attributionDescription(status: any): any {
        return ({ agent_session: '这条用量属于独立 Agent 会话，尚未精确关联某个业务任务。', system: '这条用量由系统流程产生，不属于人工交办的业务任务。', unattributed: '目前无法可靠判断这条用量来自哪个任务或系统流程。' } as Record<string, string>)[status] || '来源待确认。';
    }
    function option(value: any, label: any): any {
        const node: any = document.createElement('option');
        node.value = value;
        node.textContent = label;
        return node;
    }
    function empty(message: any): any {
        const node: any = document.createElement('p');
        node.className = 'billing-empty';
        node.textContent = message;
        return node;
    }

    return { setEntries, setUnavailable };
}
