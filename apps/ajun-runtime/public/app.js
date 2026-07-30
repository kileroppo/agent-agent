const capabilityList = document.querySelector('#capability-list');
const agentList = document.querySelector('#agent-list');
const taskList = document.querySelector('#task-list');
const recentTaskList = document.querySelector('#recent-task-list');
const overviewStats = document.querySelector('#overview-stats');
const overviewSummary = document.querySelector('#overview-summary');
const taskCount = document.querySelector('#task-count');
const taskSearch = document.querySelector('#task-search');
const taskLoadMore = document.querySelector('#task-load-more');
const focusPanel = document.querySelector('#focus-panel');
const capabilitySummary = document.querySelector('#capability-summary');
const accessGate = document.querySelector('#access-gate');
const accessForm = document.querySelector('#access-form');
const accessKey = document.querySelector('#access-key');
const collaboratorName = document.querySelector('#collaborator-name');
const accessMessage = document.querySelector('#access-message');
const shareInfo = document.querySelector('#share-info');
const rotateShareKey = document.querySelector('#rotate-share-key');
const shareMessage = document.querySelector('#share-message');
const syncStatus = document.querySelector('#sync-status');
const syncIndicator = document.querySelector('#sync-indicator');
const employeeConnections = document.querySelector('#employee-connections');
const employeeConnectionList = document.querySelector('#employee-connection-list');
const accessConnections = document.querySelector('#access-connections');
const accessConnectionList = document.querySelector('#access-connection-list');
const accessConnectionMessage = document.querySelector('#access-connection-message');
const contentAccessSummary = document.querySelector('#content-access-summary');
const accessLoginDisclosure = document.querySelector('#access-login-disclosure');
const accessLoginForm = document.querySelector('#access-login-form');
const accessLoginProvider = document.querySelector('#access-login-provider');
const accessLoginAlias = document.querySelector('#access-login-alias');
const accessLoginAccount = document.querySelector('#access-login-account');
const accessLoginMessage = document.querySelector('#access-login-message');
const openPlatformLogin = document.querySelector('#open-platform-login');
const refreshLoginAccounts = document.querySelector('#refresh-login-accounts');
const saveAccessConnection = document.querySelector('#save-access-connection');
const cancelAccessReauthorize = document.querySelector('#cancel-access-reauthorize');
const campaignList = document.querySelector('#campaign-list');
const campaignMessage = document.querySelector('#campaign-message');
const moduleLinks = [...document.querySelectorAll('[data-module]')];
const modulePages = [...document.querySelectorAll('[data-module-page]')];
const ownerOnlyElements = [...document.querySelectorAll('[data-owner-only]')];
const taskFilterButtons = [...document.querySelectorAll('[data-task-filter]')];
const accessStepPanels = [...document.querySelectorAll('[data-access-step-panel]')];
const accessStepIndicators = [...document.querySelectorAll('[data-access-step-indicator]')];
const accessStepNext2 = document.querySelector('#access-step-next-2');
const accessStepNext3 = document.querySelector('#access-step-next-3');
const accessStepBack1 = document.querySelector('#access-step-back-1');
const accessStepBack2 = document.querySelector('#access-step-back-2');

const taskLabels = {
  'army.intake': '先让 A君判断下一步',
  'army.route-task': '任务路由',
  'army.cross-agent-mission': 'A君：多人任务统筹',
  'media.transcribe-and-refine': '小D：转录并整理素材',
  'report.public-material': '小R：公开网页摘要',
  'research.github-search': '小R：公开 GitHub 检索',
  'research.intel-report': '小R：公开资料研究',
  'office.briefing-package': '办公执行助理：汇报包',
  'office.knowledge-summary': '小办：知识归档',
  'content.video-benchmark-analysis': '小拆：视频内容拆解',
  'content.performance-review': '小拆：内容表现复盘',
  'content.platform-draft': '小创：平台内容草稿',
  'content.video-script-package': '小创：可拍视频脚本',
  'operations.health-review': '运维官：本机健康检查',
  'governance.approval-review': '审核官：范围与风险审查',
  'governance.architecture-review': '架构师：能力评估'
};

const statusLabels = {
  active: '可用',
  ready: '可用',
  local: '本机可用',
  waiting: '等待连接',
  blocked: '尚未配置',
  not_configured: '未接线',
  not_ready: '未就绪',
  pending_authorization: '待授权',
  verified: '已验证',
  connected: '已连接',
  external: 'Hermes 已接管',
  connecting: '连接中',
  disabled: '未启用',
  expiring: '即将到期',
  expired: '已到期',
  revoked: '已撤销',
  error: '需检查',
  unavailable: '暂不可用',
  partial: '部分完成',
  planned: '待准备',
  draft: '草案中',
  pending_approval: '等待审核',
  waiting_approval: '等待确认',
  waiting_worker: '等待 Mac',
  waiting_test: '待测试',
  queued: '等待开始',
  running: '处理中',
  pausing: '正在暂停',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '未完成',
  needs_input: '等待补充',
  cancelled: '已关闭',
  rejected: '已拒绝',
  stopped: '已停止'
};

const directEmployeeTaskTypes = [
  'media.transcribe-and-refine',
  'report.public-material',
  'research.intel-report',
  'office.briefing-package'
];
const completedTaskStatuses = new Set(['succeeded', 'cancelled', 'rejected']);
const attentionTaskStatuses = new Set([
  'failed',
  'needs_input',
  'pending_approval',
  'waiting_approval',
  'waiting_test',
  'paused',
  'blocked',
  'error'
]);

