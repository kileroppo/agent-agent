import { clearRefreshDraft } from '../refresh-scheduler.js';
import { escapeHtml } from '../html.js';

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
        const targetLabel: string = target === 'keys' ? 'API 与 Key 管理页' : '模型管理页';

        let setupWindow: any = null;
        try {
            setupWindow = window.open('about:blank', '_blank');
        }
        catch {
            setupWindow = null;
        }

        button.disabled = true;
        message.textContent = `正在准备 Hermes ${targetLabel}（若初次启动可能需要 1~3 秒）…`;
        try {
            const payload: any = await api(`/api/employee-model-setup/${encodeURIComponent(button.dataset.modelSetupAgentId)}`, { method: 'POST' });
            const targetUrl: string = target === 'keys' ? payload.setup.url : payload.setup.modelUrl;

            let opened = false;
            if (setupWindow && !setupWindow.closed) {
                try {
                    setupWindow.location.href = targetUrl;
                    setupWindow.opener = null;
                    opened = true;
                }
                catch {
                    try { setupWindow.close(); } catch {}
                    setupWindow = null;
                }
            }

            if (!opened) {
                try {
                    const fallbackWindow: any = window.open(targetUrl, '_blank', 'noopener,noreferrer');
                    if (fallbackWindow) {
                        try { fallbackWindow.opener = null; } catch {}
                        opened = true;
                    }
                }
                catch {
                    opened = false;
                }
            }

            if (opened) {
                message.innerHTML = `${escapeHtml(targetLabel)}已打开。<a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer" class="link-action" style="text-decoration:underline;margin-left:4px;">未自动弹出请点此直达 ↗</a>`;
            }
            else {
                message.innerHTML = `Hermes 授权页已就绪：<a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer" class="link-action" style="font-weight:bold;text-decoration:underline;color:var(--accent-color, #2563eb);">点此直接打开 ${escapeHtml(targetLabel)} ↗</a>`;
            }
        }
        catch (error: any) {
            if (setupWindow && !setupWindow.closed) {
                try { setupWindow.close(); } catch {}
            }
            message.textContent = error.message || '打开 Hermes 授权页失败，请稍后重试。';
        }
        finally {
            button.disabled = false;
        }
    });
}

