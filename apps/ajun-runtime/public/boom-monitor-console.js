import { html, raw, escapeHtml } from './html.js';
const API_ROOT = '/api/boom-monitor';
const numericCsvFields = new Set([
    'follower_count', 'likes', 'favorites', 'shares', 'comments', 'plays', 'views', 'history_limit'
]);
export function parseBoomCsv(source) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    const text = String(source || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                value += '"';
                index += 1;
            }
            else if (char === '"') {
                quoted = false;
            }
            else {
                value += char;
            }
            continue;
        }
        if (char === '"')
            quoted = true;
        else if (char === ',') {
            row.push(value.trim());
            value = '';
        }
        else if (char === '\n') {
            row.push(value.trim());
            if (row.some(Boolean))
                rows.push(row);
            row = [];
            value = '';
        }
        else if (char !== '\r')
            value += char;
    }
    row.push(value.trim());
    if (row.some(Boolean))
        rows.push(row);
    if (quoted)
        throw new Error('CSV 中有未闭合的引号。');
    if (rows.length < 2)
        throw new Error('CSV 至少需要表头和一条作品记录。');
    const headers = rows[0].map((header) => header.trim());
    if (!headers.includes('work_id'))
        throw new Error('CSV 表头必须包含 work_id。');
    return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => {
        const cell = cells[index] ?? '';
        return [header, numericCsvFields.has(header) && cell !== '' ? Number(cell) : cell];
    })));
}
export function buildBoomImportRequest(value) {
    if (Array.isArray(value))
        return { source_type: 'manual', works: value };
    if (!value || typeof value !== 'object')
        throw new Error('导入内容必须是 JSON 对象或数组。');
    const works = Array.isArray(value.works) ? value.works : [value];
    if (!works.length)
        throw new Error('导入内容没有作品记录。');
    return {
        source_type: 'manual',
        platform: value.platform || works[0]?.platform || 'douyin',
        creator: value.creator || value.creator_id || '',
        creator_name: value.creator_name || '',
        follower_count: Number(value.follower_count || 0),
        works,
    };
}
export function createBoomMonitorConsole({ root, api, formatDate }) {
    const element = (selector) => root.querySelector(selector);
    const elements = {
        refresh: element('#boom-refresh'),
        message: element('#boom-message'),
        stats: element('#boom-stats'),
        collectForm: element('#boom-collect-form'),
        sourceUrl: element('#boom-source-url'),
        collectSubmit: element('#boom-collect-submit'),
        collectResult: element('#boom-collect-result'),
        tabs: [...root.querySelectorAll('[data-boom-view]')],
        queueTab: element('[data-boom-view="queue"]'),
        pages: [...root.querySelectorAll('[data-boom-view-page]')],
        workFilters: element('#boom-work-filters'),
        filterGrade: element('#boom-filter-grade'),
        filterPlatform: element('#boom-filter-platform'),
        filterCreator: element('#boom-filter-creator'),
        workList: element('#boom-work-list'),
        scanRun: element('#boom-scan-run'),
        queueRefresh: element('#boom-queue-refresh'),
        analysisList: element('#boom-analysis-list'),
        importForm: element('#boom-import-form'),
        importFile: element('#boom-import-file'),
        importPayload: element('#boom-import-payload'),
        importSubmit: element('#boom-import-submit'),
        importResult: element('#boom-import-result'),
        settingsForm: element('#boom-settings-form'),
        autoEnabled: element('#boom-auto-enabled'),
        dailyLimit: element('#boom-daily-limit'),
        budget: element('#boom-budget'),
    };
    let initialized = false;
    let loading = false;
    let settings = { enabled: false, grades: ['T2', 'T3'] };
    let budgetState = { daily_limit: 5, dispatched_today: 0, remaining_today: 5 };
    function setMessage(message, tone = '') {
        elements.message.textContent = message;
        elements.message.dataset.tone = tone;
        elements.message.hidden = !message;
    }
    function setView(name) {
        for (const tab of elements.tabs) {
            const active = tab.dataset.boomView === name;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-pressed', String(active));
        }
        for (const page of elements.pages) {
            const active = page.dataset.boomViewPage === name;
            page.classList.toggle('is-active', active);
            page.hidden = !active;
        }
        if (name === 'queue')
            loadQueues().catch(showError);
        if (name === 'settings')
            loadSettings().catch(showError);
    }
    function showError(error) {
        setMessage(error.message || '雷达请求失败。', 'error');
    }
    function renderDashboard(dashboard, health) {
        const totals = dashboard?.totals || {};
        const boom = dashboard?.boom || {};
        const waiting = Number(dashboard?.scan_jobs || 0);
        const unhealthy = health?.ok !== true;
        const items = [
            `${Number(totals.works || 0)} 条作品`,
            `T3 ${Number(boom.T3 || 0)}`,
            `T2 ${Number(boom.T2 || 0)}`,
            ...(waiting ? [`${waiting} 条等待评分`] : []),
        ];
        elements.stats.hidden = false;
        elements.stats.classList.toggle('is-warning', unhealthy);
        elements.stats.innerHTML = html `${unhealthy ? '<strong>雷达状态待确认</strong>' : ''}<span>${items.join(' · ')}</span>`;
    }
    async function loadOverview() {
        if (loading)
            return;
        loading = true;
        elements.refresh.disabled = true;
        setMessage('正在读取爆款雷达…');
        try {
            const [health, dashboard] = await Promise.all([
                api(`${API_ROOT}/health`),
                api(`${API_ROOT}/dashboard`),
            ]);
            renderDashboard(dashboard, health);
            await loadWorks();
            setMessage('');
        }
        finally {
            loading = false;
            elements.refresh.disabled = false;
        }
    }
    function gradeBadge(grade) {
        const normalized = ['T1', 'T2', 'T3'].includes(grade) ? grade : 'N0';
        return `<span class="boom-grade ${normalized.toLowerCase()}">${normalized}</span>`;
    }
    function workMetricChips(work) {
        const rValue = Number(work.r_value);
        const mValue = Number(work.m_value);
        const likes = Number(work.likes);
        const mThreshold = boomMThreshold(work.tier);
        const volumeFloor = boomVolumeFloor(work.platform);
        return [
            metricChip({ icon: 'trend', value: ratioText(work.r_value), label: '相对历史', title: '相对历史表现：当前核心互动 ÷ 作者历史作品中位数，≥2× 达标', fill: Number.isFinite(rValue) ? rValue / 3 : 0, pass: rValue >= 2 }),
            metricChip({ icon: 'heart', value: percentText(work.m_value), label: '互动率', title: `粉丝互动率：点赞数 ÷ 粉丝数，≥${Math.round(mThreshold * 100)}% 达标`, fill: Number.isFinite(mValue) ? mValue * 20 : 0, pass: Number.isFinite(mValue) && mValue >= mThreshold }),
            metricChip({ icon: 'thumb', value: formatCompact(work.likes), label: '点赞', title: `当前累计点赞数，≥${volumeFloor} 达到基础量级`, fill: likes > 0 ? Math.max(0.08, Math.min(1, Math.log10(likes + 1) / 5)) : 0, pass: likes >= volumeFloor }),
        ].join('');
    }
    function renderWorks(works, taskProgress = new Map()) {
        if (!works.length) {
            elements.workList.innerHTML = '<p class="boom-empty">还没有符合条件的作品。</p>';
            return;
        }
        const autoGrades = new Set(Array.isArray(settings.grades) ? settings.grades : ['T2', 'T3']);
        elements.workList.innerHTML = works.map((work) => {
            const analysisStatus = String(work.analysis_status || '');
            const autoHandlesWork = settings.enabled === true && autoGrades.has(work.grade);
            const canDispatch = ['T1', 'T2', 'T3'].includes(work.grade)
                && (!analysisStatus || analysisStatus === 'cancelled' || (analysisStatus === 'queued' && !autoHandlesWork));
            const workTitle = work.title || work.work_id || `作品 ${work.id}`;
            const detailId = `boom-score-detail-${work.id}`;
            const taskId = String(work.army_task_id || '');
            const task = taskId ? taskProgress.get(taskId) : null;
            const pendingApprovalId = String(task?.pendingApproval?.approvalId || '');
            const status = workStatusLabel(analysisStatus, autoHandlesWork, task);
            const progressAction = pendingApprovalId
                ? html `<button type="button" data-boom-approve="${pendingApprovalId}">确认并继续</button>`
                : taskId
                    ? html `<a class="boom-task-link" href="/tasks/${encodeURIComponent(taskId)}">查看拆解进度</a>`
                    : '';
            return html `
      <article class="boom-list-item">
        <div class="boom-item-head">
          <span class="boom-item-copy"><strong>${workTitle}</strong><small>${platformLabel(work.platform)} · ${formatDate(work.publish_at)}${status}</small></span>
          ${raw(gradeBadge(work.grade))}
        </div>
        <div class="boom-item-metrics">
          ${raw(workMetricChips(work))}
          <div class="boom-item-actions">
            <button type="button" class="secondary-action" data-boom-detail="${work.id}" aria-label="${'查看“' + workTitle + '”的判断依据'}" aria-controls="${detailId}" aria-expanded="false">查看判断依据</button>
            ${raw(canDispatch ? html `<button type="button" data-boom-dispatch-work="${work.id}" aria-label="${'开始拆解“' + workTitle + '”'}">开始拆解</button>` : progressAction)}
          </div>
        </div>
        <p class="boom-item-reason">${gradeReason(work.grade)}</p>
        <div id="${detailId}" class="boom-score-detail" data-boom-detail-output="${work.id}" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      </article>`;
        }).join('');
    }
    async function showWorkDetail(workId, triggerButton) {
        const output = elements.workList.querySelector(`[data-boom-detail-output="${workId}"]`);
        if (!output)
            return;
        output.hidden = false;
        output.classList.remove('is-error');
        output.textContent = '正在读取判断依据…';
        triggerButton?.setAttribute('aria-expanded', 'true');
        try {
            const payload = await api(`${API_ROOT}/works/${workId}`);
            const official = payload.score_details;
            output.innerHTML = html `
        <div class="boom-detail-head"><strong>判断依据：三道门槛</strong></div>
        ${official ? raw(gateRows(official)) : '<p>暂无评分记录。</p>'}
        <small>缺少发布时间时只表示累计表现，不表示作品正在爆发。</small>`;
        }
        catch (error) {
            output.classList.add('is-error');
            output.textContent = `判断依据读取失败：${error.message}`;
            throw error;
        }
    }
    async function dispatchManually(workId = null, triggerButton = null) {
        if (triggerButton?.disabled)
            return;
        const scope = workId ? '这条作品' : '当前待处理项';
        if (!window.confirm(`确定开始${scope}的拆解吗？系统会先由小D取证，再由小拆分析，不会直接发布内容。`))
            return;
        const originalLabel = triggerButton?.textContent;
        if (triggerButton) {
            triggerButton.disabled = true;
            triggerButton.textContent = '正在交给军团…';
        }
        try {
            if (workId)
                await api(`${API_ROOT}/analysis/queue/${workId}`, { method: 'POST' });
            const result = await api(`${API_ROOT}/analysis/run`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ manual: true, ...(workId ? { work_id: Number(workId) } : {}) }),
            });
            const message = result.status === 'daily_limit'
                ? '今日派发已达到上限。'
                : result.status === 'idle'
                    ? '当前没有待派发作品。'
                    : result.status === 'external_dispatch_disabled'
                        ? '军团任务入口未就绪，作品仍保留在队列。'
                        : Number(result.processed || 0) > 0
                            ? '拆解任务已创建。后续进度和需要你确认的步骤会显示在作品卡上。'
                            : '当前没有新的作品需要处理。';
            setMessage(message, result.status === 'ok' ? 'ready' : '');
            await loadSettings();
            await Promise.all([loadWorks(), loadQueues()]);
        }
        finally {
            if (triggerButton?.isConnected) {
                triggerButton.disabled = false;
                triggerButton.textContent = originalLabel;
            }
        }
    }
    async function loadWorks() {
        elements.workList.innerHTML = '<p class="boom-empty">正在读取作品…</p>';
        const query = new URLSearchParams();
        if (elements.filterGrade.value)
            query.set('grade', elements.filterGrade.value);
        if (elements.filterPlatform.value)
            query.set('platform', elements.filterPlatform.value);
        if (elements.filterCreator.value.trim())
            query.set('creator_id', elements.filterCreator.value.trim());
        const payload = await api(`${API_ROOT}/works?${query}`);
        const works = payload.works || [];
        const taskIds = [...new Set(works.map((work) => String(work.army_task_id || '')).filter(Boolean))];
        const taskEntries = await Promise.all(taskIds.map(async (taskId) => {
            try {
                const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
                return [taskId, detail.task || detail];
            }
            catch {
                return [taskId, null];
            }
        }));
        renderWorks(works, new Map(taskEntries));
    }
    async function approveAndContinue(approvalId, triggerButton) {
        if (triggerButton?.disabled)
            return;
        if (!window.confirm('确认继续这条拆解吗？这里只会取证和分析，不会自动发布内容。'))
            return;
        const originalLabel = triggerButton.textContent;
        triggerButton.disabled = true;
        triggerButton.textContent = '正在继续…';
        try {
            await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ decisionBy: '爆款雷达本机确认', decisionReason: '已在爆款雷达确认只进行素材取证和内容拆解，不自动发布。' }),
            });
            setMessage('已确认，系统会继续取证和拆解。你可以关闭页面，稍后回来查看进度。', 'ready');
            await Promise.all([loadWorks(), loadQueues()]);
        }
        finally {
            if (triggerButton?.isConnected) {
                triggerButton.disabled = false;
                triggerButton.textContent = originalLabel;
            }
        }
    }
    function queueItem(item) {
        const title = item.title || item.work_id || `作品 ${item.work_id || item.id}`;
        const workId = item.work_id;
        const status = String(item.status || '');
        const summary = queueProblemSummary(status);
        const failure = item.dispatch_error || item.error_message;
        const taskId = String(item.army_task_id || '');
        const action = status === 'waiting_source'
            ? '<button type="button" class="secondary-action" data-boom-focus-intake>补充链接</button>'
            : taskId && ['waiting_approval', 'needs_input', 'failed'].includes(status)
                ? html `<a class="boom-task-link" href="/tasks/${encodeURIComponent(taskId)}">查看并处理</a>`
                : status === 'queued' && Number(budgetState.remaining_today) <= 0
                    ? '<button type="button" class="secondary-action" data-boom-open-settings>调整今日上限</button>'
                    : workId
                        ? html `<button type="button" data-boom-dispatch-work="${workId}">重试</button>`
                        : '';
        return html `<article class="boom-queue-item"><strong>${title}</strong><span>${summary}</span>${raw(taskId ? html `<small>任务编号 ${taskId}</small>` : '')}<div class="boom-item-actions">${raw(action)}</div>${raw(failure ? html `<details class="boom-technical-detail"><summary>查看技术原因</summary><small class="is-error">${failure}</small></details>` : '')}</article>`;
    }
    function actionableAnalysisItems(items) {
        return items.filter((item) => {
            const status = String(item.status || '');
            if (['waiting_source', 'dispatch_failed', 'waiting_approval', 'needs_input', 'failed'].includes(status))
                return true;
            return status === 'queued' && settings.enabled === true && Number(budgetState.remaining_today) <= 0;
        });
    }
    async function loadQueues() {
        const analysis = await api(`${API_ROOT}/analysis`);
        const analysisItems = actionableAnalysisItems(analysis.items || []);
        elements.queueTab.hidden = analysisItems.length === 0;
        elements.queueTab.textContent = analysisItems.length ? `需要处理 ${analysisItems.length}` : '需要处理';
        if (!analysisItems.length && root.querySelector('[data-boom-view-page="queue"]')?.classList.contains('is-active'))
            setView('works');
        elements.analysisList.innerHTML = analysisItems.length ? analysisItems.map((item) => queueItem(item)).join('') : '<p class="boom-empty">没有需要处理的项目。</p>';
    }
    function renderSettings(payload) {
        settings = payload.analysis_auto || { enabled: false, grades: ['T2', 'T3'] };
        const budget = payload.analysis_budget || {};
        budgetState = budget;
        elements.autoEnabled.checked = settings.enabled === true;
        const grades = new Set(Array.isArray(settings.grades) ? settings.grades : ['T2', 'T3']);
        for (const checkbox of root.querySelectorAll('input[name="boom-grade"]'))
            checkbox.checked = grades.has(checkbox.value);
        elements.dailyLimit.value = settings.daily_limit ?? budget.daily_limit ?? payload.daily_limit ?? 5;
        elements.budget.textContent = `今日已创建拆解 ${budget.dispatched_today ?? 0} 条 · 剩余 ${budget.remaining_today ?? Math.max(0, Number(elements.dailyLimit.value))} 条`;
    }
    async function loadSettings() {
        renderSettings(await api(`${API_ROOT}/settings`));
    }
    function renderCollectResult(payload) {
        const score = payload.score;
        elements.collectResult.hidden = false;
        elements.collectResult.innerHTML = score ? html `
      <div class="boom-result-head"><strong>${payload.message || '已完成采集和评分'}</strong>${raw(gradeBadge(score.grade))}</div>
      <p>${gradeReason(score.grade)}</p>
      <small>详细指标和样本依据已保留在最近作品的“查看判断依据”中。</small>` : html `<strong>${payload.message || '已完成采集。'}</strong>`;
    }
    async function parseImportInput() {
        const file = elements.importFile.files?.[0];
        const pasted = elements.importPayload.value.trim();
        if (!file && !pasted)
            throw new Error('请选择 JSON/CSV 文件，或粘贴 JSON。');
        if (file) {
            const text = await file.text();
            return file.name.toLowerCase().endsWith('.csv') ? parseBoomCsv(text) : JSON.parse(text);
        }
        return JSON.parse(pasted);
    }
    function bind() {
        elements.refresh.addEventListener('click', () => refreshAll().catch(showError));
        for (const tab of elements.tabs)
            tab.addEventListener('click', () => setView(tab.dataset.boomView));
        elements.workFilters.addEventListener('submit', (event) => {
            event.preventDefault();
            loadWorks().catch(showError);
        });
        elements.workList.addEventListener('click', (event) => {
            const detail = event.target.closest('[data-boom-detail]');
            if (detail)
                showWorkDetail(detail.dataset.boomDetail, detail).catch(showError);
            const dispatch = event.target.closest('[data-boom-dispatch-work]');
            if (dispatch)
                dispatchManually(dispatch.dataset.boomDispatchWork, dispatch).catch(showError);
            const approval = event.target.closest('[data-boom-approve]');
            if (approval)
                approveAndContinue(approval.dataset.boomApprove, approval).catch(showError);
        });
        elements.analysisList.addEventListener('click', (event) => {
            const dispatch = event.target.closest('[data-boom-dispatch-work]');
            if (dispatch)
                dispatchManually(dispatch.dataset.boomDispatchWork, dispatch).catch(showError);
            if (event.target.closest('[data-boom-focus-intake]')) {
                setView('works');
                elements.sourceUrl.focus();
                setMessage('请粘贴原始作品链接后重新判断。');
            }
            if (event.target.closest('[data-boom-open-settings]'))
                setView('settings');
        });
        elements.collectForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            elements.collectSubmit.disabled = true;
            elements.collectResult.hidden = true;
            setMessage('正在通过小D读取公开指标…');
            try {
                const payload = await api(`${API_ROOT}/collect/url`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ url: elements.sourceUrl.value.trim(), history_limit: 20 }),
                });
                renderCollectResult(payload);
                await Promise.all([loadOverview(), loadQueues()]);
                setMessage('判断完成，结果已加入最近作品。', 'ready');
            }
            catch (error) {
                elements.collectResult.hidden = false;
                elements.collectResult.textContent = error.message;
                showError(error);
            }
            finally {
                elements.collectSubmit.disabled = false;
            }
        });
        elements.scanRun.addEventListener('click', async () => {
            elements.scanRun.disabled = true;
            setMessage('正在把扫描任务加入队列…');
            try {
                await api(`${API_ROOT}/scan/run`, { method: 'POST' });
                setMessage('扫描任务已入队；后续派发按当前设置执行。', 'ready');
                await loadQueues();
            }
            catch (error) {
                showError(error);
            }
            finally {
                elements.scanRun.disabled = false;
            }
        });
        elements.queueRefresh.addEventListener('click', () => loadSettings().then(loadQueues).catch(showError));
        elements.importForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            elements.importSubmit.disabled = true;
            elements.importResult.hidden = true;
            try {
                const request = buildBoomImportRequest(await parseImportInput());
                const result = await api(`${API_ROOT}/import`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
                });
                elements.importResult.textContent = JSON.stringify(result, null, 2);
                elements.importResult.hidden = false;
                setMessage(`已导入 ${result.count ?? request.works.length} 条，等待扫描；后续派发按当前设置执行。`, 'ready');
                await Promise.all([loadOverview(), loadQueues()]);
            }
            catch (error) {
                elements.importResult.textContent = error instanceof SyntaxError ? 'JSON 格式不正确，请检查逗号和引号。' : error.message;
                elements.importResult.hidden = false;
                showError(error);
            }
            finally {
                elements.importSubmit.disabled = false;
            }
        });
        elements.settingsForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const enabled = elements.autoEnabled.checked;
            if (enabled && settings.enabled !== true && !window.confirm('启用后，命中所选等级的作品会在每日上限内自动交给小D和小拆。确定启用吗？')) {
                elements.autoEnabled.checked = false;
                return;
            }
            const grades = [...root.querySelectorAll('input[name="boom-grade"]:checked')].map((input) => input.value);
            if (!grades.length) {
                setMessage('至少选择一个自动派发等级。', 'error');
                return;
            }
            const dailyLimit = Math.max(0, Math.min(100, Number(elements.dailyLimit.value || 0)));
            const submit = element('#boom-settings-submit');
            submit.disabled = true;
            try {
                const payload = await api(`${API_ROOT}/settings`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        analysis_auto_enabled: enabled,
                        analysis_auto_grades: grades.join(','),
                        analysis_daily_limit: dailyLimit,
                        daily_limit: dailyLimit,
                    }),
                });
                renderSettings(payload);
                await loadQueues();
                setMessage(enabled ? '自动拆解设置已保存。' : '设置已保存，自动拆解保持关闭。', 'ready');
            }
            catch (error) {
                showError(error);
            }
            finally {
                submit.disabled = false;
            }
        });
    }
    async function refreshAll() {
        await loadSettings();
        await Promise.all([loadOverview(), loadQueues()]);
    }
    return {
        activate() {
            if (!initialized) {
                initialized = true;
                bind();
                refreshAll().catch(showError);
            }
        },
    };
}
function gradeReason(grade) {
    return {
        T3: '明显超过作者历史表现，触达规模和互动质量都达到完整拆解标准。',
        T2: '明显超过作者历史表现，已达到快速拆解标准。',
        T1: '表现高于作者历史水平，先作为候选观察。',
        N0: '暂未达到爆款拆解门槛。',
    }[grade] || '评分依据待确认。';
}
function platformLabel(platform) {
    return { douyin: '抖音', xiaohongshu: '小红书', bilibili: 'B站', youtube: 'YouTube', manual: '手动' }[platform] || platform || '未知平台';
}
function queueStatusLabel(status) {
    return { queued: '等待处理', submitted: '已受理', planning: '规划中', acquiring: '取证中', analyzing: '分析中', waiting_approval: '等待确认', needs_input: '需要处理', completed: '已完成', failed: '失败', dispatching: '正在创建任务', dispatch_failed: '任务创建失败', waiting_source: '等待来源', cancelled: '已关闭' }[status] || status || '未入队';
}
function workStatusLabel(status, autoHandlesWork, task = null) {
    if (task?.pendingApproval?.approvalId || ['pending_approval', 'waiting_approval'].includes(String(task?.status || '')))
        return ' · 等你确认';
    if (['succeeded', 'completed'].includes(String(task?.status || '')))
        return ' · 已完成';
    if (['failed', 'cancelled', 'rejected'].includes(String(task?.status || '')))
        return ' · 拆解未完成';
    return {
        queued: autoHandlesWork ? ' · 等待自动拆解' : ' · 等待手动拆解',
        submitted: ' · 已受理',
        planning: ' · 正在规划',
        acquiring: ' · 小D取证中',
        analyzing: ' · 小拆分析中',
        waiting_approval: ' · 等你确认',
        needs_input: ' · 需要处理',
        dispatching: ' · 正在创建任务',
        completed: ' · 已完成',
        failed: ' · 拆解失败',
        dispatch_failed: ' · 拆解失败',
        waiting_source: ' · 需要补充链接',
        cancelled: ' · 未拆解',
    }[status] || '';
}
function queueProblemSummary(status) {
    return {
        waiting_source: '缺少可核验作品链接，暂时不能让小D取证。',
        dispatch_failed: '交给拆解流程失败，作品仍安全保留。',
        failed: '拆解启动失败，作品仍安全保留。',
        waiting_approval: '拆解任务正在等待你的确认，确认前不会继续。',
        needs_input: '拆解任务已停止等待处理，不会继续伪装成运行中。',
        queued: '今日自动拆解额度已用完。',
    }[status] || '这条作品需要人工确认。';
}
function ratioText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} 倍` : '-';
}
function percentText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : '-';
}
function formatCompact(value) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return '-';
    if (number >= 100000000)
        return `${(number / 100000000).toFixed(1)} 亿`;
    if (number >= 10000)
        return `${(number / 10000).toFixed(1)} 万`;
    return String(number);
}
const boomMetricIcons = {
    trend: '<path d="M2 12l4-4 3 3 5-6"/><path d="M10 5h4v4"/>',
    heart: '<path d="M8 13.4S2.6 10 2.6 6.2A2.9 2.9 0 0 1 8 4.7a2.9 2.9 0 0 1 5.4 1.5c0 3.8-5.4 7.2-5.4 7.2z"/>',
    thumb: '<path d="M5 7.2 7 2.9a1.3 1.3 0 0 1 1.6 1.3V6h3.4a1.6 1.6 0 0 1 1.6 2l-.9 3.9a1.6 1.6 0 0 1-1.6 1.3H5z"/><path d="M5 7.2H2.6V13H5"/>',
    samples: '<path d="M8 2.2 13.6 5 8 7.8 2.4 5z"/><path d="m2.4 8.2 5.6 2.8 5.6-2.8"/><path d="m2.4 11 5.6 2.8 5.6-2.8"/>',
    spark: '<path d="M8 1.8 9.5 6 13.8 7.5 9.5 9 8 13.2 6.5 9 2.2 7.5 6.5 6z"/>',
};
function metricChip({ icon, value, label, title, fill, pass }) {
    const percent = Math.round(Math.max(0, Math.min(1, Number(fill) || 0)) * 100);
    return `<span class="boom-metric${pass ? ' is-pass' : ''}" title="${escapeHtml(title)}">`
        + `<svg class="boom-metric-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${boomMetricIcons[icon] || ''}</svg>`
        + `<span class="boom-metric-copy"><b>${escapeHtml(value)}</b><small>${escapeHtml(label)}</small></span>`
        + `<i class="boom-metric-fill" style="width:${percent}%"></i></span>`;
}
// 与后端 boom-monitor/scoring.ts 的门槛保持一致：互动率门槛随粉丝量级递减，量级门槛按平台区分。
const BOOM_M_THRESHOLDS = { high: 0.04, mid: 0.08, mid_small: 0.15, low: 0.3 };
const BOOM_VOLUME_FLOORS = { xiaohongshu: { T1: 100, T2: 500, T3: 5000 }, default: { T1: 500, T2: 3000, T3: 10000 } };
const BOOM_QUALITY_REASON_LABELS = {
    favorite_rate_floor: '藏率高', favorite_rate_vs_history: '藏超历史',
    share_rate_floor: '转发高', share_rate_vs_history: '转发超历史',
    comment_rate_floor: '评论高', comment_rate_vs_history: '评论超历史',
};
function boomMThreshold(tier) {
    return Number(BOOM_M_THRESHOLDS[String(tier || '')] ?? BOOM_M_THRESHOLDS.mid);
}
function boomVolumeFloors(platform) {
    return BOOM_VOLUME_FLOORS[String(platform || '')] || BOOM_VOLUME_FLOORS.default;
}
function boomVolumeFloor(platform) {
    return boomVolumeFloors(platform).T1;
}
function gateMark(passed) {
    return `<span class="boom-gate-mark${passed ? ' is-pass' : ''}" aria-label="${passed ? '达标' : '未达标'}">${passed ? '✓' : '✗'}</span>`;
}
function gateRows(score) {
    const signals = score.signals || {};
    const relative = signals.relative || {};
    const reach = signals.reach || {};
    const quality = signals.quality || {};
    const sampleCount = Number(score.sample_count || 0);
    const insufficient = String(score.status || '') === 'insufficient_history';
    const relativePassed = relative.passed === true;
    const mValue = Number(reach.m_value ?? score.m_value);
    const mThreshold = Number(reach.m_threshold ?? boomMThreshold(score.tier));
    const floors = reach.absolute_floors || boomVolumeFloors('');
    const volume = Number(score.absolute_interactions || 0);
    const volumePassed = volume >= Number(floors.T1);
    const reachPassed = Number.isFinite(mValue) && mValue >= mThreshold;
    const qualityPassed = quality.passed === true;
    const reasonChips = (quality.reasons || []).map((reason) => `<span class="boom-quality-chip">${escapeHtml(BOOM_QUALITY_REASON_LABELS[reason] || reason)}</span>`).join('');
    const gateRow = (icon, label, gate, value, passed, extra = '') => `<div class="boom-gate-row${passed ? ' is-pass' : ''}">`
        + `<svg class="boom-metric-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${boomMetricIcons[icon] || ''}</svg>`
        + `<span class="boom-gate-label">${escapeHtml(label)}</span>`
        + `<span class="boom-gate-gate">${escapeHtml(gate)}</span>`
        + `<span class="boom-gate-value">${escapeHtml(value)}</span>`
        + `${extra}${gateMark(passed)}</div>`;
    return `<div class="boom-gate-list">`
        + gateRow('trend', '相对表现', '≥2×', ratioText(score.r_value), relativePassed)
        + gateRow('heart', '触达粉丝', `≥${(mThreshold * 100).toFixed(0)}%`, percentText(score.m_value), reachPassed)
        + gateRow('thumb', '绝对量级', `≥${formatCompact(floors.T1)}`, formatCompact(volume), volumePassed)
        + gateRow('spark', '质量信号', '任一突出', reasonChips ? '' : '—', qualityPassed, reasonChips)
        + `</div>`
        + `<p class="boom-gate-meta">`
        + `<span title="判断可信度：历史样本数"><b>${sampleCount}</b>/5 样本</span>`
        + `<span title="历史作品中位数">中位 ${formatCompact(score.baseline_metric)}</span>`
        + `<span title="评分时粉丝快照">粉丝 ${formatCompact(score.follower_snapshot)}</span>`
        + `</p>`
        + (insufficient ? '<p class="boom-gate-note">历史样本不足，暂只能按累计表现判断。</p>' : '')
        + (score.grade_cap === 'T1' ? '<p class="boom-gate-note">绝对量级未到更高档，等级封顶 T1。</p>' : '');
}
