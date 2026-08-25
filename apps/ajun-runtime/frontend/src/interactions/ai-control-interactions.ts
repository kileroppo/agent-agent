export function bindAiControlInteractions({ elements, api, accessViews }: any): any {
    const { refreshAiControl, aiControlMessage, aiServiceList }: any = elements;
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
}
