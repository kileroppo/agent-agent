import { canRefreshConsole, startRefreshScheduler } from './refresh-scheduler.js';

export function bindConsoleInteractions({
  elements,
  state,
  api,
  load,
  setSyncStatus,
  moduleNavigation,
  accessViews,
}) {
  const {
    accessForm, accessKey, collaboratorName, rotateShareKey, shareMessage,
    refreshAiControl, aiControlMessage, aiServiceList, employeeConnectionList,
    accessLoginProvider, accessLoginAccount, accessStepNext2, accessStepBack1,
    accessStepBack2, accessStepNext3, accessLoginMessage, openPlatformLogin,
    refreshLoginAccounts, accessLoginForm, saveAccessConnection,
    cancelAccessReauthorize, accessConnectionList, accessConnectionMessage,
    accessLoginAlias, accessLoginDisclosure,
    campaignList, campaignMessage,
    accessGate,
  } = elements;

accessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  state.shareKey = accessKey.value.trim();
  state.requesterName = collaboratorName.value.trim();
  sessionStorage.setItem('ajun-share-key', state.shareKey);
  sessionStorage.setItem('ajun-requester-name', state.requesterName);
  await load();
});

rotateShareKey.addEventListener('click', async () => {
  if (!window.confirm('换新后，旧口令会立即失效。确定继续吗？')) return;
  rotateShareKey.disabled = true;
  try {
    const share = await api('/api/local-share/rotate', { method: 'POST' });
    document.querySelector('#share-key').value = share.accessKey;
    shareMessage.textContent = '已换新，请把新口令发给需要继续访问的人。';
  } catch (error) {
    shareMessage.textContent = error.message;
  } finally {
    rotateShareKey.disabled = false;
  }
});

refreshAiControl.addEventListener('click', async () => {
  refreshAiControl.disabled = true;
  aiControlMessage.textContent = '正在重新检测 Mac 与 4070 节点…';
  try {
    await api('/api/local-ai/services/desktop-node/reconnect', { method:'POST' });
    await accessViews.renderAiControl();
  } catch (error) {
    aiControlMessage.textContent = error.message;
  } finally {
    refreshAiControl.disabled = false;
  }
});

aiServiceList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-ai-service]');
  if (!button) return;
  const { aiService:serviceId, aiAction:action } = button.dataset;
  if (action === 'stop' && !window.confirm('停止后不会自动保持后台运行；下次任务可按策略重新唤醒。确定停止吗？')) return;
  button.disabled = true;
  aiControlMessage.textContent = `正在${accessViews.aiActionLabel(action)} ${serviceId}…`;
  try {
    await api(`/api/local-ai/services/${encodeURIComponent(serviceId)}/${encodeURIComponent(action)}`, { method:'POST' });
    await accessViews.renderAiControl();
  } catch (error) {
    aiControlMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

aiServiceList.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-ai-policy]');
  if (!select) return;
  select.disabled = true;
  aiControlMessage.textContent = '正在保存启动策略…';
  try {
    await api(`/api/local-ai/services/${encodeURIComponent(select.dataset.aiPolicy)}/policy`, {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ mode:select.value, idleSeconds:900 }),
    });
    await accessViews.renderAiControl();
  } catch (error) {
    aiControlMessage.textContent = error.message;
    await accessViews.renderAiControl();
  }
});

employeeConnectionList.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.closest('form[data-agent-id]');
  if (!form) return;
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
    form.reset();
    message.textContent = payload.employee.channel?.message || '已保存，正在连接。';
    await accessViews.renderEmployeeConnections();
    await load();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-model-setup-agent-id]');
  if (!button) return;
  const message = button.closest('[data-model-setup-scope]')?.querySelector('.model-setup-message');
  if (!message) return;
  const target = button.dataset.modelSetupTarget === 'keys' ? 'keys' : 'models';
  const setupWindow = window.open('about:blank', '_blank');
  if (!setupWindow) {
    message.textContent = '浏览器阻止了新窗口，请允许本机页面打开新窗口后重试。';
    return;
  }
  setupWindow.opener = null;
  button.disabled = true;
  message.textContent = target === 'keys' ? '正在准备 Hermes API 与 Key 管理页…' : '正在准备 Hermes 模型管理页…';
  try {
    const payload = await api(`/api/employee-model-setup/${encodeURIComponent(button.dataset.modelSetupAgentId)}`, { method: 'POST' });
    setupWindow.location.replace(target === 'keys' ? payload.setup.url : payload.setup.modelUrl);
    message.textContent = target === 'keys' ? 'API 与 Key 管理页已打开。' : '模型管理页已打开。';
  } catch (error) {
    setupWindow.close();
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

accessLoginProvider.addEventListener('change', accessViews.renderAccessLoginAccounts);
accessLoginAccount.addEventListener('change', () => {
  if (accessLoginAccount.value) accessViews.setAccessStep(3);
});
accessStepNext2.addEventListener('click', () => accessViews.setAccessStep(2));
accessStepBack1.addEventListener('click', () => accessViews.setAccessStep(1));
accessStepBack2.addEventListener('click', () => accessViews.setAccessStep(2));
accessStepNext3.addEventListener('click', () => {
  if (!accessLoginAccount.value) {
    accessLoginMessage.textContent = '请先选择一个已登录账号。';
    accessLoginAccount.focus();
    return;
  }
  accessViews.setAccessStep(3);
});

openPlatformLogin.addEventListener('click', async () => {
  openPlatformLogin.disabled = true;
  accessLoginMessage.textContent = '正在打开真实 Chrome 登录页…';
  try {
    const payload = await api('/api/access-login/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: accessLoginProvider.value })
    });
    accessLoginMessage.textContent = `${payload.login.message} 登录完成后刷新账号。`;
    accessViews.setAccessStep(2);
  } catch (error) {
    accessLoginMessage.textContent = error.message;
  } finally {
    openPlatformLogin.disabled = false;
  }
});

