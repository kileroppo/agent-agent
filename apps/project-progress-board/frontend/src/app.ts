const state: any = { dashboard: null, project: null, editingTaskId: null, editingProjectId: null };
const $: any = (selector: any): any => document.querySelector(selector);
const statusLabels: any = { planning: '规划中', active: '进行中', completed: '已完成', paused: '已暂停', todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };
const statusClass: any = (status: any): any => `status-${status}`;
const escapeHtml: any = (value: any = ''): any => String(value).replace(/[&<>'"]/g, (char: any): any => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as Record<string, string>)[char]);
let toastTimer: any = null;
function toast(message: any, error: any = false): any { const el: any = $('#toast'); el.textContent = message; el.className = `toast visible ${error ? 'error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout((): any => { el.className = 'toast'; }, 2600); }
async function request(url: any, options: any = {}): Promise<any> {
    const response: any = await fetch(url, options);
    const data: any = await response.json();
    if (!response.ok)
        throw new Error(data.error || '请求失败');
    return data;
}
function stat(label: any, value: any, detail: any, tone: any = ''): any { return `<article class="stat ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`; }
function renderDashboard(data: any): any {
    state.dashboard = data;
    $('#stats').innerHTML = [stat('项目', data.stats.projects, `${data.stats.active || data.projects.filter((p: any): any => p.status === 'active').length} 个进行中`), stat('整体完成度', `${data.stats.progress}%`, `${data.stats.done} 个任务已完成`, 'green'), stat('正在处理', data.stats.doing, '需要持续跟进', 'blue'), stat('阻塞', data.stats.blocked, data.stats.blocked ? '需要解除卡点' : '目前没有阻塞', data.stats.blocked ? 'red' : '')].join('');
    $('#focus-list').innerHTML = data.focusTasks.length ? data.focusTasks.map((task: any): any => `<button class="focus-item" data-project-id="${task.project_id}"><span class="focus-icon ${statusClass(task.status)}">${task.status === 'blocked' ? '!' : '→'}</span><span class="focus-main"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.projectName)} · ${escapeHtml(task.nextAction || '继续推进')}</small></span><span class="tag ${statusClass(task.status)}">${statusLabels[task.status]}</span><span class="chevron">›</span></button>`).join('') : '<div class="empty-inline">目前没有进行中或阻塞任务。</div>';
    $('#project-grid').innerHTML = data.projects.length ? data.projects.map(renderProjectCard).join('') : '<div class="empty-state"><strong>还没有项目</strong><span>先新建一个项目，把下一步写下来。</span></div>';
    document.querySelectorAll('[data-project-id]').forEach((el: any): any => el.addEventListener('click', (): any => openProject(el.dataset.projectId)));
    $('#sync-state').textContent = `已同步 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function renderProjectCard(project: any): any { const stats: any = project.stats; return `<button class="project-card" data-project-id="${project.id}"><div class="project-card-head"><span class="project-mark">${escapeHtml(project.name.slice(0, 1))}</span><span class="tag ${statusClass(project.status)}">${statusLabels[project.status]}</span></div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description || '还没有项目说明。')}</p><div class="project-progress"><div><span>完成度</span><strong>${stats.progress}%</strong></div><div class="progress-track"><i style="width:${stats.progress}%"></i></div></div><div class="project-card-foot"><span>${escapeHtml(project.currentPhase)}</span><span>${stats.doing} 进行中 · ${stats.blocked} 阻塞</span></div></button>`; }
async function loadDashboard(): Promise<any> {
    try {
        renderDashboard(await request('/api/dashboard'));
    }
    catch (error: any) {
        toast(error.message, true);
        $('#sync-state').textContent = '同步失败';
    }
}
async function openProject(id: any): Promise<any> {
    try {
        state.project = (await request(`/api/projects/${id}`)).project;
        renderDetail();
        $('#detail').classList.remove('hidden');
        $('#detail').setAttribute('aria-hidden', 'false');
        document.body.classList.add('detail-open');
        window.scrollTo(0, 0);
    }
    catch (error: any) {
        toast(error.message, true);
    }
}
function renderDetail(): any {
    const project: any = state.project;
    const stats: any = project.stats;
    $('#detail-content').innerHTML = `<div class="detail-head"><div><p class="eyebrow">PROJECT / ${String(project.id).padStart(2, '0')}</p><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description)}</p></div><div class="detail-actions"><button class="button quiet" id="edit-project">编辑项目</button><button class="button primary" id="new-task">新增任务</button></div></div><div class="detail-summary"><div><span>当前阶段</span><strong>${escapeHtml(project.currentPhase)}</strong></div><div><span>总体完成度</span><strong>${stats.progress}%</strong></div><div><span>任务总数</span><strong>${stats.total}</strong></div><div><span>更新时间</span><strong>${new Date(project.updatedAt).toLocaleDateString()}</strong></div></div><section class="timeline-section"><div class="section-heading"><div><p class="eyebrow">PLAN</p><h2>阶段规划</h2></div><p>从规划到验收，保持一条主线。</p></div><div class="timeline">${project.phases.map((phase: any, index: any): any => `<div class="timeline-item ${phase.status === 'active' ? 'active' : ''} ${phase.status === 'completed' ? 'completed' : ''}"><span class="timeline-dot"></span><div><strong>${escapeHtml(phase.name)}</strong><small>${phase.done}/${phase.total} 个任务完成 · ${phase.progress}%</small></div>${index < project.phases.length - 1 ? '<i></i>' : ''}</div>`).join('') || '<div class="empty-inline">还没有阶段任务。</div>'}</div></section><section class="task-section"><div class="section-heading"><div><p class="eyebrow">TASKS</p><h2>任务进度</h2></div><p>${stats.done} 已完成 · ${stats.doing} 进行中 · ${stats.todo} 未开始 · ${stats.blocked} 阻塞</p></div><div class="task-columns">${['doing', 'blocked', 'todo', 'done'].map((status: any): any => `<div class="task-column"><div class="column-title"><span class="column-dot ${statusClass(status)}"></span><strong>${statusLabels[status]}</strong><small>${project.tasks.filter((task: any): any => task.status === status).length}</small></div>${project.tasks.filter((task: any): any => task.status === status).map(renderTask).join('') || '<div class="column-empty">暂无任务</div>'}</div>`).join('')}</div></section>`;
    $('#new-task').onclick = (): any => openTaskDialog();
    $('#edit-project').onclick = (): any => openProjectDialog(project);
    document.querySelectorAll('[data-task-id]').forEach((el: any): any => el.addEventListener('click', (): any => openTaskDialog(el.dataset.taskId)));
}
function renderTask(task: any): any { return `<button class="task-card" data-task-id="${task.id}"><div class="task-card-top"><span class="tag ${statusClass(task.priority === 'high' ? 'high' : task.status)}">${task.priority === 'high' ? '重点' : statusLabels[task.status]}</span><span>${task.progress}%</span></div><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.phase)} · ${escapeHtml(task.owner)}</small>${task.nextAction ? `<p>下一步：${escapeHtml(task.nextAction)}</p>` : ''}${task.blockedReason ? `<p class="blocked-copy">${escapeHtml(task.blockedReason)}</p>` : ''}<div class="progress-track"><i style="width:${task.progress}%"></i></div></button>`; }
function openTaskDialog(taskId?: any): any {
    state.editingTaskId = taskId ? Number(taskId) : null;
    const task: any = taskId ? state.project.tasks.find((item: any): any => item.id === Number(taskId)) : null;
    const form: any = $('#task-form');
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
$('#task-form').elements.progress.addEventListener('input', (event: any): any => { $('#progress-output').textContent = `${event.target.value}%`; });
$('#task-form').addEventListener('submit', async (event: any): Promise<any> => {
    event.preventDefault();
    const data: any = Object.fromEntries(new FormData(event.currentTarget));
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
    catch (error: any) {
        toast(error.message, true);
    }
});
function openProjectDialog(project: any = null): any {
    state.editingProjectId = project?.id || null;
    const form: any = $('#project-form');
    form.reset();
    form.querySelector('h2').textContent = project ? '编辑项目' : '新建项目';
    if (project) {
        for (const [key, value] of Object.entries({ name: project.name, description: project.description, currentPhase: project.currentPhase, status: project.status, repository: project.repository }))
            if (form.elements[key])
                form.elements[key].value = value;
    }
    $('#project-dialog').showModal();
}
$('#project-form').addEventListener('submit', async (event: any): Promise<any> => {
    event.preventDefault();
    const data: any = Object.fromEntries(new FormData(event.currentTarget));
    try {
        const url: any = state.editingProjectId ? `/api/projects/${state.editingProjectId}` : '/api/projects';
        const result: any = await request(url, { method: state.editingProjectId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
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
    catch (error: any) {
        toast(error.message, true);
    }
});
document.querySelectorAll('[data-close]').forEach((button: any): any => button.addEventListener('click', (): any => button.closest('dialog').close()));
$('#new-project').onclick = (): any => openProjectDialog();
$('#refresh').onclick = loadDashboard;
$('#back').onclick = (): any => { $('#detail').classList.add('hidden'); $('#detail').setAttribute('aria-hidden', 'true'); document.body.classList.remove('detail-open'); history.replaceState(null, '', '#'); };
window.addEventListener('popstate', (): any => $('#back').click());
loadDashboard();
