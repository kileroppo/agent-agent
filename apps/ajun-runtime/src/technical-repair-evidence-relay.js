import fs from 'node:fs/promises';
import path from 'node:path';

export class TechnicalRepairEvidenceRelay {
  constructor({ governance, projectRoot, allowedWorkspaceRoots = [], fsImpl = fs } = {}) {
    this.governance = governance;
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.allowedWorkspaceRoots = [this.projectRoot, ...allowedWorkspaceRoots].map((item) => path.resolve(item));
    this.fs = fsImpl;
  }

  async relay(task) {
    const agentId = task.governance?.paperclipAssigneeAgentId;
    if (!agentId) return { status:'unavailable', reason:'未找到技术专家。' };
    const agent = await this.governance.getPaperclipAgent(agentId);
    const workspace = await this.workspaceFor(task, agent);
    if (!workspace) return { status:'unavailable', reason:'技术专家工作区不在允许项目范围内。' };
    const sourcePath = path.join(workspace, 'paperclip-work-product.json');
    let draft;
    try { draft = JSON.parse(await this.fs.readFile(sourcePath, 'utf8')); }
    catch (error) { return error?.code === 'ENOENT' ? { status:'pending' } : { status:'unavailable', reason:'技术专家回执无法读取。' }; }
    const product = normalizeProduct(draft, task);
    if (!product) return { status:'unavailable', reason:'技术专家回执缺少完整修复和测试证据。' };
    const created = await this.governance.createIssueWorkProduct(task.governance.paperclipIssueId, product);
    await this.governance.completeTechnicalRepairIssue(task.governance.paperclipIssueId, product.title);
    return { status:'relayed', product:created, sourcePath };
  }

  async workspaceFor(task, agent) {
    const prepared = safeWorkspace(task.execution?.workspace?.path, this.allowedWorkspaceRoots);
    if (prepared) return prepared;
    const issueId = task.governance?.paperclipIssueId;
    if (issueId && typeof this.governance.getPaperclipIssueRuns === 'function' && typeof this.governance.getExecutionWorkspace === 'function') {
      try {
        const runs = await this.governance.getPaperclipIssueRuns(issueId);
        const run = Array.isArray(runs) ? [...runs].reverse().find((item) => item?.environmentLease?.executionWorkspaceId) : null;
        if (run) {
          const executionWorkspace = await this.governance.getExecutionWorkspace(run.environmentLease.executionWorkspaceId);
          const resolved = safeWorkspace(executionWorkspace?.cwd, this.allowedWorkspaceRoots);
          if (resolved) return resolved;
        }
      } catch {
        // A missing or retired execution workspace must not make A君 read an arbitrary directory.
      }
    }
    return safeWorkspace(agent?.adapterConfig?.cwd, this.allowedWorkspaceRoots);
  }
}

function safeWorkspace(value, allowedRoots) {
  if (!value || typeof value !== 'string') return null;
  const workspace = path.resolve(value);
  return allowedRoots.some((root) => {
    const relative = path.relative(root, workspace);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }) ? workspace : null;
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
