import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);

export class TechnicalExpertRunner {
  constructor({ command = process.env.AJUN_CODEX_COMMAND || path.join(os.homedir(), '.local', 'bin', 'codex'), execFileImpl = execFile, fsImpl = fs, maxRunMs = 150_000 } = {}) {
    this.command = command;
    this.execFile = execFileImpl;
    this.fs = fsImpl;
    this.maxRunMs = maxRunMs;
  }

  async run(task, workspace) {
    const scope = repairScope(task);
    if (!scope) return { status:'waiting_for_scope' };
    const prompt = buildPrompt(task, scope);
    try {
      const command = this.execFile(this.command, ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-C', workspace, prompt], { cwd:workspace, timeout:this.maxRunMs, maxBuffer:2_000_000, stdio:['ignore', 'pipe', 'pipe'] });
      command?.child?.stdin?.end();
      await command;
    } catch (error) {
      if (error?.killed || error?.signal === 'SIGTERM') return { status:'waiting_for_test', reason:'自动修复检查超过本轮时限，已停止等待并保留独立副本。' };
      return { status:'failed', reason:String(error?.message || '技术专家未能完成本轮修复。').slice(0, 500) };
    }
    const evidencePath = path.join(workspace, 'paperclip-work-product.json');
    try {
      const evidence = JSON.parse(await this.fs.readFile(evidencePath, 'utf8'));
      return { status:'evidence_ready', evidencePath, evidence };
    } catch (error) {
      return error?.code === 'ENOENT' ? { status:'evidence_missing' } : { status:'failed', reason:'技术专家留下的结果无法读取。' };
    }
  }
}

function repairScope(task) {
  const scope = task.input?.context?.repairScope;
  const files = Array.isArray(scope?.files) ? scope.files.map((item) => String(item || '').trim()).filter(validRelativePath) : [];
  const testCommand = String(scope?.testCommand || '').trim();
  const recoveryCheck = String(scope?.recoveryCheck || '').trim();
  if (!files.length || !testCommand || !recoveryCheck) return null;
  return { files, testCommand, recoveryCheck };
}

function validRelativePath(value) { return value.length > 0 && !path.isAbsolute(value) && !value.split('/').includes('..'); }

function buildPrompt(task, scope) {
  return [
    '你是 Agent军团的技术专家，正在一个独立修理副本中处理受控修复。',
    `问题：${String(task.input?.title || '未命名技术问题').slice(0, 200)}`,
    `说明：${String(task.input?.description || '').slice(0, 1000)}`,
    `只允许修改这些文件：${scope.files.join('、')}。另可新建 paperclip-work-product.json 作为本轮回执；这个回执不会带回主工程。`,
    `必须运行的自动检查：${scope.testCommand}`, `必须完成的恢复检查：${scope.recoveryCheck}`,
    '不得读取凭据、联网、登录、外发、付费、发布、删除、扩权或提交代码。不得修改未允许文件。',
    '完成后必须在当前目录写 paperclip-work-product.json，内容必须是 JSON，且至少包含：{"metadata":{"agentArmyRepairEvidence":{"changedFiles":["实际修改的相对路径"],"testsPassed":true,"testSummary":"检查结果","recoveryVerified":true,"recoverySummary":"恢复检查结果","remainingTests":[]}}}。没有完整证据不得声称修好。'
  ].join('\n');
}
