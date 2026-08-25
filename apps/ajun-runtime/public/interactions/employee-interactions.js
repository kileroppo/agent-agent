import { clearRefreshDraft } from '../refresh-scheduler.js';
import { escapeHtml } from '../html.js';
export function bindEmployeeInteractions({ elements, api, accessViews, load }) {
    const { employeeConnectionList } = elements;
    employeeConnectionList.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target.closest('form[data-agent-id]');
        if (!form)
            return;
        const button = form.querySelector('button');
        const message = form.querySelector('.connection-message');
        const data = new FormData(form);
        button.disabled = true;
        message.textContent = '正在保存到本机并连接…';
        try {
            const payload = await api(`/api/employee-feishu-connections/${encodeURIComponent(form.dataset.agentId)}`, {
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
        catch (error) {
            message.textContent = error.message;
        }
        finally {
            button.disabled = false;
        }
    });
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-model-setup-agent-id]');
        if (!button)
            return;
        const message = button.closest('[data-model-setup-scope]')?.querySelector('.model-setup-message');
        if (!message)
            return;
        const target = button.dataset.modelSetupTarget === 'keys' ? 'keys' : 'models';
        const targetLabel = target === 'keys' ? 'API 与 Key 管理页' : '模型管理页';
        let setupWindow = null;
        try {
            setupWindow = window.open('about:blank', '_blank');
        }
        catch {
            setupWindow = null;
        }
        button.disabled = true;
        message.textContent = `正在准备 Hermes ${targetLabel}（若初次启动可能需要 1~3 秒）…`;
        try {
            const payload = await api(`/api/employee-model-setup/${encodeURIComponent(button.dataset.modelSetupAgentId)}`, { method: 'POST' });
            const targetUrl = target === 'keys' ? payload.setup.url : payload.setup.modelUrl;
            let opened = false;
            if (setupWindow && !setupWindow.closed) {
                try {
                    setupWindow.location.href = targetUrl;
                    setupWindow.opener = null;
                    opened = true;
                }
                catch {
                    try {
                        setupWindow.close();
                    }
                    catch { }
                    setupWindow = null;
                }
            }
            if (!opened) {
                try {
                    const fallbackWindow = window.open(targetUrl, '_blank', 'noopener,noreferrer');
                    if (fallbackWindow) {
                        try {
                            fallbackWindow.opener = null;
                        }
                        catch { }
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
        catch (error) {
            if (setupWindow && !setupWindow.closed) {
                try {
                    setupWindow.close();
                }
                catch { }
            }
            message.textContent = error.message || '打开 Hermes 授权页失败，请稍后重试。';
        }
        finally {
            button.disabled = false;
        }
    });
}
