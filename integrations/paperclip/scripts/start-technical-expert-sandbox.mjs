#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = 'http://127.0.0.1:3100';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sandbox = path.join(root, 'docs/acceptance-fixtures/technical-repair-sandbox');
const metadata = { agentArmyId:'technical-expert-sandbox', managedBy:'ajun-runtime', testOnly:true, safetyMode:'isolated-worktree' };
const adapterConfig = {
  command:'/Users/pengaro/.local/bin/codex', cwd:sandbox,
  instructionsFilePath:path.join(root, 'agents/technical-expert/prompts/system.md'),
  model:'gpt-5.4', modelReasoningEffort:'high', search:false, fastMode:false,
  dangerouslyBypassApprovalsAndSandbox:false,
  extraArgs:['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'],
  workspaceStrategy:{ type:'project_primary' },
  timeoutSec:900, graceSec:15, outputInactivityTimeoutMs:300000
};

function ensureSandboxRepository() {
  if (!fs.existsSync(path.join(sandbox, '.git'))) {
    execFileSync('git', ['init'], { cwd:sandbox, stdio:'ignore' });
    execFileSync('git', ['add', '.'], { cwd:sandbox, stdio:'ignore' });
    execFileSync('git', ['-c', 'user.name=Agent Army Acceptance', '-c', 'user.email=acceptance@local.invalid', 'commit', '-m', 'initial controlled repair fixture'], { cwd:sandbox, stdio:'ignore' });
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method:options.method || 'GET', headers:options.body ? {'content-type':'application/json'} : undefined, body:options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Paperclip 返回 ${response.status}`);
  return payload;
}

async function start() {
  ensureSandboxRepository();
  const companies = await request('/api/companies');
  const company = companies.find((item) => item.name === 'Agent军团');
  if (!company) throw new Error('Paperclip 中未找到 Agent军团。');
  const agents = await request(`/api/companies/${company.id}/agents`);
  let agent = agents.find((item) => item.metadata?.agentArmyId === metadata.agentArmyId && item.status !== 'terminated');
  if (!agent) {
    const environment = await request(`/api/companies/${company.id}/adapters/codex_local/test-environment`, { method:'POST', body:{ adapterConfig } });
    if (!['pass', 'warn'].includes(environment.status)) throw new Error('技术专家练习环境未通过检查。');
    agent = await request(`/api/companies/${company.id}/agents`, { method:'POST', body:{ name:'技术专家练习实例', role:'engineer', title:'只用于受控修复验收', icon:'wrench', capabilities:'只修复独立计算练习中的已知错误，必须运行 npm test 并留下可复核结果。', adapterType:'codex_local', adapterConfig, budgetMonthlyCents:0, permissions:{ canCreateAgents:false, canCreateSkills:false }, metadata } });
  } else if (agent.adapterConfig?.workspaceStrategy?.type !== 'project_primary') {
    agent = await request(`/api/agents/${agent.id}`, { method:'PATCH', body:{ adapterConfig } });
  }
  const issue = await request(`/api/companies/${company.id}/issues`, { method:'POST', body:{ title:'受控修复演练：修正加法函数', description:'只在当前独立练习项目内工作。`calculator.js` 的 add 函数实现错误。请修正它，运行 `npm test`，并在当前任务留下修改文件、测试结果、恢复检查和暂时不能验证项。不得修改任何其他项目，不得登录、外发、付费、发布、删除或扩权。', status:'todo', priority:'low', assigneeAgentId:agent.id } });
  return { agent:{ name:agent.name, status:agent.status, adapterType:agent.adapterType }, issue:{ id:issue.id, identifier:issue.identifier, status:issue.status } };
}

start().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode=1; });
