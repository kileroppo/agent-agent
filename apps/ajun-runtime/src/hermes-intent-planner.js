import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const INTENTS = new Set(['identity', 'army_overview', 'army_report', 'usage_report', 'task_progress', 'agent_proposal', 'architecture_review', 'army_planning', 'cross_agent_mission', 'health_check', 'media_task', 'public_report', 'github_search', 'intel_research', 'employee_status', 'route_task', 'intake', 'clarify']);

export class HermesIntentPlanner {
  constructor({ command = '/Users/pengaro/.local/bin/hermes', hermesHome = process.env.AJUN_HERMES_HOME || '', profileRoot = process.env.AGENT_ARMY_HERMES_PROFILE_ROOT || path.join(os.homedir(), '.hermes/profiles'), timeoutMs = 18_000, run = runCommand } = {}) {
    this.command = command; this.hermesHome = hermesHome; this.profileRoot = profileRoot; this.timeoutMs = timeoutMs; this.run = run;
  }

  async decide(text, { routes = [], employees = [], agentId = null } = {}) {
    const hermesHome = agentProfileHome(this.profileRoot, agentId) || this.hermesHome;
    if (!hermesHome) return null;
    const allowedRoutes = normalizeRoutes(routes);
    const allowedEmployees = normalizeEmployees(employees);
    const output = await this.run(this.command, ['--ignore-rules', '--oneshot', promptFor(text, allowedRoutes, allowedEmployees, agentId)], { timeoutMs: this.timeoutMs, env: { ...process.env, HERMES_HOME: hermesHome } });
    return parseDecision(output, allowedRoutes, allowedEmployees);
  }
}

function promptFor(text, routes, employees, agentId = null) {
  return [
    agentId ? `你正在作为“${agentId}”岗位的独立 Hermes Agent 理解消息。你只负责把用户的一句话归到一个已有动作或安全追问，绝不调用工具、绝不执行任务、绝不编造结果。` : '你是“A君·军团总管”的理解助手。你只负责把用户的一句话归到一个已有动作或已经上岗员工，绝不调用工具、绝不执行任务、绝不解释。',
    '只输出一行 JSON。普通分类格式：{"intent":"identity|army_overview|army_report|usage_report|task_progress|agent_proposal|architecture_review|army_planning|cross_agent_mission|health_check|media_task|public_report|github_search|intel_research|intake"}。如果当前员工清单中有唯一合适的人，可输出：{"intent":"route_task","taskType":"清单中的任务类型","agentId":"清单中的员工编号"}。如果用户只是在聊天、意思不完整、没有可执行目标，或你不确定该不该创建工作，输出：{"intent":"clarify","reply":"一句中文追问"}。',
    'identity=问你是谁、你负责什么、介绍自己、你是做什么的；这只是聊天说明，不能创建任务、不能调用员工。army_overview=问有多少员工、谁在做什么、谁忙/卡住/工作状态，或问今天/现在有什么需要自己确认、决定或补充；它只展示现状。army_report=要今天的工作汇报、日报、今天完成了什么、当前进展与卡点总结；usage_report=问今天花了多少、成本、费用或实际使用情况；task_progress=问某项工作进度、结果、完成没有；agent_proposal=要创建新员工/Agent/助手；architecture_review=要复盘重复工作、发现能力缺口或判断是否需要新员工；army_planning=让总管判断当前最优先做什么、怎么推进、安排合适现有员工；cross_agent_mission=要让多个员工一起盘点军团、协同完成内部安全工作；health_check=用户要判断系统、服务或任务有没有异常/故障/卡死，或要求给处理建议、说明谁接手、是否能安全恢复、用户需要做什么。即使用户说“任务卡住”，只要要求判断和处理就必须选 health_check，不能选 army_overview；media_task=要整理视频/音频或含公开视频链接；public_report=要查找、读取或对比一到五个具体公开网页并给摘要/基础对比；github_search=要在公开 GitHub 找开源项目，或读某个公开仓库的 README/文件并说明实现方式；intel_research=围绕一个主题综合多个公开来源，要求背景、关键发现、结论、行动建议或未决问题。不得把登录、付费、私密资料或高风险目标归到这些公开只读类别；employee_status=用户明确在问某一位当前员工最近做了什么、正在做什么或卡在哪里，例如“看下小D最近干了啥”；只能输出 {"intent":"employee_status","agentId":"员工清单中的编号"}，不得查看全团。仅提到员工名字但在交代“补充链接、验证、整理、处理”等工作时，不是 employee_status；没有可用链接时用 clarify 追问链接，不能创建重复工作；intake=用户明确交代了一个低风险工作目标，但当前没有唯一合适员工；clarify=没有明确工作目标时的聊天或追问。clarify 的 reply 只能是一句简短中文，说明还缺哪一个信息；不能说已经开始、不能承诺结果、不能编造状态。',
    `当前可派活员工：${routes.length ? JSON.stringify(routes) : '暂无额外员工；不要编造员工或任务类型。'}`,
    `当前可查看的员工：${employees.length ? JSON.stringify(employees) : '暂无员工；不要编造员工。'}`,
    `用户的话：${JSON.stringify(String(text || '').slice(0, 2000))}`
  ].join('\n');
}

function agentProfileHome(profileRoot, agentId) {
  const id = String(agentId || '').trim();
  return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? path.join(profileRoot, id) : null;
}

function parseDecision(raw, routes, employees) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (parsed?.intent === 'route_task') {
    const route = routes.find((item) => item.taskType === parsed.taskType && item.agentId === parsed.agentId);
    return route ? { intent:'route_task', taskType:route.taskType, agentId:route.agentId } : null;
  }
  if (parsed?.intent === 'employee_status') {
    const employee = employees.find((item) => item.agentId === parsed.agentId);
    return employee ? { intent:'employee_status', agentId:employee.agentId } : null;
  }
  if (parsed?.intent === 'clarify') {
    const reply = safeClarification(parsed.reply);
    return reply ? { intent:'clarify', reply } : { intent:'clarify' };
  }
  return INTENTS.has(parsed?.intent) ? { intent: parsed.intent } : null;
}

function safeClarification(value) {
  const reply = String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  if (!reply || /https?:\/\//i.test(reply)) return null;
  return reply;
}

function normalizeRoutes(routes) {
  return (Array.isArray(routes) ? routes : []).map((route) => ({ taskType:String(route?.taskType || '').trim(), agentId:String(route?.agentId || '').trim(), name:String(route?.name || '').trim() })).filter((route) => route.taskType && route.agentId);
}

function normalizeEmployees(employees) {
  return (Array.isArray(employees) ? employees : []).map((employee) => ({ agentId:String(employee?.agentId || '').trim(), name:String(employee?.name || '').trim() })).filter((employee) => employee.agentId && employee.name);
}

function runCommand(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024, env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