refreshLoginAccounts.addEventListener('click', async () => {
  refreshLoginAccounts.disabled = true;
  accessLoginMessage.textContent = '正在检查 Chrome 登录状态…';
  try {
    await accessViews.renderAccessLoginOptions();
    accessLoginMessage.textContent = accessLoginAccount.options.length > 1
      ? '已找到可授权账号，请选择。'
      : '还没有检测到登录状态。';
  } catch (error) {
    accessLoginMessage.textContent = error.message;
  } finally {
    refreshLoginAccounts.disabled = false;
  }
});

accessLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(accessLoginForm);
  saveAccessConnection.disabled = true;
  accessLoginMessage.textContent = state.reauthorizeConnectionId ? '正在续期并恢复连接…' : '正在登记受控连接…';
  try {
    const path = state.reauthorizeConnectionId
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
    accessLoginForm.reset();
    accessViews.resetAccessReauthorization();
    await Promise.all([accessViews.renderAccessConnections(), accessViews.renderAccessLoginOptions()]);
  } catch (error) {
    accessLoginMessage.textContent = error.message;
  } finally {
    saveAccessConnection.disabled = false;
  }
});

cancelAccessReauthorize.addEventListener('click', () => {
  accessLoginForm.reset();
  accessViews.resetAccessReauthorization();
  accessViews.renderAccessLoginAccounts();
  accessLoginMessage.textContent = '已取消续期。';
});

accessConnectionList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-connection-action]');
  if (!button) return;
  const action = button.dataset.connectionAction;
  if (action === 'reauthorize') {
    state.reauthorizeConnectionId = button.dataset.connectionId;
    accessLoginProvider.value = button.dataset.provider;
    accessLoginAlias.value = button.dataset.alias;
    accessLoginDisclosure.open = true;
    accessViews.renderAccessLoginAccounts();
    accessViews.setAccessStep(1);
    saveAccessConnection.textContent = '3. 续期并恢复连接';
    cancelAccessReauthorize.hidden = false;
    accessLoginMessage.textContent = '先确认平台登录，再选择账号完成续期。';
    accessLoginForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (action === 'default') {
    button.disabled = true;
    accessConnectionMessage.textContent = '正在保存默认账号…';
    try {
      await api(`/api/access-connections/${encodeURIComponent(button.dataset.connectionId)}/default`, { method:'POST' });
      accessConnectionMessage.textContent = '默认账号已保存，后续任务会优先使用它。';
      await accessViews.renderAccessConnections();
    } catch (error) {
      accessConnectionMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
    return;
  }
  const prompt = action === 'disable'
    ? '禁用后相关任务会暂停，之后可以重新授权恢复。确定暂时禁用吗？'
    : '撤销后旧连接会永久停用，需要重新授权才能继续。确定撤销吗？';
  if (!window.confirm(prompt)) return;
  button.disabled = true;
  accessConnectionMessage.textContent = action === 'disable' ? '正在禁用账号连接…' : '正在撤销账号连接…';
  try {
    await api(`/api/access-connections/${encodeURIComponent(button.dataset.connectionId)}/${action}`, { method: 'POST' });
    accessConnectionMessage.textContent = action === 'disable' ? '账号连接已暂时禁用。' : '账号连接已撤销。';
    await accessViews.renderAccessConnections();
  } catch (error) {
    accessConnectionMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

campaignList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-campaign-action]');
  const card = button?.closest('[data-campaign-id]');
  if (!button || !card) return;
  const action = button.dataset.campaignAction;
  if (action === 'approve' && card.dataset.campaignApprovalAllowed !== 'true') {
    campaignMessage.textContent = '启动前检查未通过，活动保持草案；请按卡片原因修复后刷新。';
    return;
  }
  const budgetCents = Number(card.dataset.campaignBudgetCents || 0);
  const budgetLabel = `$${(budgetCents / 100).toFixed(2)}`;
  const messages = {
    approve:`确认授权7天、每天每平台最多1条、总计最多14次，预算上限 ${budgetLabel}，并允许在范围内自动发布？验证码、风控、违规或预算超限会立即停止。`,
    pause:'暂停后不会继续生成或发布；已发布内容不会自动删除。确定暂停？',
    resume:'将从页面标明的当前阶段恢复，不重新生成已验证产物。确定恢复？',
    stop:'停止后不会自动删除已发布内容；重新运行必须新建授权。确定停止？'
  };
  if (!window.confirm(messages[action] || '确定执行这个活动操作？')) return;
  button.disabled = true;
  campaignMessage.textContent = '正在写回 Paperclip…';
  let failedClosed = false;
  try {
    await api(`/api/content-campaigns/${encodeURIComponent(card.dataset.campaignId)}/${action}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(action === 'approve'
        ? { confirmActivityGrant:true, confirmHighBudget:budgetCents > 500 }
        : {})
    });
    await accessViews.renderContentCampaigns();
  } catch (error) {
    failedClosed = action === 'approve';
    if (failedClosed) button.title = error.message;
    campaignMessage.textContent = error.message;
  } finally {
    button.disabled = failedClosed;
  }
});

window.addEventListener('hashchange', moduleNavigation.locationChanged);

startRefreshScheduler({
  refresh:load,
  canRefresh:() => canRefreshConsole({
    page:document,
    accessGate,
    forms:[accessForm, accessLoginForm],
  }),
  intervalMs:15_000,
});

accessViews.setAccessStep(1);
load().catch((error) => {
  setSyncStatus(error.message, 'error');
});

}
