import { taskStatusGroup } from './task-record-filter.js';
import { statusLabel } from './console-labels.js';
import { businessDebtPresentation, capabilityPresentation, capabilitySummaryText, countCapabilityTiers, isOwnerActionFocus, managerFirstEmployees, reliabilityPresentation } from './overview-presentation.js';
import { html, raw, escapeHtml } from './html.js';

export function createOverviewView({ elements, state, api, employeeView, formatDate }: any): any {
    const { capabilityList, agentList, recentTaskList, overviewStats, overviewSummary, chainDiagnosis, focusPanel, capabilitySummary } = elements;
    const { replaceChildrenPreservingDisclosureState } = elements;

    function render(): any {
        renderFocus(state.overview.taskFocus);
        renderOverviewStats();
        capabilityList.replaceChildren(...state.overview.capabilities.map((item: any): any => capabilityCard(item)));
        const capabilityTiers: any = countCapabilityTiers(state.overview.capabilities);
        capabilitySummary.textContent = capabilitySummaryText(capabilityTiers);
        const employees: any = managerFirstEmployees(state.overview.manager, state.overview.agents);
        const directEmployees: any = employees.filter(employeeView.isPrimaryEmployee);
        const supportEmployees: any = employees.filter((agent: any): any => !employeeView.isPrimaryEmployee(agent));
        replaceChildrenPreservingDisclosureState(agentList, [
            employeeView.agentGroupTitle('业务结果入口', '日常派活去飞书；这里查看状态、验收和恢复'),
            ...directEmployees.map((agent: any): any => employeeView.agentCard(agent, false)),
            ...(supportEmployees.length ? [employeeView.backgroundEmployeeDisclosure(supportEmployees)] : [])
        ]);
        renderRecentTasks(state.overview.recentTasks || []);
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
                ? `${active} 项工作正在推进，你暂时不需操作。`
                : '负责人当前没有待办。';
        const cards: any = [
            statCard('运行工作', active, active ? '正在推进业务任务' : '无执行中任务', 'clock', active > 0 ? 'active' : 'normal', recordCategoryHref('business_active')),
            statCard('系统可靠性', reliability.value, reliability.note, 'shield', reliability.attention ? 'warning' : 'success', reliability.href),
            statCard('业务质量债', debt.value, debt.note, 'target', debt.attention ? 'warning' : 'normal', debt.href),
        ];
        overviewStats.replaceChildren(...cards);
        renderChainDiagnosis(health);
    }
    function renderChainDiagnosis(health: any): any {
        if (!chainDiagnosis) return;
        const coreStatus: any = typeof health?.coreOnline === 'string' ? health.coreOnline : (health?.coreOnline?.status || 'unknown');
        const isHealthy: any = coreStatus === 'online' && (health?.reliability === 'healthy' || health?.reliability?.status === 'healthy');
        if (isHealthy) {
            chainDiagnosis.hidden = true;
            chainDiagnosis.replaceChildren();
            return;
        }
        chainDiagnosis.hidden = false;
        const existing: any = chainDiagnosis.querySelector('.chain-diagnosis-disclosure');
        if (existing) {
            if (existing.open)
                fetchChainDiagnosis();
            return;
        }
        const holder: any = document.createElement('div');
        holder.innerHTML = html`<details class="chain-diagnosis-disclosure" data-disclosure-key="chain-diagnosis"><summary><strong>飞书链路需要检查</strong><small>展开看下一步</small><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="chain-diagnosis-body"><p>展开后读取本机诊断。</p></div></details>`;
        const disclosure: any = holder.firstElementChild;
        disclosure.addEventListener('toggle', () => {
            if (disclosure.open)
                fetchChainDiagnosis();
        });
        chainDiagnosis.replaceChildren(disclosure);
    }
    async function fetchChainDiagnosis(): Promise<any> {
        if (!chainDiagnosis) return;
        const body: any = chainDiagnosis.querySelector('.chain-diagnosis-body');
        if (!body || body.dataset.loaded === 'true') return;
        try {
            const diagnosis: any = await api('/api/diagnose/feishu-chain');
            const checks: any = Array.isArray(diagnosis.checks) ? diagnosis.checks : [];
            const checkItems: any = checks.map((check: any): any => {
                const icon: any = check.status === 'passing' ? 'check' : check.status === 'failed' ? 'alert' : 'clock';
                const conclusion: any = String(check.conclusion || '').trim();
                return html`<li class="chain-check-item ${check.status}"><svg class="chain-check-icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg><div class="chain-check-copy"><strong>${check.title}</strong>${raw(conclusion ? `<small title="真相层级：${escapeHtml(check.truthLayer)}">${conclusion}</small>` : '')}</div></li>`;
            }).join('');
            const caveat: any = diagnosis.verdictCaveat ? html`<small>${diagnosis.verdictCaveat}</small>` : '';
            const nextStep: any = diagnosis.uniqueNextStep ? html`<p class="chain-next-step"><strong>唯一下一步：</strong>${diagnosis.uniqueNextStep}</p>` : '';
            const userGuide = getUserGuidance(diagnosis.verdict);

            body.dataset.loaded = 'true';
            body.innerHTML = html`
                <div class="chain-user-card ${userGuide.statusTone}">
                    <div class="chain-user-header">
                        <span class="chain-status-badge ${userGuide.statusTone}">${userGuide.statusLabel}</span>
                        <strong>${userGuide.headline}</strong>
                    </div>
                    <p class="chain-user-desc">${userGuide.desc}</p>
                    <div class="chain-user-actions">
                        <button type="button" class="chain-action-btn primary" data-copy-cmd="npm run diagnose:feishu-chain">
                            <svg width="13" height="13" aria-hidden="true"><use href="#icon-records"></use></svg>
                            <span>复制排查命令</span>
                        </button>
                        <button type="button" class="chain-action-btn secondary" data-reload-diagnosis>
                            <svg width="13" height="13" aria-hidden="true"><use href="#icon-spark"></use></svg>
                            <span>重新检测</span>
                        </button>
                    </div>
                </div>
                <details class="chain-tech-details">
                    <summary>
                        <span>底层诊断与环境自检（共 ${checks.length} 项）</span>
                        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
                    </summary>
                    <div class="chain-tech-content">
                        <p class="chain-verdict"><strong>${chainVerdictLabel(diagnosis.verdict)}</strong>${raw(caveat)}</p>
                        <ul class="chain-check-list">${raw(checkItems)}</ul>
                        ${raw(nextStep)}
                    </div>
                </details>
            `;

            body.querySelector('[data-copy-cmd]')?.addEventListener('click', async (e: any): Promise<any> => {
                const cmd = e.currentTarget.dataset.copyCmd;
                if (!cmd) return;
                try {
                    await navigator.clipboard.writeText(cmd);
                    const span = e.currentTarget.querySelector('span');
                    if (span) {
                        const originalText = span.textContent;
                        span.textContent = '已复制命令';
                        setTimeout(() => {
                            if (span && span.isConnected) span.textContent = originalText;
                        }, 2000);
                    }
                } catch {
                    const span = e.currentTarget.querySelector('span');
                    if (span) span.textContent = '复制失败';
                }
            });

            body.querySelector('[data-reload-diagnosis]')?.addEventListener('click', (): any => {
                body.removeAttribute('data-loaded');
                body.innerHTML = '<p>正在重新检测链路…</p>';
                fetchChainDiagnosis();
            });
        }
        catch (error: any) {
            body.innerHTML = html`<p class="chain-diagnosis-error">链路诊断加载失败：${error.message || '未知错误'}</p>`;
        }
    }
    function getUserGuidance(verdict: string): { statusTone: string; statusLabel: string; headline: string; desc: string } {
        if (verdict === 'no_local_gap_found') {
            return {
                statusTone: 'passing',
                statusLabel: '通道就绪',
                headline: '飞书通道就绪 · 待真机验证',
                desc: '本机检查通过。请在飞书私聊中向【A君·军团总管】或对应员工（如小R）发送一条测试消息即可开始使用。',
            };
        }
        if (verdict === 'blocking_gap') {
            return {
                statusTone: 'failed',
                statusLabel: '需要配置',
                headline: '飞书连接通道需要配置',
                desc: '检测到飞书网关服务或必要环境变量缺失。若需使用飞书日常派活，请点击下方复制排查命令交由技术人员配置。',
            };
        }
        return {
            statusTone: 'unknown',
            statusLabel: '本地独立模式',
            headline: '当前处于本地独立运行模式',
            desc: '未检测到常驻飞书守护服务（不影响本地功能使用）。若要在飞书对话，可在飞书私聊中发一条消息测试连接，或复制排查命令排查。',
        };
    }
    function chainVerdictLabel(verdict: string): string {
        return {
            blocking_gap:'发现阻断问题',
            no_local_gap_found:'本机检查通过',
            diagnosis_incomplete:'本机信息不足，暂无法确认',
        }[verdict] || '暂无法确认';
    }
    function recordCategoryHref(category: any): any {
        const params: any = new URLSearchParams({ recordView: 'all', recordCategory: category, recordTime: 'all' });
        return `/?${params}#records`;
    }
    function statCard(label: any, value: any, note: any, icon: any, statusTone: any = 'normal', href: any = ''): any {
        const node: any = document.createElement(href ? 'a' : 'article');
        node.className = `stat-card is-${statusTone}${href ? ' is-link' : ''}`;
        if (href) {
            node.href = href;
            node.setAttribute('aria-label', `${label} ${value}，${note}`);
        }
        const statusPill = statusTone === 'success' ? '健康' : statusTone === 'warning' ? '需关注' : statusTone === 'active' ? '运行中' : '正常';
        node.innerHTML = html`
            <div class="stat-card-head">
                <div class="stat-icon-badge is-${statusTone}">
                    <svg aria-hidden="true"><use href="#icon-${icon}"></use></svg>
                </div>
                <span class="stat-tag is-${statusTone}">${statusPill}</span>
            </div>
            <div class="stat-card-body">
                <span class="stat-label">${label}</span>
                <strong class="stat-value">${value}</strong>
                <span class="stat-note" title="${escapeHtml(note)}">${note}</span>
            </div>
        `;
        return node;
    }
    function renderRecentTasks(tasks: any): any {
        recentTaskList.replaceChildren();
        if (!tasks.length) {
            const empty: any = document.createElement('div');
            empty.className = 'recent-task-empty';
            empty.innerHTML = '<svg aria-hidden="true"><use href="#icon-records"></use></svg><span>暂无最近任务记录</span>';
            recentTaskList.append(empty);
            return;
        }
        recentTaskList.append(...tasks.map((task: any): any => {
            const item: any = document.createElement('a');
            item.className = 'recent-task';
            item.href = `/tasks/${encodeURIComponent(task.taskId)}`;
            const attention: any = taskStatusGroup(task.status) === 'attention';
            const agent: any = employeeView?.agentName ? employeeView.agentName(task.assigneeAgentId || task.agentId || task.input?.agentId) : (task.assigneeAgentId || '');
            const time: any = formatDate(task.updatedAt || task.createdAt);
            const isCompleted: boolean = ['succeeded', 'cancelled', 'rejected', 'stopped'].includes(task.status);
            const icon = task.taskType?.includes('video') ? 'radar' : (task.taskType?.includes('presentation') ? 'target' : 'records');
            item.innerHTML = html`
              <div class="recent-task-left">
                <div class="recent-task-icon-wrapper ${raw(attention ? 'attention' : isCompleted ? 'success' : 'active')}">
                  <svg aria-hidden="true"><use href="#icon-${icon}"></use></svg>
                </div>
                <div class="recent-task-content">
                  <strong class="recent-task-title">${task.input?.title || '未命名任务'}</strong>
                  <span class="recent-task-sub">${agent ? `<span class="recent-agent-tag">${agent}</span>` : ''}<span>${time}</span></span>
                </div>
              </div>
              <span class="recent-task-status ${taskStatusGroup(task.status)}">${statusLabel(task.status)}</span>`;
            return item;
        }));
    }
    function renderFocus(focus: any): any {
        focusPanel.classList.remove('skeleton-panel');
        const governanceReady: any = state.overview.capabilities.some((item: any): any => item.id === 'governance' && item.status === 'ready');
        const externalWriteReady: any = state.overview.capabilities.some((item: any): any => item.id === 'external-execution' && item.status === 'ready');
        const costText: any = usageCostText(state.overview.usage);

        if (!focus?.total) {
            focusPanel.innerHTML = html`
                <div class="focus-inner">
                    <div class="focus-copy">
                        <div class="focus-header-line">
                            <span class="focus-state is-clear"><svg class="focus-icon" aria-hidden="true"><use href="#icon-check"></use></svg><span>负责人暂不需处理</span></span>
                        </div>
                        <h3 class="focus-task-title">没有待处理任务</h3>
                        <p class="focus-action-copy">系统运行平稳；日常派活请在飞书交办，A君会在这里同步下一步；这不表示系统风险已排除。</p>
                    </div>
                    <div class="focus-guard-grid">
                        <div class="guard-card is-active"><div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-shield"></use></svg></div><div class="guard-card-info"><span class="guard-card-label">治理总控</span><strong class="guard-card-val">Paperclip 已连接</strong></div></div>
                        <div class="guard-card is-active"><div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-target"></use></svg></div><div class="guard-card-info"><span class="guard-card-label">发布权限</span><strong class="guard-card-val">对外发布关闭</strong></div></div>
                        <div class="guard-card is-active"><div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-clock"></use></svg></div><div class="guard-card-info"><span class="guard-card-label">任务队列</span><strong class="guard-card-val">就绪</strong></div></div>
                        <div class="guard-card is-active"><div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-cost"></use></svg></div><div class="guard-card-info"><span class="guard-card-label">今日费用</span><strong class="guard-card-val">${costText}</strong></div></div>
                    </div>
                </div>
            `;
            return;
        }
        const current: any = focus.next;
        const needsOwner: any = isOwnerActionFocus(focus, current);
        const title: any = current ? current.title : '没有新动作';
        const action: any = current
            ? current.action
            : '历史记录已归档，不会自动重试或对外发布。';
        const primaryAction: any = current
            ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}"><span>${current.status === 'succeeded' ? '查看建议' : needsOwner ? '查看并处理' : '查看进度'}</span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
            : '<a class="focus-primary-action secondary" href="#records"><span>打开任务记录</span></a>';

        focusPanel.innerHTML = html`
            <div class="focus-inner">
                <div class="focus-copy">
                    <div class="focus-header-line">
                        <span class="focus-state ${raw(needsOwner ? 'needs-owner' : current ? 'is-running' : 'is-clear')}">
                            <i class="focus-dot"></i>
                            <span>${needsOwner ? '需要你决定' : current ? '正在处理中' : '暂不需处理'}</span>
                        </span>
                    </div>
                    <h3 class="focus-task-title">${title}</h3>
                    <p class="focus-action-copy">${action}</p>
                    <div class="focus-actions">${raw(primaryAction)}</div>
                </div>
                <div class="focus-guard-grid">
                    <div class="guard-card ${governanceReady ? 'is-active' : 'is-warning'}">
                        <div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-shield"></use></svg></div>
                        <div class="guard-card-info">
                            <span class="guard-card-label">治理总控</span>
                            <strong class="guard-card-val">${governanceReady ? 'Paperclip 已连接' : '治理连接待恢复'}</strong>
                        </div>
                    </div>
                    <div class="guard-card is-active">
                        <div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-target"></use></svg></div>
                        <div class="guard-card-info">
                            <span class="guard-card-label">发布权限</span>
                            <strong class="guard-card-val">${externalWriteReady ? '对外写入按审批开放' : '对外发布关闭'}</strong>
                        </div>
                    </div>
                    <div class="guard-card ${focus.inProgress ? 'is-active' : 'is-muted'}">
                        <div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-clock"></use></svg></div>
                        <div class="guard-card-info">
                            <span class="guard-card-label">推进中任务</span>
                            <strong class="guard-card-val">${focus.inProgress ? `${focus.inProgress} 项正在推进` : '没有执行中任务'}</strong>
                        </div>
                    </div>
                    <div class="guard-card is-active">
                        <div class="guard-card-icon"><svg aria-hidden="true"><use href="#icon-cost"></use></svg></div>
                        <div class="guard-card-info">
                            <span class="guard-card-label">今日费用</span>
                            <strong class="guard-card-val">${costText}</strong>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    function usageCostText(usage: any): any {
        const totals: any = usage?.cost?.totals || [];
        if (!usage?.cost?.reportedTaskCount || !totals.length)
            return '今日费用未上报';
        return `今日已上报费用 ${totals.map((item: any): any => `${item.amount} ${item.currency}`).join(' · ')}`;
    }
    function capabilityCard(item: any): any {
        const node: any = document.createElement('article');
        const truth: any = capabilityPresentation(item);
        const evidenceTaskId: any = String(item?.truth?.evidenceTaskId || '').trim();
        const note: any = truth.level === 'verified' && evidenceTaskId ? '打开证据任务核对结果，点“有用”即完成验收' : truth.note;
        const acceptLink: any = truth.level === 'verified' && evidenceTaskId
            ? html`<a class="capability-accept-link" href="/tasks/${encodeURIComponent(evidenceTaskId)}">去验收 →</a>`
            : '';
        node.className = `capability-card capability-${truth.level}`;
        node.innerHTML = html`<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><span class="capability-truth ${truth.level}">${truth.label}</span><h3>${item.name}</h3><p title="${item.detail}">${item.detail}</p><small>${note}${raw(acceptLink)}</small>`;
        return node;
    }
    return {
        render,
        renderOverviewStats,
        recordCategoryHref,
        statCard,
    };
}
