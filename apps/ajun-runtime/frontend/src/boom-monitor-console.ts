const API_ROOT: any = '/api/boom-monitor';
const numericCsvFields: any = new Set([
    'follower_count', 'likes', 'favorites', 'shares', 'comments', 'plays', 'views', 'history_limit'
]);
export function parseBoomCsv(source: any): any {
    const rows: any = [];
    let row: any = [];
    let value: any = '';
    let quoted: any = false;
    const text: any = String(source || '').replace(/^\uFEFF/, '');
    for (let index: any = 0; index < text.length; index += 1) {
        const char: any = text[index];
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
    const headers: any = rows[0].map((header: any): any => header.trim());
    if (!headers.includes('work_id'))
        throw new Error('CSV 表头必须包含 work_id。');
    return rows.slice(1).map((cells: any): any => Object.fromEntries(headers.map((header: any, index: any): any => {
        const cell: any = cells[index] ?? '';
        return [header, numericCsvFields.has(header) && cell !== '' ? Number(cell) : cell];
    })));
}
export function buildBoomImportRequest(value: any): any {
    if (Array.isArray(value))
        return { source_type: 'manual', works: value };
    if (!value || typeof value !== 'object')
        throw new Error('导入内容必须是 JSON 对象或数组。');
    const works: any = Array.isArray(value.works) ? value.works : [value];
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
export function createBoomMonitorConsole({ root, api, escapeHtml, formatDate }: any): any {
    const element: any = (selector: any): any => root.querySelector(selector);
    const elements: any = {
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
    let initialized: any = false;
    let loading: any = false;
    let settings: any = { enabled: false, grades: ['T2', 'T3'] };
    let budgetState: any = { daily_limit: 5, dispatched_today: 0, remaining_today: 5 };
    function setMessage(message: any, tone: any = ''): any {
        elements.message.textContent = message;
        elements.message.dataset.tone = tone;
        elements.message.hidden = !message;
    }
    function setView(name: any): any {
        for (const tab of elements.tabs) {
            const active: any = tab.dataset.boomView === name;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-pressed', String(active));
        }
        for (const page of elements.pages) {
            const active: any = page.dataset.boomViewPage === name;
            page.classList.toggle('is-active', active);
            page.hidden = !active;
        }
        if (name === 'queue')
            loadQueues().catch(showError);
        if (name === 'settings')
            loadSettings().catch(showError);
    }
    function showError(error: any): any {
        setMessage(error.message || '雷达请求失败。', 'error');
    }
    function renderDashboard(dashboard: any, health: any): any {
        const totals: any = dashboard?.totals || {};
        const boom: any = dashboard?.boom || {};
        const waiting: any = Number(dashboard?.scan_jobs || 0);
        const unhealthy: any = health?.ok !== true;
        const items: any[] = [
            `${Number(totals.works || 0)} 条作品`,
            `T3 ${Number(boom.T3 || 0)}`,
            `T2 ${Number(boom.T2 || 0)}`,
            ...(waiting ? [`${waiting} 条等待评分`] : []),
        ];
        elements.stats.hidden = false;
        elements.stats.classList.toggle('is-warning', unhealthy);
        elements.stats.innerHTML = `${unhealthy ? '<strong>雷达状态待确认</strong>' : ''}<span>${escapeHtml(items.join(' · '))}</span>`;
    }
    async function loadOverview(): Promise<any> {
        if (loading)
            return;
        loading = true;
        elements.refresh.disabled = true;
        setMessage('正在读取爆款雷达…');
        try {
            const [health, dashboard]: any = await Promise.all([
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
    function gradeBadge(grade: any): any {
        const normalized: any = ['T1', 'T2', 'T3'].includes(grade) ? grade : 'N0';
        return `<span class="boom-grade ${normalized.toLowerCase()}">${escapeHtml(normalized)}</span>`;
    }
    function renderWorks(works: any, taskProgress: Map<string, any> = new Map()): any {
        if (!works.length) {
            elements.workList.innerHTML = '<p class="boom-empty">还没有符合条件的作品。</p>';
            return;
        }
        const autoGrades: any = new Set(Array.isArray(settings.grades) ? settings.grades : ['T2', 'T3']);
        elements.workList.innerHTML = works.map((work: any): any => {
            const analysisStatus: any = String(work.analysis_status || '');
            const autoHandlesWork: any = settings.enabled === true && autoGrades.has(work.grade);
            const canDispatch: any = ['T1', 'T2', 'T3'].includes(work.grade)
                && (!analysisStatus || analysisStatus === 'cancelled' || (analysisStatus === 'queued' && !autoHandlesWork));
            const workTitle: any = work.title || work.work_id || `作品 ${work.id}`;
            const detailId: any = `boom-score-detail-${work.id}`;
            const taskId: any = String(work.army_task_id || '');
            const task: any = taskId ? taskProgress.get(taskId) : null;
            const pendingApprovalId: any = String(task?.pendingApproval?.approvalId || '');
            const status: any = workStatusLabel(analysisStatus, autoHandlesWork, task);
            const progressAction: any = pendingApprovalId
                ? `<button type="button" data-boom-approve="${escapeHtml(pendingApprovalId)}">确认并继续</button>`
                : taskId
                    ? `<a class="boom-task-link" href="/tasks/${encodeURIComponent(taskId)}">查看拆解进度</a>`
                    : '';
            return `
      <article class="boom-list-item">
        <div class="boom-item-head">
          <span class="boom-item-copy"><strong>${escapeHtml(workTitle)}</strong><small>${escapeHtml(platformLabel(work.platform))} · ${escapeHtml(formatDate(work.publish_at))}${escapeHtml(status)}</small></span>
          ${gradeBadge(work.grade)}
        </div>
        <p class="boom-item-reason">${escapeHtml(gradeReason(work.grade))}</p>
        <div class="boom-item-actions">
          <button type="button" class="secondary-action" data-boom-detail="${work.id}" aria-label="查看“${escapeHtml(workTitle)}”的判断依据" aria-controls="${detailId}" aria-expanded="false">查看判断依据</button>
          ${canDispatch ? `<button type="button" data-boom-dispatch-work="${work.id}" aria-label="开始拆解“${escapeHtml(workTitle)}”">开始拆解</button>` : progressAction}
        </div>
        <div id="${detailId}" class="boom-score-detail" data-boom-detail-output="${work.id}" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      </article>`;
        }).join('');
    }
    async function showWorkDetail(workId: any, triggerButton: any): Promise<any> {
        const output: any = elements.workList.querySelector(`[data-boom-detail-output="${workId}"]`);
        if (!output)
            return;
        output.hidden = false;
        output.classList.remove('is-error');
        output.textContent = '正在读取判断依据…';
        triggerButton?.setAttribute('aria-expanded', 'true');
        try {
            const payload: any = await api(`${API_ROOT}/works/${workId}`);
            const official: any = payload.score_details;
            const sampleCount: any = Number(official?.sample_count || 0);
            output.innerHTML = `
        <strong>判断依据</strong>
        <p>当前等级：${official ? gradeBadge(official.grade) : '暂无'}</p>
        <p>判断可信度：${official ? (sampleCount >= 5 ? `已有 ${sampleCount} 条历史样本支撑` : `历史样本不足（${sampleCount}/5）`) : '暂无'}</p>
        <p>相对历史表现：${official ? `${ratioText(official.r_value)}（当前核心互动 ÷ 作者历史作品中位数）` : '暂无'}</p>
        <p>粉丝互动率：${official ? `${percentText(official.m_value)}（点赞数 ÷ 粉丝数）` : '暂无'}</p>
        <small>缺少发布时间时只表示累计表现，不表示作品正在爆发。</small>`;
        }
        catch (error: any) {
            output.classList.add('is-error');
            output.textContent = `判断依据读取失败：${error.message}`;
            throw error;
        }
    }
    async function dispatchManually(workId: any = null, triggerButton: any = null): Promise<any> {
        if (triggerButton?.disabled)
            return;
        const scope: any = workId ? '这条作品' : '当前待处理项';
        if (!window.confirm(`确定开始${scope}的拆解吗？系统会先由小D取证，再由小拆分析，不会直接发布内容。`))
            return;
        const originalLabel: any = triggerButton?.textContent;
        if (triggerButton) {
            triggerButton.disabled = true;
            triggerButton.textContent = '正在交给军团…';
        }
        try {
            if (workId)
                await api(`${API_ROOT}/analysis/queue/${workId}`, { method: 'POST' });
            const result: any = await api(`${API_ROOT}/analysis/run`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ manual: true, ...(workId ? { work_id: Number(workId) } : {}) }),
            });
            const message: any = result.status === 'daily_limit'
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
    async function loadWorks(): Promise<any> {
        elements.workList.innerHTML = '<p class="boom-empty">正在读取作品…</p>';
        const query: any = new URLSearchParams();
        if (elements.filterGrade.value)
            query.set('grade', elements.filterGrade.value);
        if (elements.filterPlatform.value)
            query.set('platform', elements.filterPlatform.value);
        if (elements.filterCreator.value.trim())
            query.set('creator_id', elements.filterCreator.value.trim());
        const payload: any = await api(`${API_ROOT}/works?${query}`);
        const works: any[] = payload.works || [];
        const taskIds: any[] = [...new Set(works.map((work: any): any => String(work.army_task_id || '')).filter(Boolean))];
        const taskEntries: any[] = await Promise.all(taskIds.map(async (taskId: any): Promise<any> => {
            try {
                const detail: any = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
                return [taskId, detail.task || detail];
            }
            catch {
                return [taskId, null];
            }
        }));
        renderWorks(works, new Map(taskEntries));
    }
    async function approveAndContinue(approvalId: any, triggerButton: any): Promise<any> {
        if (triggerButton?.disabled)
            return;
        if (!window.confirm('确认继续这条拆解吗？这里只会取证和分析，不会自动发布内容。'))
            return;
        const originalLabel: any = triggerButton.textContent;
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
    function queueItem(item: any): any {
        const title: any = item.title || item.work_id || `作品 ${item.work_id || item.id}`;
        const workId: any = item.work_id;
        const status: any = String(item.status || '');
        const summary: any = queueProblemSummary(status);
        const failure: any = item.dispatch_error || item.error_message;
        const taskId: any = String(item.army_task_id || '');
        const action: any = status === 'waiting_source'
            ? '<button type="button" class="secondary-action" data-boom-focus-intake>补充链接</button>'
            : taskId && ['waiting_approval', 'needs_input', 'failed'].includes(status)
                ? `<a class="boom-task-link" href="/tasks/${encodeURIComponent(taskId)}">查看并处理</a>`
            : status === 'queued' && Number(budgetState.remaining_today) <= 0
                ? '<button type="button" class="secondary-action" data-boom-open-settings>调整今日上限</button>'
                : workId
                    ? `<button type="button" data-boom-dispatch-work="${escapeHtml(workId)}">重试</button>`
                    : '';
        return `<article class="boom-queue-item"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(summary)}</span>${taskId ? `<small>任务编号 ${escapeHtml(taskId)}</small>` : ''}<div class="boom-item-actions">${action}</div>${failure ? `<details class="boom-technical-detail"><summary>查看技术原因</summary><small class="is-error">${escapeHtml(failure)}</small></details>` : ''}</article>`;
    }
    function actionableAnalysisItems(items: any[]): any[] {
        return items.filter((item: any): any => {
            const status: any = String(item.status || '');
            if (['waiting_source', 'dispatch_failed', 'waiting_approval', 'needs_input', 'failed'].includes(status))
                return true;
            return status === 'queued' && settings.enabled === true && Number(budgetState.remaining_today) <= 0;
        });
    }
    async function loadQueues(): Promise<any> {
        const analysis: any = await api(`${API_ROOT}/analysis`);
        const analysisItems: any[] = actionableAnalysisItems(analysis.items || []);
        elements.queueTab.hidden = analysisItems.length === 0;
        elements.queueTab.textContent = analysisItems.length ? `需要处理 ${analysisItems.length}` : '需要处理';
        if (!analysisItems.length && root.querySelector('[data-boom-view-page="queue"]')?.classList.contains('is-active'))
            setView('works');
        elements.analysisList.innerHTML = analysisItems.length ? analysisItems.map((item: any): any => queueItem(item)).join('') : '<p class="boom-empty">没有需要处理的项目。</p>';
    }
    function renderSettings(payload: any): any {
        settings = payload.analysis_auto || { enabled: false, grades: ['T2', 'T3'] };
        const budget: any = payload.analysis_budget || {};
        budgetState = budget;
        elements.autoEnabled.checked = settings.enabled === true;
        const grades: any = new Set(Array.isArray(settings.grades) ? settings.grades : ['T2', 'T3']);
        for (const checkbox of root.querySelectorAll('input[name="boom-grade"]'))
            checkbox.checked = grades.has(checkbox.value);
        elements.dailyLimit.value = settings.daily_limit ?? budget.daily_limit ?? payload.daily_limit ?? 5;
        elements.budget.textContent = `今日已创建拆解 ${budget.dispatched_today ?? 0} 条 · 剩余 ${budget.remaining_today ?? Math.max(0, Number(elements.dailyLimit.value))} 条`;
    }
    async function loadSettings(): Promise<any> {
        renderSettings(await api(`${API_ROOT}/settings`));
    }
    function renderCollectResult(payload: any): any {
        const score: any = payload.score;
        elements.collectResult.hidden = false;
        elements.collectResult.innerHTML = score ? `
      <div class="boom-result-head"><strong>${escapeHtml(payload.message || '已完成采集和评分')}</strong>${gradeBadge(score.grade)}</div>
      <p>${escapeHtml(gradeReason(score.grade))}</p>
      <small>详细指标和样本依据已保留在最近作品的“查看判断依据”中。</small>` : `<strong>${escapeHtml(payload.message || '已完成采集。')}</strong>`;
    }
    async function parseImportInput(): Promise<any> {
        const file: any = elements.importFile.files?.[0];
        const pasted: any = elements.importPayload.value.trim();
        if (!file && !pasted)
            throw new Error('请选择 JSON/CSV 文件，或粘贴 JSON。');
        if (file) {
            const text: any = await file.text();
            return file.name.toLowerCase().endsWith('.csv') ? parseBoomCsv(text) : JSON.parse(text);
        }
        return JSON.parse(pasted);
    }
    function bind(): any {
        elements.refresh.addEventListener('click', (): any => refreshAll().catch(showError));
        for (const tab of elements.tabs)
            tab.addEventListener('click', (): any => setView(tab.dataset.boomView));
        elements.workFilters.addEventListener('submit', (event: any): any => {
            event.preventDefault();
            loadWorks().catch(showError);
        });
        elements.workList.addEventListener('click', (event: any): any => {
            const detail: any = event.target.closest('[data-boom-detail]');
            if (detail)
                showWorkDetail(detail.dataset.boomDetail, detail).catch(showError);
            const dispatch: any = event.target.closest('[data-boom-dispatch-work]');
            if (dispatch)
                dispatchManually(dispatch.dataset.boomDispatchWork, dispatch).catch(showError);
            const approval: any = event.target.closest('[data-boom-approve]');
            if (approval)
                approveAndContinue(approval.dataset.boomApprove, approval).catch(showError);
        });
        elements.analysisList.addEventListener('click', (event: any): any => {
            const dispatch: any = event.target.closest('[data-boom-dispatch-work]');
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
        elements.collectForm.addEventListener('submit', async (event: any): Promise<any> => {
            event.preventDefault();
            elements.collectSubmit.disabled = true;
            elements.collectResult.hidden = true;
            setMessage('正在通过小D读取公开指标…');
            try {
                const payload: any = await api(`${API_ROOT}/collect/url`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ url: elements.sourceUrl.value.trim(), history_limit: 20 }),
                });
                renderCollectResult(payload);
                await Promise.all([loadOverview(), loadQueues()]);
                setMessage('判断完成，结果已加入最近作品。', 'ready');
            }
            catch (error: any) {
                elements.collectResult.hidden = false;
                elements.collectResult.textContent = error.message;
                showError(error);
            }
            finally {
                elements.collectSubmit.disabled = false;
            }
        });
        elements.scanRun.addEventListener('click', async (): Promise<any> => {
            elements.scanRun.disabled = true;
            setMessage('正在把扫描任务加入队列…');
            try {
                await api(`${API_ROOT}/scan/run`, { method: 'POST' });
                setMessage('扫描任务已入队；后续派发按当前设置执行。', 'ready');
                await loadQueues();
            }
            catch (error: any) {
                showError(error);
            }
            finally {
                elements.scanRun.disabled = false;
            }
        });
        elements.queueRefresh.addEventListener('click', (): any => loadSettings().then(loadQueues).catch(showError));
        elements.importForm.addEventListener('submit', async (event: any): Promise<any> => {
            event.preventDefault();
            elements.importSubmit.disabled = true;
            elements.importResult.hidden = true;
            try {
                const request: any = buildBoomImportRequest(await parseImportInput());
                const result: any = await api(`${API_ROOT}/import`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
                });
                elements.importResult.textContent = JSON.stringify(result, null, 2);
                elements.importResult.hidden = false;
                setMessage(`已导入 ${result.count ?? request.works.length} 条，等待扫描；后续派发按当前设置执行。`, 'ready');
                await Promise.all([loadOverview(), loadQueues()]);
            }
            catch (error: any) {
                elements.importResult.textContent = error instanceof SyntaxError ? 'JSON 格式不正确，请检查逗号和引号。' : error.message;
                elements.importResult.hidden = false;
                showError(error);
            }
            finally {
                elements.importSubmit.disabled = false;
            }
        });
        elements.settingsForm.addEventListener('submit', async (event: any): Promise<any> => {
            event.preventDefault();
            const enabled: any = elements.autoEnabled.checked;
            if (enabled && settings.enabled !== true && !window.confirm('启用后，命中所选等级的作品会在每日上限内自动交给小D和小拆。确定启用吗？')) {
                elements.autoEnabled.checked = false;
                return;
            }
            const grades: any = [...root.querySelectorAll('input[name="boom-grade"]:checked')].map((input: any): any => input.value);
            if (!grades.length) {
                setMessage('至少选择一个自动派发等级。', 'error');
                return;
            }
            const dailyLimit: any = Math.max(0, Math.min(100, Number(elements.dailyLimit.value || 0)));
            const submit: any = element('#boom-settings-submit');
            submit.disabled = true;
            try {
                const payload: any = await api(`${API_ROOT}/settings`, {
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
            catch (error: any) {
                showError(error);
            }
            finally {
                submit.disabled = false;
            }
        });
    }
    async function refreshAll(): Promise<any> {
        await loadSettings();
        await Promise.all([loadOverview(), loadQueues()]);
    }
    return {
        activate(): any {
            if (!initialized) {
                initialized = true;
                bind();
                refreshAll().catch(showError);
            }
        },
    };
}
function gradeReason(grade: any): any {
    return ({
        T3: '明显超过作者历史表现，触达规模和互动质量都达到完整拆解标准。',
        T2: '明显超过作者历史表现，已达到快速拆解标准。',
        T1: '表现高于作者历史水平，先作为候选观察。',
        N0: '暂未达到爆款拆解门槛。',
    } as Record<string, string>)[grade] || '评分依据待确认。';
}
function platformLabel(platform: any): any {
    return ({ douyin: '抖音', xiaohongshu: '小红书', bilibili: 'B站', youtube: 'YouTube', manual: '手动' } as Record<string, string>)[platform] || platform || '未知平台';
}
function queueStatusLabel(status: any): any {
    return ({ queued: '等待处理', submitted: '已受理', planning: '规划中', acquiring: '取证中', analyzing: '分析中', waiting_approval: '等待确认', needs_input: '需要处理', completed: '已完成', failed: '失败', dispatching: '正在创建任务', dispatch_failed: '任务创建失败', waiting_source: '等待来源', cancelled: '已关闭' } as Record<string, string>)[status] || status || '未入队';
}
function workStatusLabel(status: any, autoHandlesWork: any, task: any = null): any {
    if (task?.pendingApproval?.approvalId || ['pending_approval', 'waiting_approval'].includes(String(task?.status || '')))
        return ' · 等你确认';
    if (['succeeded', 'completed'].includes(String(task?.status || '')))
        return ' · 已完成';
    if (['failed', 'cancelled', 'rejected'].includes(String(task?.status || '')))
        return ' · 拆解未完成';
    return ({
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
    } as Record<string, string>)[status] || '';
}
function queueProblemSummary(status: any): any {
    return ({
        waiting_source: '缺少可核验作品链接，暂时不能让小D取证。',
        dispatch_failed: '交给拆解流程失败，作品仍安全保留。',
        failed: '拆解启动失败，作品仍安全保留。',
        waiting_approval: '拆解任务正在等待你的确认，确认前不会继续。',
        needs_input: '拆解任务已停止等待处理，不会继续伪装成运行中。',
        queued: '今日自动拆解额度已用完。',
    } as Record<string, string>)[status] || '这条作品需要人工确认。';
}
function ratioText(value: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} 倍` : '-';
}
function percentText(value: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : '-';
}
