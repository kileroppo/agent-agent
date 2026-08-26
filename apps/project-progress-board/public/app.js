import { html, raw, escapeHtml } from './html.js';
const state = { dashboard: null, project: null, editingTaskId: null, editingProjectId: null };
const $ = (selector) => document.querySelector(selector);
const statusLabels = { planning: '规划中', active: '进行中', completed: '已完成', paused: '已暂停', todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };
const statusClass = (status) => `status-${status}`;
let toastTimer = null;
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `toast visible ${error ? 'error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600); }
async function request(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error || '请求失败');
    return data;
}
function stat(label, value, detail, tone = '') { return html `<article class="stat ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`; }
function renderDashboard(data) {
    state.dashboard = data;
    $('#stats').innerHTML = [stat('项目', data.stats.projects, `${data.stats.active || data.projects.filter((p) => p.status === 'active').length} 个进行中`), stat('整体完成度', `${data.stats.progress}%`, `${data.stats.done} 个任务已完成`, 'green'), stat('正在处理', data.stats.doing, '需要持续跟进', 'blue'), stat('阻塞', data.stats.blocked, data.stats.blocked ? '需要解除卡点' : '目前没有阻塞', data.stats.blocked ? 'red' : '')].join('');
    $('#focus-list').innerHTML = data.focusTasks.length ? data.focusTasks.map((task) => html `<button class="focus-item" data-project-id="${task.project_id}"><span class="focus-icon ${statusClass(task.status)}">${task.status === 'blocked' ? '!' : '→'}</span><span class="focus-main"><strong>${task.title}</strong><small>${task.projectName} · ${task.nextAction || '继续推进'}</small></span><span class="tag ${statusClass(task.status)}">${statusLabels[task.status]}</span><span class="chevron">›</span></button>`).join('') : '<div class="empty-inline">目前没有进行中或阻塞任务。</div>';
    $('#project-grid').innerHTML = data.projects.length ? data.projects.map(renderProjectCard).join('') : '<div class="empty-state"><strong>还没有项目</strong><span>先新建一个项目，把下一步写下来。</span></div>';
    document.querySelectorAll('[data-project-id]').forEach((el) => el.addEventListener('click', () => openProject(el.dataset.projectId)));
    $('#sync-state').textContent = `已同步 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function renderProjectCard(project) { const stats = project.stats; return html `<button class="project-card" data-project-id="${project.id}"><div class="project-card-head"><span class="project-mark">${project.name.slice(0, 1)}</span><span class="tag ${statusClass(project.status)}">${statusLabels[project.status]}</span></div><h3>${project.name}</h3><p>${project.description || '还没有项目说明。'}</p><div class="project-progress"><div><span>完成度</span><strong>${stats.progress}%</strong></div><div class="progress-track"><i style="width:${stats.progress}%"></i></div></div><div class="project-card-foot"><span>${project.currentPhase}</span><span>${stats.doing} 进行中 · ${stats.blocked} 阻塞</span></div></button>`; }
async function loadDashboard() {
    try {
        renderDashboard(await request('/api/dashboard'));
    }
    catch (error) {
        toast(error.message, true);
        $('#sync-state').textContent = '同步失败';
    }
}
async function openProject(id) {
    try {
        state.project = (await request(`/api/projects/${id}`)).project;
        renderDetail();
        $('#detail').classList.remove('hidden');
        $('#detail').setAttribute('aria-hidden', 'false');
        document.body.classList.add('detail-open');
        window.scrollTo(0, 0);
    }
    catch (error) {
        toast(error.message, true);
    }
}
function renderDetail() {
    const project = state.project;
    const stats = project.stats;
    $('#detail-content').innerHTML = html `<div class="detail-head"><div><p class="eyebrow">PROJECT / ${String(project.id).padStart(2, '0')}</p><h1>${project.name}</h1><p>${project.description}</p></div><div class="detail-actions"><button class="button quiet" id="edit-project">编辑项目</button><button class="button primary" id="new-task">新增任务</button></div></div><div class="detail-summary"><div><span>当前阶段</span><strong>${project.currentPhase}</strong></div><div><span>总体完成度</span><strong>${stats.progress}%</strong></div><div><span>任务总数</span><strong>${stats.total}</strong></div><div><span>更新时间</span><strong>${new Date(project.updatedAt).toLocaleDateString()}</strong></div></div><section class="timeline-section"><div class="section-heading"><div><p class="eyebrow">PLAN</p><h2>阶段规划</h2></div><p>从规划到验收，保持一条主线。</p></div><div class="timeline">${raw(project.phases.map((phase, index) => html `<div class="timeline-item ${phase.status === 'active' ? 'active' : ''} ${phase.status === 'completed' ? 'completed' : ''}"><span class="timeline-dot"></span><div><strong>${phase.name}</strong><small>${phase.done}/${phase.total} 个任务完成 · ${phase.progress}%</small></div>${index < project.phases.length - 1 ? '<i></i>' : ''}</div>`).join('') || '<div class="empty-inline">还没有阶段任务。</div>')}</div></section><section class="task-section"><div class="section-heading"><div><p class="eyebrow">TASKS</p><h2>任务进度</h2></div><p>${stats.done} 已完成 · ${stats.doing} 进行中 · ${stats.todo} 未开始 · ${stats.blocked} 阻塞</p></div><div class="task-columns">${['doing', 'blocked', 'todo', 'done'].map((status) => html `<div class="task-column"><div class="column-title"><span class="column-dot ${statusClass(status)}"></span><strong>${statusLabels[status]}</strong><small>${project.tasks.filter((task) => task.status === status).length}</small></div>${raw(project.tasks.filter((task) => task.status === status).map(renderTask).join('') || '<div class="column-empty">暂无任务</div>')}</div>`).join('')}</div></section>`;
    $('#new-task').onclick = () => openTaskDialog();
    $('#edit-project').onclick = () => openProjectDialog(project);
    document.querySelectorAll('[data-task-id]').forEach((el) => el.addEventListener('click', () => openTaskDialog(el.dataset.taskId)));
}
function renderTask(task) {
    const isBlocked = task.status === 'blocked' || Boolean(task.blockedReason);
    return html `<button class="task-card ${isBlocked ? 'is-blocked-card' : ''}" data-task-id="${task.id}">
      <div class="task-card-top">
        <span class="tag ${statusClass(task.priority === 'high' ? 'high' : task.status)}">${task.priority === 'high' ? '重点' : statusLabels[task.status]}</span>
        <span class="task-percent">${task.progress}%</span>
      </div>
      <strong class="task-title">${task.title}</strong>
      <div class="task-meta-row"><small class="task-phase-badge">${task.phase}</small><small class="task-owner">${task.owner}</small></div>
      ${raw(task.nextAction ? html `<div class="task-next-box"><span class="next-dot">→</span><span>${task.nextAction}</span></div>` : '')}
      ${raw(task.blockedReason ? html `<div class="task-attention-banner"><span class="attention-badge">! 阻塞卡点</span><p>${task.blockedReason}</p></div>` : '')}
      <div class="progress-track"><i style="width:${task.progress}%"></i></div>
    </button>`;
}
function openTaskDialog(taskId) {
    state.editingTaskId = taskId ? Number(taskId) : null;
    const task = taskId ? state.project.tasks.find((item) => item.id === Number(taskId)) : null;
    const form = $('#task-form');
    form.reset();
    $('#task-dialog-title').textContent = task ? '编辑任务' : '新增任务';
    if (task) {
        for (const [key, value] of Object.entries({ title: task.title, status: task.status, progress: task.progress, phase: task.phase, owner: task.owner, nextAction: task.nextAction, blockedReason: task.blockedReason, notes: task.notes }))
            if (form.elements[key])
                form.elements[key].value = value;
    }
    $('#progress-output').textContent = `${form.elements.progress.value}%`;
    $('#task-dialog').showModal();
}
$('#task-form').elements.progress.addEventListener('input', (event) => { $('#progress-output').textContent = `${event.target.value}%`; });
$('#task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.progress = Number(data.progress);
    try {
        if (state.editingTaskId)
            await request(`/api/tasks/${state.editingTaskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        else
            await request(`/api/projects/${state.project.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        $('#task-dialog').close();
        state.project = (await request(`/api/projects/${state.project.id}`)).project;
        renderDetail();
        await loadDashboard();
        toast('任务已保存');
    }
    catch (error) {
        toast(error.message, true);
    }
});
function openProjectDialog(project = null) {
    state.editingProjectId = project?.id || null;
    const form = $('#project-form');
    form.reset();
    form.querySelector('h2').textContent = project ? '编辑项目' : '新建项目';
    if (project) {
        for (const [key, value] of Object.entries({ name: project.name, description: project.description, currentPhase: project.currentPhase, status: project.status, repository: project.repository }))
            if (form.elements[key])
                form.elements[key].value = value;
    }
    $('#project-dialog').showModal();
}
$('#project-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
        const url = state.editingProjectId ? `/api/projects/${state.editingProjectId}` : '/api/projects';
        const result = await request(url, { method: state.editingProjectId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        $('#project-dialog').close();
        await loadDashboard();
        if (state.editingProjectId) {
            state.project = result.project;
            renderDetail();
            toast('项目已更新');
        }
        else {
            openProject(result.project.id);
            toast('项目已创建');
        }
    }
    catch (error) {
        toast(error.message, true);
    }
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('#new-project').onclick = () => openProjectDialog();
$('#refresh').onclick = loadDashboard;
$('#back').onclick = () => { $('#detail').classList.add('hidden'); $('#detail').setAttribute('aria-hidden', 'true'); document.body.classList.remove('detail-open'); history.replaceState(null, '', '#'); };
window.addEventListener('popstate', () => $('#back').click());
loadDashboard();