let overview;
const selectedTaskId = taskIdFromPath(location.pathname);
let selectedTaskRevealed = false;
let shareKey = sessionStorage.getItem('ajun-share-key') || '';
let requesterName = sessionStorage.getItem('ajun-requester-name') || '';
let localOwner = false;
let loading = false;
let currentTaskFilter = selectedTaskId ? 'all' : 'attention';
let taskSearchQuery = '';
let visibleTaskCount = 24;
let accessLoginOptions = { providers: [], accounts: [] };
let reauthorizeConnectionId = '';

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (shareKey) headers.set('x-ajun-share-key', shareKey);
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败。');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setSyncStatus(message, state) {
  syncStatus.textContent = message;
  syncIndicator.className = `sync-indicator ${state}`;
}

async function load() {
  if (loading) return;
  loading = true;
  syncIndicator.className = 'sync-indicator syncing';
  try {
    overview = await api('/api/overview');
    accessGate.hidden = true;
    document.body.classList.remove('access-required');
    await renderLocalShare();
    render();
    updateOwnerNavigation();
    activateModuleFromHash();
    setSyncStatus(`已同步 · ${new Date().toLocaleTimeString()}`, 'synced');
    document.body.classList.remove('is-loading');
  } catch (error) {
    if (error.status === 401) {
      accessGate.hidden = false;
      accessMessage.textContent = error.message;
      document.body.classList.add('access-required');
      setSyncStatus('等待共享口令', 'waiting');
      return;
    }
    setSyncStatus('同步暂不可用', 'error');
    throw error;
  } finally {
    loading = false;
  }
}

async function renderLocalShare() {
  if (!isLoopbackLocation()) {
    localOwner = false;
    shareInfo.hidden = true;
    employeeConnections.hidden = true;
    accessConnections.hidden = true;
    return;
  }
  try {
    const share = await api('/api/local-share');
    localOwner = true;
    shareInfo.hidden = !share.enabled;
    if (share.enabled) {
      document.querySelector('#share-addresses').textContent = `同一局域网可通过：${share.addresses.map((address) => `http://${address}:4321`).join(' · ')}`;
      document.querySelector('#share-key').value = share.accessKey;
    }
    await Promise.all([
      renderEmployeeConnections(),
      renderAccessConnections(),
      renderAccessLoginOptions(),
      renderContentCampaigns()
    ]);
  } catch {
    localOwner = false;
    shareInfo.hidden = true;
    employeeConnections.hidden = true;
    accessConnections.hidden = true;
  }
}

function isLoopbackLocation() {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname.toLowerCase());
}

function updateOwnerNavigation() {
  for (const element of ownerOnlyElements) element.hidden = !localOwner;
  if (!localOwner && ['#connections', '#campaigns'].includes(location.hash)) activateModule('overview', { replaceHash: true });
}

function activateModuleFromHash() {
  activateModule(selectedTaskId ? 'records' : location.hash.slice(1) || 'overview');
}

function activateModule(name, { replaceHash = false } = {}) {
  const requested = modulePages.some((page) => page.dataset.modulePage === name) ? name : 'overview';
  const selected = ['connections', 'campaigns'].includes(requested) && !localOwner ? 'overview' : requested;
  for (const link of moduleLinks) {
    const active = link.dataset.module === selected;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const page of modulePages) {
    const active = page.dataset.modulePage === selected;
    page.classList.toggle('is-active', active);
    page.setAttribute('aria-hidden', String(!active));
  }
  document.title = `${moduleTitle(selected)} · A君运行台`;
  if (replaceHash && location.hash !== `#${selected}`) history.replaceState(null, '', `#${selected}`);
}

function moduleTitle(name) {
  return ({ overview: '总览', employees: '员工', connections: '账号与接入', campaigns:'发布活动', records: '任务记录' })[name] || '总览';
}

async function renderContentCampaigns() {
  if (!localOwner || !campaignList || !campaignMessage) return;
  try {
    const payload = await api('/api/content-campaigns');
    const campaigns = payload.campaigns || [];
    campaignMessage.textContent = campaigns.length ? `${campaigns.length} 个活动` : '尚无活动草案';
    campaignList.replaceChildren(...(campaigns.length
      ? campaigns.map(campaignCard)
      : [emptyCampaignCard('M5 Pipeline 尚未创建活动 Case；真实付费调用和发布仍保持关闭。')]));
  } catch (error) {
    campaignMessage.textContent = '尚未启用';
    campaignList.replaceChildren(emptyCampaignCard(error.message));
  }
}

