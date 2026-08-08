const jobsEl = document.querySelector('#jobs');
const emptyEl = document.querySelector('#empty-state');
const messageEl = document.querySelector('#form-message');
const template = document.querySelector('#job-template');
const connectionsEl = document.querySelector('#connections');
const connectionsEmptyEl = document.querySelector('#connections-empty');
const connectionSelect = document.querySelector('#connection-id');
const operationsEl = document.querySelector('#operations-events');
const cookieBridgeClientSelect = document.querySelector('#cookie-bridge-client-id');

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((tab) => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
  document.querySelector('#url-form').classList.toggle('hidden', button.dataset.source !== 'url');
  document.querySelector('#upload-form').classList.toggle('hidden', button.dataset.source !== 'upload');
  setMessage('');
}));
document.querySelector('#url-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const url = data.get('url'); const connectionId = data.get('connectionId') || null;
  await submit('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, connectionId }) });
});
document.querySelector('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/jobs/upload', { method: 'POST', body: new FormData(event.currentTarget) });
});
document.querySelector('#refresh').addEventListener('click', loadJobs);
document.querySelector('#cookie-bridge-connection-form').addEventListener('submit', createCookieBridgeConnection);

async function submit(url, options) {
  setMessage('正在创建任务…');
  try {
    const response = await fetch(url, options); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建任务失败');
    setMessage('任务已开始，处理进度会显示在下方。');
    document.querySelector('#url-form').reset(); document.querySelector('#upload-form').reset();
    await loadJobs();
  } catch (error) { setMessage(error.message, true); }
}

async function loadJobs() {
  const response = await fetch('/api/jobs');
  const { jobs } = await response.json();
  emptyEl.hidden = jobs.length > 0; jobsEl.replaceChildren();
  jobs.forEach(renderJob);
}

async function createCookieBridgeConnection(event) {
  event.preventDefault();
  const form = event.currentTarget; const data = new FormData(form);
  setMessage('正在登记受控账号连接…');
  try {
    const response = await fetch('/api/connections/cookie-bridge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: data.get('provider'), accountAlias: data.get('accountAlias'), clientId: data.get('clientId'),
        grantedOperations: ['read_media_metadata', 'read_content_images', 'download_authorized_media'],
        dataScope: ['content:read'], allowedAgentIds: ['xiaod']
      })
    });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '登记受控账号失败');
    form.reset();
    setMessage('受控账号已登记。Cookie 不会显示或保存在小D任务中。');
    await loadConnections(payload.connection.connectionId);
  } catch (error) { setMessage(error.message, true); }
}

async function loadCookieBridgeAccounts() {
  try {
    const response = await fetch('/api/cookie-bridge/accounts'); const { accounts } = await response.json();
    if (!response.ok) throw new Error('unavailable');
    cookieBridgeClientSelect.replaceChildren(new Option('选择 CookieBridge 中的已登录账号', ''));
    accounts.filter((account) => account.connected).forEach((account) => {
      const platforms = account.platforms.length ? account.platforms.join('、') : '未标记平台';
      cookieBridgeClientSelect.append(new Option(`${platforms} · ${account.clientId}`, account.clientId));
    });
    if (cookieBridgeClientSelect.options.length === 1) cookieBridgeClientSelect.options[0].text = 'CookieBridge 暂无已连接账号';
  } catch {
    cookieBridgeClientSelect.replaceChildren(new Option('CookieBridge 本机服务暂不可用', ''));
  }
}

