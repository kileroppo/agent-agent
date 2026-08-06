import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const execFile = promisify(execFileCallback);

export class IsolatedRepairWorkspace {
  constructor({
    projectRoot,
    parentDir = path.join(os.homedir(), '.paperclip', 'agent-army-worktrees', 'ajun-repairs'),
    sourceIdentity = null,
    verifySourceRoot = null,
    fsImpl = fs,
    execFileImpl = execFile,
  } = {}) {
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.parentDir = path.resolve(parentDir);
    this.sourceIdentity = sourceIdentity;
    this.verifySourceRoot = verifySourceRoot;
    this.fs = fsImpl;
    this.execFile = execFileImpl;
  }

  async prepare(task) {
    if (this.verifySourceRoot) await this.verifySourceRoot();
    const taskKey = safeTaskKey(task?.taskId);
    if (!taskKey) throw new Error('修复任务缺少安全编号，未建立修理副本。');
    const scope = validateRepairScope(task);
    const workspace = path.join(this.parentDir, taskKey);
    assertInside(workspace, this.parentDir);
    await this.fs.mkdir(this.parentDir, { recursive:true });
    if (await exists(this.fs, workspace)) {
      await this.assertReusableWorkspace(taskKey, scope, workspace);
      return { workspace, reused:true };
    }
    await this.execFile('git', ['worktree', 'add', '--detach', workspace, 'HEAD'], { cwd:this.projectRoot });
    await this.assertWorkspaceGitIdentity(workspace);
    await this.overlayScopedFiles(scope, workspace, taskKey);
    if (this.verifySourceRoot) await this.verifySourceRoot();
    return { workspace, reused:false };
  }

  async assertReusableWorkspace(taskKey, scope, workspace) {
    await assertCanonicalDirectory(this.fs, workspace, this.parentDir);
    await this.assertWorkspaceGitIdentity(workspace);
    const snapshotPath = path.join(workspace, '.agent-army-repair-snapshot.json');
    await assertSafeRegularFile(this.fs, workspace, snapshotPath);
    let snapshot;
    try {
      snapshot = JSON.parse(await this.fs.readFile(snapshotPath, 'utf8'));
    } catch {
      throw new Error('现有修理副本缺少可验证的任务快照，拒绝复用。');
    }
    if (
      snapshot?.version !== 2
      || snapshot.taskId !== taskKey
      || snapshot.scopeHash !== scopeHash(scope)
      || !sameSourceIdentity(snapshot.sourceIdentity, this.sourceIdentity)
    ) {
      throw new Error('现有修理副本不属于当前任务或源码根，拒绝复用。');
    }
  }

