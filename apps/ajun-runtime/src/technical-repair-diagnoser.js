import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const SAFE_TEST_COMMAND = /^(?:node --test [A-Za-z0-9_./ -]+|npm test --prefix apps\/ajun-runtime)$/;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|credentials?|secrets?|tokens?|cookies?)(?:\/|$)/i;

export class TechnicalRepairDiagnoser {
  constructor({ command = '/Users/pengaro/.local/bin/codex', execFileImpl = execFile, maxRunMs = 60_000 } = {}) {
    this.command = command;
    this.execFile = execFileImpl;
    this.maxRunMs = maxRunMs;
  }

  async diagnose(task, projectRoot) {
    const prompt = buildPrompt(task);
    try {
      const command = this.execFile(this.command, ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-C', projectRoot, prompt], { cwd:projectRoot, timeout:this.maxRunMs, maxBuffer:200_000, stdio:['ignore', 'pipe', 'pipe'] });
      command?.child?.stdin?.end();
      const output = await command;
      return parseDecision(output?.stdout ?? output);
    } catch (error) {
      if (error?.killed || error?.signal === 'SIGTERM') return { status:'waiting_for_test', reason:'技术诊断超过本轮时限，已保留故障记录。' };
      return { status:'waiting_for_test', reason:'技术诊断暂时无法完成，已保留故障记录。' };
    }
  }
}

function buildPrompt(task) {
  const failure = task.input?.context?.failure || {};
  return [
    '你是 Agent军团的技术诊断员。只读查看当前工程，绝不修改文件、绝不联网、绝不读取凭据、绝不登录或外发。',
    `故障任务：${String(task.input?.title || '未命名故障').slice(0, 200)}`,
    `故障代码：${String(failure.code || 'unknown_failure').slice(0, 120)}；阶段：${String(failure.stage || 'unknown').slice(0, 120)}。`,
    '只输出一行 JSON，不要代码块。若能安全修复，格式为：{"decision":"repair","summary":"原因摘要","repairScope":{"files":["相对路径"],"testCommand":"node --test 相对测试路径","recoveryCheck":"如何确认故障已恢复"}}。',
    '如果无法从现有资料安全确定范围，输出：{"decision":"needs_input","summary":"还缺少什么证据"}。',
    '修复范围最多 4 个相对路径；不得包含 .env、凭据、密钥、Cookie、token、node_modules 或 .git。测试命令只能是 node --test 或 npm test --prefix apps/ajun-runtime。'
  ].join('\n');
}

function parseDecision(raw) {
  try {
    const parsed = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (parsed?.decision !== 'repair') return { status:'waiting_for_test', reason:String(parsed?.summary || '当前资料不足，无法安全确定修复范围。').slice(0, 300) };
    const scope = normalizeScope(parsed.repairScope);
    if (!scope) return { status:'waiting_for_test', reason:'技术诊断没有给出可安全执行的修复范围。' };
    return { status:'ready', summary:String(parsed.summary || '技术诊断已确定受控修复范围。').slice(0, 500), repairScope:scope };
  } catch {
    return { status:'waiting_for_test', reason:'技术诊断没有留下可读取的范围结论。' };
  }
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
