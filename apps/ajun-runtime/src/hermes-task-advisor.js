import { execFile } from 'node:child_process';

const MAX_ITEMS = 4;

export class HermesTaskAdvisor {
  constructor({ command = process.env.AJUN_HERMES_COMMAND || '/Users/pengaro/.local/bin/hermes', hermesHome = process.env.AJUN_HERMES_HOME || '', timeoutMs = 18_000, run = runCommand } = {}) {
    this.command = command;
    this.hermesHome = hermesHome;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  async advise({ request, employees = [] } = {}) {
    if (!this.hermesHome) return null;
    const output = await this.run(this.command, ['--ignore-rules', '--oneshot', promptFor(request, employees)], { timeoutMs:this.timeoutMs, env:{ ...process.env, HERMES_HOME:this.hermesHome } });
    return parseAdvice(output);
  }
}

function promptFor(request, employees) {
  return [
    '你是“A君·军团总管”的任务理解助手。只解释用户想要什么和安全的下一步，不调用工具、不执行任务、不承诺系统没有的能力。',
    '只输出一行 JSON：{"understanding":"一句话说明用户真正想要的结果","deliverable":"用户最后应收到什么","missing":["最多4项确实缺少的信息或材料"],"safeNextStep":"当前最小、无登录无外发无付费的下一步"}。',
    '只能依据当前员工清单判断能力。清单没有的能力必须明确说当前没有对应员工，不能编造员工、数据、完成结果或外部访问。',
    `当前员工清单：${JSON.stringify(normalizeEmployees(employees))}`,
    `用户原话：${JSON.stringify(String(request || '').slice(0, 2000))}`
  ].join('\n');
}

function parseAdvice(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  const understanding = cleanText(parsed?.understanding, 300);
  const deliverable = cleanText(parsed?.deliverable, 300);
  const safeNextStep = cleanText(parsed?.safeNextStep, 400);
  if (!understanding || !deliverable || !safeNextStep) return null;
  const missing = Array.isArray(parsed?.missing) ? parsed.missing.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, MAX_ITEMS) : [];
  return { understanding, deliverable, missing, safeNextStep };
}

function normalizeEmployees(employees) {
  return (Array.isArray(employees) ? employees : []).map((employee) => ({
    name:cleanText(employee?.name, 80),
    taskTypes:Array.isArray(employee?.acceptedTaskTypes) ? employee.acceptedTaskTypes.map((type) => cleanText(type, 100)).filter(Boolean).slice(0, 8) : []
  })).filter((employee) => employee.name);
}

function cleanText(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }

function runCommand(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout:timeoutMs, maxBuffer:16 * 1024, env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
