import { taskStatusGroup } from './task-record-filter.js';
import { statusLabel } from './console-labels.js';
import { businessDebtPresentation, capabilityPresentation, capabilitySummaryText, countCapabilityTiers, isOwnerActionFocus, managerFirstEmployees, reliabilityPresentation } from './overview-presentation.js';
import { html, raw, escapeHtml } from './html.js';
export function createOverviewView({ elements, state, api, employeeView, formatDate }) {
    const { capabilityList, agentList, recentTaskList, overviewStats, overviewSummary, chainDiagnosis, focusPanel, capabilitySummary } = elements;
    const { replaceChildrenPreservingDisclosureState } = elements;
    function render() {
        renderFocus(state.overview.taskFocus);
        renderOverviewStats();
        capabilityList.replaceChildren(...state.overview.capabilities.map((item) => capabilityCard(item)));
        const capabilityTiers = countCapabilityTiers(state.overview.capabilities);
        capabilitySummary.textContent = capabilitySummaryText(capabilityTiers);
        const employees = managerFirstEmployees(state.overview.manager, state.overview.agents);
        const directEmployees = employees.filter(employeeView.isPrimaryEmployee);
        const supportEmployees = employees.filter((agent) => !employeeView.isPrimaryEmployee(agent));
        replaceChildrenPreservingDisclosureState(agentList, [
            employeeView.agentGroupTitle('业务结果入口', '日常派活去飞书；这里查看状态、验收和恢复'),
            ...directEmployees.map((agent) => employeeView.agentCard(agent, false)),
            ...(supportEmployees.length ? [employeeView.backgroundEmployeeDisclosure(supportEmployees)] : [])
        ]);
        renderRecentTasks(state.overview.recentTasks || []);
    }
    function renderOverviewStats() {
        const focus = state.overview.taskFocus || {};
        const health = state.overview.health || {};
        const active = Number.isFinite(focus.inProgress) ? focus.inProgress : 0;
        const ownerActionable = Number.isFinite(focus.ownerActionable) ? focus.ownerActionable : (focus.next ? 1 : 0);
        const reliability = reliabilityPresentation(health, recordCategoryHref);
        const debt = businessDebtPresentation(health.businessDebt, focus, recordCategoryHref);
        overviewSummary.textContent = ownerActionable
            ? `${ownerActionable} 件事需要你决定。`
            : active
                ? `${active} 项工作正在推进，你暂时不需操作。`
                : '负责人当前没有待办。';
        const cards = [
            statCard('运行中', active, active ? '系统正在推进的业务工作' : '当前没有执行中的业务工作', 'clock', false, recordCategoryHref('business_active')),
            statCard('系统可靠性', reliability.value, reliability.note, reliability.icon, reliability.attention, reliability.href),
            statCard('业务质量债', debt.value, debt.note, debt.icon, debt.attention, debt.href),
        ];
        overviewStats.replaceChildren(...cards);
        renderChainDiagnosis(health);
    }
    function renderChainDiagnosis(health) {
        if (!chainDiagnosis)
            return;
        const coreStatus = typeof health?.coreOnline === 'string' ? health.coreOnline : (health?.coreOnline?.status || 'unknown');
        const isHealthy = coreStatus === 'online' && (health?.reliability === 'healthy' || health?.reliability?.status === 'healthy');
        if (isHealthy) {
            chainDiagnosis.hidden = true;
            chainDiagnosis.replaceChildren();
            return;
        }
        chainDiagnosis.hidden = false;
        // 诊断已创建后不再随首页轮询重建，避免展开内容短暂回到“正在加载”。
        const existing = chainDiagnosis.querySelector('.chain-diagnosis-disclosure');
        if (existing) {
            if (existing.open)
                fetchChainDiagnosis();
            return;
        }
        const holder = document.createElement('div');
        holder.innerHTML = html `<details class="chain-diagnosis-disclosure" data-disclosure-key="chain-diagnosis"><summary><strong>飞书链路需要检查</strong><small>展开看下一步</small><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="chain-diagnosis-body"><p>展开后读取本机诊断。</p></div></details>`;
        const disclosure = holder.firstElementChild;
        disclosure.addEventListener('toggle', () => {
            if (disclosure.open)
                fetchChainDiagnosis();
        });
        chainDiagnosis.replaceChildren(disclosure);
    }
    async function fetchChainDiagnosis() {
        if (!chainDiagnosis)
            return;
        const body = chainDiagnosis.querySelector('.chain-diagnosis-body');
        if (!body || body.dataset.loaded === 'true')
            return;
        try {
            const diagnosis = await api('/api/diagnose/feishu-chain');
            const checks = Array.isArray(diagnosis.checks) ? diagnosis.checks : [];
            const checkItems = checks.map((check) => {
                const icon = check.status === 'passing' ? 'check' : check.status === 'failed' ? 'alert' : 'clock';
                const conclusion = String(check.conclusion || '').trim();
                return html `<li class="chain-check-item ${check.status}"><svg class="chain-check-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg><div class="chain-check-copy"><strong>${check.title}</strong>${raw(conclusion ? `<small title="真相层级：${escapeHtml(check.truthLayer)}">${conclusion}</small>` : '')}</div></li>`;
            }).join('');
            const caveat = diagnosis.verdictCaveat ? html `<small>${diagnosis.verdictCaveat}</small>` : '';
            const nextStep = diagnosis.uniqueNextStep ? html `<p class="chain-next-step"><strong>唯一下一步：</strong>${diagnosis.uniqueNextStep}</p>` : '';
            body.dataset.loaded = 'true';
            body.innerHTML = html `<p class="chain-verdict"><strong>${chainVerdictLabel(diagnosis.verdict)}</strong>${raw(caveat)}</p><ul class="chain-check-list">${raw(checkItems)}</ul>${raw(nextStep)}`;
        }
        catch (error) {
            body.innerHTML = html `<p class="chain-diagnosis-error">链路诊断加载失败：${error.message || '未知错误'}</p>`;
        }
    }
    function chainVerdictLabel(verdict) {
        return {
            blocking_gap: '发现阻断问题',
            no_local_gap_found: '本机检查通过',
            diagnosis_incomplete: '本机信息不足，暂无法确认',
        }[verdict] || '暂无法确认';
    }
    function recordCategoryHref(category) {
        const params = new URLSearchParams({ recordView: 'all', recordCategory: category, recordTime: 'all' });
        return `/?${params}#records`;
    }
    function statCard(label, value, note, icon, attention = false, href = '') {
        const node = document.createElement(href ? 'a' : 'article');
        node.className = `stat-card${attention ? ' attention' : ''}${href ? ' is-link' : ''}`;
        if (href) {
            node.href = href;
            node.setAttribute('aria-label', `${label} ${value}，${note}`);
        }
        node.innerHTML = html `<div class="stat-card-head"><span>${label}</span><span class="stat-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span></div><strong class="stat-value">${value}</strong><span class="stat-note">${note}</span>`;
        return node;
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
            const item = document.createElement('a');
            item.className = 'recent-task';
            item.href = `/tasks/${encodeURIComponent(task.taskId)}`;
            const attention = taskStatusGroup(task.status) === 'attention';
            const agent = employeeView?.agentName ? employeeView.agentName(task.assigneeAgentId || task.agentId || task.input?.agentId) : (task.assigneeAgentId || '');
            const time = formatDate(task.updatedAt || task.createdAt);
            item.innerHTML = html `
              <div class="recent-task-left">
                <span class="recent-task-dot${raw(attention ? ' attention' : '')}"></span>
                <div class="recent-task-content">
                  <strong class="recent-task-title">${task.input?.title || '未命名任务'}</strong>
                  <span class="recent-task-sub">${agent ? `${agent} · ` : ''}${time}</span>
                </div>
              </div>
              <span class="recent-task-status ${taskStatusGroup(task.status)}">${statusLabel(task.status)}</span>`;
            return item;
        }));
    }
    function renderFocus(focus) {
        focusPanel.classList.remove('skeleton-panel');
        if (!focus?.total) {
            focusPanel.innerHTML = '<div class="focus-copy"><p class="focus-state is-clear">负责人暂不需处理</p><h3>还没有任务记录</h3><p class="focus-action-copy">请在飞书交办，A君会在这里同步下一步；这不表示系统风险已排除。</p></div><div class="focus-guard"><span class="guard-pill">对外发布关闭</span><span class="guard-pill">不会静默执行</span></div>';
            return;
        }
        const current = focus.next;
        const needsOwner = isOwnerActionFocus(focus, current);
        const title = current ? current.title : '没有新动作';
        const action = current
            ? current.action
            : '历史失败和待验证记录都留在“记录”中，不会自动重试或对外发布。';
        // 原因说明只在有具体任务时展示；无任务时一句话已经说清，不再重复堆叠。
        const reason = current
            ? (current.status === 'succeeded'
                ? '这是建议，不会自动创建后续任务。'
                : needsOwner
                    ? '这件事需要你的输入或确认，系统不会替你决定。'
                    : '系统正在推进，你可以查看进度，不需要一直盯着。')
            : '';
        const primaryAction = current
            ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}">${current.status === 'succeeded' ? '查看这条建议' : needsOwner ? '查看并处理' : '查看进度'}</a>`
            : '<a class="focus-primary-action secondary" href="#records">打开任务记录</a>';
        const governanceReady = state.overview.capabilities.some((item) => item.id === 'governance' && item.status === 'ready');
        const externalWriteReady = state.overview.capabilities.some((item) => item.id === 'external-execution' && item.status === 'ready');
        const costText = usageCostText(state.overview.usage);
        focusPanel.innerHTML = html `
    <div class="focus-copy">
      <div class="focus-header-line">
        <span class="focus-state ${raw(needsOwner ? 'needs-owner' : current ? 'is-running' : 'is-clear')}">
          <i class="focus-dot"></i>
          <span>${needsOwner ? '需要你决定' : current ? '系统正在处理' : '负责人暂不需处理'}</span>
        </span>
      </div>
      <h3 class="focus-task-title">${title}</h3>
      <p class="focus-action-copy">${action}</p>
      ${raw(reason ? html `<p class="focus-reason">${reason}</p>` : '')}
      <div class="focus-actions">${raw(primaryAction)}</div>
    </div>
    <div class="focus-guard">
      <span class="guard-pill"><i class="guard-dot ${governanceReady ? 'on' : 'off'}"></i>${governanceReady ? 'Paperclip 已连接' : '治理连接待恢复'}</span>
      <span class="guard-pill"><i class="guard-dot ${externalWriteReady ? 'on' : 'off'}"></i>${externalWriteReady ? '对外写入按审批开放' : '对外发布关闭'}</span>
      <span class="guard-pill"><i class="guard-dot on"></i>${focus.inProgress ? `${focus.inProgress} 项正在推进` : '没有执行中任务'}</span>
      <span class="guard-pill"><i class="guard-dot on"></i>${costText}</span>
    </div>`;
    }
    function usageCostText(usage) {
        const totals = usage?.cost?.totals || [];
        if (!usage?.cost?.reportedTaskCount || !totals.length)
            return '今日费用未上报';
        return `今日已上报费用 ${totals.map((item) => `${item.amount} ${item.currency}`).join(' · ')}`;
    }
    function capabilityCard(item) {
        const node = document.createElement('article');
        const truth = capabilityPresentation(item);
        const evidenceTaskId = String(item?.truth?.evidenceTaskId || '').trim();
        const note = truth.level === 'verified' && evidenceTaskId ? '打开证据任务核对结果，点“有用”即完成验收' : truth.note;
        const acceptLink = truth.level === 'verified' && evidenceTaskId
            ? html `<a class="capability-accept-link" href="/tasks/${encodeURIComponent(evidenceTaskId)}">去验收 →</a>`
            : '';
        node.className = `capability-card capability-${truth.level}`;
        node.innerHTML = html `<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><span class="capability-truth ${truth.level}">${truth.label}</span><h3>${item.name}</h3><p title="${item.detail}">${item.detail}</p><small>${note}${raw(acceptLink)}</small>`;
        return node;
    }
    return {
        render,
        renderOverviewStats,
        recordCategoryHref,
        statCard,
    };
}
