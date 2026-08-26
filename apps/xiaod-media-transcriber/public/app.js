const query = (selector) => document.querySelector(selector);
const queryAll = (selector) => document.querySelectorAll(selector);
const jobsEl = query('#jobs');
const emptyEl = query('#empty-state');
const messageEl = query('#form-message');
const template = query('#job-template');
const connectionsEl = query('#connections');
const connectionsEmptyEl = query('#connections-empty');
const connectionSelect = query('#connection-id');
const operationsEl = query('#operations-events');
const cookieBridgeClientSelect = query('#cookie-bridge-client-id');
const revisionDialog = query('#transcript-revision-dialog');
const revisionForm = query('#transcript-revision-form');
const revisionTranscript = query('#revision-transcript');
const revisionVersion = query('#revision-version');
const revisionMessage = query('#revision-message');
const revisionReload = query('#revision-reload');
const STAGES = [
    ['queued', '等待'],
    ['preparing', '素材'],
    ['acquiring', '获取'],
    ['transcribing', '转录'],
    ['analyzing_visual', '关键帧'],
    ['distilling', '整理'],
    ['awaiting_review', '听审'],
    ['delivering', '交付'],
    ['awaiting_delivery', '飞书'],
    ['completed', '完成'],
];
function renderStageStepper(job) {
    const currentIndex = STAGES.findIndex(([key]) => key === job.status);
    const isFailed = job.status === 'failed';
    const el = document.createElement('div');
    el.className = 'stage-stepper';
    // Show a condensed subset: pick up to 5 relevant stages around the current one
    const visibleStages = condenseStages(STAGES, currentIndex, isFailed);
    visibleStages.forEach((stage, index) => {
        if (index > 0) {
            const connector = document.createElement('span');
            connector.className = `stage-connector ${stage.done ? 'done' : ''}`;
            connector.textContent = '──';
            el.append(connector);
        }
        const node = document.createElement('span');
        node.className = `stage-node ${stage.done ? 'done' : ''} ${stage.active ? 'active' : ''} ${stage.failed ? 'failed' : ''}`;
        node.title = stage.fullLabel;
        const dot = document.createElement('span');
        dot.className = 'stage-dot';
        dot.textContent = stage.done ? '✓' : (stage.active ? '◉' : (stage.failed ? '✗' : '○'));
        const label = document.createElement('span');
        label.className = 'stage-label';
        label.textContent = stage.label;
        node.append(dot, label);
        el.append(node);
    });
    return el;
}
function condenseStages(stages, currentIndex, isFailed) {
    return stages.map(([key, label], index) => ({
        key,
        label,
        fullLabel: label,
        done: currentIndex >= 0 && index < currentIndex,
        active: !isFailed && index === currentIndex,
        failed: isFailed && index === currentIndex,
    }));
}
let activeRevisionJobId = null;
let activeRevisionVersion = null;
queryAll('.tab').forEach((button) => button.addEventListener('click', () => {
    queryAll('.tab').forEach((tab) => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
    query('#url-form').classList.toggle('hidden', button.dataset.source !== 'url');
    query('#upload-form').classList.toggle('hidden', button.dataset.source !== 'upload');
    setMessage('');
}));
query('#url-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const url = data.get('url');
    const connectionId = data.get('connectionId') || null;
    await submit('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, connectionId }) });
});
query('#upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await submit('/api/jobs/upload', { method: 'POST', body: new FormData(event.currentTarget) });
});
query('#refresh').addEventListener('click', loadJobs);
query('#cookie-bridge-connection-form').addEventListener('submit', createCookieBridgeConnection);
query('#revision-close').addEventListener('click', () => revisionDialog.close());
revisionForm.addEventListener('submit', saveTranscriptRevision);
revisionReload.addEventListener('click', () => loadTranscriptRevision(activeRevisionJobId));
async function submit(url, options) {
    setMessage('正在创建任务…');
    try {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error || '创建任务失败');
        setMessage('任务已开始，处理进度会显示在下方。');
        query('#url-form').reset();
        query('#upload-form').reset();
        await loadJobs();
    }
    catch (error) {
        setMessage(error.message, true);
    }
}
async function loadJobs() {
    const expandedLogs = new Set();
    jobsEl.querySelectorAll('.job-card[data-job-id]').forEach((card) => {
        const details = card.querySelector('.job-log');
        if (details?.open)
            expandedLogs.add(card.dataset.jobId);
    });
    const response = await fetch('/api/jobs');
    const { jobs } = await response.json();
    emptyEl.hidden = jobs.length > 0;
    jobsEl.replaceChildren();
    jobs.forEach(renderJob);
    if (expandedLogs.size) {
        jobsEl.querySelectorAll('.job-card[data-job-id]').forEach((card) => {
            if (expandedLogs.has(card.dataset.jobId)) {
                const details = card.querySelector('.job-log');
                if (details)
                    details.open = true;
            }
        });
    }
}
async function createCookieBridgeConnection(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
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
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload.error || '登记受控账号失败');
        form.reset();
        setMessage('受控账号已登记。Cookie 不会显示或保存在小D任务中。');
        await loadConnections(payload.connection.connectionId);
    }
    catch (error) {
        setMessage(error.message, true);
    }
}
async function loadCookieBridgeAccounts() {
    try {
        const response = await fetch('/api/cookie-bridge/accounts');
        const { accounts } = await response.json();
        if (!response.ok)
            throw new Error('unavailable');
        cookieBridgeClientSelect.replaceChildren(new Option('选择 CookieBridge 中的已登录账号', ''));
        accounts.filter((account) => account.connected).forEach((account) => {
            const platforms = account.platforms.length ? account.platforms.join('、') : '未标记平台';
            cookieBridgeClientSelect.append(new Option(`${platforms} · ${account.clientId}`, account.clientId));
        });
        if (cookieBridgeClientSelect.options.length === 1)
            cookieBridgeClientSelect.options[0].text = 'CookieBridge 暂无已连接账号';
    }
    catch {
        cookieBridgeClientSelect.replaceChildren(new Option('CookieBridge 本机服务暂不可用', ''));
    }
}
async function loadConnections(selectedId = connectionSelect.value) {
    const response = await fetch('/api/connections');
    const { connections } = await response.json();
    connectionSelect.replaceChildren(new Option('不使用账号连接（仅尝试公开读取）', ''));
    connectionsEl.replaceChildren();
    connectionsEmptyEl.hidden = connections.length > 0;
    connections.forEach((connection) => {
        if (connection.credentialKind === 'cookie_bridge') {
            const option = new Option(`${connection.provider} · ${connection.accountAlias} · ${connectionStatusLabel(connection.status)}`, connection.connectionId);
            if (connection.connectionId === selectedId && connection.status === 'active')
                option.selected = true;
            option.disabled = connection.status !== 'active';
            connectionSelect.append(option);
        }
        const row = document.createElement('article');
        row.className = 'connection-row';
        const main = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = `${connection.provider} · ${connection.accountAlias}`;
        const detail = document.createElement('p');
        detail.textContent = connection.credentialKind === 'browser_session'
            ? '旧浏览器连接已停用；不能读取浏览器登录态。'
            : connection.credentialKind === 'browser_companion'
                ? '已撤销的旧浏览器伴侣连接，不再使用。'
                : `只读 · CookieBridge 受控入口 · ${connection.grantedOperations.join('、')}`;
        main.append(title, detail);
        const actions = document.createElement('div');
        const state = document.createElement('span');
        state.className = `connection-status ${connection.status}`;
        state.textContent = connectionStatusLabel(connection.status);
        actions.append(state);
        if (connection.status === 'active') {
            const revoke = document.createElement('button');
            revoke.className = 'quiet danger';
            revoke.type = 'button';
            revoke.textContent = '撤销';
            revoke.onclick = () => revokeConnection(connection.connectionId);
            actions.append(revoke);
        }
        row.append(main, actions);
        connectionsEl.append(row);
    });
    await loadOperations();
}
async function loadOperations() {
    const response = await fetch('/api/operations/events');
    const { events } = await response.json();
    operationsEl.replaceChildren();
    if (events.length === 0) {
        operationsEl.textContent = '暂无健康事件。';
        return;
    }
    events.slice(0, 8).forEach((event) => {
        const item = document.createElement('p');
        item.textContent = `${new Date(event.createdAt).toLocaleString()} · ${event.safeMessage}`;
        operationsEl.append(item);
    });
}
async function revokeConnection(id) {
    const response = await fetch(`/api/connections/${id}/revoke`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok)
        return setMessage(payload.error || '撤销连接失败', true);
    setMessage('账号连接已撤销。后续受限链接会要求重新授权。');
    await loadConnections();
}
function renderJob(job) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.jobId = job.id;
    card.querySelector('.job-title').textContent = job.title;
    const status = card.querySelector('.status');
    status.textContent = job.failure?.category === 'needs_input' ? '需要授权或补充' : statusLabel(job.status);
    status.classList.add(job.failure?.category === 'needs_input' ? 'failed' : job.status);
    card.querySelector('.job-source').textContent = job.sourceType === 'upload' ? `本地文件 · ${job.originalName}` : `${job.sourceUrl}${job.connectionId ? ' · 已使用账号连接' : ''}`;
    card.querySelector('.job-main').insertBefore(renderStageStepper(job), card.querySelector('.progress-track'));
    card.querySelector('.progress-bar').style.width = `${job.progress}%`;
    card.querySelector('.stage-message').textContent = job.stageMessage;
    const warnings = card.querySelector('.warnings');
    if (job.error) {
        const p = document.createElement('p');
        p.className = 'error';
        p.textContent = job.error;
        warnings.append(p);
    }
    if (job.failure?.recovery) {
        const p = document.createElement('p');
        p.className = 'warning';
        p.textContent = job.failure.recovery;
        warnings.append(p);
    }
    job.warnings.forEach((warning) => { const p = document.createElement('p'); p.className = 'warning'; p.textContent = warning; warnings.append(p); });
    const actions = card.querySelector('.job-actions');
    if (job.output?.markdownPath) {
        const link = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download`;
        link.textContent = '完整整理稿';
        actions.append(link);
    }
    if (job.output?.guidePath) {
        const link = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download/guide`;
        link.textContent = '内容导览';
        actions.append(link);
    }
    if (job.output?.proofreadPath) {
        const link = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download/proofread`;
        link.textContent = '校对文本';
        actions.append(link);
    }
    if (job.output?.larkUrl) {
        const link = document.createElement('a');
        link.className = 'link-button';
        link.href = job.output.larkUrl;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = '打开飞书';
        actions.append(link);
    }
    if (['completed', 'awaiting_delivery'].includes(job.status) && job.output?.confirmedTranscriptPath && job.output?.confirmationMode === 'automatic') {
        const revise = document.createElement('button');
        revise.className = 'secondary';
        revise.type = 'button';
        revise.textContent = '修正字幕';
        revise.onclick = () => openTranscriptRevision(job.id);
        actions.append(revise);
    }
    if (job.status === 'failed' && job.failure?.retryable === true) {
        const retry = document.createElement('button');
        retry.className = 'secondary';
        retry.textContent = '重试任务';
        retry.onclick = () => retryJob(job.id);
        actions.append(retry);
    }
    if (job.status === 'awaiting_delivery' && job.output?.markdownPath && job.output?.larkDelivery?.state !== 'uncertain') {
        const redeliver = document.createElement('button');
        redeliver.className = 'secondary';
        redeliver.textContent = '继续飞书交付';
        redeliver.onclick = () => redeliverJob(job.id);
        actions.append(redeliver);
    }
    renderLogTimeline(job, card);
    jobsEl.append(card);
}
function renderLogTimeline(job, card) {
    const logDetails = card.querySelector('.job-log');
    const logList = card.querySelector('.job-log ol');
    if (!logList)
        return;
    logList.replaceChildren();
    const logs = Array.isArray(job.log) ? job.log.slice().reverse() : [];
    logs.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'log-item';
        const isSuccess = ['completed', 'delivering'].includes(item.stage) || item.message.includes('完成') || item.message.includes('成功');
        const isWarning = item.message.includes('降级') || item.message.includes('重试') || item.message.includes('未配置');
        const isError = item.stage === 'failed' || item.message.includes('失败') || item.message.includes('异常');
        const toneClass = isError ? 'log-danger' : (isWarning ? 'log-warning' : (isSuccess ? 'log-success' : 'log-info'));
        const dot = document.createElement('span');
        dot.className = `log-dot ${toneClass}`;
        dot.textContent = isError ? '✗' : (isWarning ? '!' : (isSuccess ? '✓' : '•'));
        const content = document.createElement('div');
        content.className = 'log-content';
        const header = document.createElement('div');
        header.className = 'log-header';
        const timeEl = document.createElement('time');
        timeEl.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const stageEl = document.createElement('span');
        stageEl.className = 'log-stage';
        stageEl.textContent = statusLabel(item.stage) || item.stage;
        header.append(stageEl, timeEl);
        const msgEl = document.createElement('p');
        msgEl.className = 'log-message';
        msgEl.textContent = item.message;
        content.append(header, msgEl);
        li.append(dot, content);
        logList.append(li);
    });
    if (logDetails) {
        logDetails.addEventListener('toggle', async () => {
            if (!logDetails.open || card.dataset.eventsLoaded)
                return;
            card.dataset.eventsLoaded = 'true';
            try {
                const res = await fetch(`/api/jobs/${job.id}/events`);
                const { events } = await res.json();
                if (Array.isArray(events) && events.length > 0) {
                    const det = document.createElement('details');
                    det.className = 'telemetry-details';
                    const summary = document.createElement('summary');
                    summary.textContent = `查看微观执行收据与遥测 (${events.length} 条记录)`;
                    det.append(summary);
                    const list = document.createElement('div');
                    list.className = 'telemetry-list';
                    events.forEach((ev) => {
                        const row = document.createElement('div');
                        const isErr = ev.status === 'failed' || ev.status === 'error';
                        const isWarn = ev.status === 'fallback';
                        row.className = `telemetry-item ${isErr ? 'err' : (isWarn ? 'warn' : 'ok')}`;
                        const time = ev.startedAt ? new Date(ev.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                        const duration = Number.isFinite(ev.durationMs) ? `${ev.durationMs}ms` : '';
                        const meta = [ev.provider, ev.model, duration].filter(Boolean).join(' · ');
                        row.innerHTML = `<div class="telemetry-head"><span class="telemetry-type">${ev.eventType}</span><span class="telemetry-route">${ev.routeId || ev.capabilityId || ''}</span><time>${time}</time></div>${meta ? `<div class="telemetry-meta">${meta}</div>` : ''}${ev.safeSummary ? `<p class="telemetry-summary">${ev.safeSummary}</p>` : ''}`;
                        list.append(row);
                    });
                    det.append(list);
                    logDetails.append(det);
                }
            }
            catch {
                // best-effort
            }
        });
    }
}
async function openTranscriptRevision(jobId) {
    activeRevisionJobId = jobId;
    activeRevisionVersion = null;
    revisionForm.reset();
    query('#revision-editor').value = 'local-owner';
    revisionTranscript.value = '';
    setRevisionMessage('正在读取最新 AI 字幕初稿…');
    revisionReload.classList.add('hidden');
    if (!revisionDialog.open)
        revisionDialog.showModal();
    await loadTranscriptRevision(jobId);
}
async function loadTranscriptRevision(jobId) {
    if (!jobId)
        return;
    setRevisionMessage('正在读取最新字幕…');
    revisionReload.classList.add('hidden');
    try {
        const response = await fetch(`/api/jobs/${jobId}/transcript-revision`);
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload.error || '无法读取字幕');
        activeRevisionVersion = payload.revision.version;
        revisionVersion.textContent = `当前版本 v${payload.revision.version} · ${payload.revision.completeListen ? '已有完整人工听审记录' : 'AI 初稿，可做局部人工补正'}`;
        revisionTranscript.value = payload.revision.transcript;
        setRevisionMessage('');
    }
    catch (error) {
        setRevisionMessage(error.message, true);
    }
}
async function saveTranscriptRevision(event) {
    event.preventDefault();
    if (!activeRevisionJobId || !activeRevisionVersion)
        return;
    const submitButton = revisionForm.querySelector('button[type="submit"]');
    const data = new FormData(revisionForm);
    submitButton.disabled = true;
    setRevisionMessage('正在保存新版本…');
    try {
        const response = await fetch(`/api/jobs/${activeRevisionJobId}/transcript-revisions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expectedVersion: activeRevisionVersion,
                correctedTranscript: data.get('correctedTranscript'),
                correctionSummary: data.get('correctionSummary'),
                editorRef: data.get('editorRef'),
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            if (response.status === 409) {
                revisionReload.classList.remove('hidden');
                throw new Error(`${payload.error || '字幕版本已经变化'} 当前编辑未覆盖服务器内容。`);
            }
            throw new Error(payload.error || '字幕补正保存失败');
        }
        activeRevisionVersion = payload.revision.version;
        revisionVersion.textContent = `当前版本 v${payload.revision.version} · AI 初稿已局部人工补正`;
        setRevisionMessage(`已保存 v${payload.revision.version}。未调用模型，也未自动外发。`);
        revisionReload.classList.add('hidden');
        await loadJobs();
    }
    catch (error) {
        setRevisionMessage(error.message, true);
    }
    finally {
        submitButton.disabled = false;
    }
}
async function retryJob(id) {
    const response = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok)
        return setMessage(data.error || '无法重试', true);
    setMessage('任务已重新进入队列。');
    loadJobs();
}
async function redeliverJob(id) {
    const response = await fetch(`/api/jobs/${id}/redeliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok)
        return setMessage(data.error || '无法继续飞书交付', true);
    setMessage('飞书交付状态已更新。');
    loadJobs();
}
function statusLabel(status) { return { queued: '等待中', preparing: '检查素材', acquiring: '获取素材', transcribing: '转录中', analyzing_visual: '提取关键帧', distilling: '整理中', delivering: '交付中', awaiting_review: '等待听审', awaiting_delivery: '等待飞书交付', completed: '已完成', failed: '失败' }[status] || status; }
function connectionStatusLabel(status) { return { active: '已授权待验证', expiring: '即将过期', expired: '已过期', revoked: '已撤销', disabled: '已停用', error: '异常' }[status] || status; }
function setMessage(message, isError = false) { messageEl.textContent = message; messageEl.classList.toggle('error', isError); }
function setRevisionMessage(message, isError = false) { revisionMessage.textContent = message; revisionMessage.classList.toggle('error', isError); }
async function loadHealth() {
    const response = await fetch('/api/health');
    const { capabilities, commonAccess } = await response.json();
    const el = query('#capabilities');
    const labels = { asr: '本地 ASR', aiRefinement: '语义整理', lark: '飞书交付' };
    Object.entries(capabilities).filter(([key]) => labels[key]).forEach(([key, value]) => { const badge = document.createElement('span'); badge.className = `capability ${value ? 'ready' : ''}`; badge.textContent = `${labels[key]} · ${value ? '已配置' : '未配置'}`; el.append(badge); });
    if (commonAccess?.contentAcquisitionCenter) {
        const badge = document.createElement('span');
        badge.className = 'capability ready';
        badge.textContent = '通用内容获取 · 已就绪';
        el.append(badge);
    }
}
await Promise.all([loadHealth(), loadJobs(), loadConnections(), loadCookieBridgeAccounts()]);
setInterval(loadJobs, 3000);
export {};