function campaignCard(campaign) {
  const node = document.createElement('article');
  node.className = 'campaign-card';
  const progress = campaign.progress || { completedPlatformCases:0, totalPlatformCases:14 };
  const cost = campaign.costs?.totalCents == null ? '尚无真实费用' : `$${(campaign.costs.totalCents / 100).toFixed(2)}`;
  const approvalAllowed = campaign.status === 'draft' && campaign.approval?.allowed === true;
  const approvalReason = campaign.approval?.reason || '尚未完成活动启动前检查。';
  const actions = campaign.status === 'draft'
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

function emptyCampaignCard(message) {
  const node = document.createElement('article');
  node.className = 'campaign-card campaign-empty';
  node.innerHTML = `<h3>当前没有可运行活动</h3><p>${escapeHtml(message)}</p><small>先完成 Pipeline dry-run、岗位绑定、预算和插件审计；不会在此页面静默安装或发布。</small>`;
  return node;
}

async function renderEmployeeConnections() {
  if (!localOwner) return;
  const payload = await api('/api/employee-feishu-connections');
  employeeConnections.hidden = false;
  employeeConnectionList.replaceChildren(...payload.employees.map((employee) => {
    const node = document.createElement('article');
    node.className = 'connection-card';
    const status = employee.channel?.status || (employee.configured ? 'connecting' : 'not_configured');
    const modelAction = `
      <div class="connection-actions" data-model-setup-scope>
        <button type="button" class="model-setup-button secondary-action" data-model-setup-agent-id="${escapeHtml(employee.agentId)}" data-model-setup-target="models">管理模型</button>
        <button type="button" class="model-setup-button secondary-action" data-model-setup-agent-id="${escapeHtml(employee.agentId)}" data-model-setup-target="keys">管理 API 与 Key</button>
        <p class="model-setup-message connection-message" role="status">使用 Hermes 官方页面，并锁定到这名员工的 Profile。</p>
      </div>`;
    const connectionControls = status === 'external'
      ? '<div class="connection-managed"><strong>独立员工入口已启用</strong><p>由员工自己的 Hermes 档案和飞书入口承接。</p></div>'
      : `<details class="connection-form-disclosure"><summary>${employee.configured ? '更新接线配置' : '配置飞书入口'}</summary><form data-agent-id="${escapeHtml(employee.agentId)}"><label>飞书 App ID<input name="appId" autocomplete="off" placeholder="cli_..." required></label><label>App Secret<input name="appSecret" type="password" autocomplete="new-password" required></label><label>允许老板的 open_id<input name="allowedUserId" autocomplete="off" placeholder="ou_..." required></label><button>${employee.configured ? '更新并重新连接' : '保存并连接'}</button><p class="connection-message" role="status">${escapeHtml(employee.channel?.message || '尚未接线。')}</p></form></details>`;
    node.innerHTML = `
      <details class="connection-disclosure">
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

async function renderAccessConnections() {
  if (!localOwner) return;
  const payload = await api('/api/access-connections');
  accessConnections.hidden = false;
  renderContentAccessSummary(payload);
  const activeConnections = payload.connections
    .filter((connection) => !['revoked', 'disabled', 'expired'].includes(connection.status))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.provider.localeCompare(right.provider));
  const archivedConnections = payload.connections.filter((connection) => ['revoked', 'disabled', 'expired'].includes(connection.status));
  const ambiguousPlatforms = Object.entries(groupConnectionsByProvider(activeConnections))
    .filter(([, connections]) => connections.length > 1 && !connections.some((connection) => connection.isDefault));
  accessConnectionMessage.textContent = payload.status === 'unavailable'
    ? (payload.message || '账号连接状态暂时不可用。')
    : ambiguousPlatforms.length
      ? `${ambiguousPlatforms.map(([provider]) => providerLabel(provider)).join('、')}有多个账号，请先设一个默认账号。`
      : `${activeConnections.length} 个当前连接 · 默认账号已明确`;
  accessConnectionList.replaceChildren(
    ...activeConnections.map(accountConnectionCard),
    ...(archivedConnections.length ? [archivedConnectionGroup(archivedConnections)] : [])
  );
}

function renderContentAccessSummary(payload) {
  if (!contentAccessSummary) return;
  const connections = payload.connections || [];
  const active = connections.filter((connection) => ['active', 'expiring'].includes(connection.status));
  const defaults = Object.entries(groupConnectionsByProvider(active))
    .map(([provider, providerConnections]) => {
      const selected = providerConnections.find((connection) => connection.isDefault)
        || (providerConnections.length === 1 ? providerConnections[0] : null);
      return selected ? `${providerLabel(provider)}：${selected.accountAlias}` : `${providerLabel(provider)}：待选择`;
    });
  const verified = active.filter((connection) => connection.lastVerification?.status === 'succeeded').length;
  const failed = active.filter((connection) => connection.lastVerification?.status === 'failed').length;
  const unverified = active.length - verified - failed;
  const adapters = payload.acquisition?.adapters || [];
  const healthyAdapters = adapters.filter((adapter) => adapter.healthStatus === 'healthy').length;
  const crawlerReady = payload.acquisition?.status === 'ready' && payload.acquisition?.mediaCrawlerDeep === true;
  contentAccessSummary.replaceChildren(
    accessSummaryCard('平台可用', defaults.length, defaults.join('；') || '尚未连接账号', defaults.some((item) => item.endsWith('待选择')) ? 'warning' : 'ready'),
    accessSummaryCard('真实读取成功', `${verified}/${active.length}`, `${failed ? `${failed} 个账号最近失败` : ''}${failed && unverified ? ' · ' : ''}${unverified ? `${unverified} 个尚未实测` : failed ? '' : '当前账号均有成功证据'}`, failed || unverified ? 'warning' : 'ready'),
    accessSummaryCard('采集服务', crawlerReady ? '可用' : '需检查', `${healthyAdapters}/${adapters.length || 0} 个通道正常`, crawlerReady ? 'ready' : 'warning')
  );
}

function accessSummaryCard(label, value, detail, tone) {
  const node = document.createElement('article');
  node.className = `access-summary-card ${tone}`;
  node.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small>`;
  return node;
}

function accountConnectionCard(connection) {
  const node = document.createElement('article');
  node.className = 'connection-card account-connection-card';
  const canRevoke = ['active', 'expiring', 'error'].includes(connection.status);
  const canDisable = ['active', 'expiring', 'error'].includes(connection.status);
  const canReauthorize = ['xhs', 'dy', 'bili', 'ks'].includes(connection.provider);
  const operationText = connection.grantedOperations.length ? connection.grantedOperations.join('、') : '未登记';
  const scopeText = connection.dataScope.length ? connection.dataScope.join('、') : '未登记';
  const employeeText = connection.allowedAgentIds.length ? connection.allowedAgentIds.map(agentName).join('、') : '未分配';
  const timing = connection.expiresAt ? `到期：${formatDate(connection.expiresAt)}` : '到期：由连接器管理';
  const health = connection.lastHealthAt ? `最近检查：${formatDate(connection.lastHealthAt)}` : '最近检查：尚无记录';
  const verification = connection.lastVerification
    ? connection.lastVerification.status === 'succeeded'
      ? `真实读取：${formatDate(connection.lastVerification.at)}成功 · ${adapterLabel(connection.lastVerification.adapterId)} · ${connection.lastVerification.capabilities.join('、') || '内容'}`
      : `真实读取：${formatDate(connection.lastVerification.at)}失败 · ${failureLabel(connection.lastVerification.failureCode)}`
    : '真实读取：尚未执行';
  const summaryState = ['active', 'expiring'].includes(connection.status) && connection.lastVerification
    ? connection.lastVerification.status === 'succeeded'
      ? { className:'succeeded', label:'读取成功' }
      : { className:'failed', label:'读取失败' }
    : { className:connection.status, label:statusLabel(connection.status) };
  const managementActions = [
    canReauthorize ? `<button type="button" class="secondary-action" data-connection-action="reauthorize" data-connection-id="${escapeHtml(connection.connectionId)}" data-provider="${escapeHtml(connection.provider)}" data-alias="${escapeHtml(connection.accountAlias)}">${connection.status === 'active' ? '续期/重新授权' : '重新授权'}</button>` : '',
    canDisable ? `<button type="button" class="secondary-action" data-connection-action="disable" data-connection-id="${escapeHtml(connection.connectionId)}">暂时禁用</button>` : '',
    canRevoke ? `<button type="button" class="secondary-action danger-action" data-connection-action="revoke" data-connection-id="${escapeHtml(connection.connectionId)}">永久撤销</button>` : ''
  ].filter(Boolean).join('');
  const primaryAction = connection.status === 'active'
    ? connection.isDefault
      ? '<span class="connection-default-note">任务默认使用这个账号</span>'
      : `<button type="button" data-connection-action="default" data-connection-id="${escapeHtml(connection.connectionId)}">设为${escapeHtml(providerLabel(connection.provider))}默认账号</button>`
    : '';
  node.innerHTML = `
    <details class="connection-disclosure">
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
        ${managementActions ? `<details class="action-menu"><summary><svg aria-hidden="true"><use href="#icon-more"></use></svg>管理连接</summary><div class="connection-actions">${managementActions}</div></details>` : '<span class="connection-final-state">无需操作</span>'}
      </div>
    </details>`;
  return node;
}

function archivedConnectionGroup(connections) {
  const node = document.createElement('details');
  node.className = 'connection-history';
  node.innerHTML = `<summary><span>历史连接</span><small>${connections.length} 条已撤销、停用或过期记录</small><svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg></summary><div class="connection-grid"></div>`;
  node.querySelector('.connection-grid').replaceChildren(...connections.map(accountConnectionCard));
  return node;
}

function groupConnectionsByProvider(connections) {
  return connections.reduce((groups, connection) => {
    (groups[connection.provider] ||= []).push(connection);
    return groups;
  }, {});
}

function adapterLabel(value) {
  return ({
    'mediacrawlerpro-specialized-content':'深度采集',
    'bilibili-native-subtitles':'B站原生字幕',
    'yt-dlp-general-media':'公开视频通道'
  })[value] || value || '内容通道';
}

function failureLabel(value) {
  return ({
    authorization_required:'需要重新授权',
    adapter_unavailable:'采集通道不可用',
    source_rate_limited:'平台临时限流',
    capability_not_available:'能力暂不支持'
  })[value] || value || '读取失败';
}

async function renderAccessLoginOptions() {
  if (!localOwner) return;
  accessLoginOptions = await api('/api/access-login/options');
  const selectedProvider = accessLoginProvider.value;
  accessLoginProvider.replaceChildren(...accessLoginOptions.providers.map((provider) => new Option(provider.label, provider.id)));
  if (accessLoginOptions.providers.some((provider) => provider.id === selectedProvider)) accessLoginProvider.value = selectedProvider;
  renderAccessLoginAccounts();
}

function renderAccessLoginAccounts() {
  const provider = accessLoginProvider.value;
  const current = accessLoginAccount.value;
  const accounts = accessLoginOptions.accounts.filter((account) => account.connected && account.platforms.includes(provider));
  accessLoginAccount.replaceChildren(new Option(accounts.length ? '请选择已登录账号' : '还没有检测到已登录账号', ''));
  for (const account of accounts) {
    const label = account.nicknames?.[provider] || 'Chrome 已登录账号';
    accessLoginAccount.append(new Option(label, account.clientId));
  }
  if (accounts.some((account) => account.clientId === current)) accessLoginAccount.value = current;
}

function setAccessStep(step) {
  const nextStep = Math.min(3, Math.max(1, step));
  for (const panel of accessStepPanels) panel.hidden = Number(panel.dataset.accessStepPanel) !== nextStep;
  for (const indicator of accessStepIndicators) {
    const indicatorStep = Number(indicator.dataset.accessStepIndicator);
    indicator.classList.toggle('is-active', indicatorStep === nextStep);
    indicator.classList.toggle('is-complete', indicatorStep < nextStep);
  }
}

function resetAccessReauthorization() {
  reauthorizeConnectionId = '';
  saveAccessConnection.textContent = '3. 授权给小D';
  cancelAccessReauthorize.hidden = true;
  setAccessStep(1);
}

function render() {
  renderFocus(overview.taskFocus);
  renderOverviewStats();
  capabilityList.replaceChildren(...overview.capabilities.map((item) => capabilityCard(item)));
  const readyCapabilities = overview.capabilities.filter((item) => ['ready', 'active', 'connected', 'verified'].includes(item.status)).length;
  const limitedCapabilities = overview.capabilities.length - readyCapabilities;
  capabilitySummary.textContent = `${readyCapabilities} 项已就绪${limitedCapabilities ? ` · ${limitedCapabilities} 项受限或待准备` : ''}`;
  const directEmployees = overview.alwaysOnAgents?.length ? overview.alwaysOnAgents : overview.agents.filter(isDirectEmployee);
  const supportEmployees = overview.onDemandAgents?.length ? overview.onDemandAgents : overview.agents.filter((agent) => !isDirectEmployee(agent));
  agentList.replaceChildren(...[
    agentGroupTitle('常驻员工', '保持飞书入口或后台巡检常驻'),
    ...directEmployees.map((agent) => agentCard(agent, false)),
    agentGroupTitle('后台按需能力', '不常驻飞书入口，由 A君或 Paperclip 按任务唤醒'),
    ...supportEmployees.map((agent) => agentCard(agent, true))
  ]);
  renderTaskLists();
}

function renderOverviewStats() {
  const tasks = overview.tasks || [];
  const active = tasks.filter((task) => taskStatusGroup(task.status) === 'active').length;
  const focus = overview.taskFocus || {};
  const ownerActionable = Number.isFinite(focus.ownerActionable) ? focus.ownerActionable : (focus.next ? 1 : 0);
  const readyAgents = overview.agents.filter((agent) => ['active', 'ready', 'external', 'connected', 'verified'].includes(agent.status)).length;
  overviewSummary.textContent = ownerActionable
    ? `${ownerActionable} 件事需要你决定。`
    : active
      ? `${active} 项工作正在推进，你暂时不用处理。`
      : '当前没有必须处理的事。';
  const cards = [
    statCard('需要你', ownerActionable, ownerActionable ? '打开上方下一步处理' : '目前无需决定', 'target', ownerActionable > 0),
    statCard('正在处理', active, active ? '系统会继续推进' : '没有执行中的工作', 'clock'),
    statCard('可用员工', `${readyAgents}/${overview.agents.length}`, '按任务自动安排', 'employees')
  ];
  overviewStats.replaceChildren(...cards);
}

function statCard(label, value, note, icon, attention = false) {
  const node = document.createElement('article');
  node.className = `stat-card${attention ? ' attention' : ''}`;
  node.innerHTML = `<div class="stat-card-head"><span>${escapeHtml(label)}</span><span class="stat-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span></div><strong class="stat-value">${escapeHtml(value)}</strong><span class="stat-note">${escapeHtml(note)}</span>`;
  return node;
}

function renderTaskLists() {
  const tasks = overview.tasks || [];
  const normalizedQuery = taskSearchQuery.toLocaleLowerCase('zh-CN');
  const filtered = tasks.filter((task) =>
    selectedTaskId
      ? task.taskId === selectedTaskId
      : currentTaskFilter === 'all' || taskStatusGroup(task.status) === currentTaskFilter
  ).filter((task) => !normalizedQuery || [
    task.input?.title,
    task.taskId,
    agentName(task.assigneeAgentId),
    taskTypeLabel(task.taskType),
    statusLabel(task.status)
  ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(normalizedQuery)));
  const shown = selectedTaskId ? filtered : filtered.slice(0, visibleTaskCount);
  taskCount.textContent = filtered.length > shown.length ? `显示 ${shown.length}/${filtered.length} 条` : `${filtered.length} 条`;
  taskList.replaceChildren();
  if (!filtered.length) {
    taskList.append(document.querySelector('#empty').content.cloneNode(true));
  } else {
    taskList.append(...shown.map(taskCard));
    if (selectedTaskId && !selectedTaskRevealed) {
      selectedTaskRevealed = true;
      requestAnimationFrame(() => taskList.querySelector(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.scrollIntoView({ block:'center' }));
    }
  }
  taskLoadMore.hidden = Boolean(selectedTaskId) || shown.length >= filtered.length;
  if (!taskLoadMore.hidden) taskLoadMore.textContent = `再显示 ${Math.min(24, filtered.length - shown.length)} 条`;
  updateTaskFilterCounts(tasks);
  renderRecentTasks(tasks.slice(0, 3));
}

function updateTaskFilterCounts(tasks) {
  const labels = { attention:'待复盘', active:'进行中', completed:'已结束', all:'全部' };
  for (const button of taskFilterButtons) {
    const filter = button.dataset.taskFilter;
    const count = filter === 'all' ? tasks.length : tasks.filter((task) => taskStatusGroup(task.status) === filter).length;
    const active = filter === currentTaskFilter;
    button.textContent = `${labels[filter]} ${count}`;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderRecentTasks(tasks) {
  recentTaskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = '暂无记录';
    recentTaskList.append(empty);
    return;
  }
  recentTaskList.append(...tasks.map((task) => {
    const item = document.createElement('div');
    item.className = 'recent-task';
    const attention = taskStatusGroup(task.status) === 'attention';
    item.innerHTML = `<span class="recent-task-dot${attention ? ' attention' : ''}"></span><span class="recent-task-title">${escapeHtml(task.input.title)}</span><span class="recent-task-status">${escapeHtml(statusLabel(task.status))}</span>`;
    return item;
  }));
}

function taskCard(task) {
  const node = document.createElement('article');
  node.className = 'task';
  node.dataset.taskId = task.taskId;
  const approval = overview.approvals.find((item) => task.approvalRefs?.includes(item.approvalId));
  const pendingApproval = approval?.status === 'pending' ? approval : null;
  const artifacts = task.artifactRefs || [];
  const report = artifacts.find((item) => item.type === 'health_report')?.data;
  const intake = artifacts.find((item) => item.type === 'task_intake_record')?.data;
  const review = artifacts.find((item) => item.type === 'review_report')?.data;
  const architecture = artifacts.find((item) => item.type === 'architecture_review')?.data;
  const xiaodResult = artifacts.find((item) => item.type === 'xiaod_media_delivery');
  const publicReport = artifacts.find((item) => item.type === 'public_web_report')?.data;
  const recovery = recoveryState(task);
  const approvalResult = pendingApproval
    ? `<p class="result degraded">待你确认：${escapeHtml(pendingApproval.reason)}<br><small>本次范围：${escapeHtml(pendingApproval.requestedScope?.title || task.input.title)} · ${escapeHtml(taskTypeLabel(pendingApproval.requestedScope?.taskType || task.taskType))}</small></p>`
    : '';
  const result = approvalResult || (
    recovery ? `<p class="result ${recovery.tone}">${escapeHtml(recovery.detail)}</p>`
      : task.error?.userMessage ? `<p class="result degraded">需要处理：${escapeHtml(task.error.userMessage)}</p>`
        : report ? `<p class="result ${escapeHtml(report.overall)}">健康检查：${escapeHtml(report.overall === 'healthy' ? '正常' : '需要关注')} · ${escapeHtml(report.components.map((item) => `${item.name}${item.status === 'healthy' ? '正常' : '异常'}`).join('、'))}</p>`
          : intake ? `<p class="result healthy">下一步建议：${escapeHtml(intake.nextAction)}</p>`
            : review ? `<p class="result ${review.scopeStated ? 'healthy' : 'degraded'}">审核结论：${escapeHtml(review.nextAction)}</p>`
              : architecture ? `<p class="result healthy">能力评估：已启用 ${architecture.currentCapabilities.length} 个岗位 · ${escapeHtml(architecture.nextAction)}</p>`
                : publicReport ? `<p class="result healthy">网页摘要：${escapeHtml(publicReport.summary)}</p>`
                  : xiaodResult ? `<p class="result ${xiaodResult.validation?.qualityPassed ? 'healthy' : 'degraded'}">小D交付已生成 · ${xiaodResult.validation?.qualityPassed ? '质量检查通过' : '建议人工校对'}</p>`
                    : ''
  );
  const shownStatus = recovery || { label: statusLabel(task.status), className: task.status };
  const presentation = task.presentation || {
    taskRef:`#${String(task.taskId || '').replaceAll('-', '').slice(0, 8).toUpperCase()}`,
    summary:`${task.input.title}：${statusLabel(task.status)}`,
    nextAction:task.error?.userMessage || '等待新的进度。',
    detailPath:`/tasks/${encodeURIComponent(task.taskId)}`,
    technical:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage, errorCode:task.error?.code }
  };
  node.innerHTML = `
    <details class="task-disclosure"${selectedTaskId === task.taskId ? ' open' : ''}>
      <summary>
        <div class="task-summary-main">
          <span class="status ${escapeHtml(shownStatus.className)}">${escapeHtml(shownStatus.label)}</span>
          <div class="task-summary-copy">
            <h3>${escapeHtml(task.input.title)}</h3>
            <p>${escapeHtml(taskTypeLabel(task.taskType))}</p>
          </div>
        </div>
        <span class="task-owner">${escapeHtml(agentName(task.assigneeAgentId))}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="task-body">
        <div class="task-body-copy">
          <p class="task-human-summary">${escapeHtml(presentation.summary)}</p>
          <p class="task-next-action"><strong>下一步</strong>${escapeHtml(presentation.nextAction)}</p>
          ${result}
          <div class="task-actions">
            <a class="task-detail-link" href="${escapeHtml(presentation.detailPath)}">查看任务 ${escapeHtml(presentation.taskRef)}</a>
            <button class="task-copy-id" type="button">复制完整编号</button>
          </div>
          <details class="task-technical">
            <summary>技术详情</summary>
            <dl>
              <div><dt>完整编号</dt><dd>${escapeHtml(presentation.technical.taskId || task.taskId)}</dd></div>
              <div><dt>原始状态</dt><dd>${escapeHtml(presentation.technical.status || task.status)}</dd></div>
              <div><dt>当前阶段</dt><dd>${escapeHtml(presentation.technical.currentStage || '未记录')}</dd></div>
              ${presentation.technical.errorCode ? `<div><dt>错误代码</dt><dd>${escapeHtml(presentation.technical.errorCode)}</dd></div>` : ''}
              <div><dt>路由说明</dt><dd>${escapeHtml(task.routing?.reason || '未记录')}</dd></div>
            </dl>
          </details>
        </div>
        <div class="task-meta">
          <strong>${escapeHtml(agentName(task.assigneeAgentId))}</strong>
          <span>${escapeHtml(taskTypeLabel(task.taskType))}</span>
          <span>提交人：${escapeHtml(requesterLabel(task))}</span>
          ${task.parentTaskId ? '<span>来自 A君建议</span>' : ''}
          ${pendingApproval ? '<span class="approval">请在飞书原会话处理</span>' : ''}
        </div>
      </div>
    </details>`;
  node.querySelector('.task-copy-id')?.addEventListener('click', async () => {
    const button = node.querySelector('.task-copy-id');
    try {
      await navigator.clipboard.writeText(task.taskId);
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败，请展开技术详情';
    }
    setTimeout(() => { button.textContent = '复制完整编号'; }, 1600);
  });
  return node;
}

function taskIdFromPath(pathname) {
  return pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] || '';
}

function taskStatusGroup(status) {
  if (completedTaskStatuses.has(status)) return 'completed';
  if (attentionTaskStatuses.has(status)) return 'attention';
  return 'active';
}

function renderFocus(focus) {
  focusPanel.classList.remove('skeleton-panel');
  if (!focus?.total) {
    focusPanel.innerHTML = '<div class="focus-copy"><p class="focus-state is-clear">无需处理</p><h3>还没有任务记录</h3><p>请在飞书交办，A君会在这里同步下一步。</p></div><div class="focus-guard"><span>对外发布关闭</span><span>不会静默执行</span></div>';
    return;
  }
  const current = focus.next;
  const focusTask = overview.tasks.find((task) => task.taskId === current?.taskId);
  const recovery = focusTask ? recoveryState(focusTask) : null;
  const ownerStatuses = new Set(['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test', 'succeeded']);
  const needsOwner = Boolean(current && ownerStatuses.has(current.status));
  const title = current ? escapeHtml(current.title) : '现在没有必须处理的事';
  const action = recovery
    ? escapeHtml(recovery.detail)
    : current
      ? escapeHtml(current.action)
      : '历史失败和待验证记录都留在“记录”中，不会自动重试或对外发布。';
  const reason = current?.status === 'succeeded'
    ? '这是建议，不会自动创建后续任务。'
    : needsOwner
      ? '这件事需要你的输入或确认，系统不会替你决定。'
      : current
        ? '系统正在推进，你可以查看进度，不需要一直盯着。'
        : '当前没有任务在执行，也没有等待你的审批。';
  const primaryAction = current
    ? `<a class="focus-primary-action" href="/tasks/${encodeURIComponent(current.taskId)}">${current.status === 'succeeded' ? '查看这条建议' : needsOwner ? '查看并处理' : '查看进度'}</a>`
    : '<a class="focus-primary-action secondary" href="#records">打开任务记录</a>';
  const governanceReady = overview.capabilities.some((item) => item.id === 'governance' && item.status === 'ready');
  const externalWriteReady = overview.capabilities.some((item) => item.id === 'external-execution' && item.status === 'ready');
  focusPanel.innerHTML = `
    <div class="focus-copy">
      <p class="focus-state ${needsOwner ? 'needs-owner' : current ? 'is-running' : 'is-clear'}">${needsOwner ? '需要你决定' : current ? '系统正在处理' : '无需处理'}</p>
      <h3>${title}</h3>
      <p class="focus-action-copy">${action}</p>
      <p class="focus-reason">${escapeHtml(reason)}</p>
      <div class="focus-actions">${primaryAction}</div>
    </div>
    <div class="focus-guard">
      <span>${governanceReady ? 'Paperclip 已连接' : '治理连接待恢复'}</span>
      <span>${externalWriteReady ? '对外写入按审批开放' : '对外发布关闭'}</span>
      <span>${focus.inProgress ? `${focus.inProgress} 项正在推进` : '没有执行中任务'}</span>
    </div>`;
}

function isDirectEmployee(agent) {
  return agent.acceptedTaskTypes.some((type) => directEmployeeTaskTypes.includes(type));
}

function agentGroupTitle(title, detail) {
  const node = document.createElement('div');
  node.className = 'agent-group-title';
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  return node;
}

function agentCard(agent, support) {
  const node = document.createElement('article');
  node.className = `agent${support ? ' support-agent' : ''}`;
  const types = agent.acceptedTaskTypes.map(taskTypeLabel).join(' · ');
  const summaryTypes = agent.acceptedTaskTypes.slice(0, 2).map(taskTypeLabel).join(' · ') || '职责待核对';
  const independent = independentRuntimeLabel(agent);
  node.innerHTML = `
    <details class="agent-disclosure">
      <summary>
        <span class="agent-avatar">${escapeHtml(agent.name.slice(0, 1))}</span>
        <span class="agent-summary-copy">
          <strong>${escapeHtml(agent.name)}</strong>
          <small>${escapeHtml(summaryTypes)}</small>
        </span>
        <span class="status ${escapeHtml(agent.status)}">${escapeHtml(statusLabel(agent.status))}</span>
        <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
      </summary>
      <div class="agent-body">
        <p>${escapeHtml(agent.role)}</p>
        <p>${escapeHtml(types)}</p>
        <p>${escapeHtml(independent)}</p>
      </div>
    </details>`;
  return node;
}

function capabilityCard(item) {
  const node = document.createElement('article');
  node.className = 'capability-card';
  node.innerHTML = `<span class="capability-icon"><svg aria-hidden="true"><use href="#icon-spark"></use></svg></span><h3>${escapeHtml(item.name)}</h3><p title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</p>`;
  return node;
}

function independentRuntimeLabel(agent) {
  const state = agent.independentRuntime?.state;
  if (state === 'model_pending') return '岗位已定义，正在配置独立大脑';
  if (state === 'model_transport_pending') return '独立身份已建立，模型授权和真实调用待完成';
  const channel = agent.feishuChannel;
  if (channel?.status === 'external' && channel?.verified === true) return '独立 Hermes 员工已完成真实任务与连续追问';
  if (channel?.status === 'external') return '独立 Hermes 飞书入口已接管，待真实消息验证';
  if (channel?.verified === true) return '独立飞书入口已完成真实任务收发';
  if (channel?.status === 'connected') return '独立飞书入口已连接，待真实消息验证';
  if (channel?.status === 'connecting') return '独立飞书入口正在连接';
  if (channel?.status === 'failed') return `独立飞书入口未连接：${channel.message}`;
  if (channel?.status === 'disabled') return `独立飞书入口未启用：${channel.message}`;
  return ({
    ready: '已独立接通',
    channel_pending: '模型调用已验证，飞书入口待接通',
    waiting_verification: '独立入口待真实验证',
    not_created: '独立身份尚未创建',
    missing_profile: '独立身份资料缺失',
    invalid_reference: '独立身份资料无效',
    not_declared: '目前由 A君统一代管'
  })[state] || (agent.source === 'approved-proposal' ? '通过限定试用，由 A君统一代管' : '状态待核对');
}

function taskTypeLabel(type) {
  const agent = overview?.agents.find((item) => item.acceptedTaskTypes.includes(type));
  const suffix = agent?.status === 'draft' ? '（准备中）' : '';
  return `${taskLabels[type] || agent?.name || '待分配工作'}${suffix}`;
}

function statusLabel(status) {
  return statusLabels[String(status || '')] || '状态待确认';
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '待确认' : date.toLocaleString();
}

function recoveryState(task) {
  if (task.status !== 'failed') return null;
  const children = overview?.tasks?.filter((item) => item.parentTaskId === task.taskId) || [];
  const latest = (items) => [...items].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0];
  const technical = latest(children.filter((item) => item.taskType === 'operations.technical-repair'));
  if (technical?.status === 'waiting_test') return { label: '待测试', className: 'waiting_test', tone: 'degraded', active: false, detail: '技术专家已保留当前结果，但这轮检查还需要后续验证；其他工作会继续推进。' };
  if (technical?.status === 'succeeded') return { label: '修复已核对', className: 'succeeded', tone: 'healthy', active: false, detail: '技术专家已经完成本轮修复和检查；A君正在保留最终记录。' };
  if (technical?.status === 'failed') return { label: '修复未完成', className: 'failed', tone: 'degraded', active: false, detail: '技术专家本轮没有修复成功，当前记录已保留，不会假装完成。' };
  if (technical && ['queued', 'running'].includes(technical.status)) return { label: '技术专家处理中', className: 'running', tone: 'healthy', active: true, detail: '技术专家正在处理这件事，A君会继续跟进最终结果；你不用重复提交。' };
  const retry = latest(children.filter((item) => item.taskType === task.taskType && item.recovery?.rootTaskId === task.taskId));
  if (retry && ['queued', 'running'].includes(retry.status)) return { label: '正在自动重试', className: 'running', tone: 'healthy', active: true, detail: '运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  const coordination = task.recovery?.coordination?.status;
  if (coordination === 'pending') return { label: '系统正在接手', className: 'running', tone: 'healthy', active: true, detail: '任务遇到问题，运维官正在判断安全的恢复办法。' };
  if (coordination === 'retrying') return { label: '正在自动重试', className: 'running', tone: 'healthy', active: true, detail: '运维官正在按安全规则重试一次，A君会继续跟进结果。' };
  if (coordination === 'escalated') return { label: '技术专家处理中', className: 'running', tone: 'healthy', active: true, detail: '这件事已经交给技术专家，A君会继续跟进最终结果。' };
  return null;
}

function agentName(agentId) {
  return overview?.agents.find((agent) => agent.agentId === agentId)?.name || '等待分配';
}

function providerLabel(provider) {
  return ({
    xhs:'小红书',
    dy:'抖音',
    bili:'哔哩哔哩',
    ks:'快手',
    youtube:'YouTube'
  })[provider] || provider || '未知平台';
}

function requesterLabel(task) {
  const requester = task?.requester || {};
  if (/^ou_[a-zA-Z0-9]+$/.test(String(requester.ref || ''))) return '飞书老板';
  if (requester.kind === 'local-owner') return '老板';
  if (requester.kind === 'feishu-user') return '飞书老板';
  if (requester.kind === 'local-system') return 'A君';
  if (requester.kind === 'lan-collaborator') return requester.ref || '局域网同事';
  return '内部协作';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

accessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  shareKey = accessKey.value.trim();
  requesterName = collaboratorName.value.trim();
  sessionStorage.setItem('ajun-share-key', shareKey);
  sessionStorage.setItem('ajun-requester-name', requesterName);
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
    await renderEmployeeConnections();
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

accessLoginProvider.addEventListener('change', renderAccessLoginAccounts);
accessLoginAccount.addEventListener('change', () => {
  if (accessLoginAccount.value) setAccessStep(3);
});
accessStepNext2.addEventListener('click', () => setAccessStep(2));
accessStepBack1.addEventListener('click', () => setAccessStep(1));
accessStepBack2.addEventListener('click', () => setAccessStep(2));
accessStepNext3.addEventListener('click', () => {
  if (!accessLoginAccount.value) {
    accessLoginMessage.textContent = '请先选择一个已登录账号。';
    accessLoginAccount.focus();
    return;
  }
  setAccessStep(3);
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
    setAccessStep(2);
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
    await renderAccessLoginOptions();
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
  accessLoginMessage.textContent = reauthorizeConnectionId ? '正在续期并恢复连接…' : '正在登记受控连接…';
  try {
    const path = reauthorizeConnectionId
      ? `/api/access-connections/${encodeURIComponent(reauthorizeConnectionId)}/reauthorize`
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
    accessLoginMessage.textContent = reauthorizeConnectionId ? '连接已续期并恢复可用。' : '账号已授权给小D的只读能力。';
    accessLoginForm.reset();
    resetAccessReauthorization();
    await Promise.all([renderAccessConnections(), renderAccessLoginOptions()]);
  } catch (error) {
    accessLoginMessage.textContent = error.message;
  } finally {
    saveAccessConnection.disabled = false;
  }
});

cancelAccessReauthorize.addEventListener('click', () => {
  accessLoginForm.reset();
  resetAccessReauthorization();
  renderAccessLoginAccounts();
  accessLoginMessage.textContent = '已取消续期。';
});

accessConnectionList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-connection-action]');
  if (!button) return;
  const action = button.dataset.connectionAction;
  if (action === 'reauthorize') {
    reauthorizeConnectionId = button.dataset.connectionId;
    accessLoginProvider.value = button.dataset.provider;
    accessLoginAlias.value = button.dataset.alias;
    accessLoginDisclosure.open = true;
    renderAccessLoginAccounts();
    setAccessStep(1);
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
      await renderAccessConnections();
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
    await renderAccessConnections();
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
    await renderContentCampaigns();
  } catch (error) {
    failedClosed = action === 'approve';
    if (failedClosed) button.title = error.message;
    campaignMessage.textContent = error.message;
  } finally {
    button.disabled = failedClosed;
  }
});

for (const button of taskFilterButtons) {
  button.addEventListener('click', () => {
    currentTaskFilter = button.dataset.taskFilter;
    visibleTaskCount = 24;
    renderTaskLists();
  });
}

taskSearch.addEventListener('input', () => {
  taskSearchQuery = taskSearch.value.trim();
  visibleTaskCount = 24;
  renderTaskLists();
});

taskLoadMore.addEventListener('click', () => {
  visibleTaskCount += 24;
  renderTaskLists();
});

window.addEventListener('hashchange', activateModuleFromHash);

function canAutoSync() {
  return !document.hidden
    && accessGate.hidden
    && !accessForm.contains(document.activeElement)
    && !accessLoginForm.contains(document.activeElement);
}

setInterval(() => {
  if (canAutoSync()) load().catch(() => {});
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (canAutoSync()) load().catch(() => {});
});

setAccessStep(1);
activateModuleFromHash();
load().catch((error) => {
  setSyncStatus(error.message, 'error');
});
