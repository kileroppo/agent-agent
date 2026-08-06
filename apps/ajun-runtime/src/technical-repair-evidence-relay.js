import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TechnicalRepairEvidenceRelay {
  constructor({ governance, projectRoot, allowedWorkspaceRoots = [], verifySourceRoot = null, fsImpl = fs } = {}) {
    this.governance = governance;
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.allowedWorkspaceRoots = [this.projectRoot, ...allowedWorkspaceRoots].map((item) => path.resolve(item));
    this.verifySourceRoot = verifySourceRoot;
    this.fs = fsImpl;
  }

  async relay(task) {
    try {
      if (this.verifySourceRoot) await this.verifySourceRoot();
    } catch {
      return { status:'unavailable', reason:'技术修复源码根已变化，拒绝转交回执。' };
    }
    const agentId = task.governance?.paperclipAssigneeAgentId;
    if (!agentId) return { status:'unavailable', reason:'未找到技术专家。' };
    const agent = await this.governance.getPaperclipAgent(agentId);
    const workspace = await this.workspaceFor(task, agent);
    if (!workspace) return { status:'unavailable', reason:'技术专家工作区不在允许项目范围内。' };
    const sourcePath = path.join(workspace, 'paperclip-work-product.json');
    let draft;
    try { draft = JSON.parse(await readSafeRegularFile(this.fs, workspace, sourcePath)); }
    catch (error) { return error?.code === 'ENOENT' ? { status:'pending' } : { status:'unavailable', reason:'技术专家回执无法读取。' }; }
    const product = normalizeProduct(draft, task);
    if (!product) return { status:'unavailable', reason:'技术专家回执缺少完整修复和测试证据。' };
    const created = await this.governance.createIssueWorkProduct(task.governance.paperclipIssueId, product);
    await this.governance.completeTechnicalRepairIssue(task.governance.paperclipIssueId, product.title);
    return { status:'relayed', product:created, sourcePath };
  }

  async workspaceFor(task, agent) {
    const prepared = await safeWorkspace(this.fs, task.execution?.workspace?.path, this.allowedWorkspaceRoots);
    if (prepared) return prepared;
    const issueId = task.governance?.paperclipIssueId;
    if (issueId && typeof this.governance.getPaperclipIssueRuns === 'function' && typeof this.governance.getExecutionWorkspace === 'function') {
      try {
        const runs = await this.governance.getPaperclipIssueRuns(issueId);
        const run = Array.isArray(runs) ? [...runs].reverse().find((item) => item?.environmentLease?.executionWorkspaceId) : null;
        if (run) {
          const executionWorkspace = await this.governance.getExecutionWorkspace(run.environmentLease.executionWorkspaceId);
          const resolved = await safeWorkspace(this.fs, executionWorkspace?.cwd, this.allowedWorkspaceRoots);
          if (resolved) return resolved;
        }
      } catch {
        // A missing or retired execution workspace must not make A君 read an arbitrary directory.
      }
    }
    return safeWorkspace(this.fs, agent?.adapterConfig?.cwd, this.allowedWorkspaceRoots);
  }
}

async function safeWorkspace(fsImpl, value, allowedRoots) {
  if (!value || typeof value !== 'string') return null;
  if (!path.isAbsolute(value)) return null;
  const workspace = path.normalize(value);
  try {
    const stat = await fsImpl.lstat(workspace);
    const canonical = await fsImpl.realpath(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== workspace) return null;
    for (const allowedRoot of allowedRoots) {
      let canonicalRoot;
      try { canonicalRoot = await fsImpl.realpath(allowedRoot); }
      catch { continue; }
      const relative = path.relative(canonicalRoot, canonical);
      if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return canonical;
      }
    }
  } catch {}
  return null;
}

async function readSafeRegularFile(fsImpl, root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('回执文件越出允许工作区。');
  }
  let cursor = root;
  let expected;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fsImpl.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('回执路径包含符号链接。');
    if (cursor !== candidate && !stat.isDirectory()) throw new Error('回执路径祖先不是目录。');
    if (cursor === candidate && !stat.isFile()) throw new Error('回执必须是普通文件。');
    if (cursor === candidate) expected = stat;
  }
  if (await fsImpl.realpath(candidate) !== candidate) {
    throw new Error('回执没有解析到工作区内的原始文件。');
  }
  const handle = await fsImpl.open(
    candidate,
    fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.dev !== expected.dev
      || stat.ino !== expected.ino
      || stat.size > 1024 * 1024
    ) {
      throw new Error('回执不是允许大小的普通文件。');
    }
    return handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function normalizeProduct(draft, task) {
  const proof = draft?.metadata?.agentArmyRepairEvidence;
  if (proof?.testsPassed !== true || proof?.recoveryVerified !== true || !Array.isArray(proof?.changedFiles) || proof.changedFiles.length === 0) return null;
  const suppliedStatus = String(draft?.status || '').trim();
  const status = ['approved', 'merged'].includes(suppliedStatus) ? suppliedStatus : 'approved';
  const defaultTitle = `修复证据：${String(task?.input?.title || '技术专家任务').slice(0, 120)}`;
  return {
    type:'artifact', provider:String(draft?.provider || 'A君技术专家').slice(0, 80), title:String(draft?.title || defaultTitle).slice(0, 160), status,
    summary:String(draft.summary || '技术专家已提交修复和验证证据。').slice(0, 1000),
    metadata:{ agentArmyRepairEvidence:{
      changedFiles:proof.changedFiles.map((item) => String(item).slice(0, 240)).filter(Boolean),
      testsPassed:true, testSummary:String(proof.testSummary || '').slice(0, 1000),
      recoveryVerified:true, recoverySummary:String(proof.recoverySummary || '').slice(0, 1000),
      remainingTests:Array.isArray(proof.remainingTests) ? proof.remainingTests.map((item) => String(item).slice(0, 240)) : []
    } }
  };
}
