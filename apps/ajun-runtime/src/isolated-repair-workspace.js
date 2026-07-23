import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const execFile = promisify(execFileCallback);

export class IsolatedRepairWorkspace {
  constructor({ projectRoot, parentDir = '/Users/pengaro/.paperclip/agent-army-worktrees/ajun-repairs', fsImpl = fs, execFileImpl = execFile } = {}) {
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.parentDir = path.resolve(parentDir);
    this.fs = fsImpl;
    this.execFile = execFileImpl;
  }

  async prepare(task) {
    const taskKey = safeTaskKey(task?.taskId);
    if (!taskKey) throw new Error('修复任务缺少安全编号，未建立修理副本。');
    const workspace = path.join(this.parentDir, taskKey);
    assertInside(workspace, this.parentDir);
    if (await exists(this.fs, path.join(workspace, '.git'))) return { workspace, reused:true };
    await this.fs.mkdir(this.parentDir, { recursive:true });
    await this.execFile('git', ['worktree', 'add', '--detach', workspace, 'HEAD'], { cwd:this.projectRoot });
    await this.overlayScopedFiles(task, workspace);
    return { workspace, reused:false };
  }

  async overlayScopedFiles(task, workspace) {
    const files = repairFiles(task);
    if (!files.length) return;
    const snapshot = { version:1, files:{} };
    for (const relativePath of [...new Set([...files, ...testSupportFiles(task)])]) {
      const source = path.join(this.projectRoot, relativePath); const target = path.join(workspace, relativePath);
      const content = await this.fs.readFile(source);
      await this.fs.mkdir(path.dirname(target), { recursive:true });
      await this.fs.writeFile(target, content);
      if (files.includes(relativePath)) snapshot.files[relativePath] = { sourceHash:hash(content) };
    }
    await this.fs.writeFile(path.join(workspace, '.agent-army-repair-snapshot.json'), `${JSON.stringify(snapshot)}\n`);
  }
}

function safeTaskKey(taskId) {
  const value = String(taskId || '').trim();
  return /^[a-zA-Z0-9-]{12,100}$/.test(value) ? value : null;
}

function assertInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('修理副本目录不在允许范围内。');
}

async function exists(fsImpl, target) {
  try { await fsImpl.access(target); return true; }
  catch { return false; }
}

function repairFiles(task) {
  return Array.isArray(task?.input?.context?.repairScope?.files) ? task.input.context.repairScope.files.map((item) => String(item || '').trim()).filter((item) => item && !path.isAbsolute(item) && !item.split('/').includes('..')) : [];
}

function testSupportFiles(task) {
  const command = String(task?.input?.context?.repairScope?.testCommand || '').trim();
  const match = command.match(/^node --test\s+(.+)$/);
  if (!match) return [];
  return match[1].split(/\s+/).map((item) => item.trim()).filter((item) => item && !path.isAbsolute(item) && !item.split('/').includes('..') && /\.(?:test|spec)\.[cm]?js$/i.test(item));
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
