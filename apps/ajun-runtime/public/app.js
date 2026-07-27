const capabilityList = document.querySelector('#capability-list'); const agentList = document.querySelector('#agent-list'); const taskList = document.querySelector('#task-list'); const focusPanel = document.querySelector('#focus-panel'); const accessGate = document.querySelector('#access-gate'); const accessForm = document.querySelector('#access-form'); const accessKey = document.querySelector('#access-key'); const collaboratorName = document.querySelector('#collaborator-name'); const accessMessage = document.querySelector('#access-message'); const shareInfo = document.querySelector('#share-info'); const rotateShareKey = document.querySelector('#rotate-share-key'); const shareMessage = document.querySelector('#share-message'); const syncStatus = document.querySelector('#sync-status'); const employeeConnections = document.querySelector('#employee-connections'); const employeeConnectionList = document.querySelector('#employee-connection-list'); const accessConnections = document.querySelector('#access-connections'); const accessConnectionList = document.querySelector('#access-connection-list'); const accessConnectionMessage = document.querySelector('#access-connection-message');
const taskLabels = { 'army.intake':'先让 A君判断下一步', 'army.route-task':'任务路由', 'army.cross-agent-mission':'A君：多人任务统筹', 'media.transcribe-and-refine':'小D：转录并整理素材', 'report.public-material':'公开资料报告员：网页摘要', 'research.intel-report':'小R：公开资料研究', 'office.briefing-package':'办公执行助理：汇报包', 'operations.health-review':'运维官：本机健康检查', 'governance.approval-review':'审核官：范围与风险审查', 'governance.architecture-review':'架构师：能力评估' };
const statusLabels = { active:'可用', ready:'可用', local:'本机可用', waiting:'等待连接', blocked:'尚未配置', not_configured:'未接线', not_ready:'未就绪', pending_authorization:'待授权', verified:'已验证', connected:'已连接', external:'Hermes 已接管', connecting:'连接中', disabled:'未启用', expiring:'即将到期', expired:'已到期', revoked:'已撤销', error:'需检查', unavailable:'暂不可用', partial:'部分完成', planned:'待准备', draft:'草案中', pending_approval:'等待审核', waiting_approval:'等待确认', waiting_worker:'等待 Mac', waiting_test:'待测试', queued:'等待开始', running:'处理中', pausing:'正在暂停', paused:'已暂停', succeeded:'已完成', failed:'未完成', needs_input:'等待补充', cancelled:'已关闭', rejected:'已拒绝' };
const directEmployeeTaskTypes = ['media.transcribe-and-refine', 'report.public-material', 'research.intel-report', 'office.briefing-package'];
let overview; let shareKey = sessionStorage.getItem('ajun-share-key') || ''; let requesterName = sessionStorage.getItem('ajun-requester-name') || ''; let localOwner = false; let loading = false;
async function api(url, options = {}) { const headers = new Headers(options.headers || {}); if (shareKey) headers.set('x-ajun-share-key', shareKey); const response = await fetch(url, { ...options, headers }); const payload = await response.json(); if (!response.ok) { const error = new Error(payload.error || '请求失败。'); error.status = response.status; throw error; } return payload; }
async function load() { if (loading) return; loading = true; try { overview = await api('/api/overview'); accessGate.hidden = true; await renderLocalShare(); render(); syncStatus.textContent = `已同步 · ${new Date().toLocaleTimeString()}`; } catch (error) { if (error.status === 401) { accessGate.hidden = false; accessMessage.textContent = error.message; syncStatus.textContent = '等待共享口令'; return; } syncStatus.textContent = '同步暂不可用'; throw error; } finally { loading = false; } }
async function renderLocalShare() { try { const share = await api('/api/local-share'); localOwner = true; shareInfo.hidden = !share.enabled; if (share.enabled) { document.querySelector('#share-addresses').textContent = `同一局域网可通过：${share.addresses.map((address) => `http://${address}:4321`).join(' · ')}`; document.querySelector('#share-key').value = share.accessKey; } await Promise.all([renderEmployeeConnections(), renderAccessConnections()]); } catch { localOwner = false; shareInfo.hidden = true; employeeConnections.hidden = true; accessConnections.hidden = true; } }
async function renderEmployeeConnections() {
  if (!localOwner) return;
  const payload = await api('/api/employee-feishu-connections');
  employeeConnections.hidden = false;
  employeeConnectionList.replaceChildren(...payload.employees.map((employee) => {
    const node = document.createElement('article'); node.className = 'connection-card';
    const status = employee.channel?.status || (employee.configured ? 'connecting' : 'not_configured');
    const modelAction = employee.model?.status === 'pending_authorization' ? `<button type="button" class="model-setup-button secondary-action" data-model-setup-agent-id="${escapeHtml(employee.agentId)}">打开模型授权</button><p class="model-setup-message connection-message" role="status">使用 Hermes 官方页面，并锁定到这名员工的 Profile。</p>` : '';
    const connectionControls = status === 'external'
      ? '<div class="connection-managed"><strong>独立员工入口已启用</strong><p>该员工由自己的 Hermes 档案和飞书入口承接。凭据不会在页面展示；更换应用时使用受控迁移流程，避免两个入口同时收消息。</p></div>'
      : `<form data-agent-id="${escapeHtml(employee.agentId)}"><label>飞书 App ID<input name="appId" autocomplete="off" placeholder="cli_..." required></label><label>App Secret<input name="appSecret" type="password" autocomplete="new-password" required></label><label>允许老板的 open_id<input name="allowedUserId" autocomplete="off" placeholder="ou_..." required></label><button>${employee.configured ? '更新并重新连接' : '保存并连接'}</button><p class="connection-message" role="status">${escapeHtml(employee.channel?.message || '尚未接线。')}</p></form>`;
    node.innerHTML = `<div><span class="status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span><h3>${escapeHtml(employee.name)}</h3><p>${escapeHtml(employee.role)}</p><p class="readiness-row"><strong>模型：</strong><span class="status ${escapeHtml(employee.model?.status || 'not_ready')}">${escapeHtml(statusLabel(employee.model?.status || 'not_ready'))}</span> ${escapeHtml(employee.model?.message || '模型状态待核对。')}</p>${modelAction}<p class="readiness-row"><strong>飞书：</strong>${escapeHtml(employee.channel?.message || '尚未接线。')}</p><small>事件：${escapeHtml(employee.requiredEvents.join('、'))}<br>权限：${escapeHtml(employee.requiredScopes.join('、'))}</small></div>${connectionControls}`;
    return node;
  }));
}
async function renderAccessConnections() {
  if (!localOwner) return;
  const payload = await api('/api/access-connections');
  accessConnections.hidden = false;
  accessConnectionMessage.textContent = payload.status === 'unavailable'
    ? (payload.message || '账号连接状态暂时不可用。')
    : `已读取 ${payload.connections.length} 条脱敏连接状态。`;
  accessConnectionList.replaceChildren(...payload.connections.map((connection) => {
    const node = document.createElement('article'); node.className = 'connection-card account-connection-card';
    const canRevoke = ['active', 'expiring', 'error'].includes(connection.status);
    const operationText = connection.grantedOperations.length ? connection.grantedOperations.join('、') : '未登记';
    const scopeText = connection.dataScope.length ? connection.dataScope.join('、') : '未登记';
    const employeeText = connection.allowedAgentIds.length ? connection.allowedAgentIds.map(agentName).join('、') : '未分配';
    const timing = connection.expiresAt ? `到期：${formatDate(connection.expiresAt)}` : '到期：由连接器管理';
    const health = connection.lastHealthAt ? `最近检查：${formatDate(connection.lastHealthAt)}` : '最近检查：尚无记录';
    node.innerHTML = `<div><span class="status ${escapeHtml(connection.status)}">${escapeHtml(statusLabel(connection.status))}</span><h3>${escapeHtml(connection.accountAlias || connection.provider || '未命名连接')}</h3><p>${escapeHtml(connection.provider || '未知平台')}</p><p class="readiness-row"><strong>可用员工：</strong>${escapeHtml(employeeText)}</p><p class="readiness-row"><strong>允许动作：</strong>${escapeHtml(operationText)}</p><p class="readiness-row"><strong>数据范围：</strong>${escapeHtml(scopeText)}</p><small>${escapeHtml(timing)}<br>${escapeHtml(health)}<br>${connection.hasCredentialReference ? '受控凭据引用已登记' : '未登记受控凭据引用'}</small></div>${canRevoke ? `<button type="button" class="revoke-connection secondary-action" data-connection-id="${escapeHtml(connection.connectionId)}">撤销连接</button>` : '<span class="connection-final-state">无需操作</span>'}`;
    return node;
  }));
}
function render() {
  renderFocus(overview.taskFocus);
  capabilityList.replaceChildren(...overview.capabilities.map((item) => card(item.name, item.detail, item.status)));
  const directEmployees = overview.agents.filter(isDirectEmployee); const supportEmployees = overview.agents.filter((agent) => !isDirectEmployee(agent));
  agentList.replaceChildren(...[
    agentGroupTitle('飞书可调用业务员工', '请在“A君·军团总管”会话中交办。'),
    ...directEmployees.map((agent) => agentCard(agent, false)),
    agentGroupTitle('后台保障', 'A君会按任务需要调用这些岗位；你不用手动安排。'),
    ...supportEmployees.map((agent) => agentCard(agent, true))
  ]);
  taskList.replaceChildren(); if (!overview.tasks.length) return taskList.append(document.querySelector('#empty').content.cloneNode(true));
  overview.tasks.forEach((task) => {
    const node = document.createElement('article'); node.className = 'task';
    const approval = overview.approvals.find((item) => task.approvalRefs?.includes(item.approvalId));
    const pendingApproval = approval?.status === 'pending' ? approval : null;
    const report = task.artifactRefs.find((item) => item.type === 'health_report')?.data;
    const intake = task.artifactRefs.find((item) => item.type === 'task_intake_record')?.data;
    const review = task.artifactRefs.find((item) => item.type === 'review_report')?.data;
    const architecture = task.artifactRefs.find((item) => item.type === 'architecture_review')?.data;
    const xiaodResult = task.artifactRefs.find((item) => item.type === 'xiaod_media_delivery');
    const publicReport = task.artifactRefs.find((item) => item.type === 'public_web_report')?.data;
    const recovery = recoveryState(task);
    const approvalResult = pendingApproval ? `<p class="result degraded">待你确认：${escapeHtml(pendingApproval.reason)}<br><small>本次范围：${escapeHtml(pendingApproval.requestedScope?.title || task.input.title)} · ${escapeHtml(taskTypeLabel(pendingApproval.requestedScope?.taskType || task.taskType))}</small></p>` : '';
    const result = approvalResult || (recovery ? `<p class="result ${recovery.tone}">${escapeHtml(recovery.detail)}</p>` : task.error?.userMessage ? `<p class="result degraded">需要处理：${escapeHtml(task.error.userMessage)}</p>` : report ? `<p class="result ${escapeHtml(report.overall)}">健康检查：${escapeHtml(report.overall === 'healthy' ? '正常' : '需要关注')} · ${escapeHtml(report.components.map((item) => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、'))}</p>` : intake ? `<p class="result healthy">下一步建议：${escapeHtml(intake.nextAction)}</p>` : review ? `<p class="result ${review.scopeStated ? 'healthy' : 'degraded'}">审核结论：${escapeHtml(review.nextAction)}</p>` : architecture ? `<p class="result healthy">能力评估：已启用 ${architecture.currentCapabilities.length} 个岗位 · ${escapeHtml(architecture.nextAction)}</p>` : publicReport ? `<p class="result healthy">网页摘要：${escapeHtml(publicReport.summary)}</p>` : xiaodResult ? `<p class="result ${xiaodResult.validation?.qualityPassed ? 'healthy' : 'degraded'}">小D交付已生成 · ${xiaodResult.validation?.qualityPassed ? '质量检查通过' : '建议人工校对'}</p>` : '');
    const shownStatus = recovery || { label:statusLabel(task.status), className:task.status };
    node.innerHTML = `<div><span class="status ${escapeHtml(shownStatus.className)}">${escapeHtml(shownStatus.label)}</span><h3>${escapeHtml(task.input.title)}</h3><p>${escapeHtml(task.routing.reason)}</p>${result}</div><div class="meta"><strong>${escapeHtml(agentName(task.assigneeAgentId))}</strong><span>${escapeHtml(taskTypeLabel(task.taskType))}</span><span>提交人：${escapeHtml(requesterLabel(task))}</span>${task.parentTaskId ? '<span>来自 A君建议</span>' : ''}${pendingApproval ? '<span class="approval">请在飞书原会话处理</span>' : ''}</div>`;
    taskList.append(node);
  });
}
function renderFocus(focus) {
  if (!focus?.total) { focusPanel.innerHTML = '<div><p class="eyebrow">当前状态</p><h3>还没有待处理任务</h3><p>从下面登记一件要推进的事，A君会先给出安全的下一步。</p></div><div class="focus-counts"><span>已完成 0</span><span>处理中 0</span></div>'; return; }
  const current = focus.next; const focusTask = overview.tasks.find((task) => task.taskId === current?.taskId); const recovery = focusTask ? recoveryState(focusTask) : null; const title = current ? escapeHtml(current.title) : '当前没有待处理任务'; const action = recovery ? escapeHtml(recovery.detail) : current ? escapeHtml(current.action) : '所有已登记任务都已经结束。';
  const recovering = overview.tasks.filter((task) => recoveryState(task)?.active).length; const unresolved = Math.max(0, focus.failed - recovering);
  focusPanel.innerHTML = `<div><p class="eyebrow">${current ? '当前一步' : '当前状态'}</p><h3>${title}</h3><p>${action}</p></div><div class="focus-counts"><span>已完成 ${focus.completed}/${focus.total}</span><span>处理中 ${focus.inProgress}</span>${recovering ? `<span class="attention">系统接手 ${recovering}</span>` : ''}${focus.paused ? `<span>已暂停 ${focus.paused}</span>` : ''}${focus.needsInput ? `<span>待补充 ${focus.needsInput}</span>` : ''}${focus.waitingApproval ? `<span class="attention">待确认 ${focus.waitingApproval}</span>` : ''}${focus.waitingTest ? `<span class="attention">待测试 ${focus.waitingTest}</span>` : ''}${unresolved ? `<span class="attention">待处理 ${unresolved}</span>` : ''}</div>`;
}
function isDirectEmployee(agent) { return agent.acceptedTaskTypes.some((type) => directEmployeeTaskTypes.includes(type)); }
function agentGroupTitle(title, detail) { const node = document.createElement('div'); node.className = 'agent-group-title'; node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`; return node; }
function agentCard(agent, support) { const node = document.createElement('article'); node.className = `agent${support ? ' support-agent' : ''}`; const types = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · '); const independent = independentRuntimeLabel(agent); node.innerHTML = `<div><span class="status ${agent.status}">${statusLabel(agent.status)}</span><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.role)}</p></div><small>${types}</small><small>独立员工状态：${escapeHtml(independent)}</small>`; return node; }
function independentRuntimeLabel(agent) { const state = agent.independentRuntime?.state; if (state === 'model_pending') return '岗位已定义，正在配置独立大脑'; if (state === 'model_transport_pending') return '独立身份已建立，模型授权和真实调用待完成'; const channel = agent.feishuChannel; if (channel?.status === 'external' && channel?.verified === true) return '独立 Hermes 员工已完成真实任务与连续追问'; if (channel?.status === 'external') return '独立 Hermes 飞书入口已接管，待真实消息验证'; if (channel?.verified === true) return '独立飞书入口已完成真实任务收发'; if (channel?.status === 'connected') return '独立飞书入口已连接，待真实消息验证'; if (channel?.status === 'connecting') return '独立飞书入口正在连接'; if (channel?.status === 'failed') return `独立飞书入口未连接：${channel.message}`; if (channel?.status === 'disabled') return `独立飞书入口未启用：${channel.message}`; return ({ ready:'已独立接通', channel_pending:'模型调用已验证，飞书入口待接通', waiting_verification:'独立入口待真实验证', not_created:'独立身份尚未创建', missing_profile:'独立身份资料缺失', invalid_reference:'独立身份资料无效', not_declared:'目前由 A君统一代管' })[state] || (agent.source === 'approved-proposal' ? '通过限定试用，由 A君统一代管' : '状态待核对'); }
function taskTypeLabel(type) { const agent = overview?.agents.find((item) => item.acceptedTaskTypes.includes(type)); const suffix = agent?.status === 'draft' ? '（准备中）' : ''; return `${taskLabels[type] || agent?.name || '待分配工作'}${suffix}`; }
function statusLabel(status) { return statusLabels[String(status || '')] || '状态待确认'; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString(); }
function recoveryState(task) {
  if (task.status !== 'failed') return null;
  const children = overview?.tasks?.filter((item) => item.parentTaskId === task.taskId) || [];
  const latest = (items) => [...items].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0];
  const technical = latest(children.filter((item) => item.taskType === 'operations.technical-repair'));
  if (technical?.status === 'waiting_test') return { label:'待测试', className:'waiting_test', tone:'degraded', active:false, detail:'技术专家已保留当前结果，但这轮检查还需要后续验证；其他工作会继续推进。' };
  if (technical?.status === 'succeeded') return { label:'修复已核对', className:'succeeded', tone:'healthy', active:false, detail:'技术专家已经完成本轮修复和检查；A君正在保留最终记录。' };
  if (technical?.status === 'failed') return { label:'修复未完成', className:'failed', tone:'degraded', active:false, detail:'技术专家本轮没有修复成功，当前记录已保留，不会假装完成。' };
  if (technical && ['queued', 'running'].includes(technical.status)) return { label:'技术专家处理中', className:'running', tone:'healthy', active:true, detail:'技术专家正在处理这件事，A君会继续跟进最终结果；你不用重复提交。' };
  const retry = latest(children.filter((item) => item.taskType === task.taskType && item.recovery?.rootTaskId === task.taskId));
  if (retry && ['queued', 'running'].includes(retry.status)) return { label:'正在自动重试', className:'running', tone:'healthy', active:true, detail:'运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  const coordination = task.recovery?.coordination?.status;
  if (coordination === 'pending') return { label:'系统正在接手', className:'running', tone:'healthy', active:true, detail:'任务遇到问题，运维官正在判断安全的恢复办法。' };
  if (coordination === 'retrying') return { label:'正在自动重试', className:'running', tone:'healthy', active:true, detail:'运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  if (coordination === 'escalated') return { label:'技术专家处理中', className:'running', tone:'healthy', active:true, detail:'这件事已经交给技术专家，A君会继续跟进最终结果。' };
  return null;
}
function agentName(agentId) { return overview?.agents.find((agent) => agent.agentId === agentId)?.name || '等待分配'; }
function requesterLabel(task) { const requester = task?.requester || {}; if (/^ou_[a-zA-Z0-9]+$/.test(String(requester.ref || ''))) return '飞书老板'; if (requester.kind === 'local-owner') return '老板'; if (requester.kind === 'feishu-user') return '飞书老板'; if (requester.kind === 'local-system') return 'A君'; if (requester.kind === 'lan-collaborator') return requester.ref || '局域网同事'; return '内部协作'; }
function card(name, detail, status) { const node=document.createElement('article'); node.className='capability'; node.innerHTML=`<span class="status ${status}">${statusLabel(status)}</span><h3>${name}</h3><p>${detail}</p>`; return node; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
accessForm.addEventListener('submit', async (event) => { event.preventDefault(); shareKey = accessKey.value.trim(); requesterName = collaboratorName.value.trim(); sessionStorage.setItem('ajun-share-key', shareKey); sessionStorage.setItem('ajun-requester-name', requesterName); await load(); });
rotateShareKey.addEventListener('click', async () => { if (!window.confirm('换新后，旧口令会立即失效。确定继续吗？')) return; rotateShareKey.disabled = true; try { const share = await api('/api/local-share/rotate', { method:'POST' }); document.querySelector('#share-key').value = share.accessKey; shareMessage.textContent = '已换新，请把新口令发给需要继续访问的人。'; } catch (error) { shareMessage.textContent = error.message; } finally { rotateShareKey.disabled = false; } });
employeeConnectionList.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.closest('form[data-agent-id]'); if (!form) return;
  const button = form.querySelector('button'); const message = form.querySelector('.connection-message'); const data = new FormData(form);
  button.disabled = true; message.textContent = '正在保存到本机并连接…';
  try {
    const payload = await api(`/api/employee-feishu-connections/${encodeURIComponent(form.dataset.agentId)}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ appId:data.get('appId'), appSecret:data.get('appSecret'), allowedUserId:data.get('allowedUserId') })
    });
    form.reset(); message.textContent = payload.employee.channel?.message || '已保存，正在连接。'; await renderEmployeeConnections(); await load();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
