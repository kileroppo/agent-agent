import { canRefreshConsole, startRefreshScheduler } from './refresh-scheduler.js';
import { bindRefreshProtectedForms, clearRefreshDraft } from './refresh-scheduler.js';
export function bindConsoleInteractions({ elements, state, api, load, setSyncStatus, moduleNavigation, accessViews, }: any): any {
    const { accessForm, accessKey, collaboratorName, rotateShareKey, shareMessage, refreshAiControl, aiControlMessage, aiServiceList, employeeConnectionList, accessLoginProvider, accessLoginAccount, accessStepNext2, accessStepBack1, accessStepBack2, accessStepNext3, accessLoginMessage, openPlatformLogin, refreshLoginAccounts, accessLoginForm, saveAccessConnection, cancelAccessReauthorize, accessConnectionList, accessConnectionMessage, accessLoginAlias, accessLoginDisclosure, campaignList, campaignMessage, accessGate, }: any = elements;
    accessForm.addEventListener('submit', async (event: any): Promise<any> => {
        event.preventDefault();
        state.shareKey = accessKey.value.trim();
        state.requesterName = collaboratorName.value.trim();
        sessionStorage.setItem('ajun-share-key', state.shareKey);
        sessionStorage.setItem('ajun-requester-name', state.requesterName);
        await load();
    });
    rotateShareKey.addEventListener('click', async (): Promise<any> => {
        if (!window.confirm('换新后，旧口令会立即失效。确定继续吗？'))
            return;
        rotateShareKey.disabled = true;
        try {
            const share: any = await api('/api/local-share/rotate', { method: 'POST' });
            const shareKey: any = document.querySelector('#share-key');
            shareKey.value = share.accessKey;
            shareMessage.textContent = '已换新，请把新口令发给需要继续访问的人。';
        }
        catch (error: any) {
            shareMessage.textContent = error.message;
        }
        finally {
            rotateShareKey.disabled = false;
        }
    });
    refreshAiControl.addEventListener('click', async (): Promise<any> => {
        refreshAiControl.disabled = true;
        aiControlMessage.textContent = '正在重新检测 Mac 与 4070 节点…';
        try {
            await api('/api/local-ai/services/desktop-node/reconnect', { method: 'POST' });
            await accessViews.renderAiControl();
        }
        catch (error: any) {
            aiControlMessage.textContent = error.message;
        }
        finally {
            refreshAiControl.disabled = false;
        }
    });
    aiServiceList.addEventListener('click', async (event: any): Promise<any> => {
        const button: any = event.target.closest('button[data-ai-service]');
        if (!button)
            return;
        const { aiService: serviceId, aiAction: action }: any = button.dataset;
        if (action === 'stop' && !window.confirm('停止后不会自动保持后台运行；下次任务可按策略重新唤醒。确定停止吗？'))
            return;
        button.disabled = true;
        aiControlMessage.textContent = `正在${accessViews.aiActionLabel(action)} ${serviceId}…`;
        try {
            await api(`/api/local-ai/services/${encodeURIComponent(serviceId)}/${encodeURIComponent(action)}`, { method: 'POST' });
            await accessViews.renderAiControl();
        }
        catch (error: any) {
            aiControlMessage.textContent = error.message;
        }
        finally {
            button.disabled = false;
        }
    });
    aiServiceList.addEventListener('change', async (event: any): Promise<any> => {
        const select: any = event.target.closest('select[data-ai-policy]');
        if (!select)
            return;
        select.disabled = true;
        aiControlMessage.textContent = '正在保存启动策略…';
        try {
            await api(`/api/local-ai/services/${encodeURIComponent(select.dataset.aiPolicy)}/policy`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ mode: select.value, idleSeconds: 900 }),
            });
            await accessViews.renderAiControl();
        }
        catch (error: any) {
            aiControlMessage.textContent = error.message;
            await accessViews.renderAiControl();
        }
    });
    document.addEventListener('click', async (event: any): Promise<any> => {
        const addBtn: any = (event.target as any).closest('[data-custom-ai-add]');
        if (addBtn) { const form: any = addBtn.parentElement?.querySelector('.custom-ai-form'); if (form) form.hidden = false; return; }
        const cancelBtn: any = (event.target as any).closest('[data-custom-ai-cancel]');
        if (cancelBtn) { const form: any = cancelBtn.closest('.custom-ai-form'); if (form) form.hidden = true; return; }
        const submitBtn: any = (event.target as any).closest('[data-custom-ai-submit]');
        if (submitBtn) {
            const form: any = submitBtn.closest('.custom-ai-form');
            if (!form) return;
            const inputs: any = Object.fromEntries([...form.querySelectorAll('input')].map((i: any): any => [i.name, i.value]));
            try { await api('/api/custom-ai/capabilities', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(inputs) }); await accessViews.renderAiControl(); } catch (e: any) { aiControlMessage.textContent = e.message; }
            return;
        }
        const removeBtn: any = (event.target as any).closest('[data-custom-ai-remove]');
        if (removeBtn) { try { await api(`/api/custom-ai/capabilities/${removeBtn.dataset.customAiRemove}`, { method:'DELETE' }); await accessViews.renderAiControl(); } catch (e: any) { aiControlMessage.textContent = e.message; } return; }
        const healthBtn: any = (event.target as any).closest('[data-custom-ai-health]');
        if (healthBtn) { try { await api(`/api/custom-ai/capabilities/${healthBtn.dataset.customAiHealth}/health-check`, { method:'POST' }); await accessViews.renderAiControl(); } catch (e: any) { aiControlMessage.textContent = e.message; } return; }
    });
    employeeConnectionList.addEventListener('submit', async (event: any): Promise<any> => {
        event.preventDefault();
        const form: any = event.target.closest('form[data-agent-id]');
        if (!form)
            return;
        const button: any = form.querySelector('button');
        const message: any = form.querySelector('.connection-message');
        const data: any = new FormData(form);
        button.disabled = true;
        message.textContent = '正在保存到本机并连接…';
        try {
            const payload: any = await api(`/api/employee-feishu-connections/${encodeURIComponent(form.dataset.agentId)}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    appId: data.get('appId'),
                    appSecret: data.get('appSecret'),
                    allowedUserId: data.get('allowedUserId')
                })
            });
            clearRefreshDraft(form);
            form.reset();
            message.textContent = payload.employee.channel?.message || '已保存，正在连接。';
            await accessViews.renderEmployeeConnections();
            await load();
        }
        catch (error: any) {
            message.textContent = error.message;
        }
        finally {
            button.disabled = false;
        }
    });
    document.addEventListener('click', async (event: any): Promise<any> => {
        const button: any = event.target.closest('button[data-model-setup-agent-id]');
        if (!button)
            return;
        const message: any = button.closest('[data-model-setup-scope]')?.querySelector('.model-setup-message');
        if (!message)
            return;
        const target: any = button.dataset.modelSetupTarget === 'keys' ? 'keys' : 'models';
        const setupWindow: any = window.open('about:blank', '_blank');
        if (!setupWindow) {
            message.textContent = '浏览器阻止了新窗口，请允许本机页面打开新窗口后重试。';
            return;
        }
        setupWindow.opener = null;
        button.disabled = true;
        message.textContent = target === 'keys' ? '正在准备 Hermes API 与 Key 管理页…' : '正在准备 Hermes 模型管理页…';
        try {
            const payload: any = await api(`/api/employee-model-setup/${encodeURIComponent(button.dataset.modelSetupAgentId)}`, { method: 'POST' });
            setupWindow.location.replace(target === 'keys' ? payload.setup.url : payload.setup.modelUrl);
            message.textContent = target === 'keys' ? 'API 与 Key 管理页已打开。' : '模型管理页已打开。';
        }
        catch (error: any) {
            setupWindow.close();
            message.textContent = error.message;
        }
        finally {
            button.disabled = false;
        }
    });
    accessLoginProvider.addEventListener('change', accessViews.renderAccessLoginAccounts);
    accessLoginAccount.addEventListener('change', (): any => {
        if (accessLoginAccount.value)
            accessViews.setAccessStep(3);
    });
    accessStepNext2.addEventListener('click', (): any => accessViews.setAccessStep(2));
    accessStepBack1.addEventListener('click', (): any => accessViews.setAccessStep(1));
    accessStepBack2.addEventListener('click', (): any => accessViews.setAccessStep(2));
    accessStepNext3.addEventListener('click', (): any => {
        if (!accessLoginAccount.value) {
            accessLoginMessage.textContent = '请先选择一个已登录账号。';
            accessLoginAccount.focus();
            return;
        }
        accessViews.setAccessStep(3);
    });
    openPlatformLogin.addEventListener('click', async (): Promise<any> => {
        openPlatformLogin.disabled = true;
        accessLoginMessage.textContent = '正在打开真实 Chrome 登录页…';
        try {
            const payload: any = await api('/api/access-login/open', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: accessLoginProvider.value })
            });
            accessLoginMessage.textContent = `${payload.login.message} 登录完成后刷新账号。`;
            accessViews.setAccessStep(2);
        }
        catch (error: any) {
            accessLoginMessage.textContent = error.message;
        }
        finally {
            openPlatformLogin.disabled = false;
        }
    });
    refreshLoginAccounts.addEventListener('click', async (): Promise<any> => {
        refreshLoginAccounts.disabled = true;
        accessLoginMessage.textContent = '正在检查 Chrome 登录状态…';
        try {
            await accessViews.renderAccessLoginOptions();
            accessLoginMessage.textContent = accessLoginAccount.options.length > 1
                ? '已找到可授权账号，请选择。'
                : '还没有检测到登录状态。';
        }
        catch (error: any) {
            accessLoginMessage.textContent = error.message;
        }
        finally {
            refreshLoginAccounts.disabled = false;
        }
    });
    accessLoginForm.addEventListener('submit', async (event: any): Promise<any> => {
        event.preventDefault();
        const data: any = new FormData(accessLoginForm);
        saveAccessConnection.disabled = true;
        accessLoginMessage.textContent = state.reauthorizeConnectionId ? '正在续期并恢复连接…' : '正在登记受控连接…';
        try {
            const path: any = state.reauthorizeConnectionId
                ? `/api/access-connections/${encodeURIComponent(state.reauthorizeConnectionId)}/reauthorize`
                : '/api/access-connections';
            await api(path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    provider: data.get('provider'),
                    accountAlias: data.get('accountAlias'),
                    clientId: data.get('clientId')
                })
            });
            accessLoginMessage.textContent = state.reauthorizeConnectionId ? '连接已续期并恢复可用。' : '账号已授权给小D的只读能力。';
            clearRefreshDraft(accessLoginForm);
            accessLoginForm.reset();
            accessViews.resetAccessReauthorization();
            await Promise.all([accessViews.renderAccessConnections(), accessViews.renderAccessLoginOptions()]);
        }
        catch (error: any) {
            accessLoginMessage.textContent = error.message;
        }
        finally {
            saveAccessConnection.disabled = false;
        }
    });
    cancelAccessReauthorize.addEventListener('click', (): any => {
        clearRefreshDraft(accessLoginForm);
        accessLoginForm.reset();
        accessViews.resetAccessReauthorization();
        accessViews.renderAccessLoginAccounts();
        accessLoginMessage.textContent = '已取消续期。';
    });
    accessConnectionList.addEventListener('click', async (event: any): Promise<any> => {
        const button: any = event.target.closest('button[data-connection-action]');
        if (!button)
            return;
        const action: any = button.dataset.connectionAction;
        if (action === 'reauthorize') {
            state.reauthorizeConnectionId = button.dataset.connectionId;
            accessLoginProvider.value = button.dataset.provider;
            // 续期时锁定平台，防止下拉框落到其他平台导致误开错误登录页、续期到错误连接。
            accessLoginProvider.disabled = true;
            accessLoginAlias.value = button.dataset.alias;
            accessLoginDisclosure.open = true;
            accessViews.renderAccessLoginAccounts();
            accessViews.setAccessStep(1);
            saveAccessConnection.textContent = '3. 续期并恢复连接';
            cancelAccessReauthorize.hidden = false;
            accessLoginMessage.textContent = `正在续期：${button.dataset.providerLabel || button.dataset.provider}「${button.dataset.alias}」。先确认平台登录，再选择账号完成续期。`;
            accessLoginForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (action === 'default') {
            button.disabled = true;
            accessConnectionMessage.textContent = '正在保存默认账号…';
            try {
                await api(`/api/access-connections/${encodeURIComponent(button.dataset.connectionId)}/default`, { method: 'POST' });
                accessConnectionMessage.textContent = '默认账号已保存，后续任务会优先使用它。';
                await accessViews.renderAccessConnections();
            }
            catch (error: any) {
                accessConnectionMessage.textContent = error.message;
            }
            finally {
                button.disabled = false;
            }
            return;
        }
        const prompt: any = action === 'disable'
            ? '禁用后相关任务会暂停，之后可以重新授权恢复。确定暂时禁用吗？'
            : '撤销后旧连接会永久停用，需要重新授权才能继续。确定撤销吗？';
        if (!window.confirm(prompt))
            return;
        button.disabled = true;
        accessConnectionMessage.textContent = action === 'disable' ? '正在禁用账号连接…' : '正在撤销账号连接…';
        try {
            await api(`/api/access-connections/${encodeURIComponent(button.dataset.connectionId)}/${action}`, { method: 'POST' });
            accessConnectionMessage.textContent = action === 'disable' ? '账号连接已暂时禁用。' : '账号连接已撤销。';
            await accessViews.renderAccessConnections();
        }
        catch (error: any) {
            accessConnectionMessage.textContent = error.message;
        }
        finally {
            button.disabled = false;
        }
    });
    campaignList?.addEventListener('click', async (event: any): Promise<any> => {
        const button: any = event.target.closest('button[data-campaign-action]');
        const card: any = button?.closest('[data-campaign-id]');
        if (!button || !card)
            return;
        const action: any = button.dataset.campaignAction;
        if (action === 'approve' && card.dataset.campaignApprovalAllowed !== 'true') {
            campaignMessage.textContent = '启动前检查未通过，活动保持草案；请按卡片原因修复后刷新。';
            return;
        }
        const budgetCents: any = Number(card.dataset.campaignBudgetCents || 0);
        const budgetLabel: any = `$${(budgetCents / 100).toFixed(2)}`;
        const messages: any = {
            approve: `确认授权7天、每天每平台最多1条、总计最多14次，预算上限 ${budgetLabel}，并允许在范围内自动发布？验证码、风控、违规或预算超限会立即停止。`,
            pause: '暂停后不会继续生成或发布；已发布内容不会自动删除。确定暂停？',
            resume: '将从页面标明的当前阶段恢复，不重新生成已验证产物。确定恢复？',
            stop: '停止后不会自动删除已发布内容；重新运行必须新建授权。确定停止？'
        };
        if (!window.confirm(messages[action] || '确定执行这个活动操作？'))
            return;
        button.disabled = true;
        campaignMessage.textContent = '正在写回 Paperclip…';
        let failedClosed: any = false;
        try {
            await api(`/api/content-campaigns/${encodeURIComponent(card.dataset.campaignId)}/${action}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(action === 'approve'
                    ? { confirmActivityGrant: true, confirmHighBudget: budgetCents > 500 }
                    : {})
            });
            await accessViews.renderContentCampaigns();
        }
        catch (error: any) {
            failedClosed = action === 'approve';
            if (failedClosed)
                button.title = error.message;
            campaignMessage.textContent = error.message;
        }
        finally {
            button.disabled = failedClosed;
        }
    });
    document.addEventListener('submit', async (event: any): Promise<any> => {
        const form: any = (event.target as any).closest('#task-submit-form');
        if (!form) return;
        event.preventDefault();
        const message: any = form.querySelector('.task-submit-message');
        const title: any = form.querySelector('input[name="title"]')?.value?.trim();
        const description: any = form.querySelector('textarea[name="description"]')?.value?.trim();
        const agentId: any = form.querySelector('select[name="agentId"]')?.value?.trim();
        if (!title) { if (message) message.textContent = '请填写任务标题。'; return; }
        const submitBtn: any = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        if (message) message.textContent = '正在提交…';
        try {
            await api('/api/tasks/submit', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ title, description:description||undefined, agentId:agentId||undefined }) });
            if (message) message.textContent = '任务已提交，正在刷新列表…';
            form.reset();
            await load({ background:true });
            if (message) message.textContent = '任务提交成功。';
        } catch (error: any) { if (message) message.textContent = error.message; }
        finally { if (submitBtn) submitBtn.disabled = false; }
    });
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
