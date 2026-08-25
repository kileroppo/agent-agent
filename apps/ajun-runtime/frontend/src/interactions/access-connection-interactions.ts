import { clearRefreshDraft } from '../refresh-scheduler.js';

export function bindAccessConnectionInteractions({ elements, state, api, accessViews }: any): any {
    const { accessLoginProvider, accessLoginAccount, accessStepNext2, accessStepBack1, accessStepBack2, accessStepNext3, accessLoginMessage, openPlatformLogin, refreshLoginAccounts, accessLoginForm, saveAccessConnection, cancelAccessReauthorize, accessConnectionList, accessConnectionMessage, accessLoginAlias, accessLoginDisclosure }: any = elements;
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
}