  async assertWorkspaceGitIdentity(workspace) {
    await assertCanonicalDirectory(this.fs, workspace, this.parentDir);
    const marker = path.join(workspace, '.git');
    await assertSafeRegularFile(this.fs, workspace, marker, { allowDirectory:true });
    const topLevel = await this.execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd:workspace, encoding:'utf8', timeout:5_000, maxBuffer:1024 * 1024 },
    );
    const canonicalTopLevel = await this.fs.realpath(String(topLevel.stdout || '').trim());
    if (canonicalTopLevel !== workspace) {
      throw new Error('修理副本不是独立 Git worktree，拒绝使用。');
    }
    if (this.sourceIdentity?.gitCommonDir) {
      const common = await this.execFile(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd:workspace, encoding:'utf8', timeout:5_000, maxBuffer:1024 * 1024 },
      );
      const canonicalCommon = await this.fs.realpath(String(common.stdout || '').trim());
      if (canonicalCommon !== this.sourceIdentity.gitCommonDir) {
        throw new Error('修理副本不属于当前源码仓库，拒绝使用。');
      }
      const head = await this.execFile(
        'git',
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        { cwd:workspace, encoding:'utf8', timeout:5_000, maxBuffer:1024 * 1024 },
      );
      if (String(head.stdout || '').trim() !== this.sourceIdentity.head) {
        throw new Error('修理副本 HEAD 与当前源码根启动快照不一致，拒绝使用。');
      }
    }
  }

  async overlayScopedFiles(scope, workspace, taskKey) {
    const files = scope.repairFiles;
    const snapshot = {
      version:2,
      taskId:taskKey,
      scopeHash:scopeHash(scope),
      sourceIdentity:sourceIdentityRecord(this.sourceIdentity),
      files:{},
    };
    for (const relativePath of [...new Set([...files, ...scope.testSupportFiles])]) {
      const source = path.join(this.projectRoot, relativePath); const target = path.join(workspace, relativePath);
      const content = await readSafeRegularFile(this.fs, this.projectRoot, source);
      await replaceExistingRegularFile(this.fs, workspace, target, content);
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

async function assertCanonicalDirectory(fsImpl, candidate, parent) {
  assertInside(candidate, parent);
  const stat = await fsImpl.lstat(candidate);
  const canonical = await fsImpl.realpath(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== candidate) {
    throw new Error('修理副本必须是允许范围内的真实目录。');
  }
}

async function assertSafeRegularFile(fsImpl, root, candidate, { allowDirectory = false } = {}) {
  assertInside(candidate, root);
  const relative = path.relative(root, candidate);
  let cursor = root;
  let result;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fsImpl.lstat(cursor);
    result = stat;
    if (stat.isSymbolicLink()) throw new Error('修复范围包含符号链接，拒绝读取。');
    const isLast = cursor === candidate;
    if (!isLast && !stat.isDirectory()) throw new Error('修复范围路径祖先不是目录。');
    if (isLast && !stat.isFile() && !(allowDirectory && stat.isDirectory())) {
      throw new Error('修复范围必须是普通文件。');
    }
  }
  const canonical = await fsImpl.realpath(candidate);
  if (canonical !== candidate) throw new Error('修复范围没有解析到原始文件。');
  return result;
}

async function readSafeRegularFile(fsImpl, root, candidate) {
  const expected = await assertSafeRegularFile(fsImpl, root, candidate);
  const handle = await fsImpl.open(
    candidate,
    fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error('修复范围文件在读取时发生替换。');
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function replaceExistingRegularFile(fsImpl, root, candidate, content) {
  const expected = await assertSafeRegularFile(fsImpl, root, candidate);
  const handle = await fsImpl.open(
    candidate,
    fsConstants.constants.O_WRONLY
      | fsConstants.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error('修理副本文件在写入时发生替换。');
    }
    await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameSourceIdentity(actual, expected) {
  if (!expected) return actual === null;
  const record = sourceIdentityRecord(expected);
  return Object.entries(record).every(([key, value]) => actual?.[key] === value);
}

function sourceIdentityRecord(identity) {
  if (!identity) return null;
  return Object.fromEntries([
    'device',
    'inode',
    'head',
    'gitCommonDir',
    'gitCommonDevice',
    'gitCommonInode',
    'gitDir',
    'gitDirDevice',
    'gitDirInode',
  ].map((key) => [key, identity[key]]));
}

function scopeHash(scope) {
  const value = {
    repairFiles:[...new Set(scope.repairFiles)].sort(),
    testSupportFiles:[...new Set(scope.testSupportFiles)].sort(),
  };
  return hash(JSON.stringify(value));
}

async function exists(fsImpl, target) {
  try { await fsImpl.lstat(target); return true; }
  catch { return false; }
}

function validateRepairScope(task) {
  const repairScope = task?.input?.context?.repairScope;
  const rawFiles = repairScope?.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('修复范围必须包含至少一个安全的相对文件路径，未建立修理副本。');
  }
  const repairFiles = rawFiles.map((item) => validateRelativePath(item, '修复范围文件'));
  const rawCommand = repairScope?.testCommand;
  if (rawCommand !== undefined && typeof rawCommand !== 'string') {
    throw new Error('自动检查命令必须是字符串，未建立修理副本。');
  }
  const command = String(rawCommand || '').trim();
  let testSupportFiles = [];
  if (/^node\s+--test(?:\s|$)/.test(command)) {
    const match = command.match(/^node --test\s+(.+)$/);
    if (!match) throw new Error('node --test 必须包含安全的相对测试路径，未建立修理副本。');
    testSupportFiles = match[1].split(/\s+/).map((item) => {
      const candidate = validateRelativePath(item, '自动检查路径');
      if (!/\.(?:test|spec)\.[cm]?js$/i.test(candidate)) {
        throw new Error('自动检查路径必须是 .test.js 或 .spec.js 文件，未建立修理副本。');
      }
      return candidate;
    });
  }
  return { repairFiles, testSupportFiles };
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label}必须是非空相对路径，未建立修理副本。`);
  }
  const candidate = value.trim();
  const segments = candidate.split(/[\\/]/);
  if (
    !candidate
    || candidate.includes('\0')
    || path.isAbsolute(candidate)
    || segments.includes('..')
  ) {
    throw new Error(`${label}包含非法绝对路径或 .. 分段，未建立修理副本。`);
  }
  return candidate;
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
