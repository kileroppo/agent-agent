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
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value.trim());
      value = '';
    } else if (char === '\n') {
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') value += char;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error('CSV 中有未闭合的引号。');
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一条作品记录。');

  const headers = rows[0].map((header) => header.trim());
  if (!headers.includes('work_id')) throw new Error('CSV 表头必须包含 work_id。');
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => {
    const cell = cells[index] ?? '';
    return [header, numericCsvFields.has(header) && cell !== '' ? Number(cell) : cell];
  })));
}

export function buildBoomImportRequest(value) {
  if (Array.isArray(value)) return { source_type:'manual', works:value };
  if (!value || typeof value !== 'object') throw new Error('导入内容必须是 JSON 对象或数组。');
  const works = Array.isArray(value.works) ? value.works : [value];
  if (!works.length) throw new Error('导入内容没有作品记录。');
  return {
    source_type:'manual',
    platform:value.platform || works[0]?.platform || 'douyin',
    creator:value.creator || value.creator_id || '',
    creator_name:value.creator_name || '',
    follower_count:Number(value.follower_count || 0),
    works,
  };
}

export function createBoomMonitorConsole({ root, api, escapeHtml, formatDate }) {
  const element = (selector) => root.querySelector(selector);
  const elements = {
    refresh:element('#boom-refresh'),
    message:element('#boom-message'),
    stats:element('#boom-stats'),
    collectForm:element('#boom-collect-form'),
    sourceUrl:element('#boom-source-url'),
    collectSubmit:element('#boom-collect-submit'),
    collectResult:element('#boom-collect-result'),
    tabs:[...root.querySelectorAll('[data-boom-view]')],
    pages:[...root.querySelectorAll('[data-boom-view-page]')],
    workFilters:element('#boom-work-filters'),
    filterGrade:element('#boom-filter-grade'),
    filterPlatform:element('#boom-filter-platform'),
    filterCreator:element('#boom-filter-creator'),
    workList:element('#boom-work-list'),
    scanRun:element('#boom-scan-run'),
    queueRefresh:element('#boom-queue-refresh'),
    dispatchRun:element('#boom-dispatch-run'),
    scanList:element('#boom-scan-list'),
    analysisList:element('#boom-analysis-list'),
    importForm:element('#boom-import-form'),
    importFile:element('#boom-import-file'),
    importPayload:element('#boom-import-payload'),
    importSubmit:element('#boom-import-submit'),
    importResult:element('#boom-import-result'),
    settingsForm:element('#boom-settings-form'),
    autoEnabled:element('#boom-auto-enabled'),
    dailyLimit:element('#boom-daily-limit'),
    budget:element('#boom-budget'),
  };
  let initialized = false;
  let loading = false;
  let settings = { enabled:false, grades:['T2', 'T3'] };

  function setMessage(message, tone = '') {
    elements.message.textContent = message;
    elements.message.dataset.tone = tone;
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
    if (name === 'queue') loadQueues().catch(showError);
    if (name === 'settings') loadSettings().catch(showError);
  }

  function showError(error) {
    setMessage(error.message || '雷达请求失败。', 'error');
  }

  function statCard(label, value, note, tone = '') {
    return `<article class="boom-stat-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
  }

  function renderDashboard(dashboard, health) {
    const totals = dashboard?.totals || {};
    const boom = dashboard?.boom || {};
    elements.stats.innerHTML = [
      statCard('雷达服务', health?.ok ? '正常' : '待确认', health?.ok ? '已并入 A君入口' : '暂未取得健康状态', health?.ok ? 'ready' : 'warning'),
      statCard('作品', totals.works || 0, `${totals.creators || 0} 位创作者`),
      statCard('T3', boom.T3 || 0, '优先完整拆解', Number(boom.T3) ? 'attention' : ''),
      statCard('T2', boom.T2 || 0, '建议快速拆解'),
      statCard('待扫描', dashboard?.scan_jobs || 0, '等待评分的任务'),
    ].join('');
  }

  async function loadOverview() {
    if (loading) return;
    loading = true;
    elements.refresh.disabled = true;
    setMessage('正在读取爆款雷达…');
    try {
      const [health, dashboard] = await Promise.all([
        api(`${API_ROOT}/health`),
        api(`${API_ROOT}/dashboard`),
      ]);
      renderDashboard(dashboard, health);
      setMessage(`雷达已同步 · ${new Date().toLocaleTimeString()}`, 'ready');
      await loadWorks();
    } finally {
      loading = false;
      elements.refresh.disabled = false;
    }
  }

  function gradeBadge(grade) {
    const normalized = ['T1', 'T2', 'T3'].includes(grade) ? grade : 'N0';
    return `<span class="boom-grade ${normalized.toLowerCase()}">${escapeHtml(normalized)}</span>`;
  }

  function renderWorks(works) {
    if (!works.length) {
      elements.workList.innerHTML = '<p class="boom-empty">还没有符合条件的作品。</p>';
      return;
    }
    elements.workList.innerHTML = works.map((work) => {
      const canDispatch = ['T1', 'T2', 'T3'].includes(work.grade) && !['dispatched', 'dispatching'].includes(work.analysis_status);
      const workTitle = work.title || work.work_id || `作品 ${work.id}`;
      const detailId = `boom-score-detail-${work.id}`;
      return `
      <details class="boom-list-item">
        <summary>
          <span class="boom-item-copy"><strong>${escapeHtml(workTitle)}</strong><small>${escapeHtml(platformLabel(work.platform))} · ${escapeHtml(formatDate(work.publish_at))}</small></span>
          ${gradeBadge(work.grade)}
          <svg class="chevron" aria-hidden="true"><use href="#icon-chevron"></use></svg>
        </summary>
        <dl class="boom-facts">
          <div><dt>R 相对表现</dt><dd>${numberText(work.r_value, 2)}</dd></div>
          <div><dt>M 触达效率</dt><dd>${numberText(work.m_value, 4)}</dd></div>
          <div><dt>历史基线</dt><dd>${escapeHtml(work.baseline_metric ?? '待确认')}</dd></div>
          <div><dt>派发状态</dt><dd>${escapeHtml(queueStatusLabel(work.analysis_status))}</dd></div>
        </dl>
        <div class="boom-item-actions">
          <button type="button" class="secondary-action" data-boom-detail="${work.id}" aria-label="查看“${escapeHtml(workTitle)}”的评分依据" aria-controls="${detailId}" aria-expanded="false">查看评分依据</button>
          ${canDispatch ? `<button type="button" data-boom-dispatch-work="${work.id}" aria-label="把“${escapeHtml(workTitle)}”交给小D和小拆">交给小D和小拆</button>` : ''}
        </div>
        <div id="${detailId}" class="boom-score-detail" data-boom-detail-output="${work.id}" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      </details>`;
    }).join('');
  }

  async function showWorkDetail(workId, triggerButton) {
    const output = elements.workList.querySelector(`[data-boom-detail-output="${workId}"]`);
    if (!output) return;
    output.hidden = false;
    output.classList.remove('is-error');
    output.textContent = '正在读取评分依据…';
    triggerButton?.setAttribute('aria-expanded', 'true');
    try {
      const payload = await api(`${API_ROOT}/works/${workId}`);
      const official = payload.score_details;
      const legacy = payload.legacy_score;
      output.innerHTML = `
        <strong>评分依据</strong>
        <p>正式 v2：${official ? `${gradeBadge(official.grade)} · R ${numberText(official.r_value, 4)} · M ${numberText(official.m_value, 4)}` : '暂无'}</p>
        <p>旧 v1 对照：${legacy ? `${gradeBadge(legacy.grade)} · 仅供回滚，不控制派发` : '暂无'}</p>
        <small>缺少发布时间时只表示累计表现，不表示作品正在爆发。</small>`;
    } catch (error) {
      output.classList.add('is-error');
      output.textContent = `评分依据读取失败：${error.message}`;
      throw error;
    }
  }

  async function dispatchManually(workId = null, triggerButton = null) {
    if (triggerButton?.disabled) return;
    const scope = workId ? '这条作品' : '当前待派发项';
    if (!window.confirm(`确定把${scope}交给小D和小拆吗？不会直接发布内容。`)) return;
    const originalLabel = triggerButton?.textContent;
    if (triggerButton) {
      triggerButton.disabled = true;
      triggerButton.textContent = '正在交给军团…';
    }
    try {
      if (workId) await api(`${API_ROOT}/analysis/queue/${workId}`, { method:'POST' });
      const result = await api(`${API_ROOT}/analysis/run`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ manual:true, ...(workId ? { work_id:Number(workId) } : {}) }),
      });
      const message = result.status === 'daily_limit'
        ? '今日派发已达到上限。'
        : result.status === 'idle'
          ? '当前没有待派发作品。'
          : result.status === 'external_dispatch_disabled'
            ? '军团任务入口未就绪，作品仍保留在队列。'
            : `本次处理 ${result.processed ?? 0} 条。`;
      setMessage(message, result.status === 'ok' ? 'ready' : '');
      await Promise.all([loadWorks(), loadQueues(), loadSettings()]);
    } finally {
      if (triggerButton?.isConnected) {
        triggerButton.disabled = false;
        triggerButton.textContent = originalLabel;
      }
    }
  }

  async function loadWorks() {
    elements.workList.innerHTML = '<p class="boom-empty">正在读取作品…</p>';
    const query = new URLSearchParams();
    if (elements.filterGrade.value) query.set('grade', elements.filterGrade.value);
    if (elements.filterPlatform.value) query.set('platform', elements.filterPlatform.value);
    if (elements.filterCreator.value.trim()) query.set('creator_id', elements.filterCreator.value.trim());
    const payload = await api(`${API_ROOT}/works?${query}`);
    renderWorks(payload.works || []);
  }

  function queueItem(item, kind) {
    const title = kind === 'scan'
      ? `${platformLabel(item.creator_ref || item.source_type)} 扫描`
      : item.title || item.work_id || `作品 ${item.work_id || item.id}`;
    const meta = kind === 'scan'
      ? `${queueStatusLabel(item.status)} · ${formatDate(item.created_at)}`
      : `${item.tier || 'N0'} · ${item.analysis_depth === 'full' ? '完整拆解' : '快速拆解'} · ${queueStatusLabel(item.status)}`;
    const failure = item.dispatch_error || item.error_message;
    return `<article class="boom-queue-item"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span>${item.army_task_id ? `<small>军团任务 ${escapeHtml(item.army_task_id)}</small>` : ''}${failure ? `<small class="is-error">${escapeHtml(failure)}</small>` : ''}</article>`;
  }

  async function loadQueues() {
    const [scans, analysis] = await Promise.all([
      api(`${API_ROOT}/scan/jobs?limit=20`),
      api(`${API_ROOT}/analysis`),
    ]);
    const scanItems = scans.jobs || [];
    const analysisItems = analysis.items || [];
    elements.scanList.innerHTML = scanItems.length ? scanItems.map((item) => queueItem(item, 'scan')).join('') : '<p class="boom-empty">没有扫描任务。</p>';
    elements.analysisList.innerHTML = analysisItems.length ? analysisItems.map((item) => queueItem(item, 'analysis')).join('') : '<p class="boom-empty">没有待派发作品。</p>';
  }

  function renderSettings(payload) {
    settings = payload.analysis_auto || { enabled:false, grades:['T2', 'T3'] };
    const budget = payload.analysis_budget || {};
    elements.autoEnabled.checked = settings.enabled === true;
    const grades = new Set(Array.isArray(settings.grades) ? settings.grades : ['T2', 'T3']);
    for (const checkbox of root.querySelectorAll('input[name="boom-grade"]')) checkbox.checked = grades.has(checkbox.value);
    elements.dailyLimit.value = settings.daily_limit ?? budget.daily_limit ?? payload.daily_limit ?? 5;
    elements.budget.textContent = `今日已派发 ${budget.dispatched_today ?? 0} 条 · 剩余 ${budget.remaining_today ?? Math.max(0, Number(elements.dailyLimit.value))} 条`;
  }

  async function loadSettings() {
    renderSettings(await api(`${API_ROOT}/settings`));
  }

  function renderCollectResult(payload) {
    const score = payload.score;
    elements.collectResult.hidden = false;
    elements.collectResult.innerHTML = score ? `
      <div class="boom-result-head"><strong>${escapeHtml(payload.message || '已完成采集和评分')}</strong>${gradeBadge(score.grade)}</div>
      <p>正式 v2 · R ${numberText(score.r_value, 2)} · M ${numberText(score.m_value, 4)} · 历史样本 ${escapeHtml(score.sample_count ?? 0)} 条</p>
      <small>缺少发布时间时只判断累计表现，不宣称作品“正在爆”。</small>` : `<strong>${escapeHtml(payload.message || '已完成采集。')}</strong>`;
  }

  async function parseImportInput() {
    const file = elements.importFile.files?.[0];
    const pasted = elements.importPayload.value.trim();
    if (!file && !pasted) throw new Error('请选择 JSON/CSV 文件，或粘贴 JSON。');
    if (file) {
      const text = await file.text();
      return file.name.toLowerCase().endsWith('.csv') ? parseBoomCsv(text) : JSON.parse(text);
    }
    return JSON.parse(pasted);
  }

  function bind() {
    elements.refresh.addEventListener('click', () => loadOverview().catch(showError));
    for (const tab of elements.tabs) tab.addEventListener('click', () => setView(tab.dataset.boomView));
    elements.workFilters.addEventListener('submit', (event) => {
      event.preventDefault();
      loadWorks().catch(showError);
    });
    elements.workList.addEventListener('click', (event) => {
      const detail = event.target.closest('[data-boom-detail]');
      if (detail) showWorkDetail(detail.dataset.boomDetail, detail).catch(showError);
      const dispatch = event.target.closest('[data-boom-dispatch-work]');
      if (dispatch) dispatchManually(dispatch.dataset.boomDispatchWork, dispatch).catch(showError);
    });
    elements.collectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      elements.collectSubmit.disabled = true;
      elements.collectResult.hidden = true;
      setMessage('正在通过小D读取公开指标…');
      try {
        const payload = await api(`${API_ROOT}/collect/url`, {
          method:'POST', headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ url:elements.sourceUrl.value.trim(), history_limit:20 }),
        });
        renderCollectResult(payload);
        setMessage('采集和评分完成；后续派发按当前设置执行。', 'ready');
        await Promise.all([loadWorks(), loadOverview()]);
      } catch (error) {
        elements.collectResult.hidden = false;
        elements.collectResult.textContent = error.message;
        showError(error);
      } finally {
        elements.collectSubmit.disabled = false;
      }
    });
    elements.scanRun.addEventListener('click', async () => {
      elements.scanRun.disabled = true;
      setMessage('正在把扫描任务加入队列…');
      try {
        await api(`${API_ROOT}/scan/run`, { method:'POST' });
        setMessage('扫描任务已入队；后续派发按当前设置执行。', 'ready');
        await loadQueues();
      } catch (error) { showError(error); }
      finally { elements.scanRun.disabled = false; }
    });
    elements.queueRefresh.addEventListener('click', () => loadQueues().catch(showError));
    elements.dispatchRun.addEventListener('click', async () => {
      elements.dispatchRun.disabled = true;
      try {
        await dispatchManually();
      } catch (error) { showError(error); }
      finally { elements.dispatchRun.disabled = false; }
    });
    elements.importForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      elements.importSubmit.disabled = true;
      elements.importResult.hidden = true;
      try {
        const request = buildBoomImportRequest(await parseImportInput());
        const result = await api(`${API_ROOT}/import`, {
          method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(request),
        });
        elements.importResult.textContent = JSON.stringify(result, null, 2);
        elements.importResult.hidden = false;
        setMessage(`已导入 ${result.count ?? request.works.length} 条，等待扫描；后续派发按当前设置执行。`, 'ready');
        await Promise.all([loadWorks(), loadOverview()]);
      } catch (error) {
        elements.importResult.textContent = error instanceof SyntaxError ? 'JSON 格式不正确，请检查逗号和引号。' : error.message;
        elements.importResult.hidden = false;
        showError(error);
      } finally { elements.importSubmit.disabled = false; }
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
          method:'POST', headers:{ 'content-type':'application/json' },
          body:JSON.stringify({
            analysis_auto_enabled:enabled,
            analysis_auto_grades:grades.join(','),
            analysis_daily_limit:dailyLimit,
            daily_limit:dailyLimit,
          }),
        });
        renderSettings(payload);
        setMessage(enabled ? '自动派发设置已保存。' : '设置已保存，自动派发保持关闭。', 'ready');
      } catch (error) { showError(error); }
      finally { submit.disabled = false; }
    });
  }

  return {
    activate() {
      if (!initialized) {
        initialized = true;
        bind();
        loadOverview().catch(showError);
      }
    },
  };
}

function platformLabel(platform) {
  return ({ douyin:'抖音', xiaohongshu:'小红书', youtube:'YouTube', manual:'手动' })[platform] || platform || '未知平台';
}

function queueStatusLabel(status) {
  return ({ queued:'等待处理', running:'处理中', completed:'已完成', failed:'失败', dispatched:'已派发', dispatching:'派发中', dispatch_failed:'派发失败', waiting_source:'等待来源', cancelled:'已关闭' })[status] || status || '未入队';
}

function numberText(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '-';
}
