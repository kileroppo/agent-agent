import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const SAFE_TEST_COMMAND = /^(?:node --test [A-Za-z0-9_./ -]+|npm test --prefix apps\/ajun-runtime)$/;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|credentials?|secrets?|tokens?|cookies?)(?:\/|$)/i;

export class TechnicalRepairDiagnoser {
  constructor({ command = process.env.AJUN_CODEX_COMMAND || path.join(os.homedir(), '.local', 'bin', 'codex'), execFileImpl = execFile, fsImpl = fs, maxRunMs = 60_000 } = {}) {
    this.command = command;
    this.execFile = execFileImpl;
    this.fs = fsImpl;
    this.maxRunMs = maxRunMs;
  }

  async diagnose(task, projectRoot) {
    const prompt = buildPrompt(task);
    try {
      const command = this.execFile(this.command, ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-C', projectRoot, prompt], { cwd:projectRoot, timeout:this.maxRunMs, maxBuffer:200_000, stdio:['ignore', 'pipe', 'pipe'] });
      command?.child?.stdin?.end();
      const output = await command;
      return await parseDecision(output?.stdout ?? output, { projectRoot, fsImpl:this.fs });
    } catch (error) {
      if (error?.killed || error?.signal === 'SIGTERM') return { status:'waiting_for_test', reason:'技术诊断超过本轮时限，已保留故障记录。' };
      return { status:'waiting_for_test', reason:'技术诊断暂时无法完成，已保留故障记录。' };
    }
  }
}

function buildPrompt(task) {
  const failure = task.input?.context?.failure || {};
  const classification = task.input?.context?.failureClassification || {};
  return [
    '你是 Agent军团的技术诊断员。只读查看当前工程，绝不修改文件、绝不联网、绝不读取凭据、绝不登录或外发。',
    `故障任务：${String(task.input?.title || '未命名故障').slice(0, 200)}`,
    `故障代码：${String(failure.code || 'unknown_failure').slice(0, 120)}；阶段：${String(failure.stage || 'unknown').slice(0, 120)}；脱敏说明：${String(failure.message || '未提供').slice(0, 800)}。`,
    `预分类：${String(classification.failureClass || 'unknown').slice(0, 120)}；建议路由：${String(classification.route || 'diagnose_before_action').slice(0, 120)}。预分类只是线索，不是根因结论。`,
    '只输出一行 JSON，不要代码块。若能安全修复，格式为：{"decision":"repair","failureClass":"code_defect","summary":"根因摘要","evidence":["现有代码或测试中的依据"],"repairScope":{"files":["相对路径"],"testCommand":"node --test 相对测试路径","recoveryCheck":"如何确认原故障已恢复"},"nextAction":"实施最小修复"}。',
    '如果属于授权、平台、输入或证据不足，输出：{"decision":"needs_input","failureClass":"authorization_or_permission|external_dependency|input_or_source|unknown","summary":"目前能确认的根因边界","evidence":["已有脱敏依据"],"nextAction":"只写一个最小可执行下一步"}。',
    '修复范围最多 4 个相对路径；不得包含 .env、凭据、密钥、Cookie、token、node_modules 或 .git。测试命令只能是 node --test 或 npm test --prefix apps/ajun-runtime。'
  ].join('\n');
}

async function parseDecision(raw, { projectRoot, fsImpl }) {
  try {
    const parsed = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const detail = {
      failureClass:String(parsed?.failureClass || 'unknown').slice(0, 120),
      summary:String(parsed?.summary || '当前资料不足，无法安全确定修复范围。').slice(0, 500),
      evidence:(Array.isArray(parsed?.evidence) ? parsed.evidence : []).map((item) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 500)).filter(Boolean).slice(0, 8),
      nextAction:String(parsed?.nextAction || '补充最小诊断证据后再判断。').slice(0, 500)
    };
    if (parsed?.decision !== 'repair') return { status:'waiting_for_test', reason:detail.summary, ...detail };
    const scope = normalizeScope(parsed.repairScope);
    if (!scope) return { status:'waiting_for_test', reason:'技术诊断没有给出可安全执行的修复范围。', ...detail };
    const missingPaths = await missingScopePaths(scope, projectRoot, fsImpl);
    if (missingPaths.length) {
      return {
        status:'waiting_for_test',
        reason:`技术诊断引用了当前工程中不存在的路径：${missingPaths.join('、')}`,
        ...detail,
        invalidPaths:missingPaths
      };
    }
    return { status:'ready', ...detail, repairScope:scope };
  } catch {
    return { status:'waiting_for_test', reason:'技术诊断没有留下可读取的范围结论。' };
  }
}

async function missingScopePaths(scope, projectRoot, fsImpl) {
  const candidates = [...scope.files];
  const testPath = scope.testCommand.startsWith('node --test ') ? scope.testCommand.slice('node --test '.length).trim() : '';
  if (testPath) candidates.push(testPath);
  const missing = [];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(projectRoot, candidate);
      if (!resolved.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) throw new Error('outside');
      await fsImpl.access(resolved);
    } catch {
      missing.push(candidate);
    }
  }
  return [...new Set(missing)];
}

function normalizeScope(scope) {
  const files = Array.isArray(scope?.files) ? scope.files.map((item) => String(item || '').trim()).filter(safePath) : [];
  const testCommand = String(scope?.testCommand || '').trim();
  const recoveryCheck = String(scope?.recoveryCheck || '').trim();
  if (!files.length || files.length > 4 || !SAFE_TEST_COMMAND.test(testCommand) || !recoveryCheck) return null;
  return { files, testCommand, recoveryCheck:recoveryCheck.slice(0, 500) };
}

function safePath(value) {
  return value.length > 0 && !path.isAbsolute(value) && !value.split('/').includes('..') && !SENSITIVE_PATH.test(value) && !value.startsWith('.git/') && !value.startsWith('node_modules/');
}
