export function createAccessViews({ elements, state, api, escapeHtml, statusLabel, formatDate, providerLabel, agentName, replaceChildrenPreservingDisclosureState, setTextIfChanged, modelPolicyConsole, }: any): any {
    const { shareInfo, employeeConnections, accessConnections, aiControl, aiServiceList, aiControlMessage, aiRoutingList, campaignList, campaignMessage, employeeConnectionList, accessConnectionList, accessConnectionMessage, contentAccessSummary, accessLoginDisclosure, accessLoginForm, accessLoginProvider, accessLoginAlias, accessLoginAccount, accessLoginMessage, saveAccessConnection, cancelAccessReauthorize, accessStepPanels, accessStepIndicators, }: any = elements;
    async function renderLocalShare(): Promise<any> {
        if (!isLoopbackLocation()) {
            state.localOwner = false;
            shareInfo.hidden = true;
            employeeConnections.hidden = true;
            accessConnections.hidden = true;
            aiControl.hidden = true;
            modelPolicyConsole.setVisible(false);
            return;
        }
        try {
            const share: any = await api('/api/local-share');
            state.localOwner = true;
            shareInfo.hidden = !share.enabled;
            if (share.enabled) {
                const shareAddresses: any = document.querySelector('#share-addresses');
                const shareKey: any = document.querySelector('#share-key');
                shareAddresses.textContent = `同一局域网可通过：${share.addresses.map((address: any): any => `http://${address}:4321`).join(' · ')}`;
                shareKey.value = share.accessKey;
            }
            await Promise.all([
                renderEmployeeConnections(),
                renderAccessConnections(),
                renderAccessLoginOptions(),
                renderAiControl(),
                renderContentCampaigns(),
                modelPolicyConsole.load()
            ]);
        }
        catch {
            state.localOwner = false;
            shareInfo.hidden = true;
            employeeConnections.hidden = true;
            accessConnections.hidden = true;
            aiControl.hidden = true;
            modelPolicyConsole.setVisible(false);
        }
    }
    async function renderAiControl(): Promise<any> {
        if (!state.localOwner)
            return;
        aiControl.hidden = false;
        try {
            const payload: any = await api('/api/local-ai/control');
            replaceChildrenPreservingDisclosureState(aiServiceList, payload.services.map(aiServiceCard));
            aiRoutingList.replaceChildren(...payload.routing.map((route: any): any => {
                const row: any = document.createElement('p');
                row.innerHTML = `<strong>${escapeHtml(route.capability)}</strong><span>${escapeHtml(route.providers.join(' → '))}</span>`;
                return row;
            }));
            const running: any = payload.services.filter((service: any): any => service.state === 'running').length;
            const stopped: any = payload.services.filter((service: any): any => service.state === 'stopped').length;
            aiControlMessage.textContent = `${running} 个运行中 · ${stopped} 个已停止/等待任务 · 所有项目服务都在此登记`;
        }
        catch (error: any) {
            aiControlMessage.textContent = error.message;
            aiServiceList.replaceChildren();
        }
    }
    function aiServiceCard(service: any): any {
        const node: any = document.createElement('article');
        node.className = `ai-service-card ${escapeHtml(service.state)}`;
        const modes: any = service.mode === 'per_request'
            ? '<span class="ai-mode-static">每次任务启动</span>'
            : `<label>启动方式<select data-ai-policy="${escapeHtml(service.id)}"${['gateway', 'desktop-node'].includes(service.id) ? ' disabled' : ''}>
        ${[['on_demand', '按需启动'], ['always_on', '保持运行'], ['disabled', '禁用']].map(([value, label]: any): any => `<option value="${value}"${service.mode === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></label>`;
        const actions: any = service.actions.map((action: any): any => `<button type="button" class="${action === 'stop' ? 'secondary-action danger-action' : 'secondary-action'}" data-ai-service="${escapeHtml(service.id)}" data-ai-action="${escapeHtml(action)}">${escapeHtml(aiActionLabel(action))}</button>`).join('');
        node.innerHTML = `
    <div class="ai-service-head"><div><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.node === 'windows' ? 'Windows 4070' : 'Mac')} · ${escapeHtml(service.endpoint)}</small></div><span class="status ${escapeHtml(service.state)}">${escapeHtml(aiStateLabel(service.state))}</span></div>
    <p>${escapeHtml(service.detail)}</p>
    ${service.managed === false && service.state === 'running' ? '<p class="ai-ownership-note">这是外部启动的进程，A君不会停止它。</p>' : ''}
    <div class="ai-service-controls">${modes}<div class="connection-actions">${actions || '<span class="connection-final-state">无需常驻控制</span>'}</div></div>`;
        return node;
    }
    function aiActionLabel(action: any): any {
        return ({ start: '启动', stop: '停止', restart: '重启', reconnect: '重新检测' } as Record<string, string>)[action] || action;
    }
    function aiStateLabel(state: any): any {
        return ({ running: '运行中', stopped: '已停止', ready: '按任务运行', offline: '失联', unknown: '待检测' } as Record<string, string>)[state] || '待确认';
    }
    async function renderContentCampaigns(): Promise<any> {
        if (!state.localOwner || !campaignList || !campaignMessage)
            return;
        try {
            const payload: any = await api('/api/content-campaigns');
            const campaigns: any = payload.campaigns || [];
            campaignMessage.textContent = campaigns.length ? `${campaigns.length} 个活动` : '尚无活动草案';
            campaignList.replaceChildren(...(campaigns.length
                ? campaigns.map(campaignCard)
                : [emptyCampaignCard('M5 Pipeline 尚未创建活动 Case；真实付费调用和发布仍保持关闭。')]));
        }
        catch (error: any) {
            campaignMessage.textContent = '尚未启用';
            campaignList.replaceChildren(emptyCampaignCard(error.message));
        }
    }
    function campaignCard(campaign: any): any {
        const node: any = document.createElement('article');
        node.className = 'campaign-card';
        const progress: any = campaign.progress || { completedPlatformCases: 0, totalPlatformCases: 14 };
        const cost: any = campaign.costs?.totalCents == null ? '尚无真实费用' : `$${(campaign.costs.totalCents / 100).toFixed(2)}`;
        const approvalAllowed: any = campaign.status === 'draft' && campaign.approval?.allowed === true;
        const approvalReason: any = campaign.approval?.reason || '尚未完成活动启动前检查。';
        const actions: any = campaign.status === 'draft'
            ? `<button type="button" data-campaign-action="approve"${approvalAllowed ? '' : ' disabled'} title="${escapeHtml(approvalReason)}">确认活动授权</button>`
            : campaign.status === 'active'
                ? '<button type="button" class="secondary-action" data-campaign-action="pause">暂停活动</button><button type="button" class="secondary-action danger-action" data-campaign-action="stop">停止活动</button>'
                : campaign.status === 'paused'
                    ? '<button type="button" data-campaign-action="resume">从当前阶段恢复</button><button type="button" class="secondary-action danger-action" data-campaign-action="stop">停止活动</button>'
                    : '';
        node.dataset.campaignId = campaign.campaignId;
        node.dataset.campaignBudgetCents = String(Number(campaign.grant?.budgetCents || 0));
        node.dataset.campaignApprovalAllowed = String(approvalAllowed);
        node.innerHTML = `
    <div class="campaign-card-head">
      <div><p class="eyebrow">${escapeHtml(campaign.caseKey || 'M5')}</p><h3>${escapeHtml(campaign.title)}</h3></div>
      <span class="status ${escapeHtml(campaign.status)}">${escapeHtml(statusLabel(campaign.status))}</span>
    </div>
    <div class="campaign-facts">
      <p><strong>当前阶段</strong>${escapeHtml(campaign.currentStage || '尚未开始')}</p>
      <p><strong>当前负责人</strong>${escapeHtml(campaign.currentOwner?.label || 'Paperclip 当前未指派')}</p>
      <p><strong>发布进度</strong>${progress.completedPlatformCases}/${progress.totalPlatformCases}</p>
      <p><strong>实际费用</strong>${escapeHtml(cost)}</p>
      <p><strong>授权到期</strong>${escapeHtml(campaign.grant?.expiresAt ? formatDate(campaign.grant.expiresAt) : '待批准')}</p>
    </div>
    ${campaign.pauseReason ? `<p class="campaign-alert"><strong>暂停原因</strong>${escapeHtml(campaign.pauseReason)}</p>` : ''}
    <p class="campaign-next"><strong>下一步</strong>${escapeHtml(campaign.nextAction || '查看 Paperclip 活动记录。')}</p>
    <p class="subtle"><strong>当前恢复步骤</strong>${escapeHtml(campaign.recoveryStep || `从“${campaign.recoverFrom || '当前阶段'}”继续；已验证产物不会重新生成。`)}</p>
    ${campaign.status === 'draft' ? `<p class="${approvalAllowed ? 'subtle' : 'campaign-alert'}"><strong>启动前检查</strong>${escapeHtml(approvalReason)}</p>` : ''}
    <div class="campaign-actions">${actions}</div>`;
        return node;
    }
    function emptyCampaignCard(message: any): any {
        const node: any = document.createElement('article');
        node.className = 'campaign-card campaign-empty';
        node.innerHTML = `<h3>当前没有可运行活动</h3><p>${escapeHtml(message)}</p><small>先完成 Pipeline dry-run、岗位绑定、预算和插件审计；不会在此页面静默安装或发布。</small>`;
        return node;
    }
    async function renderEmployeeConnections(): Promise<any> {
        if (!state.localOwner)
            return;
        const payload: any = await api('/api/employee-feishu-connections');
        employeeConnections.hidden = false;
        replaceChildrenPreservingDisclosureState(employeeConnectionList, payload.employees.map((employee: any): any => {
            const node: any = document.createElement('article');
            node.className = 'connection-card';
            const status: any = employee.channel?.status || (employee.configured ? 'connecting' : 'not_configured');
            const modelAction: any = `
      <div class="connection-actions" data-model-setup-scope>
        <button type="button" class="model-setup-button secondary-action" data-model-setup-agent-id="${escapeHtml(employee.agentId)}" data-model-setup-target="models">管理模型</button>
        <button type="button" class="model-setup-button secondary-action" data-model-setup-agent-id="${escapeHtml(employee.agentId)}" data-model-setup-target="keys">管理 API 与 Key</button>
        <p class="model-setup-message connection-message" role="status">使用 Hermes 官方页面，并锁定到这名员工的 Profile。</p>
      </div>`;
            const connectionControls: any = status === 'external'
                ? '<div class="connection-managed"><strong>独立员工入口已启用</strong><p>由员工自己的 Hermes 档案和飞书入口承接。</p></div>'
                : `<details class="connection-form-disclosure" data-disclosure-key="employee-form:${escapeHtml(employee.agentId)}"><summary>${employee.configured ? '更新接线配置' : '配置飞书入口'}</summary><form data-agent-id="${escapeHtml(employee.agentId)}" data-refresh-protected><label>飞书 App ID<input name="appId" autocomplete="off" placeholder="cli_..." required></label><label>App Secret<input name="appSecret" type="password" autocomplete="new-password" required></label><label>允许老板的 open_id<input name="allowedUserId" autocomplete="off" placeholder="ou_..." required></label><button>${employee.configured ? '更新并重新连接' : '保存并连接'}</button><p class="connection-message" role="status">${escapeHtml(employee.channel?.message || '尚未接线。')}</p></form></details>`;
            node.innerHTML = `
      <details class="connection-disclosure" data-disclosure-key="employee:${escapeHtml(employee.agentId)}">
        <summary>
          <span class="summary-icon"><svg aria-hidden="true"><use href="#icon-employees"></use></svg></span>
          <span class="connection-summary-copy">
            <strong>${escapeHtml(employee.name)}</strong>
            <small>${escapeHtml(employee.role)}</small>
          </span>
          <span class="status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
          <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
        </summary>
        <div class="connection-body">
          <div class="connection-facts">
            <p class="readiness-row"><strong>模型：</strong><span class="status ${escapeHtml(employee.model?.status || 'not_ready')}">${escapeHtml(statusLabel(employee.model?.status || 'not_ready'))}</span> ${escapeHtml(employee.model?.message || '模型状态待核对。')}</p>
            ${modelAction}
            <p class="readiness-row"><strong>飞书：</strong>${escapeHtml(employee.channel?.message || '尚未接线。')}</p>
            <small>事件：${escapeHtml(employee.requiredEvents.join('、'))}<br>权限：${escapeHtml(employee.requiredScopes.join('、'))}</small>
          </div>
          ${connectionControls}
        </div>
      </details>`;
            return node;
        }));
    }
    async function renderAccessConnections(): Promise<any> {
        if (!state.localOwner)
            return;
        const payload: any = await api('/api/access-connections');
        accessConnections.hidden = false;
        renderContentAccessSummary(payload);
        const activeConnections: any = payload.connections
            .filter((connection: any): any => !['revoked', 'disabled', 'expired'].includes(connection.status))
            .sort((left: any, right: any): any => Number(right.isDefault) - Number(left.isDefault) || left.provider.localeCompare(right.provider));
        const archivedConnections: any = payload.connections.filter((connection: any): any => ['revoked', 'disabled', 'expired'].includes(connection.status));
        const ambiguousPlatforms: any = Object.entries(groupConnectionsByProvider(activeConnections))
            .filter(([, connections]: any): any => connections.length > 1 && !connections.some((connection: any): any => connection.isDefault));
        const connectionMessage: any = payload.status === 'unavailable'
            ? (payload.message || '账号连接状态暂时不可用。')
            : ambiguousPlatforms.length
                ? `${ambiguousPlatforms.map(([provider]: any): any => providerLabel(provider)).join('、')}有多个账号，请先设一个默认账号。`
                : `${activeConnections.length} 个当前连接 · 默认账号已明确`;
        setTextIfChanged(accessConnectionMessage, connectionMessage);
        replaceChildrenPreservingDisclosureState(accessConnectionList, [
            ...activeConnections.map(accountConnectionCard),
            ...(archivedConnections.length ? [archivedConnectionGroup(archivedConnections)] : [])
        ]);
    }
    function renderContentAccessSummary(payload: any): any {
        if (!contentAccessSummary)
            return;
        const connections: any = payload.connections || [];
        const active: any = connections.filter((connection: any): any => ['active', 'expiring'].includes(connection.status));
        const defaults: any = Object.entries(groupConnectionsByProvider(active))
            .map(([provider, providerConnections]: any): any => {
            const selected: any = providerConnections.find((connection: any): any => connection.isDefault)
                || (providerConnections.length === 1 ? providerConnections[0] : null);
            return selected ? `${providerLabel(provider)}：${selected.accountAlias}` : `${providerLabel(provider)}：待选择`;
        });
        const verified: any = active.filter((connection: any): any => connection.lastVerification?.status === 'succeeded').length;
        const failed: any = active.filter((connection: any): any => connection.lastVerification?.status === 'failed').length;
        const unverified: any = active.length - verified - failed;
        const adapters: any = payload.acquisition?.adapters || [];
        const healthyAdapters: any = adapters.filter((adapter: any): any => adapter.healthStatus === 'healthy').length;
        const crawlerReady: any = payload.acquisition?.status === 'ready' && payload.acquisition?.mediaCrawlerDeep === true;
        replaceChildrenPreservingDisclosureState(contentAccessSummary, [
            accessSummaryCard('平台可用', defaults.length, defaults.join('；') || '尚未连接账号', defaults.some((item: any): any => item.endsWith('待选择')) ? 'warning' : 'ready'),
            accessSummaryCard('真实读取成功', `${verified}/${active.length}`, `${failed ? `${failed} 个账号最近失败` : ''}${failed && unverified ? ' · ' : ''}${unverified ? `${unverified} 个尚未实测` : failed ? '' : '当前账号均有成功证据'}`, failed || unverified ? 'warning' : 'ready'),
            accessSummaryCard('采集服务', crawlerReady ? '可用' : '需检查', `${healthyAdapters}/${adapters.length || 0} 个通道正常`, crawlerReady ? 'ready' : 'warning')
        ]);
    }
    function accessSummaryCard(label: any, value: any, detail: any, tone: any): any {
        const node: any = document.createElement('article');
        node.className = `access-summary-card ${tone}`;
        node.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small>`;
        return node;
    }
    function accountConnectionCard(connection: any): any {
        const node: any = document.createElement('article');
        node.className = 'connection-card account-connection-card';
        const canRevoke: any = ['active', 'expiring', 'error'].includes(connection.status);
        const canDisable: any = ['active', 'expiring', 'error'].includes(connection.status);
        const canReauthorize: any = ['xhs', 'dy', 'bili', 'ks'].includes(connection.provider);
        const operationText: any = connection.grantedOperations.length ? connection.grantedOperations.join('、') : '未登记';
        const scopeText: any = connection.dataScope.length ? connection.dataScope.join('、') : '未登记';
        const employeeText: any = connection.allowedAgentIds.length ? connection.allowedAgentIds.map(agentName).join('、') : '未分配';
        const timing: any = connection.expiresAt ? `到期：${formatDate(connection.expiresAt)}` : '到期：由连接器管理';
        const health: any = connection.lastHealthAt ? `最近检查：${formatDate(connection.lastHealthAt)}` : '最近检查：尚无记录';
        const verification: any = connection.lastVerification
            ? connection.lastVerification.status === 'succeeded'
                ? `真实读取：${formatDate(connection.lastVerification.at)}成功 · ${adapterLabel(connection.lastVerification.adapterId)} · ${connection.lastVerification.capabilities.join('、') || '内容'}`
                : `真实读取：${formatDate(connection.lastVerification.at)}失败 · ${failureLabel(connection.lastVerification.failureCode)}`
            : '真实读取：尚未执行';
        const summaryState: any = ['active', 'expiring'].includes(connection.status) && connection.lastVerification
            ? connection.lastVerification.status === 'succeeded'
                ? { className: 'succeeded', label: '读取成功' }
                : { className: 'failed', label: '读取失败' }
            : { className: connection.status, label: statusLabel(connection.status) };
        const managementActions: any = [
            canReauthorize ? `<button type="button" class="secondary-action" data-connection-action="reauthorize" data-connection-id="${escapeHtml(connection.connectionId)}" data-provider="${escapeHtml(connection.provider)}" data-alias="${escapeHtml(connection.accountAlias)}">${connection.status === 'active' ? '续期/重新授权' : '重新授权'}</button>` : '',
            canDisable ? `<button type="button" class="secondary-action" data-connection-action="disable" data-connection-id="${escapeHtml(connection.connectionId)}">暂时禁用</button>` : '',
            canRevoke ? `<button type="button" class="secondary-action danger-action" data-connection-action="revoke" data-connection-id="${escapeHtml(connection.connectionId)}">永久撤销</button>` : ''
        ].filter(Boolean).join('');
        const primaryAction: any = connection.status === 'active'
            ? connection.isDefault
                ? '<span class="connection-default-note">任务默认使用这个账号</span>'
                : `<button type="button" data-connection-action="default" data-connection-id="${escapeHtml(connection.connectionId)}">设为${escapeHtml(providerLabel(connection.provider))}默认账号</button>`
            : '';
        node.innerHTML = `
    <details class="connection-disclosure" data-disclosure-key="account:${escapeHtml(connection.connectionId)}">
      <summary>
        <span class="summary-icon"><svg aria-hidden="true"><use href="#icon-shield"></use></svg></span>
        <span class="connection-summary-copy">
          <strong>${escapeHtml(connection.accountAlias || connection.provider || '未命名连接')}</strong>
          <small>${escapeHtml(providerLabel(connection.provider))}${connection.isDefault ? ' · 默认账号' : ''}</small>
        </span>
        <span class="status ${escapeHtml(summaryState.className)}">${escapeHtml(summaryState.label)}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="connection-body">
        <div class="connection-facts">
          <p><strong>连接状态：</strong>${escapeHtml(statusLabel(connection.status))}</p>
          <p><strong>可用员工：</strong>${escapeHtml(employeeText)}</p>
          <p><strong>允许动作：</strong>${escapeHtml(operationText)}</p>
          <p><strong>数据范围：</strong>${escapeHtml(scopeText)}</p>
          <small>${escapeHtml(verification)}<br>${escapeHtml(timing)}<br>${escapeHtml(health)}<br>${connection.hasCredentialReference ? '受控凭据引用已登记' : '未登记受控凭据引用'}</small>
        </div>
        ${primaryAction}
        ${managementActions ? `<details class="action-menu" data-disclosure-key="account-actions:${escapeHtml(connection.connectionId)}"><summary><svg aria-hidden="true"><use href="#icon-more"></use></svg>管理连接</summary><div class="connection-actions">${managementActions}</div></details>` : '<span class="connection-final-state">无需操作</span>'}
      </div>
    </details>`;
        return node;
    }
    function archivedConnectionGroup(connections: any): any {
        const node: any = document.createElement('details');
        node.className = 'connection-history';
        node.dataset.disclosureKey = 'account-history';
        node.innerHTML = `<summary><span>历史连接</span><small>${connections.length} 条已撤销、停用或过期记录</small><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="connection-grid"></div>`;
        node.querySelector('.connection-grid').replaceChildren(...connections.map(accountConnectionCard));
        return node;
    }
    function groupConnectionsByProvider(connections: any): any {
        return connections.reduce((groups: any, connection: any): any => {
            (groups[connection.provider] ||= []).push(connection);
            return groups;
        }, {});
    }
    function adapterLabel(value: any): any {
        return ({
            'mediacrawlerpro-specialized-content': '深度采集',
            'bilibili-native-subtitles': 'B站原生字幕',
            'yt-dlp-general-media': '公开视频通道'
        } as Record<string, string>)[value] || value || '内容通道';
    }
    function failureLabel(value: any): any {
        return ({
            authorization_required: '需要重新授权',
            adapter_unavailable: '采集通道不可用',
            source_rate_limited: '平台临时限流',
            capability_not_available: '能力暂不支持'
        } as Record<string, string>)[value] || value || '读取失败';
    }
    async function renderAccessLoginOptions(): Promise<any> {
        if (!state.localOwner)
            return;
        state.accessLoginOptions = await api('/api/access-login/options');
        const selectedProvider: any = accessLoginProvider.value;
        replaceChildrenPreservingDisclosureState(accessLoginProvider, state.accessLoginOptions.providers.map((provider: any): any => new Option(provider.label, provider.id)));
        if (state.accessLoginOptions.providers.some((provider: any): any => provider.id === selectedProvider))
            accessLoginProvider.value = selectedProvider;
        renderAccessLoginAccounts();
    }
    function renderAccessLoginAccounts(): any {
        const provider: any = accessLoginProvider.value;
        const current: any = accessLoginAccount.value;
        const accounts: any = state.accessLoginOptions.accounts.filter((account: any): any => account.connected && account.platforms.includes(provider));
        const accountOptions: any = [new Option(accounts.length ? '请选择已登录账号' : '还没有检测到已登录账号', '')];
        for (const account of accounts) {
            const label: any = account.nicknames?.[provider] || 'Chrome 已登录账号';
            accountOptions.push(new Option(label, account.clientId));
        }
        replaceChildrenPreservingDisclosureState(accessLoginAccount, accountOptions);
        if (accounts.some((account: any): any => account.clientId === current))
            accessLoginAccount.value = current;
    }
    function setAccessStep(step: any): any {
        const nextStep: any = Math.min(3, Math.max(1, step));
        for (const panel of accessStepPanels)
            panel.hidden = Number(panel.dataset.accessStepPanel) !== nextStep;
        for (const indicator of accessStepIndicators) {
            const indicatorStep: any = Number(indicator.dataset.accessStepIndicator);
            indicator.classList.toggle('is-active', indicatorStep === nextStep);
            indicator.classList.toggle('is-complete', indicatorStep < nextStep);
        }
    }
    function resetAccessReauthorization(): any {
        state.reauthorizeConnectionId = '';
        saveAccessConnection.textContent = '3. 授权给小D';
        cancelAccessReauthorize.hidden = true;
        setAccessStep(1);
    }
    function isLoopbackLocation(): any {
        return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname.toLowerCase());
    }
    return {
        renderLocalShare,
        renderAiControl,
        aiActionLabel,
        renderContentCampaigns,
        renderEmployeeConnections,
        renderAccessConnections,
        renderAccessLoginOptions,
        renderAccessLoginAccounts,
        setAccessStep,
        resetAccessReauthorization,
    };
}