async function loadConnections(selectedId = connectionSelect.value) {
  const response = await fetch('/api/connections'); const { connections } = await response.json();
  connectionSelect.replaceChildren(new Option('不使用账号连接（仅尝试公开读取）', ''));
  connectionsEl.replaceChildren(); connectionsEmptyEl.hidden = connections.length > 0;
  connections.forEach((connection) => {
    if (connection.credentialKind === 'cookie_bridge') {
      const option = new Option(`${connection.provider} · ${connection.accountAlias} · ${connectionStatusLabel(connection.status)}`, connection.connectionId);
      if (connection.connectionId === selectedId && connection.status === 'active') option.selected = true;
      option.disabled = connection.status !== 'active'; connectionSelect.append(option);
    }
    const row = document.createElement('article'); row.className = 'connection-row';
    const main = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${connection.provider} · ${connection.accountAlias}`;
    const detail = document.createElement('p'); detail.textContent = connection.credentialKind === 'browser_session'
      ? '旧浏览器连接已停用；不能读取浏览器登录态。'
      : connection.credentialKind === 'browser_companion'
        ? '已撤销的旧浏览器伴侣连接，不再使用。'
        : `只读 · CookieBridge 受控入口 · ${connection.grantedOperations.join('、')}`;
    main.append(title, detail);
    const actions = document.createElement('div');
    const state = document.createElement('span'); state.className = `connection-status ${connection.status}`; state.textContent = connectionStatusLabel(connection.status); actions.append(state);
    if (connection.status === 'active') { const revoke = document.createElement('button'); revoke.className = 'quiet danger'; revoke.type = 'button'; revoke.textContent = '撤销'; revoke.onclick = () => revokeConnection(connection.connectionId); actions.append(revoke); }
    row.append(main, actions); connectionsEl.append(row);
  });
  await loadOperations();
}

async function loadOperations() {
  const response = await fetch('/api/operations/events'); const { events } = await response.json();
  operationsEl.replaceChildren();
  if (events.length === 0) { operationsEl.textContent = '暂无健康事件。'; return; }
  events.slice(0, 8).forEach((event) => {
    const item = document.createElement('p'); item.textContent = `${new Date(event.createdAt).toLocaleString()} · ${event.safeMessage}`; operationsEl.append(item);
  });
}

async function revokeConnection(id) {
  const response = await fetch(`/api/connections/${id}/revoke`, { method: 'POST' }); const payload = await response.json();
  if (!response.ok) return setMessage(payload.error || '撤销连接失败', true);
  setMessage('账号连接已撤销。后续受限链接会要求重新授权。'); await loadConnections();
}

function renderJob(job) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.querySelector('.job-title').textContent = job.title;
  const status = card.querySelector('.status'); status.textContent = job.failure?.category === 'needs_input' ? '需要授权或补充' : statusLabel(job.status); status.classList.add(job.failure?.category === 'needs_input' ? 'failed' : job.status);
  card.querySelector('.job-source').textContent = job.sourceType === 'upload' ? `本地文件 · ${job.originalName}` : `${job.sourceUrl}${job.connectionId ? ' · 已使用账号连接' : ''}`;
  card.querySelector('.progress-bar').style.width = `${job.progress}%`;
  card.querySelector('.stage-message').textContent = job.stageMessage;
  const warnings = card.querySelector('.warnings');
  if (job.error) { const p = document.createElement('p'); p.className = 'error'; p.textContent = job.error; warnings.append(p); }
  if (job.failure?.recovery) { const p = document.createElement('p'); p.className = 'warning'; p.textContent = job.failure.recovery; warnings.append(p); }
  job.warnings.forEach((warning) => { const p = document.createElement('p'); p.className = 'warning'; p.textContent = warning; warnings.append(p); });
  const actions = card.querySelector('.job-actions');
  if (job.output?.markdownPath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download`; link.textContent = '完整整理稿'; actions.append(link); }
  if (job.output?.guidePath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download/guide`; link.textContent = '内容导览'; actions.append(link); }
  if (job.output?.proofreadPath) { const link = document.createElement('a'); link.className = 'link-button'; link.href = `/api/jobs/${job.id}/download/proofread`; link.textContent = '校对文本'; actions.append(link); }
  if (job.output?.larkUrl) { const link = document.createElement('a'); link.className = 'link-button'; link.href = job.output.larkUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '打开飞书'; actions.append(link); }
  if (job.status === 'failed' && job.failure?.retryable === true) { const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = '重试任务'; retry.onclick = () => retryJob(job.id); actions.append(retry); }
  if (job.status === 'awaiting_delivery' && job.output?.markdownPath && job.output?.larkDelivery?.state !== 'uncertain') { const redeliver = document.createElement('button'); redeliver.className = 'secondary'; redeliver.textContent = '继续飞书交付'; redeliver.onclick = () => redeliverJob(job.id); actions.append(redeliver); }
  const log = card.querySelector('.job-log ol'); job.log.slice().reverse().forEach((item) => { const li = document.createElement('li'); li.textContent = `${new Date(item.at).toLocaleString()} · ${item.message}`; log.append(li); });
  jobsEl.append(card);
}

async function retryJob(id) { const response = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' }); const data = await response.json(); if (!response.ok) return setMessage(data.error || '无法重试', true); setMessage('任务已重新进入队列。'); loadJobs(); }
async function redeliverJob(id) { const response = await fetch(`/api/jobs/${id}/redeliver`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }); const data = await response.json(); if (!response.ok) return setMessage(data.error || '无法继续飞书交付', true); setMessage('飞书交付状态已更新。'); loadJobs(); }
function statusLabel(status) { return ({ queued:'等待中', preparing:'检查素材', acquiring:'获取素材', transcribing:'转录中', distilling:'整理中', delivering:'交付中', awaiting_review:'等待听审', awaiting_delivery:'等待飞书交付', completed:'已完成', failed:'失败' })[status] || status; }
function connectionStatusLabel(status) { return ({ active:'已授权待验证', expiring:'即将过期', expired:'已过期', revoked:'已撤销', disabled:'已停用', error:'异常' })[status] || status; }
function setMessage(message, isError = false) { messageEl.textContent = message; messageEl.classList.toggle('error', isError); }

async function loadHealth() { const response = await fetch('/api/health'); const { capabilities, commonAccess } = await response.json(); const el = document.querySelector('#capabilities'); const labels = { asr:'本地 ASR', aiRefinement:'语义整理', lark:'飞书交付' }; Object.entries(capabilities).filter(([key]) => labels[key]).forEach(([key, value]) => { const badge = document.createElement('span'); badge.className = `capability ${value ? 'ready' : ''}`; badge.textContent = `${labels[key]} · ${value ? '已配置' : '未配置'}`; el.append(badge); }); if (commonAccess?.contentAcquisitionCenter) { const badge = document.createElement('span'); badge.className = 'capability ready'; badge.textContent = '通用内容获取 · 已就绪'; el.append(badge); } }
await Promise.all([loadHealth(), loadJobs(), loadConnections(), loadCookieBridgeAccounts()]);
setInterval(loadJobs, 3000);