employeeConnectionList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-model-setup-agent-id]'); if (!button) return;
  const message = button.parentElement.querySelector('.model-setup-message');
  const setupWindow = window.open('about:blank', '_blank'); if (!setupWindow) { message.textContent = '浏览器阻止了新窗口，请允许本机页面打开新窗口后重试。'; return; }
  setupWindow.opener = null; button.disabled = true; message.textContent = '正在准备这名员工的 Hermes 官方授权页…';
  try {
    const payload = await api(`/api/employee-model-setup/${encodeURIComponent(button.dataset.modelSetupAgentId)}`, { method:'POST' });
    setupWindow.location.replace(payload.setup.url); message.textContent = '授权页已打开。完成登录后回到这里，系统会继续核对。';
  } catch (error) { setupWindow.close(); message.textContent = error.message; }
  finally { button.disabled = false; }
});
accessConnectionList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-connection-id]'); if (!button) return;
  if (!window.confirm('撤销后，使用这个账号连接的员工会停止相关工作，直到重新授权。确定撤销吗？')) return;
  button.disabled = true; accessConnectionMessage.textContent = '正在撤销账号连接…';
  try {
    await api(`/api/access-connections/${encodeURIComponent(button.dataset.connectionId)}/revoke`, { method:'POST' });
    accessConnectionMessage.textContent = '账号连接已撤销。'; await renderAccessConnections();
  } catch (error) { accessConnectionMessage.textContent = error.message; }
  finally { button.disabled = false; }
});
function canAutoSync() { return !document.hidden && accessGate.hidden && !accessForm.contains(document.activeElement); }
setInterval(() => { if (canAutoSync()) load().catch(() => {}); }, 5000);
document.addEventListener('visibilitychange', () => { if (canAutoSync()) load().catch(() => {}); });
load().catch((error) => { syncStatus.textContent = error.message; });
