import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const STATUSES = new Set(['planning', 'active', 'completed', 'paused']);
const TASK_STATUSES = new Set(['todo', 'doing', 'done', 'blocked']);
const dbPath = process.env.PROGRESS_BOARD_DB || path.join(process.cwd(), 'data', 'progress-board.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planning',
    current_phase TEXT NOT NULL DEFAULT '规划',
    repository TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT '规划',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'normal',
    owner TEXT NOT NULL DEFAULT '本人',
    due_date TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    blocked_reason TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    source_links TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function now() { return new Date().toISOString(); }
function parseLinks(value) {
  try { return Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch { return []; }
}
function normalizeTask(row) { return { ...row, sourceLinks: parseLinks(row.source_links), source_links: undefined }; }
function normalizeProject(row) {
  const project = { ...row, currentPhase: row.current_phase, repository: row.repository, createdAt: row.created_at, updatedAt: row.updated_at };
  delete project.current_phase; delete project.created_at; delete project.updated_at; delete project.source_links;
  return project;
}
function projectStats(projectId) {
  const tasks = db.prepare('SELECT status, progress FROM tasks WHERE project_id = ?').all(projectId);
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const progress = total ? Math.round(tasks.reduce((sum, task) => sum + (task.status === 'done' ? 100 : task.progress), 0) / total) : 0;
  return { total, done, progress, doing: tasks.filter((task) => task.status === 'doing').length, blocked: tasks.filter((task) => task.status === 'blocked').length, todo: tasks.filter((task) => task.status === 'todo').length };
}
function withStats(row) { return { ...normalizeProject(row), stats: projectStats(row.id) }; }

function seed() {
  if (db.prepare('SELECT COUNT(*) AS count FROM projects').get().count > 0) return;
  const insertProject = db.prepare('INSERT INTO projects (name, description, status, current_phase, repository, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertTask = db.prepare('INSERT INTO tasks (project_id, title, phase, status, progress, priority, owner, due_date, next_action, blocked_reason, notes, source_links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const timestamp = now();
  const projects = [
    { name: 'Agent 军团', description: '以飞书为入口、A君本地运行时承载智能体的数字员工系统。', status: 'active', phase: 'M2 通用访问底座', repository: '' },
    { name: '小D · 音视频整理', description: '从素材接收、转录、整理到飞书交付的真实业务闭环。', status: 'active', phase: 'M1 受控验收', repository: '' },
    { name: '通用连接与内容获取', description: '统一账号连接、授权边界和内容获取能力。', status: 'planning', phase: '方案落地', repository: '' }
  ];
  const taskSets = [
    [['M1 小D飞书闭环', 'done', 100, '验收记录与真实运行证据归档'], ['M2 通用访问底座', 'doing', 55, '完成真实平台内容读取验收'], ['Paperclip 治理控制面', 'todo', 0, '先完成运行链路，再进入治理接入']],
    [['飞书文本消息收发', 'done', 100, ''], ['短媒体转录与交付', 'done', 100, ''], ['后台阶段更新故障回归', 'blocked', 35, '补齐剩余 M1 场景验证'], ['飞书失败任务恢复入口', 'doing', 70, '完成同一任务单次交付回归']],
    [['统一账号管家', 'done', 100, ''], ['只读浏览器会话引用', 'done', 100, ''], ['真实平台内容读取', 'todo', 0, '准备最小真实验收样例'], ['OAuth 与安全密钥存储', 'todo', 0, '明确外部平台授权边界']]
  ];
  projects.forEach((project, index) => {
    const result = insertProject.run(project.name, project.description, project.status, project.phase, project.repository, timestamp, timestamp);
    taskSets[index].forEach(([title, status, progress, nextAction], taskIndex) => insertTask.run(result.lastInsertRowid, title, index === 0 ? ['M1', 'M2', 'M3'][taskIndex] || 'M2' : project.phase, status, progress, taskIndex === 0 ? 'high' : 'normal', '本人', '', nextAction, status === 'blocked' ? '需要补齐后台阶段更新的真实回归证据' : '', '', '[]', timestamp, timestamp));
  });
}
seed();

export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all().map(withStats);
}
export function getProject(id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  if (!row) return null;
  const project = withStats(row);
  project.tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY CASE status WHEN \'doing\' THEN 1 WHEN \'blocked\' THEN 2 WHEN \'todo\' THEN 3 ELSE 4 END, updated_at DESC').all(Number(id)).map(normalizeTask);
  project.phases = [...new Set(project.tasks.map((task) => task.phase))].map((name) => {
    const tasks = project.tasks.filter((task) => task.phase === name);
    return { name, progress: tasks.length ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length) : 0, done: tasks.filter((task) => task.status === 'done').length, total: tasks.length, status: tasks.every((task) => task.status === 'done') ? 'completed' : tasks.some((task) => task.status === 'doing' || task.status === 'blocked') ? 'active' : 'planning' };
  });
  return project;
}
export function dashboard() {
  const projects = listProjects();
  const tasks = db.prepare('SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY CASE t.status WHEN \'blocked\' THEN 1 WHEN \'doing\' THEN 2 ELSE 3 END, t.updated_at DESC').all().map((task) => ({ ...normalizeTask(task), projectName: task.project_name }));
  const total = tasks.length;
  return { projects, focusTasks: tasks.filter((task) => ['doing', 'blocked'].includes(task.status)).slice(0, 8), stats: { projects: projects.length, progress: total ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / total) : 0, doing: tasks.filter((task) => task.status === 'doing').length, blocked: tasks.filter((task) => task.status === 'blocked').length, done: tasks.filter((task) => task.status === 'done').length, todo: tasks.filter((task) => task.status === 'todo').length } };
}
export function createProject(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('项目名称不能为空');
  const timestamp = now();
  const result = db.prepare('INSERT INTO projects (name, description, status, current_phase, repository, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, String(input.description || ''), STATUSES.has(input.status) ? input.status : 'planning', String(input.currentPhase || '规划'), String(input.repository || ''), timestamp, timestamp);
  return getProject(result.lastInsertRowid);
}
export function updateProject(id, input = {}) {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  if (!existing) return null;
  const next = { name: input.name === undefined ? existing.name : String(input.name).trim(), description: input.description === undefined ? existing.description : String(input.description), status: STATUSES.has(input.status) ? input.status : existing.status, phase: input.currentPhase === undefined ? existing.current_phase : String(input.currentPhase), repository: input.repository === undefined ? existing.repository : String(input.repository) };
  if (!next.name) throw new Error('项目名称不能为空');
  db.prepare('UPDATE projects SET name = ?, description = ?, status = ?, current_phase = ?, repository = ?, updated_at = ? WHERE id = ?').run(next.name, next.description, next.status, next.phase, next.repository, now(), Number(id));
  return getProject(id);
}
export function createTask(projectId, input = {}) {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(projectId))) return null;
  const title = String(input.title || '').trim();
  if (!title) throw new Error('任务名称不能为空');
  const status = TASK_STATUSES.has(input.status) ? input.status : 'todo';
  const progress = status === 'done' ? 100 : Math.max(0, Math.min(100, Number(input.progress || 0)));
  const timestamp = now();
  const result = db.prepare('INSERT INTO tasks (project_id, title, phase, status, progress, priority, owner, due_date, next_action, blocked_reason, notes, source_links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(Number(projectId), title, String(input.phase || '规划'), status, progress, String(input.priority || 'normal'), String(input.owner || '本人'), String(input.dueDate || ''), String(input.nextAction || ''), String(input.blockedReason || ''), String(input.notes || ''), JSON.stringify(Array.isArray(input.sourceLinks) ? input.sourceLinks : []), timestamp, timestamp);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, Number(projectId));
  return getProject(projectId).tasks.find((task) => task.id === Number(result.lastInsertRowid));
}
export function updateTask(id, input = {}) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!existing) return null;
  const status = TASK_STATUSES.has(input.status) ? input.status : existing.status;
  const progress = status === 'done' ? 100 : Math.max(0, Math.min(100, Number(input.progress === undefined ? existing.progress : input.progress)));
  const next = { title: input.title === undefined ? existing.title : String(input.title).trim(), phase: input.phase === undefined ? existing.phase : String(input.phase), status, progress, priority: input.priority === undefined ? existing.priority : String(input.priority), owner: input.owner === undefined ? existing.owner : String(input.owner), dueDate: input.dueDate === undefined ? existing.due_date : String(input.dueDate), nextAction: input.nextAction === undefined ? existing.next_action : String(input.nextAction), blockedReason: input.blockedReason === undefined ? existing.blocked_reason : String(input.blockedReason), notes: input.notes === undefined ? existing.notes : String(input.notes), sourceLinks: input.sourceLinks === undefined ? parseLinks(existing.source_links) : input.sourceLinks };
  if (!next.title) throw new Error('任务名称不能为空');
  const timestamp = now();
  db.prepare('UPDATE tasks SET title = ?, phase = ?, status = ?, progress = ?, priority = ?, owner = ?, due_date = ?, next_action = ?, blocked_reason = ?, notes = ?, source_links = ?, updated_at = ? WHERE id = ?').run(next.title, next.phase, next.status, next.progress, next.priority, next.owner, next.dueDate, next.nextAction, next.blockedReason, next.notes, JSON.stringify(next.sourceLinks), timestamp, Number(id));
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, existing.project_id);
  return getProject(existing.project_id).tasks.find((task) => task.id === Number(id));
}

export { db };
