const query: any = (selector: any): any => document.querySelector(selector);
const queryAll: any = (selector: any): any => document.querySelectorAll(selector);
const jobsEl: any = query('#jobs');
const emptyEl: any = query('#empty-state');
const messageEl: any = query('#form-message');
const template: any = query('#job-template');
const connectionsEl: any = query('#connections');
const connectionsEmptyEl: any = query('#connections-empty');
const connectionSelect: any = query('#connection-id');
const operationsEl: any = query('#operations-events');
const cookieBridgeClientSelect: any = query('#cookie-bridge-client-id');
const revisionDialog: any = query('#transcript-revision-dialog');
const revisionForm: any = query('#transcript-revision-form');
const revisionTranscript: any = query('#revision-transcript');
const revisionVersion: any = query('#revision-version');
const revisionMessage: any = query('#revision-message');
const revisionReload: any = query('#revision-reload');
let activeRevisionJobId: any = null;
let activeRevisionVersion: any = null;
queryAll('.tab').forEach((button: any): any => button.addEventListener('click', (): any => {
    queryAll('.tab').forEach((tab: any): any => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
    query('#url-form').classList.toggle('hidden', button.dataset.source !== 'url');
    query('#upload-form').classList.toggle('hidden', button.dataset.source !== 'upload');
    setMessage('');
}));
query('#url-form').addEventListener('submit', async (event: any): Promise<any> => {
    event.preventDefault();
    const data: any = new FormData(event.currentTarget);
    const url: any = data.get('url');
    const connectionId: any = data.get('connectionId') || null;
    await submit('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, connectionId }) });
});
query('#upload-form').addEventListener('submit', async (event: any): Promise<any> => {
    event.preventDefault();
    await submit('/api/jobs/upload', { method: 'POST', body: new FormData(event.currentTarget) });
});
query('#refresh').addEventListener('click', loadJobs);
query('#cookie-bridge-connection-form').addEventListener('submit', createCookieBridgeConnection);
query('#revision-close').addEventListener('click', (): any => revisionDialog.close());
revisionForm.addEventListener('submit', saveTranscriptRevision);
revisionReload.addEventListener('click', (): any => loadTranscriptRevision(activeRevisionJobId));
async function submit(url: any, options: any): Promise<any> {
    setMessage('正在创建任务…');
    try {
        const response: any = await fetch(url, options);
        const data: any = await response.json();
        if (!response.ok)
            throw new Error(data.error || '创建任务失败');
        setMessage('任务已开始，处理进度会显示在下方。');
        query('#url-form').reset();
        query('#upload-form').reset();
        await loadJobs();
    }
    catch (error: any) {
        setMessage(error.message, true);
    }
}
async function loadJobs(): Promise<any> {
    const response: any = await fetch('/api/jobs');
    const { jobs }: any = await response.json();
    emptyEl.hidden = jobs.length > 0;
    jobsEl.replaceChildren();
    jobs.forEach(renderJob);
}
async function createCookieBridgeConnection(event: any): Promise<any> {
    event.preventDefault();
    const form: any = event.currentTarget;
    const data: any = new FormData(form);
    setMessage('正在登记受控账号连接…');
    try {
        const response: any = await fetch('/api/connections/cookie-bridge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: data.get('provider'), accountAlias: data.get('accountAlias'), clientId: data.get('clientId'),
                grantedOperations: ['read_media_metadata', 'read_content_images', 'download_authorized_media'],
                dataScope: ['content:read'], allowedAgentIds: ['xiaod']
            })
        });
        const payload: any = await response.json();
        if (!response.ok)
            throw new Error(payload.error || '登记受控账号失败');
        form.reset();
        setMessage('受控账号已登记。Cookie 不会显示或保存在小D任务中。');
        await loadConnections(payload.connection.connectionId);
    }
    catch (error: any) {
        setMessage(error.message, true);
    }
}
async function loadCookieBridgeAccounts(): Promise<any> {
    try {
        const response: any = await fetch('/api/cookie-bridge/accounts');
        const { accounts }: any = await response.json();
        if (!response.ok)
            throw new Error('unavailable');
        cookieBridgeClientSelect.replaceChildren(new Option('选择 CookieBridge 中的已登录账号', ''));
        accounts.filter((account: any): any => account.connected).forEach((account: any): any => {
            const platforms: any = account.platforms.length ? account.platforms.join('、') : '未标记平台';
            cookieBridgeClientSelect.append(new Option(`${platforms} · ${account.clientId}`, account.clientId));
        });
        if (cookieBridgeClientSelect.options.length === 1)
            cookieBridgeClientSelect.options[0].text = 'CookieBridge 暂无已连接账号';
    }
    catch {
        cookieBridgeClientSelect.replaceChildren(new Option('CookieBridge 本机服务暂不可用', ''));
    }
}
async function loadConnections(selectedId: any = connectionSelect.value): Promise<any> {
    const response: any = await fetch('/api/connections');
    const { connections }: any = await response.json();
    connectionSelect.replaceChildren(new Option('不使用账号连接（仅尝试公开读取）', ''));
    connectionsEl.replaceChildren();
    connectionsEmptyEl.hidden = connections.length > 0;
    connections.forEach((connection: any): any => {
        if (connection.credentialKind === 'cookie_bridge') {
            const option: any = new Option(`${connection.provider} · ${connection.accountAlias} · ${connectionStatusLabel(connection.status)}`, connection.connectionId);
            if (connection.connectionId === selectedId && connection.status === 'active')
                option.selected = true;
            option.disabled = connection.status !== 'active';
            connectionSelect.append(option);
        }
        const row: any = document.createElement('article');
        row.className = 'connection-row';
        const main: any = document.createElement('div');
        const title: any = document.createElement('strong');
        title.textContent = `${connection.provider} · ${connection.accountAlias}`;
        const detail: any = document.createElement('p');
        detail.textContent = connection.credentialKind === 'browser_session'
            ? '旧浏览器连接已停用；不能读取浏览器登录态。'
            : connection.credentialKind === 'browser_companion'
                ? '已撤销的旧浏览器伴侣连接，不再使用。'
                : `只读 · CookieBridge 受控入口 · ${connection.grantedOperations.join('、')}`;
        main.append(title, detail);
        const actions: any = document.createElement('div');
        const state: any = document.createElement('span');
        state.className = `connection-status ${connection.status}`;
        state.textContent = connectionStatusLabel(connection.status);
        actions.append(state);
        if (connection.status === 'active') {
            const revoke: any = document.createElement('button');
            revoke.className = 'quiet danger';
            revoke.type = 'button';
            revoke.textContent = '撤销';
            revoke.onclick = (): any => revokeConnection(connection.connectionId);
            actions.append(revoke);
        }
        row.append(main, actions);
        connectionsEl.append(row);
    });
    await loadOperations();
}
async function loadOperations(): Promise<any> {
    const response: any = await fetch('/api/operations/events');
    const { events }: any = await response.json();
    operationsEl.replaceChildren();
    if (events.length === 0) {
        operationsEl.textContent = '暂无健康事件。';
        return;
    }
    events.slice(0, 8).forEach((event: any): any => {
        const item: any = document.createElement('p');
        item.textContent = `${new Date(event.createdAt).toLocaleString()} · ${event.safeMessage}`;
        operationsEl.append(item);
    });
}
async function revokeConnection(id: any): Promise<any> {
    const response: any = await fetch(`/api/connections/${id}/revoke`, { method: 'POST' });
    const payload: any = await response.json();
    if (!response.ok)
        return setMessage(payload.error || '撤销连接失败', true);
    setMessage('账号连接已撤销。后续受限链接会要求重新授权。');
    await loadConnections();
}
function renderJob(job: any): any {
    const card: any = template.content.firstElementChild.cloneNode(true);
    card.querySelector('.job-title').textContent = job.title;
    const status: any = card.querySelector('.status');
    status.textContent = job.failure?.category === 'needs_input' ? '需要授权或补充' : statusLabel(job.status);
    status.classList.add(job.failure?.category === 'needs_input' ? 'failed' : job.status);
    card.querySelector('.job-source').textContent = job.sourceType === 'upload' ? `本地文件 · ${job.originalName}` : `${job.sourceUrl}${job.connectionId ? ' · 已使用账号连接' : ''}`;
    card.querySelector('.progress-bar').style.width = `${job.progress}%`;
    card.querySelector('.stage-message').textContent = job.stageMessage;
    const warnings: any = card.querySelector('.warnings');
    if (job.error) {
        const p: any = document.createElement('p');
        p.className = 'error';
        p.textContent = job.error;
        warnings.append(p);
    }
    if (job.failure?.recovery) {
        const p: any = document.createElement('p');
        p.className = 'warning';
        p.textContent = job.failure.recovery;
        warnings.append(p);
    }
    job.warnings.forEach((warning: any): any => { const p: any = document.createElement('p'); p.className = 'warning'; p.textContent = warning; warnings.append(p); });
    const actions: any = card.querySelector('.job-actions');
    if (job.output?.markdownPath) {
        const link: any = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download`;
        link.textContent = '完整整理稿';
        actions.append(link);
    }
    if (job.output?.guidePath) {
        const link: any = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download/guide`;
        link.textContent = '内容导览';
        actions.append(link);
    }
    if (job.output?.proofreadPath) {
        const link: any = document.createElement('a');
        link.className = 'link-button';
        link.href = `/api/jobs/${job.id}/download/proofread`;
        link.textContent = '校对文本';
        actions.append(link);
    }
    if (job.output?.larkUrl) {
        const link: any = document.createElement('a');
        link.className = 'link-button';
        link.href = job.output.larkUrl;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = '打开飞书';
        actions.append(link);
    }
    if (['completed', 'awaiting_delivery'].includes(job.status) && job.output?.confirmedTranscriptPath && job.output?.confirmationMode === 'automatic') {
        const revise: any = document.createElement('button');
        revise.className = 'secondary';
        revise.type = 'button';
        revise.textContent = '修正字幕';
        revise.onclick = (): any => openTranscriptRevision(job.id);
        actions.append(revise);
    }
    if (job.status === 'failed' && job.failure?.retryable === true) {
        const retry: any = document.createElement('button');
        retry.className = 'secondary';
        retry.textContent = '重试任务';
        retry.onclick = (): any => retryJob(job.id);
        actions.append(retry);
    }
    if (job.status === 'awaiting_delivery' && job.output?.markdownPath && job.output?.larkDelivery?.state !== 'uncertain') {
        const redeliver: any = document.createElement('button');
        redeliver.className = 'secondary';
        redeliver.textContent = '继续飞书交付';
        redeliver.onclick = (): any => redeliverJob(job.id);
        actions.append(redeliver);
    }
    const log: any = card.querySelector('.job-log ol');
    job.log.slice().reverse().forEach((item: any): any => { const li: any = document.createElement('li'); li.textContent = `${new Date(item.at).toLocaleString()} · ${item.message}`; log.append(li); });
    jobsEl.append(card);
}
async function openTranscriptRevision(jobId: any): Promise<any> {
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
async function loadTranscriptRevision(jobId: any): Promise<any> {
    if (!jobId)
        return;
    setRevisionMessage('正在读取最新字幕…');
    revisionReload.classList.add('hidden');
    try {
        const response: any = await fetch(`/api/jobs/${jobId}/transcript-revision`);
        const payload: any = await response.json();
        if (!response.ok)
            throw new Error(payload.error || '无法读取字幕');
        activeRevisionVersion = payload.revision.version;
        revisionVersion.textContent = `当前版本 v${payload.revision.version} · ${payload.revision.completeListen ? '已有完整人工听审记录' : 'AI 初稿，可做局部人工补正'}`;
        revisionTranscript.value = payload.revision.transcript;
        setRevisionMessage('');
    }
    catch (error: any) {
        setRevisionMessage(error.message, true);
    }
}
async function saveTranscriptRevision(event: any): Promise<any> {
    event.preventDefault();
    if (!activeRevisionJobId || !activeRevisionVersion)
        return;
    const submitButton: any = revisionForm.querySelector('button[type="submit"]');
    const data: any = new FormData(revisionForm);
    submitButton.disabled = true;
    setRevisionMessage('正在保存新版本…');
    try {
        const response: any = await fetch(`/api/jobs/${activeRevisionJobId}/transcript-revisions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expectedVersion: activeRevisionVersion,
                correctedTranscript: data.get('correctedTranscript'),
                correctionSummary: data.get('correctionSummary'),
                editorRef: data.get('editorRef'),
            }),
        });
        const payload: any = await response.json();
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
    catch (error: any) {
        setRevisionMessage(error.message, true);
    }
    finally {
        submitButton.disabled = false;
    }
}
async function retryJob(id: any): Promise<any> {
    const response: any = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
    const data: any = await response.json();
    if (!response.ok)
        return setMessage(data.error || '无法重试', true);
    setMessage('任务已重新进入队列。');
    loadJobs();
}
async function redeliverJob(id: any): Promise<any> {
    const response: any = await fetch(`/api/jobs/${id}/redeliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data: any = await response.json();
    if (!response.ok)
        return setMessage(data.error || '无法继续飞书交付', true);
    setMessage('飞书交付状态已更新。');
    loadJobs();
}
function statusLabel(status: any): any { return ({ queued: '等待中', preparing: '检查素材', acquiring: '获取素材', transcribing: '转录中', distilling: '整理中', delivering: '交付中', awaiting_review: '等待听审', awaiting_delivery: '等待飞书交付', completed: '已完成', failed: '失败' } as Record<string, string>)[status] || status; }
function connectionStatusLabel(status: any): any { return ({ active: '已授权待验证', expiring: '即将过期', expired: '已过期', revoked: '已撤销', disabled: '已停用', error: '异常' } as Record<string, string>)[status] || status; }
function setMessage(message: any, isError: any = false): any { messageEl.textContent = message; messageEl.classList.toggle('error', isError); }
function setRevisionMessage(message: any, isError: any = false): any { revisionMessage.textContent = message; revisionMessage.classList.toggle('error', isError); }
async function loadHealth(): Promise<any> {
    const response: any = await fetch('/api/health');
    const { capabilities, commonAccess }: any = await response.json();
    const el: any = query('#capabilities');
    const labels: any = { asr: '本地 ASR', aiRefinement: '语义整理', lark: '飞书交付' };
    Object.entries(capabilities).filter(([key]: any): any => labels[key]).forEach(([key, value]: any): any => { const badge: any = document.createElement('span'); badge.className = `capability ${value ? 'ready' : ''}`; badge.textContent = `${labels[key]} · ${value ? '已配置' : '未配置'}`; el.append(badge); });
    if (commonAccess?.contentAcquisitionCenter) {
        const badge: any = document.createElement('span');
        badge.className = 'capability ready';
        badge.textContent = '通用内容获取 · 已就绪';
        el.append(badge);
    }
}
await Promise.all([loadHealth(), loadJobs(), loadConnections(), loadCookieBridgeAccounts()]);
setInterval(loadJobs, 3000);

export {};
