import { clearRefreshDraft } from '../refresh-scheduler.js';

export function bindEmployeeInteractions({ elements, api, accessViews, load }: any): any {
    const { employeeConnectionList }: any = elements;
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
}
