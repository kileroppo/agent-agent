export function bindCampaignInteractions({ elements, api, accessViews, load }: any): any {
    const { campaignList, campaignMessage }: any = elements;
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
}
